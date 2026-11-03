# EduPath Ai — Muse Spark features

This repository holds **only the work built during the Meta Global AI
Developer Hackathon event window, 26 October 2026 (kickoff ended 12:24 PM ET)
to 4 November 2026 (9:00 PM ET)**.

## What was pre-existing (described in words only, not in this repo)

EduPath Ai, the school platform, already existed before this week. It is a
school platform for schools, teachers and students, with classes, subjects,
rosters, exams, results and reports. That pre-existing application is **not**
included here — no part of it, no build output, no installer, no phone app —
because the event rules require pre-existing work to be kept out of the
submitted repository entirely. It is described here in words only, as context
for the features below.

## What was built this week (in this repo)

Muse Spark features, using Meta Model API, Muse Spark Standard
(`muse-spark-1.3`, data not used for training), at runtime:

1. **AI theory marking** — suggested marks are drafts only. A teacher checks
   them and saves with Save Final Score before any suggested mark becomes a
   result.
2. **AI feedback comments** — suggested comments are final as shown; the
   teacher may edit the words. Nothing reaches the student until the final
   score is saved.
3. **AI practice** — a student picks a subject from their own class, types a
   topic, sets their own timer, and gets practice questions. AI marks the
   practice attempt, with a visible countdown and auto-mark at zero with a
   "Time up" note. Practice never changes an exam result.
4. **Bulk AI exam import ("Arrange with AI")** — a teacher pastes whole
   objective and theory sheets; the model arranges them into the exam's slots
   with an editable preview. Theory wording is preserved. The system
   auto-marks objective questions; AI does not mark students.

## Files

- `src/lib/aiSpark.ts` — pure prompt building, strict JSON parsing and mark
  validation for the four features above. No API key, no password, no secret.
- `src/lib/aiProxy.ts` — client for the Cloudflare Worker proxy. Sends
  structured data plus the caller's Firebase sign-in token, never prompt text
  and never a Meta key. It imports a sign-in token helper from the
  pre-existing app (`../shared/auth` in the full app); that helper is not in
  this repo, by the rule above. In tests, a token function is injected.
- `src/lib/bulkExam.ts` — pure arranging/validation for bulk exam import.
- `worker/ai-proxy.js` — single-file, zero-dependency Cloudflare Worker.
  Verifies the Firebase ID token, checks school membership and role, builds
  prompts server-side from structured data only, and calls Meta with the key
  from its own secret store (`META_API_KEY`, set by the owner in the Worker
  dashboard, never in this repo). Routes: `/ai/arrange`, `/ai/mark-theory`,
  `/ai/feedback` (staff only), `/ai/practice-generate`, `/ai/practice-mark`
  (any school member).
- `*.test.ts` alongside each module — the tests for the modules above.
- `worker/README.md` — the Worker's own deployment notes.

## Deliberately left out

- The practice-timer helper written on 26 October 2026 at 10:24 AM ET,
  before the 12:24 PM ET kickoff end. It is genuine Spark-practice work, but
  it predates the cutoff, so it is excluded to stay strictly inside the
  event window.
- Everything pre-existing (see above), all builds, installers, APKs,
  keystores, `.env` files and secrets.
- One identifier in the Worker's source was replaced with a placeholder in
  this public copy: `DEFAULT_ADMIN_UID` is now `'YOUR_GLOBAL_ADMIN_UID'`.
  Set the real value via the Worker's `ADMIN_UID` variable when deploying
  your own copy. The Meta API key is never in this repo.

## Demo video

The 3-minute demo video opens with the pre-existing vs built-this-week line
above and demonstrates only these features.
