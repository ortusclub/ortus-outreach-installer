// Thin HTTP surface for the central connections roster service. All roster math
// is the app's real src/connections/search-service.js, passed in as `impl` —
// this file only routes, authenticates, and guards readiness.
import express from 'express';
import { rpcDispatch } from '../../src/connections/db-client.js';

export function makeApp({ impl, token, isReady, onRefresh, autopilot, configStore, runStore }) {
  const app = express();
  app.use(express.json({ limit: '4mb' })); // alreadyInvited / urls arrays can be large
  const router = express.Router();

  const auth = (req, res, next) => {
    if (req.get('authorization') === `Bearer ${token}`) return next();
    return res.status(401).json({ error: 'unauthorized' });
  };

  router.get('/health', (_req, res) => res.json({ ok: true }));

  router.post('/rpc', auth, (req, res) => {
    if (!isReady()) return res.status(503).json({ error: 'db not loaded' });
    const { fn, args } = req.body || {};
    try {
      res.json({ result: rpcDispatch(fn, args, impl) });
    } catch (err) {
      const bad = /^unknown roster fn:/.test(err.message);
      res.status(bad ? 400 : 500).json({ error: err.message });
    }
  });

  router.post('/admin/refresh', auth, async (_req, res) => {
    try { await onRefresh(); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/admin/autopilot-config', auth, (req, res) => {
    try { configStore.save(req.body || {}); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/admin/autopilot', auth, (_req, res) => {
    res.json({ config: configStore.load(), runs: runStore.load() });
  });

  router.post('/admin/autopilot', auth, async (req, res) => {
    try { res.json(await autopilot.run({ force: !!(req.body && req.body.force) })); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.use('/fg-roster', router);
  return app;
}
