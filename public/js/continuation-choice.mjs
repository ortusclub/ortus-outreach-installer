import { continuationPolicy } from './continuation-policy.mjs';

export function continuationChoices(status, { monitoringAvailable = false, checkAvailable = true } = {}) {
  const policy = continuationPolicy(status.mode);
  const monitoring = status.state === 'monitoring' || status.status === 'monitoring';
  const active = monitoring && (status.autoChecksEnabled ?? status.auto_checks_enabled) !== false;
  const tabWide = (status.monitoringScope || status.monitoring_scope || status.config?.monitoringScope) === 'tab';
  return [
    { value: 'sending', label: 'Continue remaining sending', detail: policy.remainingDetail, disabled: policy.retired },
    ...(policy.acceptance ? [
      { value: 'check', label: tabWide ? 'Run one tab-wide check now' : 'Run one check now', disabled: !checkAvailable,
        detail: `${tabWide ? 'Checks all matching senders in the current sheet tab.' : 'Checks this campaign’s configured accounts.'} Sending stays stopped and the automatic-check setting stays unchanged. Configured introductions/messages/follow-ups may send.` },
      { value: 'monitoring', label: active ? 'Automatic monitoring is already active' : 'Resume automatic monitoring',
        disabled: active || !monitoringAvailable,
        detail: active ? 'The existing schedule stays active. No need to resume it.' : monitoringAvailable
          ? policy.monitoringDetail
          : 'Unavailable: the original monitoring window and campaign ownership must be established first. This does not restart sending.' },
    ] : []),
  ];
}

export function chooseContinuation(status, capabilities) {
  const dialog = document.createElement('dialog'); dialog.className = 'launch-review continuation-choice';
  dialog.setAttribute('aria-labelledby', 'continuation-choice-title');
  const title = document.createElement('h2'); title.textContent = 'Continue campaign';
  title.id = 'continuation-choice-title';
  const name = document.createElement('p'); name.textContent = status.name || 'Selected campaign';
  name.className = 'continuation-choice-name';
  const form = document.createElement('form'); form.method = 'dialog';
  dialog.append(title, name, form);
  for (const choice of continuationChoices(status, capabilities)) {
    const section = document.createElement('section');
    const button = document.createElement('button'); button.type = 'submit'; button.value = choice.value;
    button.textContent = choice.label; button.disabled = !!choice.disabled;
    const detail = document.createElement('p'); detail.textContent = choice.detail;
    detail.id = `continuation-choice-${choice.value}-detail`;
    button.setAttribute('aria-describedby', detail.id);
    section.append(button, detail); form.append(section);
  }
  const footer = document.createElement('footer');
  const cancel = document.createElement('button'); cancel.type = 'submit'; cancel.value = 'cancel'; cancel.textContent = 'Cancel'; cancel.autofocus = true; footer.append(cancel); form.append(footer);
  document.body.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener('close', () => { const result = dialog.returnValue; dialog.remove(); resolve(['sending', 'check', 'monitoring'].includes(result) ? result : null); }, { once: true });
    dialog.showModal();
  });
}
