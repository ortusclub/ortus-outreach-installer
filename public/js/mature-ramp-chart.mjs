import { matureWarmDailyAmount, matureColdDailyAmount } from './mature-warm-pool.mjs';

export function warmRampPreview(plan, days = 28) {
  return Array.from({ length: days }, (_, i) => ({ day: i + 1, amount: matureWarmDailyAmount(plan, i + 1) }));
}

export function coldRampPreview(plan, days = 28) {
  return Array.from({ length: days }, (_, i) => ({ day: i + 1, amount: matureColdDailyAmount(plan, i + 1) }));
}

export function renderColdRampChart(host, plan) {
  renderConnectionRampChart(host, coldRampPreview(plan), 'Cold');
}

// A short preview of the same daily schedule used to launch the campaign.
export function renderWarmRampChart(host, plan) {
  renderConnectionRampChart(host, warmRampPreview(plan), 'Warm');
}

function renderConnectionRampChart(host, rows, kind) {
  host.replaceChildren();
  const maximum = Math.max(1, ...rows.map(r => r.amount));
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const heading = document.createElement('div'); heading.className = 'mature-ramp-chart__heading';
  const title = document.createElement('strong'); title.textContent = `${kind} connection ramp`;
  const summary = document.createElement('span'); summary.textContent = `First 28 days · ${total} planned connections`;
  heading.append(title, summary);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 560 104'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', rows.map(r => `Day ${r.day}: ${r.amount} connections`).join('; '));
  const label = document.createElementNS(ns, 'text'); label.setAttribute('x', '0'); label.setAttribute('y', '12');
  label.textContent = `${maximum === 1 && !total ? 0 : maximum}/day`; svg.append(label);
  for (const row of rows) {
    const height = row.amount / maximum * 62;
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String((row.day - 1) * 20 + 2)); rect.setAttribute('y', String(82 - Math.max(2, height)));
    rect.setAttribute('width', '15'); rect.setAttribute('height', String(Math.max(2, height))); rect.setAttribute('rx', '3');
    if (!row.amount) rect.setAttribute('opacity', '.2');
    const tip = document.createElementNS(ns, 'title'); tip.textContent = `Day ${row.day}: ${row.amount} connections`;
    rect.append(tip); svg.append(rect);
  }
  for (const day of [1, 7, 14, 21, 28]) {
    const text = document.createElementNS(ns, 'text'); text.setAttribute('x', String((day - 1) * 20 + 2)); text.setAttribute('y', '101');
    if (day === 28) text.setAttribute('text-anchor', 'end');
    text.textContent = `Day ${day}`; svg.append(text);
  }
  host.append(heading, svg);
}
