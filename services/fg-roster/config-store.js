// Persist the FG Auto-Pilot config locally (for the scheduler to read) AND to GCS
// (so it survives pod restarts — boot pullDb downloads it back). Local read is the
// source the handler uses each run.
import fs from 'node:fs';

export function makeConfigStore({ path, putObject }) {
  return {
    load() {
      try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
    },
    save(config) {
      const buf = JSON.stringify(config, null, 2);
      const tmp = path + '.tmp';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, path);
      if (putObject) { Promise.resolve(putObject('fg-autopilot.json', buf)).catch(() => {}); }
    },
  };
}
