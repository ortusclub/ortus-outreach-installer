import { warmRampErrors } from './mature-warm-ramp.mjs';
export const MATURE_WARM_POOLS = Object.freeze({ ortus_owned: 'Ortus Owned Account', linkedvelocity_owned: 'Other Pool Accounts (LV)' });
// Plan data is stored inside the campaign config, never in shared localStorage.
export function newMaturePlan() {
  // Default warm ramp (Sam, 2026-10-05): 3 → 6 → 10 → 20 a day, holding the last
  // rate until the pool runs out. Every figure stays editable before starting.
  // Cold connections and post engagement do not run yet, so they default to 0.
  return { version: 1, warmPool: '', coldPool: '', coldPoolSource: 'default', coldPoolOrder: 'random', postPool: '', notes: '', accounts: {}, targetProfileIds: [], warmUntilExhausted: true, stages: [
    { id: 'warm', name: 'Warm connections', fromDay: 1, toDay: 3, warmDaily: 3, coldDaily: 0, likesDaily: 0 },
    { id: 'ramp', name: 'Increase warm connections', fromDay: 4, toDay: 7, warmDaily: 6, coldDaily: 0, likesDaily: 0 },
    { id: 'cold', name: 'Introduce cold connections', fromDay: 8, toDay: 14, warmDaily: 10, coldDaily: 0, likesDaily: 0 },
    { id: 'engage', name: 'Add post engagement', fromDay: 15, toDay: 28, warmDaily: 20, coldDaily: 0, likesDaily: 0 },
  ] };
}
export function restoreMaturePlan(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.stages)) return newMaturePlan();
  // A plan saved before the until-exhausted default existed keeps its own end.
  return { ...newMaturePlan(), ...structuredClone(value), warmUntilExhausted: !!value.warmUntilExhausted, coldPoolSource: value.coldPoolSource || (value.coldPool ? 'custom' : 'default'), coldPoolOrder: value.coldPoolOrder || 'random', targetProfileIds: [...new Set(value.targetProfileIds || [])].slice(0, 1) };
}
export function maturePlanErrors(plan) {
  const errors = [];
  if (plan.warmRamp) errors.push(...warmRampErrors(plan.warmUntilExhausted ? {...plan.warmRamp,stopMode:"none"} : plan.warmRamp));
  let last = 0;
  for (const stage of plan.stages) {
    const from = Number(stage.fromDay), to = Number(stage.toDay);
    if (!plan.connectionStages && (!Number.isInteger(from) || from !== last + 1 || !Number.isInteger(to) || to < from)) errors.push(`${stage.name}: days must follow the previous stage without gaps or overlaps.`);
    last = to;
    for (const field of (plan.connectionStages ? [] : plan.warmRamp ? ['coldDaily', 'likesDaily'] : ['warmDaily', 'coldDaily', 'likesDaily'])) {
      const n = Number(stage[field]);
      if (stage[field] === '' || !Number.isInteger(n) || n < 0) errors.push(`${stage.name}: set each daily limit (use 0 to disable an activity).`);
    }
  }
  if (plan.connectionStages) {
    for (const kind of ['warm','cold']) {
      if (kind === 'warm' && plan.warmRamp) continue;
      let end = null;
      for (const stage of plan.connectionStages[kind] || []) {
        const from=Number(stage.fromDay),to=Number(stage.toDay),daily=Number(stage.daily);
        const openEnded = kind==='warm' && plan.warmUntilExhausted && stage===plan.connectionStages.warm.at(-1);
        if (!Number.isInteger(from) || from<1 || (end!==null && from!==end+1) || (!openEnded && (!Number.isInteger(to) || to<from))) errors.push(`${kind}: stages must be consecutive without overlaps.`);
        if (stage.daily==='' || !Number.isInteger(daily) || daily<0) errors.push(`${kind}: set a daily limit for each stage.`);
        end=to;
      }
    }
  }
  if ((plan.warmRamp ? Number(plan.warmRamp.maximumDaily) > 0 : (plan.connectionStages?.warm ? plan.connectionStages.warm.some(s=>Number(s.daily)>0) : plan.stages.some(s => Number(s.warmDaily) > 0))) && !Object.hasOwn(MATURE_WARM_POOLS, plan.warmPool)) errors.push('Choose the warm connection pool.');
  if (plan.connectionStages?.cold ? plan.connectionStages.cold.some(s=>Number(s.daily)>0) : plan.stages.some(s => Number(s.coldDaily) > 0)) {
    if (plan.coldPoolSource === 'default') errors.push('The default cold connection sheet has not been configured yet.');
    else if (!/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[^/]+/.test(plan.coldPool || '')) errors.push('Add a Google Sheet link for the cold connection pool.');
  }
  if (!plan.connectionStages && plan.stages.some(s => Number(s.likesDaily) > 0) && !plan.postPool.trim()) errors.push('Choose the posts for the engagement stage.');
  return [...new Set(errors)];
}
export function matureStageForDay(plan, day) {
  return plan.stages.find(s => day >= Number(s.fromDay) && day <= Number(s.toDay)) || null;
}

// Keep subsequent stages consecutive without changing their daily limits.
export function updateMatureStageEnd(plan, index, value) {
  const stage = plan.stages[index];
  if (!stage) return;
  stage.toDay = value === '' ? '' : Number(value);
  if (!Number.isInteger(stage.toDay) || stage.toDay < Number(stage.fromDay)) return;
  for (let i = index + 1; i < plan.stages.length; i++) {
    const next = plan.stages[i];
    next.fromDay = Number(plan.stages[i - 1].toDay) + 1;
    // If the preceding stage overtakes this one, keep at least one day.
    next.toDay = Math.max(next.fromDay, Number(next.toDay) || next.fromDay);
  }
}
