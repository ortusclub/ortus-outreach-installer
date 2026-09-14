# EJ QA handoff

This branch is a QA/development checkpoint for QA-02 through QA-11. Work only on branches prefixed `ej/` and return changes by pull request to Antonio's agreed integration branch.

Use separate local app data, authorised test sheets and accounts, and the designated preview engine. Never use production, shared DEV, or Antonio's active PR-19 runtime. Do not commit credentials, GoLogin tokens, browser sessions, kubeconfig files, `.env` files, or personal data.

Reproduce before changing code. Preserve campaign semantics, safety holds, identity checks, limits, uncertain-outcome handling, and equivalent dashboard/campaign-tab behaviour. Add regression tests where practical and report only tests actually run. Do not merge, force-push, release, or deploy.

This checkpoint contains the current local app changes relevant to the handoff. Verify the engine checkpoint and runtime configuration before VM testing.
