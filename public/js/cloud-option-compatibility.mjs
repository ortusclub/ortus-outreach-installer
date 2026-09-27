export function cloudOptionError(body = {}) {
  return body.stopBeforeWeeklyReset || body.stopBeforeMonthlyReset || body.skipIntroductions
    ? 'These stop-window and connections-only options currently require This machine. Change the run target or turn them off.'
    : '';
}
