// Server-side entry for the capacity-forecast helper. The implementation
// lives in public/js/capacity-forecast.mjs so the browser (app.js is an ES
// module) and node share ONE source of truth — no mirrored copy to drift.
export { forecastCapacity, WARN_DAYS } from '../public/js/capacity-forecast.mjs';
