import fs from 'node:fs';

export const HEADER = ['First Name', 'Last Name', 'LinkedIn URL', 'Company', 'Job Title', 'Country', 'Primary', 'Primary URL', 'Stage'];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// One lead row in the HEADER column order, every cell coerced to a string.
// Shared by writeLeadCsv (CSV download) and the workbook-tab write (setValues
// needs rectangular string data — no undefineds).
export function leadRow({ contact: c, warmVia }, colleagues = {}) {
  const connector = warmVia[0];
  const meta = connector ? colleagues[connector] || {} : {};
  return [c.firstname, c.lastname, c.linkedinbio, c.company, c.jobtitle, c.country,
    meta.name || connector || '', meta.linkedinUrl || '', ''].map((v) => (v == null ? '' : String(v)));
}

export function writeLeadCsv(rows, outPath, colleagues = {}) {
  const lines = [HEADER.join(',')];
  for (const r of rows) lines.push(leadRow(r, colleagues).map(csvCell).join(','));
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  return outPath;
}
