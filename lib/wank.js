// Wavu Wank's public replay feed (https://wank.wavu.wiki/api): every ranked Tekken 8 match.
// GET /api/replays?before=T → all replays with battle_at in (T-700, T]. Wavu's guidance: one request in
// flight at a time, ~1 req/s, step `before` by 700.

const FEED = 'https://wank.wavu.wiki/api/replays';
const WINDOW = 700;
const MIN_VERSION = Number(process.env.MIN_VERSION || 30000); // Season 3 = patch 3.00.00+
const LAG = 15 * 60; // leave the newest 15 min alone so windows are complete when fetched
const REQUEST_GAP_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Newest window end that's safe to fetch.
const readyT = () => Math.floor((Date.now() / 1000 - LAG) / WINDOW) * WINDOW;

async function fetchWindow(t, userAgent = 'tekken-facts (non-profit stats site)') {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${FEED}?before=${t}`, { headers: { 'User-Agent': userAgent } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      const wait = Math.min(300, 15 * 2 ** attempt);
      console.warn(`window ${t}: ${e.message}, retrying in ${wait}s`);
      await sleep(wait * 1000);
    }
  }
}

// Bandai uses 100–107 and 765 as alternate ids for the GoD ranks.
function normRank(r) {
  if (r >= 100 && r <= 107) return r - 71;
  if (r === 765) return 37;
  return r;
}

const isSeasonRanked = (b) => b.battle_type === 2 && b.game_version >= MIN_VERSION; // 2 = ranked

module.exports = { WINDOW, MIN_VERSION, REQUEST_GAP_MS, sleep, readyT, fetchWindow, normRank, isSeasonRanked };
