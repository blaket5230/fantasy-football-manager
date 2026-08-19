# ZUB Dynasty FFL Tool — Handoff to Claude Code

**Owner:** Blake Taylor, "The John Waynes", ZUB FF League
**Draft:** live auction, next Thursday. This handoff picks up from an extended
claude.ai chat session; moving to Claude Code for real filesystem/terminal
access instead of an artifact sandbox.
**Primary file:** `zub_cap_tracker.html` — single self-contained HTML/JS file,
~777KB. Everything (data, pricing engine, UI) is inline in one `<script>` tag.
**Simulation bundle:** `sim/` — a standalone Node.js Monte Carlo draft
simulator built against this file's own engine functions (see below).

---

## Read this first: the storage saga

This ate most of a session and the lesson matters for anything else touched
in this file.

The tool persists state (ratings, draft picks, plan) via a key `zub_cap_ledger_v1`.
It was originally written against `window.storage`, an API that **only exists
inside a live Claude.ai artifact render**. Blake has been opening the file by
downloading it and double-clicking it open locally (`file:///Users/...`),
which has **no such API at all**. Every "could not save" toast this session
traced back to that mismatch, not a code bug.

Current state of the fix:
- `loadState()`/`flushSave()` now try `window.storage` first, then fall back
  to real `localStorage`. See `loadState()` and `flushSave()` in the script.
- **Open risk:** `localStorage` may itself be blocked for `file://` origins
  in real browsers (proven in a jsdom test: `"localStorage is not available
  for opaque origins"`). Not yet confirmed whether this actually bites Blake
  in his real browser (jsdom's security model is stricter than some real
  browsers in practice) — he was mid-test when the session moved here.
- **The real fix in progress:** deploying to GitHub Pages, which gives the
  page a genuine `https://` origin and makes this entire class of problem
  disappear. Blake was walked through the manual steps (new repo → upload
  `index.html` → Settings → Pages → Deploy from branch). Not yet confirmed
  done. `index.html` (identical content, pre-renamed) is in this bundle,
  ready to drag in.
- The CSV export/import feature (Prep → Player Pool → "export ratings csv")
  was built specifically as a storage-independent safety net given all this
  uncertainty. It writes/reads a real file via Blob + `<a download>`, nothing
  to do with any of the above. Keep recommending Blake use it periodically
  regardless of whether GitHub Pages fixes everything.

**If Claude Code is running this locally in a normal dev workflow** (opening
via `http://localhost:...` from a dev server, not `file://`), none of this
matters — `localStorage` works completely normally on `http://` origins. If
testing needs a real server, `python3 -m http.server` in this directory and
opening `http://localhost:8000/zub_cap_tracker.html` sidesteps the whole
issue and is probably the fastest way to verify UI changes going forward.

---

## League rules that drive everything

- 12 teams, 4 divisions, auction draft, CBS Sportsline
- **$100 salary cap**, 18-man roster
- **8 starters:** QB, RB1, RB2, WR/TE1, WR/TE2, FLEX (RB/WR/TE), PK, DST
- **Roster composition assumption (confirmed with Blake this session):** of
  the 18 spots, exactly 2 QB, 2 PK, 2 DST. The other 12 split across
  RB/WR/TE with a floor of **3 RB minimum, 3 WR minimum, no TE minimum**.
  TE should never be force-filled — only taken when it's genuinely the best
  value for a WR/TE-eligible slot.
- **Escalator is off the ORIGINAL BASE, not compounding:**
  `Y1 = base`, then `ceil(base × (1 + 0.2n) + 1)` for year n.
- **Drop penalty:** 10% of each remaining year, rounded up
- Blake already holds his 2 QBs for this year (Caleb Williams $6, Jayden
  Daniels $4 = $10 total) as real entries in `SEED_TEAMS_JSON` — this is
  correct and already reflected, nothing to change there.
- **Never put anyone above ~$35, more likely $38 is the real outer edge** —
  Blake's stated real-league observation, now enforced as a market-wide
  behavioral ceiling in the simulator (see below), not yet enforced anywhere
  in the live tool's own bidding suggestions (worth considering if the
  walk-away price ever seems to suggest something wildly above that).
