// Real sample data for the FG Team-Launch overhaul sketches.
// Numbers are pulled live from the Connections DB (matched = connections whose
// job title matches the role keywords; total = all non-DNC connections in DB).
// Budget: everyone defaults to 30/month; antonio is exhausted (real sheet row).
window.FG_ROLES = ['marketing', 'brand', 'growth', 'content', 'demand', 'comms', 'cmo'];

// email, total connections in DB, matched (for current roles), auto-paired GoLogin profile (or null = needs pick)
window.FG_PEOPLE = [
  { email: 'sja@ortusclub.com',               total: 24258, matched: 3182, paired: 'sja@ortusclub.com',               budget: 30 },
  { email: 'dannah@ortusclub.com',            total: 7454,  matched: 1919, paired: null,                              budget: 30 },
  { email: 'neil@ortus.solutions',            total: 10337, matched: 1327, paired: 'neil@ortus.solutions',            budget: 30 },
  { email: 'mara@ortus.solutions',            total: 11372, matched: 844,  paired: 'mara@ortus.solutions',            budget: 30 },
  { email: 'alecx@ortus.solutions',           total: 7378,  matched: 822,  paired: 'alecx@ortus.solutions',           budget: 30 },
  { email: 'frances@ortus.solutions',         total: 8330,  matched: 745,  paired: null,                              budget: 30 },
  { email: 'anya@ortus.solutions',            total: 8654,  matched: 650,  paired: 'anya@ortus.solutions',            budget: 30 },
  { email: 'miguel@ortus.solutions',          total: 6198,  matched: 590,  paired: 'miguel@ortus.solutions',          budget: 30 },
  { email: 'Driton@oruts.solutions',          total: 7903,  matched: 358,  paired: null,                              budget: 30 },
  { email: 'antonio@ortusclub.com',           total: 1071,  matched: 91,   paired: 'antonio@ortusclub.com',           budget: 0  },
  { email: 'milee.mel@ortus.solutions',       total: 682,   matched: 72,   paired: 'milee.mel@ortus.solutions',       budget: 30 },
  { email: 'leon.p@ortus.solutions',          total: 708,   matched: 53,   paired: null,                              budget: 30 },
  { email: 'iliya@ortus.solutions',           total: 680,   matched: 50,   paired: 'iliya@ortus.solutions',           budget: 30 },
  { email: 'aulia.aprilianti@ortus.solutions',total: 701,   matched: 33,   paired: 'aulia.aprilianti@ortus.solutions',budget: 30 },
  { email: 'lhuz.d@ortus.solutions',          total: 59,    matched: 14,   paired: 'lhuz.d@ortus.solutions',          budget: 30 },
  { email: 'meizi.a@ortus.solutions',         total: 59,    matched: 3,    paired: null,                              budget: 30 },
  { email: 'aaron.bagatsolon@ortus.solutions',total: 58,    matched: 1,    paired: 'aaron.bagatsolon@ortus.solutions',budget: 30 },
  { email: 'joseph.tri@ortus.solutions',      total: 59,    matched: 0,    paired: 'joseph.tri@ortus.solutions',      budget: 30 },
];

// A few real GoLogin profile names for the manual picker.
window.FG_PROFILES = [
  'Local Browser', 'zoominfo_ii', 'chatgpt/claude', 'jenrie.alvarez@ortus.solutions',
  'farhan.ramadhan@klabber.co', 'rahadian.nugraha@klabber.co', 'andrrim.krenzi@ortusclub.com',
  'baste.prospero@ortus.solutions', 'gabrielle.deleon@gmail.com', 'profile 199',
];

// Effective invites a picked person can send = min(matched, budget).
window.fgInvitesLeft = (p) => Math.max(0, Math.min(p.matched, p.budget));
