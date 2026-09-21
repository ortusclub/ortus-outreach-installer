// A verified account credit limit can explain earlier pre-send failures from
// that same account. These patterns are deliberately narrow: any result that
// might have clicked Send stays held for human outcome verification.
export const CREDIT_RETRY_STAGE = 'Retry queued';

export function creditChannelForMode(mode) {
  if (['connect_only', 'connect_and_introduce', 'connect_and_message'].includes(mode)) return 'cc';
  if (['open_profile_only', 'inmail_only'].includes(mode)) return 'inmail';
  return '';
}

export function isPreSendCreditRetryable(mode, reason) {
  const text = String(reason || '').toLowerCase();
  if (/send.not.confirmed|voyager.rejected|error.toast|send.failed|sent|pending|already|not.open.profile|not.yet.connected|profile.not.found|\b404\b|email.required/.test(text)) return false;
  const channel = creditChannelForMode(mode);
  if (channel === 'cc') return /connect.button.not.found|no.modal.appeared/.test(text);
  if (channel === 'inmail') return /message.button.not.found|no.compose.textbox|compose.textbox.did.not.appear/.test(text);
  return false;
}
