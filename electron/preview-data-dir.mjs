import { join } from 'node:path';

export function previewUserDataDir(appData, env = process.env) {
  if (env.ORTUS_PREVIEW_ISOLATED_DATA !== '1') return null;
  const pr = String(env.ORTUS_PREVIEW_PR || '');
  if (env.ORTUS_ENGINE_ENVIRONMENT !== 'preview' || !/^[1-9][0-9]*$/.test(pr)) {
    throw new Error('Isolated preview data requires a valid preview engine and PR number');
  }
  return join(appData, `Ortus PR-${pr} Stage3 Preview`);
}
