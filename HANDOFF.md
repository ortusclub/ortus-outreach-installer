# EJ QA handoff

This branch starts from verified checkpoint `f113f3c` (`pr19-qa-full-integration-2026-09-14`) and is for QA-02 through QA-11. All integrated PR-19 safety, lifecycle, historical-log, dashboard, continuation, VM, monitoring, GoLogin pacing, login-recovery, and visibility changes are already below EJ's work in Git history.

Work only on branches prefixed `ej/` and return changes by pull request to Antonio's agreed integration branch.

Use separate local app data, authorised test sheets and accounts, and the designated PR-19 preview engine. Never use production, shared DEV, or Antonio's active runtime. Do not commit credentials, GoLogin tokens, browser sessions, kubeconfig files, `.env` files, or personal data.

Reproduce before changing code. Preserve campaign semantics, safety holds, identity checks, limits, uncertain-outcome handling, and equivalent dashboard/campaign-tab behaviour. Add regression tests where practical and report only tests actually run. Do not merge, force-push, release, or deploy.

Before testing, confirm the app shows version `3.1.60.14` and engine `preview-pr-19-pacing-400b2c0a250c`.

