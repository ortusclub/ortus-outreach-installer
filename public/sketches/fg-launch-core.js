// Shared core for the three Follower-Growth "team launch" sketches.
// Replaces the old queue: select Ortus employees → their connections come from
// the Team Connections DB → each employee auto-pairs to a GoLogin profile by
// EMAIL (team convention: GoLogin profile name IS the SoO/operator email) →
// where it can't auto-pair, a manual GoLogin picker → one sequential batch.
//
// REAL fields only:
//   employee: name · email · connInDb (count already ingested into the DB)
//   gologin profile: name(=email) · creditsTotal · creditsUsed
// No invented stats (no match %, no follower projections).
window.FGL = {
  month: '2026-06',

  // Ortus employees whose connections are in the Team Connections DB.
  employees: [
    { id: 'e1', name: 'Antonio Varlese', email: 'antonio@ortusclub.com',  connInDb: 2840 },
    { id: 'e2', name: 'Alecx Manalo',    email: 'alecx@ortusclub.com',    connInDb: 1190 },
    { id: 'e3', name: 'Sam Adcock',      email: 'sam@ortusclub.com',      connInDb: 3610 },
    { id: 'e4', name: 'Nikki Reyes',     email: 'nikki@ortusclub.com',    connInDb: 980  },
    { id: 'e5', name: 'Milena Costa',    email: 'milena@ortusclub.com',   connInDb: 1530 },
    { id: 'e6', name: 'Beatrice Talusan',email: 'bea.talusan@ortusclub.com', connInDb: 760 },
  ],

  // GoLogin profiles available in this workspace. name === login email.
  // Some line up with an employee email (auto-pair); Milena's has none.
  profiles: [
    { name: 'antonio@ortusclub.com',    creditsTotal: 30, creditsUsed: 4 },
    { name: 'alecx@ortusclub.com',      creditsTotal: 30, creditsUsed: 0 },
    { name: 'sam@ortusclub.com',        creditsTotal: 30, creditsUsed: 12 },
    { name: 'nikki@ortusclub.com',      creditsTotal: 30, creditsUsed: 30 }, // no credits left
    { name: 'bea.talusan@ortusclub.com',creditsTotal: 30, creditsUsed: 4 },
    { name: 'ortus.spare1@ortusclub.com',creditsTotal: 30, creditsUsed: 0 },
    { name: 'ortus.spare2@ortusclub.com',creditsTotal: 30, creditsUsed: 6 },
  ],

  esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); },
  creditsLeft(p) { return p ? p.creditsTotal - p.creditsUsed : 0; },

  // Auto-pair an employee to a profile by exact email. Returns profile or null.
  autoPair(emp) { return this.profiles.find((p) => p.name.toLowerCase() === emp.email.toLowerCase()) || null; },

  // Drive the sequential launch as a visible one-after-another sequence.
  // rows: [{empId, ...}]. onStep(empId, status). One row with 0 credits is skipped.
  simulateLaunch(rows, getCredits, onStep, onDone) {
    let i = 0;
    const tick = () => {
      if (i >= rows.length) { onDone && onDone(); return; }
      const r = rows[i];
      if (getCredits(r) <= 0) { onStep(r.empId, 'skipped'); i += 1; setTimeout(tick, 260); return; }
      onStep(r.empId, 'running');
      setTimeout(() => { onStep(r.empId, 'done'); i += 1; setTimeout(tick, 320); }, 900);
    };
    rows.forEach((r) => onStep(r.empId, 'waiting'));
    setTimeout(tick, 400);
  },
};
