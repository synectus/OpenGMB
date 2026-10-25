# Guardrails (G1 engine, universal / hipaa / legal_ethics packs)

Pure, deterministic, lexicon and regex based. No database, no network, no LLM. Rule content comes from an internal GBP reply playbook (v1, 2026-09-27).

```ts
const result = runGuardrails(ctx); // always runs `universal`, plus ctx.workspace.packs
const passed = assertPassed(result, reply); // throws GuardrailBlockedError if !result.ok
```

- `ok` is true when no violation has severity `block`. Warnings do not change `ok`; callers require an
  explicit acknowledgement for them (reply state machine, not this module).
- `ctx.workspace.severityOverrides` (`{ "H2.*": "warn" }`, keys are rule ids or `<prefix>.*`) is applied by the
  engine after `Rule.check`, so rule code and messages are untouched. `reply-context.ts` sets it from the
  workspace `h2Severity` setting (HIPAA H2 block|warn, default block). A downgraded violation is a warning:
  `ok` can become true, and the reply flow still requires `acknowledgeWarnings`.
- `GuardrailPassed` is branded. `assertPassed` is its only constructor, and it only accepts a result
  object that `runGuardrails` issued for exactly that reply text. Code that calls Google's
  `updateReply` should require a `GuardrailPassed` argument.
- Rules with status `pending_counsel_review` run and report; their violations carry that status.
- `Violation.status` is an addition to the plan's `Violation` shape (the plan requires the status to be
  shown in the violation but does not name the field).
- Offsets in `matches` index the ORIGINAL reply string. Matching is done on the original text with
  patterns that tolerate case, smart quotes and apostrophes, and any punctuation or whitespace between
  words, so no offset translation is needed.

## Rules

| Id                 | Pack         | Severity | Status                 | Source                                                                            |
| ------------------ | ------------ | -------- | ---------------------- | --------------------------------------------------------------------------------- |
| `U.empty`          | universal    | block    | active                 | Engine invariant: nothing to publish                                              |
| `U.length`         | universal    | block    | active                 | Google reply limit, `REPLY_MAX_BYTES` (UTF-8 bytes) in `config/google-limits.ts`  |
| `U4`               | universal    | warn     | active                 | Playbook U4 (banned boilerplate)                                                  |
| `U7.url`           | universal    | block    | active                 | Playbook U7                                                                       |
| `U7.email`         | universal    | block    | active                 | Playbook U7                                                                       |
| `U7.hashtag`       | universal    | block    | active                 | Playbook U7                                                                       |
| `U7.offer`         | universal    | block    | active                 | Playbook U7 (offers, promotions)                                                  |
| `U8.style`         | universal    | warn     | active                 | Synectus writing style (replies and posts): em dash, banned words and phrases (`config/writing-style.ts`) |
| `R6.duplicate`     | universal    | block    | active                 | Playbook U3/R6 (last 30 published replies)                                        |
| `R6.opening`       | universal    | warn     | active                 | Playbook U3/R6 (shared opening sentence)                                          |
| `H1`               | hipaa        | block    | active                 | Playbook H1 (care relationship)                                                   |
| `H2.reviewer`      | hipaa        | block    | active                 | Playbook H2 (reviewer name)                                                       |
| `H2.provider`      | hipaa        | block    | active                 | Playbook H2 ("Dr./Doctor Name")                                                   |
| `H2.staff`         | hipaa        | block    | active                 | Playbook H2 (workspace staff list)                                                |
| `H2.clinical`      | hipaa        | block    | active                 | Playbook H2/H3 (conditions, treatments, accidents, attorneys, insurance, billing) |
| `H2.date`          | hipaa        | block    | active                 | Playbook H2 (dates, weekdays)                                                     |
| `H2.echo`          | hipaa        | block    | active                 | Playbook H2 ("even if the reviewer wrote them")                                   |
| `H4.privacy-line`  | hipaa        | block    | active                 | Playbook H4 (1-3 star fixed privacy line)                                         |
| `H4.phone`         | hipaa        | block    | active                 | Playbook H4 (card phone on 1-3 star replies)                                      |
| `H4.rebuttal`      | hipaa        | block    | active                 | Playbook H4 / FTC Consumer Review Rule (no rebuttal)                              |
| `H.skip-positive`  | hipaa        | block    | active                 | Plan "Healthcare profile (G4)": positive-review replies are off                   |
| `LE1.relationship` | legal_ethics | block    | pending_counsel_review | Playbook legal line; Texas Opinion 662                                            |
| `LE2.case-facts`   | legal_ethics | block    | pending_counsel_review | Playbook legal line; Texas Opinion 662                                            |
| `LE3.guarantee`    | legal_ethics | block    | pending_counsel_review | Playbook legal line; Texas Opinion 662                                            |
| `LE4.testimonial`  | legal_ethics | warn     | pending_counsel_review | Playbook legal line; Texas Opinion 662                                            |

