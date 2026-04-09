/**
 * Fetches rows from a publicly shared Google Sheet by converting it to CSV.
 * The sheet must be set to "Anyone with the link can view".
 */

import { extractSheetId } from './utils.js';

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
      if (inQuotes && csv[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
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
 * Fetches all rows from a public Google Sheet.
 * @param {string} sheetUrl - The Google Sheet URL
 * @returns {Promise<Record<string, string>[]>}
 */
export async function fetchSheet(sheetUrl) {
  const sheetId = extractSheetId(sheetUrl);
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;

  console.log(`[sheets] Fetching CSV from: ${csvUrl}`);

  const response = await fetch(csvUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch Google Sheet (HTTP ${response.status}). Is the sheet publicly viewable?`);
  }

  const csv = await response.text();
  const rows = parseCSV(csv);

  console.log(`[sheets] Parsed ${rows.length} row(s). Columns: ${rows.length > 0 ? Object.keys(rows[0]).join(', ') : '(none)'}`);

  return rows;
}
