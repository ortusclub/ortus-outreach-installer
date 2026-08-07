# HANDOFF — Post Amplification pacing / safety design

**Status:** research done, nothing built. Parked 2026-08-07.
**Trigger to pick this up:** before Post Amp goes to the VM (cloud engine), or before it is used at real volume.

Post Amp shipped local-only at v2.160.140, password-gated (`Ortus_PostAMP`). It has never been
run end to end. This document is the research behind the pacing decisions that were NOT made, so
the work can restart cold without redoing three research agents.

---

## 1. Where Post Amp stands legally — read this first

This is not a grey area, unlike the connect/DM tooling. Two independent prohibitions:

**Automation ground** — [LinkedIn User Agreement](https://www.linkedin.com/legal/user-agreement) §8.2(13), verbatim:

> "Use bots or other unauthorized automated methods to access the Services, add or download
> contacts, send or redirect messages, **create, comment on, like, share, or re-share posts, or
> otherwise drive inauthentic engagement**;"

Every action Post Amp performs is enumerated by name.

**Coordination ground** — [Professional Community Policies](https://www.linkedin.com/legal/professional-community-policies), verbatim:

> "Don't do things to artificially increase engagement with your content. Respond authentically to
> others' content and **don't agree with others ahead of time to like or re-share each other's
> content**."

Note this one bans the *coordination itself*, even done manually by humans with no tooling.

Also relevant: §8.2(1) explicitly names **copying cookies** and using another's account — the
mechanism multi-account tooling relies on.

**The operator has been told this and decided to proceed.** These are Ortus's own accounts. This
section exists so nobody re-litigates it later, and so the risk model below makes sense.

---

## 2. The realistic failure mode is silent, not a ban

LinkedIn VP of Product Management **Gyanda Sachdeva**, on record twice:

- [Social Media Today, 2025-11-06](https://www.socialmediatoday.com/news/linkedin-vows-to-take-action-against-engagement-pods-fake-engagement/804970/):
  > "Our goal is to make engagement pods entirely ineffective. We are increasing the number of ways
  > we detect these pods and the suspicious behavior that happens in these pods."
  > "We are increasingly flagging any artificially boosted content internally, and then also, we are
  > limiting the reach of this content."
- [Social Media Today, 2026-02-16](https://www.socialmediatoday.com/news/linkedin-outlines-more-measures-to-combat-engagement-pods/812290/) — the enforcement ladder for automated comments:
  1. removed from the **"Most Relevant"** comment section
  2. reach capped to the commenter's **own network only**
  3. reach of the **boosted post itself** limited
  4. account restriction — only for persistent offenders

Plus [Help a524166](https://www.linkedin.com/help/linkedin/answer/a524166), added ~Aug 2025:

> "if we detect excessive comment creation or use of an automation tool, we may limit the visibility
> of those comments."

**Consequence for design:** the tool does not fail loudly. It fails by quietly suppressing the reach
of the very post it was pointed at, while still spending real account actions. There is no error
code to detect and no signal in our logs. Assume we cannot measure whether it is working, and
design conservatively on that basis.

---

## 3. Numbers that are real vs numbers that are fabricated

### Fabricated — do not use, do not repeat

Widely circulated, traced to vendor blogs selling pod alternatives, **no primary source**:

- "15 comments within 90 seconds triggers detection"
- "97% detection accuracy"
- "8,500 → 340 impressions overnight"
- "30–60 day reach restrictions / 60–90 day shadowbans"
- "comments carry 2x / 2.5x / 15x a like" — three different numbers for the same quantity, all
  tracing back to the same paid report

An earlier version of this analysis quoted the first three as fact. They are not.

### Real, cited

| Fact | Value | Source |
|---|---|---|
| LinkedIn post half-life | **1,393 min ≈ 23.2 h** (X: 52 min, FB: 86 min, IG: 1,096 min) | [Graffius, 2026-01-23](https://www.scottgraffius.com/blog/files/lifespan-halflife-of-social-media-posts-update-2026.html), 5.6M posts, cited in *Journal of Marketing* |
| Real reaction distribution | Like 81.4%, Love 8.6%, Celebrate 4.2%, Insightful 3.1%, Support 2.8% | [MagicPost](https://magicpost.in/blog/linkedin-reactions), 1,022,217 posts / 163M reactions, June 2026 |
| Feed ranker objectives | predicts like, comment, share, vote, click, long-dwell — **weights never published** | [LiRank, arXiv 2402.06859](https://arxiv.org/abs/2402.06859), LinkedIn official |
| Comment length vs impressions | mean 131 (<50 chars) → 261 (250+ chars), but **median flat 34→38** | [Linkhub](https://linkhub.gg/en/blog/longueur-commentaire-linkedin-impressions), 657,722 comments |
| LinkedIn's own abuse-detection method | clustering on **identical/similar feature values across many users/requests** | [LinkedIn Engineering, 2021](https://engineering.linkedin.com/blog/2021/leveraging-behavior-analytic-computation-for-anti-abuse-defenses) |

The comment-length median being flat matters: the mean is outlier-dragged. There is **no evidence**
of a length weight in the ranker. Don't build a minimum-length rule on it.

The 23.2h half-life is the single most load-bearing number here. LinkedIn is the longest-tailed feed
platform in existence. Engagement that resolves in three hours is anomalous **against LinkedIn's own
baseline shape** — which is exactly the "lack of independence" signature the coordination-detection
literature ([arXiv 2001.05658](https://arxiv.org/pdf/2001.05658)) keys on.

### Vendor-published caps (peer guesses, not measurements)

[PhantomBuster rate limits](https://support.phantombuster.com/hc/en-us/articles/360017014479-PhantomBuster-Rate-Limits-Daily-Limits-by-Platform-and-Phantom) — the only vendor publishing engagement caps at all:

| Action | New/infrequent | Frequent free | Frequent premium / Sales Nav |
|---|---|---|---|
| Likes | 100/day | 150/day | 400/day |
| **Comments** | **80/day** | **80/day** | **80/day** |

Comments are the one action whose cap does **not** rise with account strength — consistent with
LinkedIn policing comments hardest. PhantomBuster's own caveats: manual activity counts against the
same budget; divide the budget across concurrent automations; vary launch times because "LinkedIn
may become suspicious if your automations launch at the same time for a while".

No vendor anywhere publishes a repost/share cap.

---

## 4. What the open-source ecosystem actually does

Nine repos reviewed. The space is thin and low-star; there is no widely-adopted pod project.

| Repo | Stars | What it gives us |
|---|---|---|
| [alex-noel/clawsocial](https://github.com/alex-noel/clawsocial) | 0 | **Only published cap schedule anywhere.** `rate-limiter.ts:217`: LinkedIn 100 likes / 30 comments / 15 follows / 40 DMs per rolling 24h. Delays 1500–4000ms; typing 30–100ms/char; same-profile cooldown 120–180s. README: **min 10 min between comments**, min 15 min between connects, "use odd minutes (:03, :17, :33, :51) not round numbers". 5-week warm-up at +25%/week (week 1 = 20 likes/14 comments per day). Author states the caps are his guess and he never actually hit a LinkedIn limit. |
| [joeygoesgrey/linkedln-bot](https://github.com/joeygoesgrey/linkedln-bot) | 23 | **Best dedup design.** `logs/engage_state.json` keyed three ways per post — hashed DOM key, text hash, and post `data-id`/URN — so it survives LinkedIn re-rendering the same post. Also has `_already_commented()` and a similar-comment check. |
| [iqbalmirzayev/linkedin_engagement_bot](https://github.com/iqbalmirzayev/linkedin_engagement_bot) | 1 | The only true multi-account pod found. Telegram group as the pod, SQLite of links, each member runs a local worker. **Zero jitter, zero caps, fixed `sleep(5)`.** Nothing to copy. |
| [MattFlood7/LinkedInBot](https://github.com/MattFlood7/LinkedInBot) | 171 | Doesn't like or comment, but has the **best backoff**: 403 → `sleep(3600 * error403Count + random(0,10)*60)`, escalating hourly. Hard session pause every 1000 profiles or 3600s wall-clock. Randomizes *whether* to act at all (~50%). |
| [mguttmann/linkedin-internal-api](https://github.com/mguttmann/linkedin-internal-api) | 2 | Rigorously verified Voyager endpoints — see §6. |
| [eisbaw/linkedin-rs](https://github.com/eisbaw/linkedin-rs) | 21 | Android APK decompilation. **LinkedIn's own client registers only 401 and 403 handlers — there is no 429 handler at all.** No client-side throttling, no circuit breaker. |

**Two things nobody does**, i.e. we are past published prior art:

1. No repo tracks caps **per-account across a fleet** (clawsocial's limiter is single-tenant, keyed
   `platform/action` only).
2. No repo does **cross-account dedup** ("account B shouldn't hit a post account A already hit").

**Watch 403, not 429.** LinkedIn's client has no 429 path; the field-observed throttle signal is
403, and the community response is escalating hour-scale backoff with jitter.

---

## 5. Gap analysis against our code

All line numbers `src/linkedin/post-amplification.js` @ v2.160.140.

| Finding | What we do | Verdict |
|---|---|---|
| Real reaction mix is 81.4/8.6/4.2/3.1/2.8 | `pickReaction():49` — 80% Like, then **uniform** over 5 | 80/20 split is empirically near-perfect. The tail is wrong: over-produces Insightful/Funny/Support ~2×, under-produces Love ~2×. Trivial fix |
| Dedup on activity URN, multi-keyed | `state[postUrl][profileId]` keyed on the **raw URL string** (`:80`, `:84`) | **Real bug.** `/feed/update/urn:li:activity:123` and `/posts/slug-123` are the same post with different keys — dedup silently misses and the account re-comments |
| Min 10 min between comments (clawsocial) | `jitter(60000, 300000)` = 1–5 min, likes and comments alike (`:912`) | Below the only published floor |
| Co-occurrence is the risk LinkedIn actually names | every selected account, every post, no rotation | **Unmitigated, and it is the #1 sourced risk** |
| 403 = throttle signal, hour-scale backoff | no 403 handling in `engagePost` | Gap |
| Identical comment text is a named signal | per-account textarea + saved templates (`app.js:4224`), no distinctness check | Gap, cheap to close |
| Per-account daily caps | none | **Deliberately deprioritised — see below** |

**Why the per-account cap is NOT the first thing to build.** Our exposure is 1 like + at most 1
comment per account per post. Reaching even clawsocial's conservative 30 comments/day would require
amplifying 30 posts in one day. The volume axis is not where our risk lives; the coordination axis
is. A cap table would be optimising the wrong number. Revisit only if Post Amp volume grows or if
the marketing accounts start carrying heavy Follower Growth load in parallel (they share a budget —
PhantomBuster is explicit that all activity, manual included, counts against the same pool).

**Unrelated dead code found:** `:823` reads `process.env.GOLOGIN_API_TOKEN` and passes it to
`launchProfile`, which ignores its second argument since the multi-workspace change. Harmless today,
misleading later. Clear it whenever this file is next touched.

---

## 6. Rejected: the browserless Voyager path

Verified working, HTTP 201, no browser needed:

```
POST /voyager/api/voyagerSocialDashReactions?threadUrn=<url-encoded urn:li:activity:ID>
Body: {"reactionType":"LIKE"}
reactionType ∈ LIKE | PRAISE | APPRECIATION | EMPATHY | INTEREST | ENTERTAINMENT
```

Rejected for three reasons:

1. **Un-reacting does not work browserless.** Voyager `DELETE` returns a constant 400; the SDUI
   delete path returns 500 on replay because the server needs the browser-filled
   `requestMetadata.currentActor`.
2. **GraphQL query hashes rotate on every LinkedIn deploy** — `voyagerSocialDashComments.<hash>`
   differs between the two repos that documented it.
3. **It would diverge the VM port from local.** Every cloud bug this codebase has had came from a
   divergence between the app and the engine. The engine must mirror `src/linkedin/*` exactly.

Comment creation is SDUI, not Voyager, and replying to a comment is an unsolved problem in every
repo that tried.

---

## 7. Proposed work, in priority order

Nothing here is built. Items 2 and 3 need a UI decision from the operator before they can be specced.

1. **URN-keyed dedup** — extract `urn:li:activity:\d+` from the post URL, key the state file on
   that instead of the raw URL. ~10 lines. This is a live correctness bug, not a safety feature.
2. **Random subset rotation** — operator picks N of the selected accounts per post rather than all
   of them, weighted against which accounts engaged this poster recently. Directly attacks the one
   risk LinkedIn names by name. **Needs a UI decision:** how does the operator express N?
3. **Spread window** — replace the fixed 1–5 min gap with "spread over H hours" (default ~8), with
   comment-bearing accounts forced ≥10 min apart. Matches the 23.2h organic curve instead of
   fighting it. **Needs a UI decision:** how does the operator set H, and does the run survive the
   app being closed for that long? (Today it does not — this is the hard part, and it is the main
   argument for doing Post Amp on the VM.)
4. **Weighted reaction table** — swap the uniform tail for the measured base rates. Five minutes.
5. **Comment distinctness guard** — refuse to launch when two accounts carry identical or
   near-identical comment text.
6. **403 backoff** — treat 403 as a throttle signal: park the account, escalate hour-scale with
   jitter, per MattFlood7's pattern.

Recommended first cut: **1 + 4** (both small, one is a live bug), then **2 + 3** as the real design
work once the operator has answered the two UI questions.

---

## 8. Implication for the VM port

Item 3 is the reason Post Amp probably belongs on the VM rather than the laptop: an 8-hour spread
cannot survive an operator closing the app. Do NOT port first and add pacing later — that ports the
pacing bugs too, and the engine must mirror `src/linkedin/*` byte-identically.

The precedent to follow when the time comes is Follower Growth: `kind: "batch"` in the engine's
`MODE_PLAN`, browser primitive vendored byte-identical into `campaign-lib/linkedin/`, injectable for
tests, engine-side orchestration (`campaign-followergrowth.js`, 142 lines).
