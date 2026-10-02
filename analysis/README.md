# Analysis scripts

One-off investigations behind decisions and answers in `CLAUDE.md`. Run them from the repo root. They reuse the
site's own code (`public/*.js`, loaded via `vm`) so the numbers match the site.

What each needs:
- **matches**: raw matches in `analysis/data/matches*.jsonl` (gitignored). Get them with `fetch-matches.js`.
- **DB**: the local collector database `data/matchups.db`.
- **cache**: ewgf stats cached by `server.js` in `cache/`.
- **state**: build state in `state/`, from `gh release download data-state --dir state`.

| Script | Needs | What it answers |
|---|---|---|
| `fetch-matches.js [windows]` | – | Downloads recent ranked matches from Wavu (~123 windows per day, 1 req/s). `START=<unix t>` fetches older windows, `OUT=<file>` names the output. |
| `series-by-rank.js` | matches | Best-of-3 series outcomes by rank: ended after game 1 ("one and done"), at 1–1, finished. |
| `one-and-done-habits.js [minMeetings]` | matches | Players who almost never continue a series, by rank. Use `node --max-old-space-size=8192` for big samples. |
| `alt-finder.js lo hi version [main]` | DB, state | Best alt for a main: win rate against the main's bad matchups. Example: `33 37 30202 Asuka`. |
| `claim-check-mishima.js` | cache, state | Example claim check: where Reina and the Mishimas land per model and signal. |
| `popularity-vs-winrate.js` | cache | How much of a character's all-ranks win rate gap is just the rank mix. |
| `rank-band-table.js` | cache | Pick share and win rate in three rank bands, per character. |
| `metric-reliability.js` | cache | Split-half reliability of candidate tier-list signals (how Meta signals was chosen). |
| `weight-grid.js` | cache | Meta signals reliability across weight settings (why lift is 0.75). |
| `band-test.js` | cache | Meta signals with different top/mid rank bands. |
| `rank-std-test.js` | cache | Whether rank standardization improves consistency, per rank range. |
| `compare-sources.js [version]` | state | Wavu-derived stats against ewgf's stats for the same patch. |

Scripts that read `cache/stats-30201.json` or other patch-specific files assume patches 3.02.02 and 3.02.01. Update
those numbers for newer patches.
