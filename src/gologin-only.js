export const GOLOGIN_REQUIRED = 'Local Browser is no longer supported. Select a GoLogin profile and save the campaign again.';
const profileKeys = new Set(['profileId', 'profileIds', 'senderProfileIds', 'primarySource', 'sender', 'knownSourceId', 'paired']);
export function hasLocalBrowserSelection(value, key = '') {
  if (Array.isArray(value)) return value.some(item => hasLocalBrowserSelection(item, key));
  if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => hasLocalBrowserSelection(v, k));
  return profileKeys.has(key) && ['local-browser', 'Local Browser', 'local-browser - manual'].includes(value);
}
export function assertGoLoginOnly(config) {
  if (hasLocalBrowserSelection(config)) throw new Error(GOLOGIN_REQUIRED);
}
