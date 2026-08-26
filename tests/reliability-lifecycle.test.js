import test from 'node:test'; import assert from 'node:assert/strict';
import { createStopWatchdog, DEFAULT_STOP_GRACE_MS } from '../src/stop-watchdog.js';
import { launchValidation } from '../src/launch-validation.js';
import { terminalPresentation } from '../public/js/campaign-terminal.mjs';
test('stop watchdog uses the approved 15 second deadline and repeated clicks do not extend it', () => { let cb; const w=createStopWatchdog({isRunning:()=>true,onStuck:()=>{},setTimer:(fn)=>{cb=fn;return {unref(){}}},clearTimer:()=>{cb=null},now:()=>100}); const a=w.arm({generation:1}),b=w.arm({generation:1}); assert.equal(DEFAULT_STOP_GRACE_MS,15000); assert.equal(a.deadlineAt,15100); assert.equal(b.armed,false); });
test('zero actionable targets return direct resolution choices', () => { const r=launchValidation({mode:'connect_only',profileIds:['p1'],targetCount:0,diagnostics:{alreadyProcessed:431,unmatchedSenders:17}}); assert.equal(r.code,'zero-actionable-targets'); assert.deepEqual(r.fixes.map(x=>x.code),['rows','sender']); });
test('terminal wording never calls incomplete work finished', () => { const r=terminalPresentation({totalProcessed:30,totalTargets:148,endNotice:{reason:'operator_stopped'}}); assert.equal(r.label,'Stopped early'); assert.equal(r.pending,118); assert.match(r.explanation,/operator/i); });
