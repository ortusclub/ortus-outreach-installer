// A manual sweep has its own stop lifecycle. A campaign that is monitoring
// remains on the board while the sweep closes its browser.
export function applyManualCheckStatus(base, running, proof) {
  base.manualCheck = { running, ...proof };
  if (proof.stopping) {
    base.checkStopping = true;
    if (base.state !== 'monitoring') {
      base.stopping = true;
      base.stopConfirmed = false;
      base.state = 'stopping';
    }
  }
  return base;
}
