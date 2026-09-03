# Copy this prompt for every VM preview

Replace the words in square brackets, then paste the whole prompt into Codex or
Claude from the repository you are changing.

> Work on one task only: **[describe the exact change]**. The area I own is
> **[CC / Message Campaign / Follower Growth / Magellan / Sales Nav Scraper]**.
> Start from the latest approved `main` and create a short task branch. Do not
> push directly to main. Do not merge, release, deploy production, build an
> installer, tag a version, or touch any DMG.
>
> First inspect the existing behaviour and tests. Tell me which app files and
> cloud-engine files this task needs. If it crosses another person's area or a
> shared sending primitive, stop and explain the overlap before editing.
>
> Implement the smallest complete change and add regression tests. Run the full
> repository test suite. Commit and push the task branch, then open a draft Pull
> Request. Fill in the PR template, including what changed, what deliberately
> stayed unchanged, tests run, and manual proof.
>
> This work needs a temporary VM preview. Tell Antonio the cloud-engine PR
> number and which dedicated TEST GoLogin profile ID I need. Do not use an
> account assigned to another active preview. After Antonio confirms the
> assignment and the `preview-engine` label is applied, wait for GitHub's “PR
> preview engine” check to pass.
>
> Launch my desktop branch with `npm run electron:preview -- [CLOUD PR NUMBER]`.
> Before testing, prove the app banner says `PR PREVIEW ENGINE`, shows the right
> PR number and source commit, and says at least 1 approved test account. If any
> of those is wrong, do not launch a campaign.
>
> Test only the assigned mode and test account. Attach screenshots and logs to
> the PR. Leave the PR open for review; do not merge it. When the work is merged
> or abandoned, remove the `preview-engine` label or close the engine PR so its
> temporary resources are deleted.

## The short version to remember

Branch → draft PR → Antonio assigns a test account → `preview-engine` label →
GitHub tests/builds → `npm run electron:preview -- PR_NUMBER` → verify the banner
→ test → screenshots/logs → review → close the preview.
