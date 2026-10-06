// A legacy run's input sheet must never become the shared results-workbook link.
export const MATURE_RESULTS_WORKBOOK_ID = '1aZFtGnJcAs4dZ4Pvw5ju5dFwkX29zP_h3s1R8K-XXfo';
export function matureResultsLink(candidate = '') {
  const root = `https://docs.google.com/spreadsheets/d/${MATURE_RESULTS_WORKBOOK_ID}/edit`;
  try {
    const url = new URL(candidate);
    if (url.origin === 'https://docs.google.com' && url.pathname.split('/')[3] === MATURE_RESULTS_WORKBOOK_ID) {
      const gid = url.searchParams.get('gid') || new URLSearchParams(url.hash.slice(1)).get('gid');
      return { url: root + (gid && /^\d+$/.test(gid) ? `#gid=${gid}` : ''), legacy: false };
    }
  } catch { /* no account tab known yet */ }
  return { url: root, legacy: !!candidate };
}
