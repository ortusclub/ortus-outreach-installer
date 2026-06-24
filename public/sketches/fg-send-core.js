// Shared core for the three Follower-Growth "select → open profiles → send" sketches.
// REAL field set only (mirrors fgRow in src/connections/fg-export.js):
//   Target Name · LinkedIn URL · Company · Job Title · Function Match · Geo.
// No invented stats (no match %, mutuals, follower counts) — those don't exist
// in the source. Sample people are illustrative; the shape is 1:1 with the app.
window.FG_SAMPLE = {
  operator: 'Beatrice Talusan',
  operatorEmail: 'bea.talusan@ortusclub.com',
  month: '2026-06',
  creditsTotal: 30,
  creditsUsed: 4, // already used this month → 26 left, shown live in the real modal
  candidates: [
    { id: 'c1',  name: 'Marta Rossi',      title: 'Head of Brand Marketing',    company: 'Lavazza',          fn: 'marketing', geo: 'Milan, Italy' },
    { id: 'c2',  name: 'Tom Becker',       title: 'Growth Marketing Lead',       company: 'Delivery Hero',    fn: 'growth',    geo: 'Berlin, Germany' },
    { id: 'c3',  name: 'Sophie Laurent',   title: 'Content Director',            company: "L'Oréal",          fn: 'content',   geo: 'Paris, France' },
    { id: 'c4',  name: "James O'Brien",    title: 'Chief Marketing Officer',     company: 'Glofox',           fn: 'cmo',       geo: 'Dublin, Ireland' },
    { id: 'c5',  name: 'Elena Costa',      title: 'Demand Generation Manager',   company: 'Pirelli',          fn: 'demand',    geo: 'Milan, Italy' },
    { id: 'c6',  name: 'Liam Walsh',       title: 'Brand Strategist',            company: 'Diageo',           fn: 'brand',     geo: 'London, UK' },
    { id: 'c7',  name: 'Anna Novak',       title: 'Head of Communications',      company: 'Škoda',            fn: 'comms',     geo: 'Prague, Czechia' },
    { id: 'c8',  name: 'Pedro Alves',      title: 'Performance Marketing Manager', company: 'Farfetch',       fn: 'marketing', geo: 'Lisbon, Portugal' },
    { id: 'c9',  name: 'Greta Lindqvist',  title: 'Content Marketing Lead',      company: 'Spotify',          fn: 'content',   geo: 'Stockholm, Sweden' },
    { id: 'c10', name: 'Marco Bianchi',    title: 'VP Growth',                   company: 'Satispay',         fn: 'growth',    geo: 'Milan, Italy' },
    { id: 'c11', name: 'Hannah Müller',    title: 'Senior Brand Manager',        company: 'Adidas',           fn: 'brand',     geo: 'Munich, Germany' },
    { id: 'c12', name: 'Yusuf Demir',      title: 'Digital Marketing Director',  company: 'Turkish Airlines', fn: 'marketing', geo: 'Istanbul, Turkey' },
  ],
};

window.FGX = {
  esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  creditsLeft() { return FG_SAMPLE.creditsTotal - FG_SAMPLE.creditsUsed; },

  // Drive the "opens profiles and sends" phase as a visible sequence.
  // selected: [{id,name,...}]. onStep(id, status) fires per transition.
  // One name is treated as ambiguous → 'skipped' to mirror real skip-on-doubt.
  simulateSend(selected, onStep, onDone) {
    const skipIdx = selected.length > 3 ? 2 : -1; // demo a skip when sending ≥4
    let i = 0;
    const tick = () => {
      if (i >= selected.length) { onDone && onDone(); return; }
      const p = selected[i];
      onStep(p.id, 'opening');
      setTimeout(() => {
        onStep(p.id, i === skipIdx ? 'skipped' : 'invited');
        i += 1;
        setTimeout(tick, 240);
      }, 620);
    };
    selected.forEach((p) => onStep(p.id, 'queued'));
    setTimeout(tick, 400);
  },
};
