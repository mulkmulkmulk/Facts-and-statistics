# Tekken 8 - Facts and statistics

Tier lists built from live [ewgf.gg](https://ewgf.gg/statistics) ranked data, with switchable scoring and tier-cut methods.

```
node server.js                    # http://localhost:5180
```

No dependencies (Node 18+ for built-in `fetch`).

## Public site (GitHub Pages)

The public site is static. A daily GitHub Actions job (`.github/workflows/daily.yml`) runs:

```
node scripts/build-data.js update   # new ewgf stats + new Wavu matches → state/
node scripts/build-data.js site     # public/ + data/*.json → dist/, deployed to Pages
```

The front end is identical in both modes. `public/data.js` answers `/api/*` from `server.js` locally, or from
`data/*.json` on the static site; `config.js` switches the mode. The running state (matchup totals per patch, a cursor,
first-seen time per character) is stored as assets of a `data-state` release, so git history doesn't grow daily.

New characters need no code changes. Names come from ewgf's own character id list, and unknown ids still show up as
"Character N". The NEW badge is set automatically from the first day a character appears in the data; `RELEASES` in
`ranks.js` is only an optional override. Only an icon has to be added by hand (`public/icons/<slug>.png`), and until
then the tile shows initials.

**One-time setup:**
1. Create the GitHub repo from this folder and push it (`.gitignore` excludes the large local data).
2. Settings → Pages → Source: **GitHub Actions**.
3. Seed the state from your local collector so the site starts with the whole season:
   `node scripts/build-data.js bootstrap`, then `gh release create data-state --prerelease --title "Data state (automated)" --notes "Running state for the daily site build." state/*`
4. Actions → "Daily data update" → Run workflow. After that it runs every day at 04:17 UTC.

Preview a build locally with `node scripts/build-data.js site && node scripts/serve-dist.js` (http://localhost:5181).

## Where the data comes from

ewgf.gg's public API (`api.ewgf.gg/external/*`) only covers individual players. The statistics page itself, though, embeds
`stats[region][rank][character] = { games, wins }` for every region (Asia, Europe, Americas, Middle East, Oceania, unset)
and every rank from Beginner to God of Destruction Infinity. `server.js`:

- scrapes `/statistics` for the version list and the latest patch once a day (snapshot in `cache/latest.json`; the Refresh button forces it)
- calls the page's own `getVersionStatistics` server action for older patches (cached to `cache/` forever, since old patches don't change)
- rediscovers the server-action id from the page JS when ewgf deploys and the old id stops working

Both are undocumented and can break if ewgf changes its site. Keep the request volume low.

## Matchups (own database)

```
node collector.js          # runs forever: stays current + backfills to season start
node collector.js --once   # catch up, then exit
```

Reads [Wavu Wank](https://wank.wavu.wiki/api)'s public replay feed, which has every ranked match, one 700-second window per request.
It sends one request at a time at about 1/s, as Wavu's docs suggest. Only the current season is kept (`MIN_VERSION`, default 30000 = patch 3.00.00),
and only as aggregates in `data/matchups.db`: games / wins / rating-expected wins per (patch, region, rank, character, opponent).
Raw replays would be ~700k/day.

## Best estimate tab

Two models, switchable at the top of the tab (names are provisional).

### Meta signals (default), `metasignals.js`

Tekken rates each character separately and matches equal ratings, so win rates are squeezed toward 50%.
Character strength also shows in *who ends up at the top*. Three signals from ewgf's per-rank stats (latest patch, all regions):

| Signal | Definition | Blind spot it covers |
|---|---|---|
| Top win rate | wins / games at GoD+ (shrunk by 500 pseudo-games) | direct performance, but compressed by matchmaking |
| Top pick rate | share of GoD+ games | expert revealed preference, but also popularity |
| Climb lift | log(share at GoD+ / share at Garyu–Bushin) | cancels general popularity; mid ranks so beginner picks aren't penalized |

The three are z-scored and averaged with weights 1 : 1 : 0.75 (win : pick : lift). The weights were picked only by split-half
reliability, never by where characters land. Americas vs rest agreement was 0.87 at equal weights and 0.90 with lift at 0.75.
Lift from 0.25 to 0.75 all reproduce about equally, and dropping lift entirely hurts patch agreement (0.93 → 0.89). The same model is re-run on
independent slices (Asia, Americas, Europe, other regions, previous patch). The page shows the rank correlation between
Americas and the rest of the world ("regions agree"), and each character's rank range across slices.

When this was chosen, split-half agreement (regions / patches) was 0.87 / 0.93. The Explorer's composite reached only 0.39 / 0.63,
and the matchup-only methods reproduced well but compress differences.

### Matchup consensus, `consensus.js`

Builds the list from the collected matchups:

1. **Data:** the highest rank floor (GoD IV+ → GoD+ → TK+ → Fujin+) and latest patch (then whole season) where every character
   has ≥ 5,000 games and ≥ 90% of matchups have ≥ 200 games.
2. **Three metrics:** *practical* (win rate vs the real field), *intrinsic* (average head-to-head, opponents weighted equally) and
   *competitive* (win rate vs the Nash-equilibrium mix of the matchup game). Matchups are shrunk toward 50% by *k* = 100 pseudo-games.
3. **Combine:** z-scores (or Borda ranks), weighted 40 / 40 / 20 (intrinsic / competitive / practical).
4. **Tiers:** Jenks natural breaks with the fewest tiers explaining ≥ 92% of variance (or a fixed count, or CI overlap).
5. **Uncertainty:** 60 bootstrap resamples of every matchup record give a 90% interval for each score and rank.

## Statistical safeguards

- **Rank standardization:** within a rank range, average win rate varies a lot near the top (≈49% at GoD, 74% at GoD VII),
  so a character whose players sit higher gets a free boost (Simpson's paradox). Each character is compared to its own rank's
  average and weighted by the overall rank mix. In the Explorer it's on automatically from Tekken King up: split-half tests
  showed it improves consistency there (Wilson at GoD+ 0.87 → 0.91) but adds noise in wide or low ranges.
  It's always on for Meta signals' top win rate.
- **Consistency readout:** every Explorer view shows "regions agree", the rank correlation of the same method on Americas vs
  the other selected regions. It measures consistency, not correctness: plain popularity is very consistent too.
- **New characters:** DLC released under 60 days ago gets a NEW badge and a caveat, because release hype and players still
  learning the character distort pick rate, lift and win rate. Release dates are in `ranks.js`.
- **Per-player data:** `collector.js` also keeps per-player totals (`pc` table) to measure player-level uncertainty and to
  count players rather than games. A few heavy grinders can dominate a low-pick character's numbers.

## Scoring methods (Explorer tab)

| Method | Idea |
|---|---|
| Composite | `A·W + B·P + C·W·P` with W = win metric, P = pick share, both normalized so the best = 1 |
| Wilson lower bound | Bottom of the win-rate confidence interval; penalizes small samples |
| Bayesian shrunk | Beta-binomial empirical Bayes; low-sample win rates pulled toward the mean |
| Raw win rate | wins / games |

Versus-based methods, from the collected matchups:

| Method | Idea |
|---|---|
| Nash equilibrium | Treats picking a character as a zero-sum game, finds the unexploitable character mix, and scores each character by its win rate vs that mix |
| Bradley–Terry | One strength per character fitted to all head-to-head results, shown as expected win rate vs an average opponent |
| Average matchup | Mean of a character's matchup win rates, every opponent weighted equally |
| Win rate vs actual field | Plain collected win rate, for comparison |

Each matchup gets a prior of *k* pseudo-games at 50%. The rank filter applies to the row player only, so a→b is pooled with the flipped b→a.
The "high-rank player beats lower-ranked opponent" edge then cancels, and a vs b = 1 − b vs a.
A rating-adjusted win rate isn't offered because Tekken ratings are per character, so wins minus rating-expected wins is always ~0.

Mirror-match correction (optional) removes the 50% that mirrors contribute, assuming mirror frequency ≈ pick share.

## Tier cuts

Bell-curve quantiles · standard-deviation bands · natural breaks (Jenks) · statistical ties (a new tier starts when a
character's Wilson interval no longer overlaps the tier leader's).

## Icons

Put images in `public/icons/<slug>.png` (e.g. `armor-king.png`, `jack-8.png`, `devil-jin.png`). Tiles fall back to initials.
