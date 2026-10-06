import { matureWarmSchedule, plannedDays } from './mature-warm-pool.mjs';

export function warmPoolCapacity(plan, available, startDate = new Date().toISOString().slice(0, 10)) {
  const amounts = matureWarmSchedule(plan, startDate);
  const openEnded = amounts.at(-1) > 0;
  const planned = openEnded
    ? Array.from({ length: 28 }, (_, i) => amounts[Math.min(i, amounts.length - 1)] || 0).reduce((a, b) => a + b, 0)
    : amounts.reduce((a, b) => a + b, 0);
  const days = plannedDays(available + 1, amounts);
  return { available, planned, openEnded, exceeds: planned > available,
    lastAvailableDay: available ? days[available - 1] : 0, firstUnavailableDay: days[available] };
}

export function coldStageRequirements(plan) {
  if (plan.coldEnabled !== true) return [];
  const stages = plan.connectionStages?.cold || (plan.stages || []).map(s => ({ fromDay: s.fromDay, toDay: s.toDay, daily: s.coldDaily }));
  return stages.map((stage, i) => {
    const fromDay = Number(stage.fromDay), toDay = Number(stage.toDay), daily = Number(stage.daily);
    const valid = [fromDay, toDay, daily].every(Number.isSafeInteger) && fromDay >= 1 && toDay >= fromDay && daily >= 0;
    return { stage: i + 1, fromDay, toDay, daily, count: valid ? (toDay - fromDay + 1) * daily : 0 };
  });
}