Playbook items with no rule of their own: H3 (covered by H1 and H2), H5 (this pack is that scan), H6 and
H7 (process and references). See the `hipaaDocs` export.

Severity choices for `legal_ethics` (for counsel to confirm): relationship, case facts and guarantees
block; testimonial wording warns because it is softer and context dependent.

## Behaviour worth knowing

- R6 compares only the first `DUPLICATE_WINDOW_REPLIES` (30) entries of `recentReplies` (newest first).
  An identical reply produces `R6.duplicate` only; `R6.opening` is not added on top.
- H4 rules apply to ratings 1-3 only. Rating `null` skips them. `H4.phone` is skipped when the location
  has no phone; phone numbers match on digits, so `+1 713 555 0142` equals `(713) 555-0142`.
- `H.skip-positive` fires only when `workspace.skipPositiveReviews` is true and the rating is 4 or 5.
- The location's own name is masked before the H1, H2.provider, H2.clinical, H2.date, H2.echo and all
  `legal_ethics` checks, so a clinic called "Harbor Spine Clinic" may name itself.
- `A Google User` as reviewer name is ignored by `H2.reviewer`.
- Phone numbers are allowed by `U7.*` and are not treated as dates by `H2.date`.

## Messages per content type

A rule that runs on more than one content type words its message for each (`packs/wording.ts`,
`say(ctx, { reply, post, profile })`). Reply messages are the original text and never change; post
messages name the post ("The post ..."; `U7.url` says "Links are not allowed in the text. Use the
button URL."), profile messages name the description. `messages.test.ts` fails if a rule shared by
replies and another content type has no wording of its own. Results stored before 2026-10 (posts,
change sets) keep the old "Reply ..." text until they are checked again.

## Known limits

- Lexicon and regex only: no NLP, no negation, no coreference. "We do not treat back pain" is blocked the
  same as "we treated your back pain"; paraphrases not in a lexicon get through.
- H2 names come only from the review's display name, the workspace staff list and the "Dr./Doctor Name"
  pattern. A staff member not in the list and not preceded by "Dr." is not caught. Staff entries match as
  written, so list "Rosa Diaz" and "Diaz" separately if both forms occur.
- Reviewer name tokens of 2+ characters match anywhere as whole words, so a reviewer called "Will" or
  "Hope" blocks replies containing those ordinary words. This errs on the side of blocking.
- `H2.clinical` blocks any lexicon term in a reply, not only terms the reviewer used. That is the
  conservative reading of H2/H3 ("general statements" cannot be told apart from reviewer-specific ones).
  A reply that says "billing questions" or "insurance" generically is blocked; use the H4 privacy line and
  phone instead.
- `H2.date` blocks weekday names ("Sundays") and "Month day" forms, so hours stated as "open Mondays" are
  blocked. A bare year or "last week" is not caught.
- `H2.echo` overlaps `H2.clinical` by design (it reports the longer copied span); it needs `review.text`.
- Obfuscation (zero-width characters, homoglyphs, "dot com" spelled out) is not handled.
- URL detection of bare domains uses a fixed TLD list.
- `legal_ethics` wording is unreviewed by counsel. "our client" (singular) is blocked, "our clients"
  (plural) is not.
- `REPLY_MAX_BYTES` and `DUPLICATE_WINDOW_REPLIES` come from the shared config module
  (`config/google-limits.ts`), which carries their sources and verified-on dates.

## Corpus gate

`corpus/{universal,hipaa,legal_ethics}.json` hold `{ defaults, entries }`. Each entry gives a reply, context
overrides and the EXACT set of rule ids expected to fire (warnings included) plus `ok`. `corpus.test.ts`
asserts every entry, fails if any registered rule has no failing fixture, and prints
`N replies, M expected violations matched, R/T rules covered`. A reply may be written as
`{ "repeat": "a", "times": 4097 }` for length tests; `recentFiller: n` prepends n unrelated replies to
test the 30-reply window. Adding a rule without a failing fixture fails the suite.
