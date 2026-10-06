// Editable planning templates; these are not platform limits.
export const WARM_PRESETS = Object.freeze({
  gentle: { label: 'Default gentle maturing', initialDaily: 3, increaseBy: 2, everyDays: 3, maximumDaily: 15, stopAfterDays: 28 },
  moderate: { label: 'Default moderate warming', initialDaily: 5, increaseBy: 5, everyDays: 3, maximumDaily: 30, stopAfterDays: 28 },
  aggressive: { label: 'Default aggressive warming', initialDaily: 10, increaseBy: 10, everyDays: 3, maximumDaily: 50, stopAfterDays: 28 },
});
export function warmPreset(key) {
  const p = WARM_PRESETS[key];
  if (!p) throw new Error('Unknown warm-connection preset');
  const {label, ...settings} = p;
  return { ...settings, preset: key, stopMode: 'days', stopDate: '' };
}
export function warmRampErrors(ramp) {
  const errors = [];
  for (const [key,label,min] of [['initialDaily','Starting daily amount',0],['increaseBy','Increase amount',0],['everyDays','Days between increases',1],['maximumDaily','Maximum daily amount',1]]) {
    if (ramp[key] === '' || !Number.isInteger(Number(ramp[key])) || Number(ramp[key]) < min) errors.push(`${label} must be a whole number of ${min} or more.`);
  }
  if (Number(ramp.maximumDaily) < Number(ramp.initialDaily)) errors.push('The maximum must be at least the starting daily amount.');
  if (!['days','date','none'].includes(ramp.stopMode)) errors.push('Choose when warm connections stop.');
  if (ramp.stopMode === 'days' && (!Number.isInteger(Number(ramp.stopAfterDays)) || Number(ramp.stopAfterDays) < 1)) errors.push('Set at least one day of warm connections.');
  if (ramp.stopMode === 'date' && !parseDay(ramp.stopDate)) errors.push('Choose a valid stop date.');
  return errors;
}
function parseDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const d = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(+d) && d.toISOString().slice(0,10) === value ? d : null;
}
export function warmDailyAmount(ramp, day) {
  if (warmRampErrors(ramp).length || !Number.isInteger(day) || day < 1) return 0;
  if (ramp.stopMode === 'days' && day > Number(ramp.stopAfterDays)) return 0;
  return Math.min(Number(ramp.maximumDaily), Number(ramp.initialDaily) + Math.floor((day - 1) / Number(ramp.everyDays)) * Number(ramp.increaseBy));
}
export function warmSchedule(ramp, startDate, previewDays = 28) {
  const start = parseDay(startDate);
  if (!start || warmRampErrors(ramp).length) return { rows: [], endDate: null };
  let end = null;
  if (ramp.stopMode === 'days') { end = new Date(start); end.setUTCDate(end.getUTCDate() + Number(ramp.stopAfterDays) - 1); }
  if (ramp.stopMode === 'date') end = parseDay(ramp.stopDate);
  const rows = [];
  for (let day = 1; day <= previewDays; day++) {
    const date = new Date(start); date.setUTCDate(date.getUTCDate() + day - 1);
    if (end && date > end) break;
    rows.push({day,date:date.toISOString().slice(0,10),amount:warmDailyAmount(ramp,day)});
  }
  return { rows, endDate: end?.toISOString().slice(0,10) || null };
}
