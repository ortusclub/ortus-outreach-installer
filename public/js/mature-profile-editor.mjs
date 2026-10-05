import { matureProfileIdentity } from './mature-profile-identity.mjs';
import { WARM_PRESETS, warmPreset, warmRampErrors, warmSchedule } from './mature-warm-ramp.mjs';
import { newMaturePlan, restoreMaturePlan, maturePlanErrors, updateMatureStageEnd, MATURE_WARM_POOLS } from './mature-profile-plan.mjs';
let plan = newMaturePlan();
let hydrated = false;
let changed = () => {};
let accountSignature = null;
const fieldLabels = {fromDay:'From day',toDay:'Through day',warmDaily:'Warm connections / day',coldDaily:'Cold connections / day',likesDaily:'Post likes / day'};
function input(label, value, update, type = 'text') {
  const wrap = document.createElement('label'); wrap.className = 'mature-field';
  const text = document.createElement('span'); text.textContent = label;
  const control = document.createElement(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') control.type = type;
  if (type === 'number') { control.min = '0'; control.step = '1'; control.placeholder = 'Set limit'; }
  control.value = value ?? '';
  control.addEventListener('input', () => { update(control.value); changed(); updateSummary(); });
  wrap.append(text, control); return wrap;
}
function connectionSection(title, id) {
  const section = document.createElement('details'); section.className = 'mature-connection-section'; section.id = id; section.open = true;
  const summary = document.createElement('summary'); summary.textContent = title;
  const body = document.createElement('div'); body.className = 'mature-connection-body';
  section.append(summary, body); return {section, body};
}
function selectField(label, id, value, choices, update) {
  const wrap = document.createElement('label'); wrap.className = 'mature-field';
  const text = document.createElement('span'); text.textContent = label;
  const control = document.createElement('select'); control.id = id;
  for (const [key, label] of choices) { const option = document.createElement('option'); option.value = key; option.textContent = label; control.append(option); }
  control.value = value;
  control.addEventListener('change', () => { update(control.value); changed(); updateSummary(); });
  wrap.append(text, control); return wrap;
}
let accessibleProfiles = null;
let profilesRequest = null;
let identityRequest = null;
function fetchMatureIdentities() {
  if (!identityRequest) identityRequest = fetch('/api/soo-status', {signal:AbortSignal.timeout(30000)})
    .then(async response=>{const data=await response.json();if(!response.ok || !Array.isArray(data.accounts)) throw new Error('SoO unavailable');return data.accounts;})
    .catch(error=>{identityRequest=null;throw error;});
  return identityRequest;
}
async function fetchMatureProfiles() {
  if (accessibleProfiles) return accessibleProfiles;
  if (!profilesRequest) profilesRequest = (async () => {
    const response = await fetch('/api/profiles', { signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data)) throw new Error(data.error || 'Could not load GoLogin profiles.');
    accessibleProfiles = data.filter(p => p.available !== false).sort((a,b) => String(a.name || '').localeCompare(String(b.name || '')));
    return accessibleProfiles;
  })().finally(() => { profilesRequest = null; });
  return profilesRequest;
}
function profileSection() {
  const {section, body} = connectionSection('Profile to warm', 'mature-profile-section');
  const help = document.createElement('p'); help.className = 'mature-source-help';
  help.textContent = 'Choose one GoLogin profile to mature, then enter the name shown on its LinkedIn profile and its LinkedIn URL.';
  const search = input('Search accessible GoLogin profiles', '', () => populate());
  const browser = document.createElement('div'); browser.className = 'browse-card';
  const toolbar = document.createElement('div'); toolbar.className = 'browse-toolbar';
  const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'btn'; clear.textContent = 'Clear selection';
  toolbar.append(clear);
  const picker = document.createElement('div'); picker.id = 'mature-profile-picker'; picker.className = 'profile-grid';
  browser.append(toolbar, picker);
  const status = document.createElement('p'); status.className = 'mature-source-help'; status.textContent = 'Loading GoLogin profiles…'; status.setAttribute('role','status');
  const rows = document.createElement('div'); rows.id = 'mature-selected-profiles';
  let profiles = [];
  function matchingProfiles() {
    const query = search.querySelector('input').value.trim().toLowerCase();
    return profiles.filter(p => `${p.name} ${p.id} ${p.accountLabel || ''}`.toLowerCase().includes(query));
  }
  function choose(profile, selected) {
    if (selected) {
      plan.targetProfileIds = [profile.id];
      plan.accounts[profile.id] = { ...plan.accounts[profile.id], profileLabel: profile.name || profile.id };
    } else plan.targetProfileIds = plan.targetProfileIds.filter(id => id !== profile.id);
  }
  function populate() {
    picker.replaceChildren();
    const matching = matchingProfiles();
    status.textContent = `${matching.length} of ${profiles.length} profiles shown · ${plan.targetProfileIds.length} selected`;
    clear.disabled = !plan.targetProfileIds.length;
    for (const p of matching) {
      const selected = plan.targetProfileIds.includes(p.id);
      const card = document.createElement('label'); card.className = 'profile-item jt' + (selected ? ' selected' : '');
      const detail = document.createElement('div'); detail.className = 'jt-det';
      const top = document.createElement('div'); top.className = 'jt-top';
      const checkbox = document.createElement('input'); checkbox.type = 'radio'; checkbox.name = 'mature-target-profile'; checkbox.value = p.id; checkbox.checked = selected;
      checkbox.setAttribute('aria-label', p.name || p.id);
      const name = document.createElement('span'); name.className = 'jt-email'; name.textContent = p.name || p.id;
      const sub = document.createElement('div'); sub.className = 'jt-sub'; sub.textContent = p.accountLabel || 'GoLogin profile';
      checkbox.onchange = () => { choose(p, checkbox.checked); changed(); populate(); renderRows(); };
      top.append(checkbox, name); detail.append(top, sub); card.append(detail); picker.append(card);
    }
    if (!matching.length) { const empty = document.createElement('p'); empty.textContent = profiles.length ? 'No profiles match your search.' : 'No accessible profiles found.'; picker.append(empty); }
  }
  clear.onclick = () => { plan.targetProfileIds = []; changed(); populate(); renderRows(); };
  function renderRows() {
    rows.replaceChildren();
    for (const id of plan.targetProfileIds) {
      const profile = profiles.find(p => p.id === id);
      const details = plan.accounts[id] || (plan.accounts[id] = {});
      const card = document.createElement('div'); card.className = 'mature-stage'; card.dataset.profileId = id;
      const title = document.createElement('h3'); title.textContent = profile?.name || details.profileLabel || id;
      const grid = document.createElement('div'); grid.className = 'mature-cold-row';
      const nameField = input('Name as it appears on LinkedIn', details.name || '', v => details.name = v); nameField.querySelector('input').autocomplete = 'off'; nameField.querySelector('input').placeholder = 'e.g. Sam Adcock';
      const urlField = input('LinkedIn URL', details.linkedinUrl || '', v => details.linkedinUrl = v, 'url'); urlField.querySelector('input').placeholder = 'https://www.linkedin.com/in/…';
      grid.append(nameField, urlField);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn'; remove.textContent = 'Remove profile';
      remove.onclick = () => { plan.targetProfileIds = plan.targetProfileIds.filter(p => p !== id); changed(); populate(); renderRows(); };
      const identityStatus=document.createElement('p');identityStatus.className='mature-source-help';
      identityStatus.textContent='Checking the SoO LinkedIn account details…';
      card.append(title, grid, identityStatus, remove); rows.append(card);
      fetchMatureIdentities().then(accounts=>{
        if (!card.isConnected || !plan.targetProfileIds.includes(id)) return;
        const identity=matureProfileIdentity(profile || {name:details.profileLabel}, accounts);
        if (!identity) {identityStatus.textContent='No unique SoO match found. Enter the LinkedIn details below.';return;}
        let filled=false;
        for (const [key,field] of [['name',nameField],['linkedinUrl',urlField]]) {
          const control=field.querySelector('input');
          if (!details[key] && !control.value.trim() && identity[key]) {details[key]=identity[key];control.value=identity[key];filled=true;}
        }
        identityStatus.textContent=filled ? 'Prefilled from SoO. You can edit these details.' : 'SoO checked. Your existing details have been kept.';
        if(filled){changed();updateSummary();}
      }).catch(()=>{if(card.isConnected)identityStatus.textContent='SoO is unavailable right now. You can enter the details manually.';});
    }
  }
  body.append(help, search, status, browser, rows);
  renderRows();
  async function load() {
    try {
      profiles = await fetchMatureProfiles(); if (!section.isConnected) return;
      populate(); renderRows();
    } catch (error) {
      if (!section.isConnected) return;
      status.textContent = error.message;
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn'; retry.textContent = 'Retry loading profiles';
      retry.onclick = () => { retry.remove(); status.textContent = 'Loading GoLogin profiles…'; load(); }; status.append(retry);
    }
  }
  // Fetch resolves after the section is attached by the editor render.
  load(); return section;
}
function warmPresetSection() {
  const box = document.createElement('div'); box.className = 'mature-stage'; box.id = 'mature-presets';
  const title = document.createElement('h3'); title.textContent = 'Choose a starting strategy';
  const help = document.createElement('p'); help.className = 'mature-source-help';
  help.textContent = 'These editable presets set the warm-connection ramp. Cold connections and post engagement are configured separately below. Figures are planning amounts, not LinkedIn limits.';
  const buttons = document.createElement('div'); buttons.className = 'mature-preset-grid';
  for (const [key,preset] of Object.entries(WARM_PRESETS)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'mature-preset'; button.setAttribute('aria-pressed', String(plan.warmRamp?.preset === key));
    const label = document.createElement('strong'); label.textContent = preset.label;
    const detail = document.createElement('span'); detail.textContent = `Start ${preset.initialDaily}/day · +${preset.increaseBy} every ${preset.everyDays} days · maximum ${preset.maximumDaily}/day · stop after ${preset.stopAfterDays} days`;
    button.append(label,detail); button.onclick = () => { plan.warmRamp = warmPreset(key); changed(); renderMaturePlan(); }; buttons.append(button);
  }
  box.append(title,help,buttons); return box;
}
function exhaustionControl(sync) {
  const label=document.createElement('label');label.className='mature-source-help';
  const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.id='mature-warm-until-exhausted';checkbox.checked=!!plan.warmUntilExhausted;
  checkbox.onchange=()=>{plan.warmUntilExhausted=checkbox.checked;sync();changed();updateSummary();};
  label.append(checkbox,document.createTextNode(' Run at this rate until all warm connections are exhausted'));
  return label;
}
function setEndDisabled(control, disabled) {
  control.disabled=disabled;
  control.style.opacity=disabled ? '0.45' : '';
  control.style.cursor=disabled ? 'not-allowed' : '';
}
function warmRampEditor() {
  const box = document.createElement('div'); box.id = 'mature-warm-ramp';
  const ramp = plan.warmRamp;
  if (!ramp) {
    const note = document.createElement('p'); note.textContent = 'Choose a preset above to build an editable daily ramp, or edit the stage limits in this section.'; box.append(note); return box;
  }
  const grid = document.createElement('div'); grid.className = 'mature-cold-row';
  const custom = () => { ramp.preset = 'custom'; document.querySelectorAll('.mature-preset').forEach(b=>b.setAttribute('aria-pressed','false')); };
  for (const [key,label] of [['initialDaily','Start with — connections per day'],['increaseBy','Increase by — connections per day'],['everyDays','Increase every — days'],['maximumDaily','Maximum connections per day']]) {
    grid.append(input(label,ramp[key],value=>{ramp[key]=value === '' ? '' : Number(value);custom();preview();},'number'));
  }
  const duration = input('Stop after — days', ramp.stopAfterDays, v=>{ramp.stopAfterDays=v === '' ? '' : Number(v);custom();preview();},'number');
  const stopDate = input('Last day to send warm connections', ramp.stopDate, v=>{ramp.stopDate=v;custom();preview();},'date');
  const summary = document.createElement('p'); summary.className = 'mature-source-help'; summary.id = 'mature-ramp-summary'; summary.setAttribute('role','status');
  const timeline = document.createElement('div'); timeline.className = 'mature-ramp-preview'; timeline.id = 'mature-ramp-preview';
  function preview() {
    duration.hidden = ramp.stopMode !== 'days'; stopDate.hidden = ramp.stopMode !== 'date';
    const effectiveRamp = plan.warmUntilExhausted ? {...ramp,stopMode:"none"} : ramp;
    const errors = warmRampErrors(effectiveRamp); timeline.replaceChildren();
    if (errors.length) { summary.textContent = errors[0]; return; }
    const now = new Date(); const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const schedule = warmSchedule(effectiveRamp,today);
    const friendly = date => new Date(date+'T12:00:00').toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
    summary.textContent = schedule.endDate
      ? `If started today: last warm-connection day ${friendly(schedule.endDate)} (inclusive). ${schedule.rows.length ? '' : 'That date has already passed.'} Stopping warm connections does not stop other campaign activities.`
      : (plan.warmUntilExhausted ? 'After ramping, keep this rate until all eligible warm connections are exhausted. The pool size determines the last day.' : 'No automatic stop date. Warm connections stay at the daily maximum after ramping until you stop them.');
    const heading = document.createElement('p'); heading.textContent = 'Daily plan preview · first 28 days if started today'; timeline.append(heading);
    const list = document.createElement('div'); list.className = 'mature-day-grid';
    for(const row of schedule.rows) { const item=document.createElement('div'); item.className='mature-day'; const day=document.createElement('span'); day.textContent=`Day ${row.day}`; const amount=document.createElement('strong'); amount.textContent=row.amount; item.title=friendly(row.date);item.append(day,amount);list.append(item); }
    timeline.append(list);
  }
  const stop = selectField('When should warm connections stop?', 'mature-warm-stop', ramp.stopMode,
    [['days','After a number of days'],['date','On a specific date'],['none','No automatic stop']],v=>{ramp.stopMode=v;custom();preview();});
  grid.append(stop,duration,stopDate);
  const sync=()=>{[stop.querySelector('select'),duration.querySelector('input'),stopDate.querySelector('input')].forEach(control=>setEndDisabled(control,!!plan.warmUntilExhausted));preview();};
  box.append(grid,exhaustionControl(sync),summary,timeline);sync();return box;
}
function updateSummary() {
  const el = document.getElementById('mature-plan-summary');
  if (!el) return;
  const errors = maturePlanErrors(plan);
  el.textContent = errors.length ? `Draft plan · ${errors[0]}` : 'Plan configured · automatic execution is not enabled yet.';
}
export function readMaturePlan() { return hydrated ? structuredClone(plan) : null; }
export function loadMaturePlan(value) { plan = restoreMaturePlan(value); hydrated = true; accountSignature = null; renderMaturePlan(); }
export function renderMaturePlan({onChange, accounts} = {}) {
  if (onChange) changed = onChange;
  const host = document.getElementById('mature-plan-editor');
  if (!host) return;
  host.replaceChildren();
  const sources = document.createElement('div'); sources.className = 'mature-sources';
  const warm = connectionSection('Warm Connections', 'mature-warm-section');
  const cold = connectionSection('Cold Connections', 'mature-cold-section');
  const posts = connectionSection('Post Engagement — Coming soon', 'mature-post-section');
  sources.append(profileSection(), warmPresetSection(), warm.section, cold.section, posts.section);
  const warmLabel = document.createElement('label'); warmLabel.className = 'mature-field';
  const warmText = document.createElement('span'); warmText.textContent = 'Warm pool';
  const warmSelect = document.createElement('select'); warmSelect.id = 'mature-warm-pool';
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Select account ownership'; placeholder.disabled = true;
  warmSelect.append(placeholder);
  for (const [value, label] of Object.entries(MATURE_WARM_POOLS)) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; warmSelect.append(option);
  }
  warmSelect.value = Object.hasOwn(MATURE_WARM_POOLS, plan.warmPool) ? plan.warmPool : '';
  warmSelect.addEventListener('change', () => { plan.warmPool = warmSelect.value; changed(); updateSummary(); });
  warmLabel.append(warmText, warmSelect); warm.body.append(warmLabel);
  const warmHelp = document.createElement('p'); warmHelp.className = 'mature-source-help';
  warmHelp.textContent = 'Warm connections: managed profiles in the selected ownership group. The planned workflow sends an invitation and automatically accepts it from the receiving profile.'; warm.body.append(warmHelp, warmRampEditor());
  const coldRow = document.createElement('div'); coldRow.className = 'mature-cold-row';
  const customSheet = input('Your Google Sheet — paste the link to the tab to use', plan.coldPool, v => plan.coldPool = v, 'url');
  customSheet.id = 'mature-custom-cold-sheet';
  const defaultHelp = document.createElement('p'); defaultHelp.id = 'mature-default-cold-help';
  defaultHelp.textContent = 'Default cold-connection sheet: awaiting setup.';
  const syncColdSource = () => { customSheet.hidden = plan.coldPoolSource !== 'custom'; defaultHelp.hidden = plan.coldPoolSource !== 'default'; };
  coldRow.append(selectField('Cold connection pool', 'mature-cold-source', plan.coldPoolSource,
    [['default', 'Default Google Sheet'], ['custom', 'Add your own Google Sheet']], v => { plan.coldPoolSource = v; syncColdSource(); }));
  coldRow.append(selectField('Connection order', 'mature-cold-order', plan.coldPoolOrder,
    [['random', 'Randomise profiles'], ['descending', 'Descending row order (top to bottom)']], v => plan.coldPoolOrder = v));
  cold.body.append(coldRow, customSheet, defaultHelp); syncColdSource();
  const coldHelp = document.createElement('p'); coldHelp.className = 'mature-source-help';
  coldHelp.textContent = 'Cold connections: people outside the managed profile network. Acceptance is up to the recipient; managed profiles must be excluded from this pool.'; cold.body.append(coldHelp);
  const postNotice = document.createElement('p'); postNotice.className = 'mature-source-help';
  postNotice.textContent = 'Coming soon — post engagement is not available yet.';
  posts.body.append(postNotice);
  host.append(sources);
  function stageSettings(stage, fields, destination) {
    const card=document.createElement('div'); card.className='mature-stage';
    const heading=document.createElement('h3'); heading.textContent=stage.name; card.append(heading);
    const grid=document.createElement('div'); grid.className='mature-stage-fields';
    for (const key of ['fromDay','toDay',...fields]) {
      const field = input(fieldLabels[key],stage[key],v=>{
        if (key === 'toDay') {
          updateMatureStageEnd(plan, plan.stages.indexOf(stage), v);
          // A stage can appear in multiple activity sections; update every copy
          // without rebuilding the form or interrupting keyboard focus.
          host.querySelectorAll('[data-stage-index][data-stage-field]').forEach(control=>{
            control.value = plan.stages[Number(control.dataset.stageIndex)][control.dataset.stageField];
          });
        } else stage[key] = v === '' ? '' : Number(v);
      },'number');
      const control = field.querySelector('input');
      control.dataset.stageIndex = plan.stages.indexOf(stage);
      control.dataset.stageField = key;
      grid.append(field);
    }
    card.append(grid); destination.append(card);
  }
  // Independent activity schedules: editing warm days cannot move cold days.
  if (!plan.connectionStages) {
    plan.connectionStages = {
      warm: plan.stages.map((s,i)=>({fromDay:s.fromDay,toDay:s.toDay,daily:s.warmDaily})),
      cold: plan.stages.filter(s=>['cold','engage'].includes(s.id) || Number(s.coldDaily)>0)
        .map(s=>({fromDay:s.fromDay,toDay:s.toDay,daily:s.coldDaily})),
    };
  }
  function activityStages(kind, destination) {
    const list = document.createElement('div');
    const label = kind === 'warm' ? 'Warm' : 'Cold';
    function paint() {
      list.replaceChildren();
      plan.connectionStages[kind].forEach((stage,index)=>{
        const card=document.createElement('div');card.className='mature-stage';
        const title=document.createElement('h3');title.textContent=`${label} connections · stage ${index+1}`;
        const grid=document.createElement('div');grid.className='mature-cold-row';
        for(const [key,text] of [['fromDay','From day'],['toDay','Through day'],['daily',`${label} connections / day`]]) {
          const field=input(text,stage[key],value=>{
            stage[key]=value === '' ? '' : Number(value);
            if(key==='toDay') {
              const stages=plan.connectionStages[kind];
              updateMatureStageEnd({stages},index,value);
              list.querySelectorAll('[data-activity-index]').forEach(control=>{
                control.value=stages[Number(control.dataset.activityIndex)][control.dataset.activityField];
              });
            }
          },'number');
          const control=field.querySelector('input');control.dataset.activityIndex=index;control.dataset.activityField=key;
          grid.append(field);
        }
        card.append(title,grid);
        if (kind==='warm' && index===plan.connectionStages.warm.length-1) {
          const end=grid.querySelector('[data-activity-field="toDay"]');
          const sync=()=>setEndDisabled(end,!!plan.warmUntilExhausted);
          card.append(exhaustionControl(sync));sync();
        }
        list.append(card);
      });
    }
    const add=document.createElement('button');add.type='button';add.className='btn';add.textContent=`Add ${kind} stage`;
    add.onclick=()=>{
      const stages=plan.connectionStages[kind],last=stages.at(-1);
      const from=Number(last?.toDay || 0)+1;
      stages.push({fromDay:from,toDay:from+6,daily:last?.daily ?? 0});
      paint();changed();updateSummary();
    };
    paint();destination.append(list,add);
  }
  if (!plan.warmRamp) activityStages('warm',warm.body);
  activityStages('cold',cold.body);
  host.append(input('Plan notes',plan.notes,v=>plan.notes=v,'textarea'));
  updateSummary();
  if (accounts) renderMatureAccounts(accounts);
}
export function renderMatureAccounts(accounts) {
  const host=document.getElementById('mature-plan-accounts');if(!host)return;
  const signature = JSON.stringify(accounts);
  if (accountSignature === signature) return;
  accountSignature = signature;
  host.replaceChildren();
  if(!accounts.length){host.textContent='Select the accounts below. Each account has its own planned start date.';return;}
  for(const account of accounts){
    const row=document.createElement('div');row.className='mature-account';
    const name=document.createElement('strong');name.textContent=account.name;row.append(name);
    row.append(input('Planned start date',plan.accounts[account.id]?.startDate || '',v=>{plan.accounts[account.id]={...plan.accounts[account.id],startDate:v};},'date'));
    host.append(row);
  }
}
