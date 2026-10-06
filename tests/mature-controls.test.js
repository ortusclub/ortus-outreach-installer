import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { canViewCampaign } from '../src/campaign-visibility.js';
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
function route(path, context) {
  const start = source.indexOf(`app.post('${path}'`);
  const end = source.indexOf('\n});', start) + 4;
  let handler;
  vm.runInNewContext(source.slice(start, end), { canViewCampaign, campaignViewer: () => ({email:'sam@ortusclub.com'}), ...context, app: { post: (_, fn) => { handler = fn; } } });
  return handler;
}
function response() { return { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } }; }
for (const action of ['pause', 'resume', 'stop']) test(`maturing ${action} reaches the engine`, async () => {
  const calls = [];
  const handler = route('/api/mature/control/:id/:action', {
    getCloudCampaign: async () => ({ campaign: { owner:'sam@ortusclub.com', config: { matureWarm: true } } }),
    stopCloudCampaign: async (id, options) => { calls.push({ id, options }); return { ok: true }; },
    resumeCloudCampaign: async id => { calls.push({ id }); return { ok: true }; },
  });
  const res = response();
  await handler({ params: { id: 'campaign', action } }, res);
  assert.equal(res.statusCode, 200); assert.equal(calls.length, 1);
  if (action === 'pause') assert.equal(calls[0].options.pause, true);
  if (action === 'stop') assert.equal(calls[0].options.immediate, true);
});
test('resume preserves a future cold start', async () => {
  const startAt = '2099-01-01T09:00:00Z';
  let scheduled;
  const handler = route('/api/mature/control/:id/:action', {
    getCloudCampaign: async () => ({ campaign: { owner:'sam@ortusclub.com', config: { matureWarm: true, dailySchedule: { startAt } } } }),
    restartCloudCampaign: async (id, opts) => { scheduled = opts.startAt; return { ok: true }; },
    resumeCloudCampaign: () => { throw Error('must not start early'); },
  });
  await handler({ params: { id: 'cold', action: 'resume' } }, response());
  assert.equal(scheduled, startAt);
});
test('stop setup can arrive before the first setup request', async () => {
  const progress = new Map();
  const handler = route('/api/mature/cancel-start', { matureStartProgress: progress, matureStep() {} });
  const res = response();
  await handler({ query: { launchId: 'launch' } }, res);
  assert.equal(progress.get('launch').cancelled, true);
  assert.equal(res.statusCode, 200);
});
test('cancelling during dispatch stops the campaign that was just created', async () => {
  const start = source.indexOf("    if (err.code === 'MATURE_CANCELLED')");
  const end = source.indexOf('    console.error(`[mature] start failed', start);
  const stopped = [], res = response();
  await vm.runInNewContext(`(async()=>{${source.slice(start,end)}})()`, {
    err: { code: 'MATURE_CANCELLED' }, launched: ['warm', 'cold'], res, step() {},
    stopCloudCampaign: async (id, opts) => { assert.equal(opts.immediate, true); stopped.push(id); return { ok: true }; },
  });
  assert.deepEqual(stopped, ['warm','cold']); assert.equal(res.body.cancelled, true);
});

test('maturing controls reject a campaign from another company', async () => {
  let called = false;
  const handler = route('/api/mature/control/:id/:action', {
    getCloudCampaign: async () => ({campaign:{owner:'other@linkedvelocity.com',config:{matureWarm:true}}}),
    stopCloudCampaign: async () => {called=true;},
  });
  const res=response();
  await handler({params:{id:'foreign',action:'stop'}},res);
  assert.equal(res.statusCode,404);assert.equal(called,false);
});
