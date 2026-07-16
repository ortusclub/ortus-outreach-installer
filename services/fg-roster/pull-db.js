// Download the connections DB (CSV folder + cache json) from GCS into the local
// dir the app's search-service reads. Uses Application Default Credentials
// (Workload Identity on GKE) — no key files. search-service auto-reloads on file
// mtime, so a re-pull is picked up by the next /rpc with no restart.
import fs from 'node:fs';
import path from 'node:path';
import { Storage } from '@google-cloud/storage';

const BUCKET = process.env.FG_ROSTER_BUCKET || 'ortus-fg-connections-db';

// Target layout under destDir (must match search-service DEFAULT_DIR/DEFAULT_CACHE):
//   destDir/connections/*.csv
//   destDir/connections-cache.json
export async function pullDb({ destDir, bucketName = BUCKET } = {}) {
  const storage = new Storage();
  const bucket = storage.bucket(bucketName);
  fs.mkdirSync(path.join(destDir, 'connections'), { recursive: true });
  const [files] = await bucket.getFiles();
  let n = 0;
  for (const file of files) {
    // Skip "directory placeholder" objects.
    if (file.name.endsWith('/')) continue;
    const dest = path.join(destDir, file.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await file.download({ destination: dest });
    n++;
  }
  console.log(`[fg-roster] pulled ${n} object(s) from gs://${bucketName} → ${destDir}`);
  return n;
}
