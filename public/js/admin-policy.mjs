// Shared default for the server and legacy Sales Navigator controls.
export const ADMIN_EMAILS = new Set([
  'sam@ortusclub.com', 'mickey@ortusclub.com', 'stevenj@ortusclub.com',
  'ej@ortusclub.com', 'info@linkedvelocity.com',
  'mara@ortusclub.com', 'anya@ortusclub.com', 'ina@ortusclub.com',
  'jerimiah@ortusclub.com', 'andrrim.krenzi@ortusclub.com',
  'info@apexstrategy.io',
]);
export const isAdminEmail = email => ADMIN_EMAILS.has(String(email || '').trim().toLowerCase());
