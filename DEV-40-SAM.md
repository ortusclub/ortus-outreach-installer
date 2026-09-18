# DEV-40 for Sam

This is the frozen source release for Sam's MacBook. It uses app **v3.1.60.36** and only the isolated `preview-pr-40-cbeb766` engine in Kubernetes namespace `salesnav-previews`. It does not connect to shared development or production. The launcher checks the deployed image before Electron opens and exits if it has changed.

## First launch on Sam's MacBook

1. Clone this repository at branch `sam/dev-40` and run `npm ci` in the clone.
2. Authenticate `kubectl` to the cluster with permission to read and port-forward `preview-pr-40-salesnav-scraper` in `salesnav-previews`. The launcher uses `~/.kube/ortus-dev.yaml` if present, or the current Kubernetes context otherwise.
3. Run `bash scripts/electron-sam-dev40.sh` from the clone and leave the terminal open. It maintains a localhost tunnel on port `3140` for the Electron session.
4. In the app, confirm **LinkedIn · v3.1.60.36** and **DEV-40** with engine image **preview-pr-40-cbeb766** before launching a campaign.

This is a source release; no DMG is built. Sam's campaigns and runtime data are stored on his Mac and in the dedicated `preview_pr_40` engine database schema and Redis instance. GoLogin workspaces and Google Apps Script are external services shared with the existing setup, so use accounts and sheets intended for Sam's test.

The launcher must stay on this branch for the frozen test. Later PR19 or shared development changes do not update this branch or the dedicated DEV-40 deployment.
