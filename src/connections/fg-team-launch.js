// src/connections/fg-team-launch.js
// Sequential Follower-Growth batch: run each employee→profile pair one at a time
// (one browser open at any moment), reusing buildTargets/launch/send/record via
// injected deps so the loop is unit-testable without a real browser or sheet.

// FG_HEADER indices used to map a built row to the sender's queued shape.
const I_NAME = 0, I_MEMBER = 2, I_COMPANY = 3, I_TITLE = 4;

export function pairToQueued(rows) {
  return (rows || []).map((r) => ({
    name: r[I_NAME], jobTitle: r[I_TITLE], company: r[I_COMPANY], memberId: String(r[I_MEMBER] || ''),
  }));
}

export function makeInitialStatus(pairs) {
  return {
    running: true, phase: 'launching', totalAccounts: pairs.length, doneAccounts: 0,
    currentAccount: null, sent: 0, skipped: 0, invitesTotal: 0,
    perAccount: pairs.map((p) => ({ account: p.account, status: 'waiting', invited: 0, reason: '' })),
    logs: [], error: null,
  };
}

export async function runTeamLaunch(pairs, ctx, deps, status) {
  const stamp = (m) => { const line = `[${deps.now()}] ${m}`; status.logs.push(line); if (status.logs.length > 200) status.logs.shift(); try { deps.log(m); } catch (_) {} };
  stamp(`▶ Team launch started · ${pairs.length} account(s) · roles: ${(ctx.keywords || []).join(', ') || 'all'}`);
  try {
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      const slot = status.perAccount[i];
      if (ctx.getAbort()) { slot.status = 'skipped'; slot.reason = 'stopped'; status.skipped++; status.doneAccounts++; stamp(`✗ [${pair.account}] Skipped — stopped`); continue; }
      status.currentAccount = pair.account;
      const { rows, count, reason } = deps.buildTargets(pair, ctx);
      if (!count) { const why = reason || 'no targets'; slot.status = 'skipped'; slot.reason = why; status.skipped++; stamp(`✗ [${pair.account}] Skipped — ${why}`); status.doneAccounts++; continue; }
      slot.status = 'running'; status.phase = 'inviting';
      stamp(`🔄 [${pair.account}] Opening profiles & sending follow invites — ${count} target(s)…`);
      let handle = null;
      try {
        handle = await deps.launch(pair);
        const out = await deps.send({ page: handle.page, queued: pairToQueued(rows), log: (m) => stamp(`[${pair.account}] ${m}`), shouldAbort: ctx.getAbort });
        const invitedIds = out.invited || [];
        if (invitedIds.length) await deps.record({ rows, invitedIds, account: pair.account, operator: pair.operator, month: ctx.month });
        slot.status = 'done'; slot.invited = invitedIds.length; status.sent++; status.invitesTotal += invitedIds.length;
        stamp(`✓ [${pair.account}] Invites sent · ${invitedIds.length} sent, ${out.creditsAfter} credits left`);
      } catch (err) {
        slot.status = 'skipped'; slot.reason = err.message; status.skipped++; stamp(`✗ [${pair.account}] Error — ${err.message}`);
      } finally {
        try { if (handle) await handle.close(); } catch (_) {}
      }
      status.doneAccounts++;
    }
    status.phase = 'done';
    stamp(`■ Team launch complete — ${status.sent} sent, ${status.skipped} skipped`);
  } catch (err) {
    status.phase = 'error'; status.error = err.message; stamp(`✗ Fatal — ${err.message}`);
  } finally {
    status.running = false; status.currentAccount = null;
  }
  return status;
}
