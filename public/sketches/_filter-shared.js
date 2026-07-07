// Shared sample data + strip rendering for the filter alternatives.
window.CAMPAIGNS = [
  { name:'APAC Founders', type:'CC',      typeLabel:'Connect Only',        bucket:'running', where:'cloud', flow:'65 leads → 2 accounts', owner:'You' },
  { name:'Nordics',       type:'CC+DM',   typeLabel:'Connect + DM',        bucket:'running', where:'local', flow:'48 leads → 1 account',  owner:'You' },
  { name:'EMEA Buyers',   type:'CC',      typeLabel:'Connect Only',        bucket:'running', where:'cloud', flow:'80 leads → 1 account',  owner:'You' },
  { name:'Benelux Ops',   type:'CC+IC',   typeLabel:'Connect + Introduce', bucket:'queued',  where:'cloud', flow:'52 leads → 1 account',  owner:'You' },
  { name:'DACH Ops',      type:'Message', typeLabel:'Direct Messages',     bucket:'queued',  where:'cloud', flow:'48 leads → 1 account',  owner:'You' },
  { name:'London PE',     type:'CC',      typeLabel:'Connect Only',        bucket:'done',    where:'local', flow:'40 leads → 1 account',  owner:'You' },
  { name:'Growth Push',   type:'FG',      typeLabel:'Follower Growth',     bucket:'done',    where:'local', flow:'120 invites → 1 page',  owner:'You' },
];
window.TYPES = ['CC','CC+IC','CC+DM','Message','FG'];
window.typeCount = (t) => t==='All' ? CAMPAIGNS.length : CAMPAIGNS.filter(c=>c.type===t).length;

window.stripHtml = (c) => {
  const running = c.bucket==='running', queued = c.bucket==='queued';
  const railCls = c.where==='local' && running ? 'local run' : running ? 'run' : queued ? 'queued' : 'done';
  const where = c.where==='cloud' ? '<span class="sn-where cloud">☁︎ VM</span>' : '<span class="sn-where local">💻 This machine</span>';
  const dot = running ? (c.where==='local'?'<span class="dot runlocal"></span>':'<span class="dot run"></span>') : queued ? '<span class="dot q"></span>' : '<span class="dot mon"></span>';
  const status = running ? 'Running' : queued ? 'Queued' : 'Done';
  const foot = running
    ? (c.where==='local' ? '<button class="mini">Pause</button><button class="mini">Stop</button><button class="mini solid">Open</button>' : '<button class="mini">Stop</button><button class="mini solid">Open</button>')
    : queued ? '<button class="mini">Cancel</button><button class="mini solid">Open</button>' : '<button class="mini">✕</button><button class="mini solid">Open</button>';
  return `<div class="sn-strip ${railCls}" data-type="${c.type}" data-bucket="${c.bucket}">
    <div class="sn-top"><span class="sn-type">Campaign · ${c.type}</span><span class="sn-you">${c.owner}</span>${where}<span class="sn-status">${dot} ${status}</span></div>
    <div class="sn-name">${c.name} — ${c.type}</div>
    <div class="sn-flow"><b>${c.flow}</b> · ${c.typeLabel}</div>
    <div class="sn-foot"><div class="right">${foot}</div></div></div>`;
};

// Render the board filtered to `type` ('All' or a type). Fills #board.
window.renderBoard = (type) => {
  const board = document.getElementById('board');
  const rows = CAMPAIGNS.filter(c => type==='All' || c.type===type);
  const rail = (label, bucket, extra='') => {
    const list = rows.filter(c=>c.bucket===bucket);
    return list.length ? `<div class="sn-railhead">${label}${extra}</div>` + list.map(stripHtml).join('') : '';
  };
  const html = rail('▶ Now running','running') + rail('• Up next','queued')
    + rail('✓ Done','done', ` <span class="sn-railcount">${rows.filter(c=>c.bucket==='done').length}</span>`);
  board.innerHTML = html || `<div class="sn-empty" style="padding:26px;color:var(--gray);font-size:12px">No ${type} campaigns.</div>`;
  const qm = document.getElementById('qmeta');
  if (qm) qm.textContent = `${rows.filter(c=>c.bucket==='running').length} running · ${rows.filter(c=>c.bucket==='queued').length} queued`;
};
