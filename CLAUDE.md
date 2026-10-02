# Tekken 8 - Facts and statistics: AI handoff

Read this first when continuing development (any AI assistant or human). It sums up what exists, why it is built
this way, the owner's preferences, and what's next. Details live in README.md and in the code comments.

- **Live site:** https://mulkmulkmulk.github.io/Facts-and-statistics/
- **Repo:** https://github.com/mulkmulkmulk/Facts-and-statistics (public; GitHub Pages via Actions)
- **Owner:** mulkmulkmulk, a Finnish Tekken player (Asuka main, GoD IV). Writes in Finnish or English.
- **Nature:** non-profit research site, with a Ko-fi link in the footer (https://ko-fi.com/mulkmulkmulk).

## Owner's rules and preferences (follow these)

1. **Never publish without being asked.** Pushing to `main` deploys the live site. Commit or push only when the owner asks.
   Code changes go out by push; the data refreshes automatically.
2. **No "character X must be rank Y" tuning.** Community expectations (e.g. "Asuka should be bottom 5") may be used only
   as a local sanity check. Never encode them in code, README, weights or defaults. Choose methods on principle, e.g.
   split-half reliability, and never by where characters land.
3. **Natural breaks (Jenks) is the default tier cut.** Keep the other cuts (quantile, SD bands, CI overlap) available as options.
4. **Explanations:** each method has a short, plain, Tekken-flavoured description that's always visible. The long
   explanation plus a Wikipedia link sits behind the "Explain methods" tickbox, in a card above the tier list.
5. **Keep the first view clean.** Secondary views (full table, matchup chart, details) sit behind buttons. Explorer
   settings start collapsed on every screen size. The method picker is outside the settings.
6. **Explorer default rank range is GoD IV and up.** Don't mention this anywhere on the site.
7. **Tab order:** Explorer first (default), Best estimate second. The two Best estimate model names
   ("Meta signals", "Matchup consensus") are placeholders the owner will rename.
8. **Rank colours:** Garyu – Battle Ruler = **purple**, Fujin – Bushin = **blue**.
9. Before big method changes, test on data first (consistency between regions and patches) and show the evidence.

**Permissions** (obtained by the owner): the ewgf.gg developer allowed using their data; Wavu Wank and tekkendocs are fine;
the Bandai Namco community manager OK'd character art for a non-profit research site. Icons come from the tiermaker
Tekken 8 template (`public/icons/<slug>.png`).

## Layout

```
public/              front end (plain JS, no build step, no dependencies)
  index.html         tabs: Explorer, Best estimate; footer credits + Ko-fi
  config.js          SITE_MODE = 'server' locally; the build writes 'static'
  data.js            data layer: /api/* from server.js locally, data/*.json on the static site
  app.js             Explorer, page chrome, tier list rendering, matchup chart
  best.js            Best estimate tab: model switch, Tune panel, details table
  stats.js           aggregation, Wilson/Bayes, rank standardization, versus methods, Nash, tier cuts
  consensus.js       "Matchup consensus" model + bootstrap + Jenks auto tier count
  metasignals.js     "Meta signals" model (top win rate + top pick + climb lift) + region/patch consistency
  ranks.js           rank ladder, presets, DLC release dates (NEW badge), auto-release detection
server.js            local dev server: live ewgf + local matchup DB
collector.js         local, long-running: every ranked match from Wavu → data/matchups.db (matchup totals + per-player table)
lib/ewgf.js          ewgf.gg access (statistics page + internal getVersionStatistics action; ids rediscovered)
lib/wank.js          Wavu Wank replay feed helpers
lib/characters.js    character id map fallback + region ids
scripts/build-data.js  static build: bootstrap | update | site
scripts/serve-dist.js  preview the built static site on :5181
analysis/            one-off analysis scripts (see analysis/README.md)
.github/workflows/daily.yml  build + deploy (twice daily, on push to main, manual)
backups/             local snapshot of an earlier liked build (gitignored)
```

## Data sources and pipeline

- **Wavu Wank** (`https://wank.wavu.wiki/api/replays?before=T`): a public API with every ranked match in 700-second
  windows. Etiquette: one request at a time, about 1 per second. This is the source for matchups, and on the public site
  also for current-season character stats.
- **ewgf.gg:** the official API covers players only, so stats come from the statistics page's embedded data plus its
  internal `getVersionStatistics` server action. The action id changes on every ewgf deploy and is rediscovered from the
  page's JS (`lib/ewgf.js`). **ewgf's Cloudflare returns 403 to GitHub's runners.** The build therefore treats ewgf as
  optional: season patches watched from their first day get stats computed from Wavu (tier order agreed 0.998 with ewgf),
  and older patches use saved ewgf copies.
- **Static site:** `.github/workflows/daily.yml` has a `build` job (download state → `update` → `site` → save state →
  upload Pages artifact) and a separate `deploy` job. The running state (`state/`: matchup totals per patch, cursor,
  first-seen times, ewgf copies) lives in the **`data-state` release** assets, not in git. It runs at 04:17 and 16:47 UTC
  (GitHub skipped a schedule once), on push to main, and manually. CSS/JS links get a build stamp to beat the 10-minute
  Pages cache.
- **Local:** `server.js` (http://localhost:5180) serves `public/` with live ewgf and `data/matchups.db`. `collector.js`
  fills the DB: matchup totals `mu(version, region, rank, ch, opp)` and the per-player table
  `pc(version, player, ch, rank bands…)`. **The DB is not in git.**

## Models and statistical decisions (and why)

- **Ladder compression:** Tekken rates each character separately and matches equal ratings, so win rates sit near 50%
  (actual ≈ rating-expected for every character). Strength shows more in *who ends up where*, which is why the
  default Best estimate uses pick and placement signals. A rating-adjusted win rate was tried and dropped (always ≈ 0).
- **Meta signals (Best estimate default):** top win rate (GoD+, rank-standardized, shrunk by 500) + top pick share +
  climb lift (share at GoD+ ÷ share at Garyu–Bushin), z-scored, weights **1 : 1 : 0.75**. Lift at 0.75 had the best
  region agreement (0.90 vs 0.87); 0.25–0.75 are all about equal; removing lift hurts. "Top" stays at GoD+: GoD IV+
  drops region agreement to ~0.53, and GoD VI+ to ~0.06 (pure noise).
- **Matchup consensus:** practical / intrinsic / Nash-competitive from the pooled matchup matrix, 40/40/20, bootstrap CIs.
- **Matchup pooling:** the rank filter applies to the row player only, so a→b is pooled with the flipped b→a (the
  "high-rank player beats lower opponent" edge cancels). Mirrors are pinned to 50%; leaving the observed mirror cell in
  once broke Nash.
- **Rank standardization** (Simpson's paradox inside a rank range): Explorer "Auto" turns it on from Tekken King up,
  because it helped consistency there and added noise in wide/low ranges. It's always on for the Meta signals win rate.
- **"Regions agree"** readouts (Americas vs rest, rank correlation) measure consistency, not correctness. Plain
  popularity is very consistent too.
- **NEW badge:** DLC released less than 60 days ago (dates in `ranks.js`, plus automatic first-seen detection).
- **Known limits:** games cluster by player (a few grinders dominate low-pick characters at the top); per-character
  ranks invert League-style "learning curve" ideas; ranked series are **best of 3** games (2–0 or decider).

## Findings log (questions already answered with data)

- "Reina/Mishimas are casual-popular and that drags their average down": mostly false at high ranks. True in part for
  the all-ranks numbers: the rank mix explains about 25% of Reina's and Kazuya's deficit and about 40% of Jin's.
  Kazuya, Jin, Heihachi and Reina are top 11 in pick share overall.
- One-and-done (series ended after game 1): about 40% below GoD, 34% in GoD–GoD III, 25% at GoD IV+. It's the same
  whether the first game was won or lost. About 4.5–5% of regulars below GoD almost never rematch (about 13% of
  one-and-dones), against 0.7% at GoD IV+. 2-game meetings are 91% 2–0; 3-game meetings are 99% 1–1 deciders.
- Asuka alt at GoD IV+: Panda, Fahkumram and Claudio are the most consistent coverage picks; the differences are only 1–2 points.

## Continuing on a new machine

1. Install Node 24 (needs built-in `fetch` and `node:sqlite`) and the GitHub CLI (`gh auth login`). Clone the repo.
2. **Front end work without the database:** `gh release download data-state --dir state`, then
   `node scripts/build-data.js site` and `node scripts/serve-dist.js` (http://localhost:5181). This is the full static
   site with real data.
3. `node server.js` runs the live/local mode. Without `data/matchups.db`, matchup features say "no data" until
   `node collector.js` has collected some. The collector backfills toward the season start at about 1 req/s (hours)
   and resumes after restarts.
4. **Never run `bootstrap` and upload `state/*` to the release from an incomplete local DB.** That would overwrite the
   season's matchup totals with less data. The daily workflow keeps the release up to date by itself.
5. Analysis scripts that need raw matches: `node analysis/fetch-matches.js 250` (about 2 days) writes
   `analysis/data/matches.jsonl` (gitignored).

## Backlog

- **Switch-in rate and climb rate** from the per-player `pc` table (needs the local DB with the pc backfill done).
  Test both with the region/patch consistency check before adding them to the Best estimate.
- **Fact check tab** (parked; the owner wants to keep the idea): reusable views for checking community claims, such as
  pick share by rank band, rank-mix-corrected win rates and a head-to-head lookup.
- Possibly trim the Best estimate intro box and the long summary lines (the owner found the first view busy).
- Rename the two Best estimate models (owner's call).
- Matchup chart: fade cells whose interval includes 50% (needs player-level uncertainty first).
- Parked: patch trend arrows (wait for a real balance patch; 3.02.02 was bug fixes only), and a learning-curve
  win rate (doesn't fit per-character ranks).
- Minor: `collector.js` still has its own copies of the fetch and normRank helpers that live in `lib/wank.js`.

## Gotchas

- Git Bash rewrites environment values that start with `/` into Windows paths (`OUT=/x` became `C:\Program Files\Git\x`).
- GitHub may skip scheduled runs, and the Pages deploy gate once hung (fixed by the two-job workflow).
- A Pages change can take up to 10 minutes to show for returning visitors (`max-age=600`); a hard refresh fixes it.
