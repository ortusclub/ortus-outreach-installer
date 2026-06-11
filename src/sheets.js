/**
 * Fetches rows from a publicly shared Google Sheet by converting it to CSV.
 * The sheet must be set to "Anyone with the link can view".
 */

import { extractSheetId, extractSheetGid } from './utils.js';

/**
 * Parses a CSV string into an array of objects using the first row as headers.
 * Handles quoted fields with commas and newlines.
 * @param {string} csv
 * @returns {Record<string, string>[]}
 */
function parseCSV(csv) {
  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      // parseCSV only splits lines; preserve quote characters verbatim so
      // splitCSVLine can use them to delimit fields. Without this, a field
      // like "url,with,commas" lost its quotes here and splitCSVLine then
      // treated every comma as a field separator.
      if (inQuotes && csv[i + 1] === '"') {
        current += '""'; // preserve the escaped-quote pair
        i++;
      } else {
        inQuotes = !inQuotes;
        current += ch;
      }
    } else if (ch === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if (ch === '\r' && !inQuotes) {
      // skip \r
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current);

  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCSVLine(lines[i]);
    if (values.every(v => !v.trim())) continue; // skip empty rows

    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = (values[j] || '').trim();
    }
    rows.push(row);
  }

  return rows;
}

function splitCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Like parseCSV, but tags each non-empty data row with the 1-based sheet row
 * number the operator sees in Google Sheets (header = row 1, first data row =
 * row 2). Blank sheet rows are skipped but still advance the counter, so the
 * numbers stay aligned with the actual spreadsheet — this is what lets the UI
 * offer a "scrape rows 2–10" picker that matches what's on screen.
 * @param {string} csv
 * @returns {{ rowNumber: number, row: Record<string, string> }[]}
 */
function parseCSVWithRowNumbers(csv) {
  // Reuse parseCSV's line splitter via a throwaway: re-run the same char loop
  // here so the two stay byte-identical. (parseCSV builds `lines` then objects;
  // we need the line index, so we redo the split but keep position.)
  const lines = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      if (inQuotes && csv[i + 1] === '"') { current += '""'; i++; }
      else { inQuotes = !inQuotes; current += ch; }
    } else if (ch === '\n' && !inQuotes) { lines.push(current); current = ''; }
    else if (ch === '\r' && !inQuotes) { /* skip */ }
    else { current += ch; }
  }
  if (current.trim()) lines.push(current);

  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitCSVLine(lines[i]);
    if (values.every((v) => !v.trim())) continue; // skip blank rows (counter still advances)
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = (values[j] || '').trim();
    }
    out.push({ rowNumber: i + 1, row }); // line index i → sheet row i+1 (header is line 0 / row 1)
  }
  return out;
}

/**
 * Fetches the raw CSV text for a public Google Sheet (URL build + timeout +
 * one retry). Shared by fetchSheet and fetchSheetWithRows.
 * @param {string} sheetUrl
 * @returns {Promise<string>}
 */
async function fetchSheetCsv(sheetUrl) {
  const sheetId = extractSheetId(sheetUrl);
  // Honor the tab the operator pasted. Google's CSV export defaults to the
  // first sheet when no gid is given, which silently pulls the wrong data
  // for any spreadsheet with multiple tabs.
  const gid = extractSheetGid(sheetUrl);
  const csvUrl = gid
    ? `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`
    : `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;

  console.log(`[sheets] Fetching CSV from: ${csvUrl}`);

  // P-05 fix (2.8.18): timeout to prevent indefinite stalls on Google
  // Sheets / network outages. Bumped 15s → 30s and added one retry —
  // CSV exports occasionally take 15-25s on bigger sheets and the original
  // single-shot fetch failed the bulk-check on every slow sweep.
  async function tryFetch(timeoutMs) {
    return fetch(csvUrl, { signal: AbortSignal.timeout(timeoutMs) });
  }
  let response;
  try {
    response = await tryFetch(30000);
  } catch (err) {
    // Timeout (AbortError) or network blip — give it one more shot before
    // surfacing as a sweep failure. Bulk-check is gated by a 6h cooldown,
    // so spending a few extra seconds here is cheap insurance.
    console.warn(`[sheets] First CSV fetch failed (${err.message}); retrying once…`);
    response = await tryFetch(30000);
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch Google Sheet (HTTP ${response.status}). Is the sheet publicly viewable?`);
  }
  return response.text();
}

/**
 * Fetches all rows from a public Google Sheet.
 * @param {string} sheetUrl - The Google Sheet URL
 * @returns {Promise<Record<string, string>[]>}
 */
export async function fetchSheet(sheetUrl) {
  const rows = parseCSV(await fetchSheetCsv(sheetUrl));
  console.log(`[sheets] Parsed ${rows.length} row(s). Columns: ${rows.length > 0 ? Object.keys(rows[0]).join(', ') : '(none)'}`);
  return rows;
}

/**
 * Fetches all rows AND their 1-based sheet row numbers from a public Google
 * Sheet. Used by the Sales Nav Scrape "From a Sheet" row-range picker.
 * @param {string} sheetUrl - The Google Sheet URL
 * @returns {Promise<{ rowNumber: number, row: Record<string, string> }[]>}
 */
export async function fetchSheetWithRows(sheetUrl) {
  const rows = parseCSVWithRowNumbers(await fetchSheetCsv(sheetUrl));
  console.log(`[sheets] Parsed ${rows.length} non-empty row(s) with row numbers.`);
  return rows;
}