- **Realistic spend-down**: real drafters finish with well under $10 unspent,
  Blake personally aims for $1-5. Encoded in the simulator's pace-urgency
  mechanic; not something the live tool itself needs to enforce (it just
  shows Blake numbers, it doesn't simulate opponents).

---

## Bugs found and fixed this session (all already applied to the file)

1. **Keyboard shortcuts (arrows, 1-5 rating) silently did nothing.** Root
   cause: the `keydown` listener was bound inside `renderPlanView()` (the
   Squad Plan tab), so it only ever got registered if Squad Plan had been
   opened first. Moved to the unconditional page-load init. Verified with a
   real click/keydown simulation that it now works with Squad Plan never
   touched.

2. **DST and PK walk-away price were $0 for every single player.** Root
   cause: `PROD_2025` (real 2025 production stats) is individual box-score
   data — rushing/receiving/passing — and has **zero team-defense or kicker
   entries at all**, that stat category was simply never sourced. Every
   DST/PK fell back to the same placeholder replacement value, flooring VOR
   at exactly 0 for all of them regardless of quality. Fixed with a proxy
   curve (`rankProxyCurve()` in `ppgCurveFor()`) built from the FantasyPros
   consensus rank already in the file, spread across a realistic points
   range (DST: ~9.0 to ~4.5 ppg; PK: ~8.5 to ~6.5, deliberately tighter since
   kickers are the least differentiated fantasy position). This is a proxy,
   not measured stats — flagged as such in the code and to Blake.
   **Open concern:** the `mustFill` branch of `opportunityCost()`/
   `walkAwayPrice()` pushed both the top DST and top PK to the *same* $12
   ceiling despite very different VOR (1.80 vs 0.77), against $3 market for
   both. That smells like the compulsory-slot logic itself running hot
   rather than anything data-specific. Never actually dug into fixing that
   formula — Blake was told to mentally discount PK/DST dollar figures for
   now. Worth a real look if there's time before Thursday.

3. **The whole page could go permanently blank.** Root cause: boot sequence
   was `loadState().then(() => loadLiveValues().then(() => render()))` — a
   live fetch to DynastyProcess on GitHub, gating the entire UI-build step.
   This environment silently blocks external images (see below) and, when
   tested with a fetch that never settles (proven with a real hang
   simulation), the whole chain — and thus the whole page — waits forever.
   Fixed in two stages: first added an `AbortController` timeout, then
   (per Blake's explicit "if it's stale data just pull it out") **deleted
   `loadLiveValues()` entirely**, along with `valuesLive`/`valuesAsOf`. The
   `mv` field it used to refresh only ever fed secondary uses (trade
   analyzer, sort order), never actual pricing — `suggestedDollar()` already
   goes straight to `CBS_AUCTION` then `FP_BOARD`, both baked in. Zero
   network calls happen anywhere in the boot path now. Confirmed via a
   fetch stub that throws if called at all — never gets hit.

4. **CSV export/import for ratings** (`exportRatingsCSV`/`importRatingsCSV`
   in the script, buttons in Prep → Player Pool). Built as a genuine
   file-system backup independent of any browser storage mechanism, given
   the storage saga above. Round-trip tested (export → reparse → correct
   ratings restored, bad rows skipped without crashing).

5. **Failed-save toast used to be a dead end** — once 4 retries failed there
   was no way to retry short of making another edit. It's now clickable
   (retries immediately) and correctly resets to a clean "Saved" state once
   a retry actually succeeds.

Known **not fully resolved**: whether Blake's real browser blocks
`localStorage` for `file://` origins the way jsdom modeled it (see storage
saga above). GitHub Pages deployment removes the question entirely and is
the recommended path regardless of the answer.

---

## Squad Plan false alarm, for the record

Multiple rounds of "Squad Plan isn't working" turned out to be Blake testing
a stale downloaded copy each time (proven by badge text that only existed in
an older version of the code). The most rigorous test run this session — a
real jsdom-rendered DOM, the actual current file, a genuine simulated click
through the real event-listener chain — rendered Squad Plan correctly with
no errors. Don't assume it's broken without a fresh console error in hand;
the code itself checked out clean every way it was tested.

---

## The simulator (`sim/` folder)

A separate, fast, headless Monte Carlo auction-draft simulator, built
because the live tool's own `walkAwayPrice()`/`bestLineupFrom()` benchmark
at ~1.3s per player evaluation cold — fine for a live UI slider, useless for
thousands of simulated bids. Loads the real engine straight out of
`zub_cap_tracker.html` at runtime via a `vm` context + DOM shim (`load.js`,
`dom-mock.js`), so pricing/valuation logic (`vor`, `suggestedDollar`,
`lineupValue`, `effMaxLegalBid`, etc.) is the real thing, not reimplemented.

**Files:**
- `load.js` / `dom-mock.js` — loads the engine headlessly
- `sim-core.js` — the actual auction room simulator: 11 heterogeneous rival
  personas (rational/namechaser/hoarder/passive/panicker, each individually
  jittered, not identical within a persona, plus a per-bid "wildcard" chance
  of acting out of character), round-robin nomination with
  value/need/gut styles, roster-composition constraints (2 QB/PK/DST hard
  cap, 3 RB/3 WR floor within a 12-slot flex budget, no TE floor), a
  $35-38 market-wide price ceiling, and pace-based spend-down pressure so
  simulated teams don't hoard cap unrealistically.
- `run.js` — quick paired-batch runner with basic stats
- `insights.js` — the real report generator: strategy scoreboard, paired
  significance tests, position-spend breakdown, roster composition/bench
  value, robustness by room-persona-mix, auto-generated takeaways
- `run-chunk.js` — runs N replicates and appends JSONL rows to a file. Used
  in ~250-replicate chunks across separate calls because **this
  environment tears down background/nohup processes between tool calls** —
  a single blocking 20+ minute run isn't reliable here. This constraint may
  not apply in Claude Code's environment; a real background process /
  longer single run might just work now. Worth testing directly rather than
  assuming the same limitation applies.
- `aggregate-report.js` — builds the final report from accumulated JSONL
- `run-2000.js` — the intended one-shot entry point (`node run-2000.js`),
  ~20-25 min estimated, written before discovering the chunking constraint.

**Throughput:** ~150-250ms/room depending on strategy complexity. The full
2000-replicate × 4-strategy run (8000 rooms) has been completed three times
this session as fixes landed; final numbers below are from the last
(post-realism-fixes) run.

### Latest validated findings (2000 replicates, `raw-results-2000-v4-final.jsonl`)

- `walkaway` (the tool's real philosophy: marginal starting-lineup value
  above replacement, cap-constrained) wins clearly: mean rank 5.25 of 12,
  top-3 in 28% of rooms.
- `aggressive_yellow` (bid into/past market price) is unambiguously worst —
  the one finding that held rock-solid across every version of this test.
- `efficiency_only` (raw VOR/$, no lineup-fit check) and `stars_and_scrubs`
  are both close to `walkaway` on average once the 2 QB/PK/DST cap was
  enforced (their prior "clearly worse" showing was partly an artifact of
  unlimited QB-stockpiling, since fixed).
- `stars_and_scrubs` has by far the lowest bust rate (1% bottom-3 finishes
  vs 8-9% for everything else) — a genuinely useful floor-protection
  property, though its specific implementation still concentrates hard into
  RB and light into WR; a real positional-balance guardrail on it would be
  the natural next experiment.
- Full report: `insights-report-2000-v4-final.txt`. Raw row-level data:
  `raw-results-2000-v4-final.jsonl` (one JSON object per replicate×strategy,
  includes position counts, spend, bench value, room persona mix).

---

## Deployment status

Blake wants this hosted (GitHub Pages, discussed; Vercel mentioned as an
alternative) instead of downloaded-and-opened-locally, primarily to make the
storage saga above moot. Walked through manually (no GitHub write-access
tool available from claude.ai chat — Blake's connected "GitHub integration"
there is a read-only context-picker, confirmed against Anthropic's own docs,
not a push/write API). **Claude Code likely has real git/gh CLI access —
if Blake has `git` configured with his GitHub credentials locally, actually
creating the repo and pushing via terminal commands would be a much better
experience than the manual web-upload path he was given. Worth checking
early in the new conversation** (`gh auth status` or `git config
--get user.name`, etc.) rather than re-walking him through the web UI.

`index.html` in this bundle is the current file, pre-renamed for a clean
GitHub Pages URL, ready to push as-is.

---

## Open items, roughly in priority order

1. **Get this actually hosted** (see above) — resolves the storage
   uncertainty for good and should probably happen before anything else.
2. **Confirm Blake finished rating his full board** (he had, as of this
   handoff) and that ratings survived whatever storage path he ends up on.
3. **`mustFill` formula recalibration** — the $12-ceiling-for-both-DST-and-PK
   oddity flagged above. Untouched this session; flagged, not fixed.
4. **A Draft Day mode dry run with Blake actually clicking through it live**
   — everything tested this session on Draft Day was headless/simulated
   (render functions, a full pick-logged-then-undone flow, all clean). The
   actual live-feel (slider drag, real-time scarcity indicators) has never
   been human-tested this session.
5. Re-scrape ADP if it's moved since the July snapshot (Blake's task).
6. Rotate the exposed FantasyPros API key (Blake's task, flagged in the
   original project HANDOFF.md, still open).
7. **Not built:** post-draft contract-length assignment (Blake said he'll
   handle manually, per original HANDOFF.md — unchanged this session).

---

## Testing approach used this session (all in claude.ai's sandboxed bash tool)

No real browser was available, so testing escalated through three tiers as
gaps were found the hard way:
1. A hand-rolled DOM mock (`document.getElementById` always returns
   *something*, never `null`) — fast, but blind to any bug where a real
   missing element should legitimately break something.
2. An event-capable version of the same mock (tracks real `addEventListener`
   registrations, supports firing synthetic events) — caught the misplaced
   keydown-listener bug.
3. **jsdom** (`npm install jsdom`, real HTML parsing, real
   `getElementById` semantics, real origin/security model) — this is what
   finally caught the opaque-origin localStorage restriction and gave
   confidence Squad Plan's code itself was clean. This is the tier worth
   defaulting to going forward; the first two have real blind spots.

Claude Code should have an actual browser available (or can install one via
Playwright/Puppeteer) — worth checking, since a real headed or headless
browser is strictly better than even the jsdom tier for anything UI-visual
(CSS, layout, focus rings) that none of this session's testing could ever
actually verify.
