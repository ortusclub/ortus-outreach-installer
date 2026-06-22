import fs from 'node:fs';

export const HEADER = ['First Name', 'Last Name', 'LinkedIn URL', 'Company', 'Job Title', 'Country', 'Primary', 'Primary URL', 'Stage'];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function writeLeadCsv(rows, outPath, colleagues = {}) {
  const lines = [HEADER.join(',')];
  for (const { contact: c, warmVia } of rows) {
    const connector = warmVia[0];
    const meta = connector ? colleagues[connector] || {} : {};
    lines.push([c.firstname, c.lastname, c.linkedinbio, c.company, c.jobtitle, c.country,
      meta.name || connector || '', meta.linkedinUrl || '', ''].map(csvCell).join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  return outPath;
}
