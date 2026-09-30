// "Meta signals" model: character strength from ewgf per-rank stats (every ranked match, every rank).
//
// Tekken rates each character separately and matches equal ratings, so win rates get squeezed toward
// 50%. Strength also shows up in *who ends up where*. Three signals, each covering another's blind spot:
//   winTop  = win rate at the top ranks, shrunk toward the average (direct performance)
//   pickTop = share of top-rank games (expert revealed preference, but also plain popularity)
//   lift    = log(top share / mid share): over-representation at the top compared to mid ranks,
//             which cancels general popularity; mid (not all) ranks so beginner picks aren't penalized

const META_KEYS = ['winTop', 'pickTop', 'lift'];
const MID_RANKS = [15, 24]; // Garyu – Bushin
const WIN_PRIOR = 500; // pseudo-games at the average top win rate

function rankGames(stats, regions) {
  const c = {};
  for (const reg of regions) for (const [rank, chars] of Object.entries(stats[reg] || {})) {
    const ri = RANKS.indexOf(rank);
    if (ri < 0) continue;
    for (const [name, s] of Object.entries(chars)) {
      const e = c[name] || (c[name] = { g: new Float64Array(RANKS.length), w: new Float64Array(RANKS.length) });
      e.g[ri] += s.games; e.w[ri] += s.wins;
    }
  }
  return c;
}

const rangeSum = (a, lo, hi) => { let s = 0; for (let i = lo; i <= hi; i++) s += a[i]; return s; };

// Raw signals per character for one slice of data.
// `standardize`: compare the top win rate to each top rank's own average (see standardizeByRank).
function metaSignals(stats, regions, topLo, standardize = true) {
  const c = rankGames(stats, regions);
  const names = Object.keys(c);
  const topHi = RANKS.length - 1;
  let tTop = 0, tMid = 0, wTop = 0;
  const rankG = new Float64Array(RANKS.length), rankW = new Float64Array(RANKS.length);
  for (const n of names) {
    tTop += rangeSum(c[n].g, topLo, topHi); tMid += rangeSum(c[n].g, ...MID_RANKS); wTop += rangeSum(c[n].w, topLo, topHi);
    for (let r = topLo; r <= topHi; r++) { rankG[r] += c[n].g[r]; rankW[r] += c[n].w[r]; }
  }
  const avgWin = tTop ? wTop / tTop : 0.5;
  return names.map((name) => {
    const g = c[name].g, w = c[name].w;
    const gTop = rangeSum(g, topLo, topHi), gMid = rangeSum(g, ...MID_RANKS);
    const shareTop = gTop / tTop, shareMid = gMid / tMid;
    let winsTop = rangeSum(w, topLo, topHi);
    if (standardize && gTop) {
      let d = 0, ws = 0;
      for (let r = topLo; r <= topHi; r++) {
        if (!g[r] || !rankG[r]) continue;
        d += (rankG[r] / tTop) * (w[r] / g[r] - rankW[r] / rankG[r]);
        ws += rankG[r] / tTop;
      }
      winsTop = (avgWin + (ws ? d / ws : 0)) * gTop;
    }
    return {
      name, gamesTop: gTop,
      winRaw: gTop ? rangeSum(w, topLo, topHi) / gTop : NaN,
      winTop: (winsTop + WIN_PRIOR * avgWin) / (gTop + WIN_PRIOR),
      pickTop: shareTop,
      lift: Math.log((shareTop + 1e-6) / (shareMid + 1e-6)),
    };
  }).filter((r) => r.gamesTop > 0);
}

// z-score each signal across characters and take the weighted mean.
function metaScore(rows, weights) {
  const wsum = META_KEYS.reduce((a, k) => a + weights[k], 0) || 1;
  const z = {};
  for (const k of META_KEYS) {
    const v = rows.map((r) => r[k]);
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length) || 1;
    z[k] = v.map((x) => (x - m) / sd);
  }
  rows.forEach((r, i) => {
    r.z = Object.fromEntries(META_KEYS.map((k) => [k, z[k][i]]));
    r.score = META_KEYS.reduce((a, k) => a + weights[k] * z[k][i], 0) / wsum;
  });
  return rows;
}

function spearmanByName(a, b) {
  const names = a.map((r) => r.name).filter((n) => b.some((r) => r.name === n));
  const rank = (rows) => {
    const s = rows.filter((r) => names.includes(r.name)).sort((x, y) => y.score - x.score);
    return Object.fromEntries(s.map((r, i) => [r.name, i]));
  };
  const ra = rank(a), rb = rank(b), n = names.length;
  if (n < 3) return NaN;
  return 1 - (6 * names.reduce((s, x) => s + (ra[x] - rb[x]) ** 2, 0)) / (n * (n * n - 1));
}

// Full model: score on all regions of the latest patch, plus the same model re-run on independent
// slices (each big region, the rest of the world, the previous patch) to show how stable each
// character's position is and how well independent halves agree.
function metaModel(latestStats, prevStats, { topLo = 29, weights = { winTop: 1, pickTop: 1, lift: 1 } } = {}) {
  const ALL = Object.keys(latestStats);
  const run = (stats, regions) => metaScore(metaSignals(stats, regions, topLo), weights);
  const rows = run(latestStats, ALL).sort((a, b) => b.score - a.score);

  const others = ALL.filter((r) => !['Asia', 'Americas', 'Europe'].includes(r));
  const slices = [
    ['Asia', run(latestStats, ['Asia'])],
    ['Americas', run(latestStats, ['Americas'])],
    ['Europe', run(latestStats, ['Europe'])],
    ['Other regions', run(latestStats, others)],
  ];
  if (prevStats) slices.push(['Previous patch', run(prevStats, Object.keys(prevStats))]);

  for (const r of rows) {
    const scores = [], ranks = [];
    for (const [, s] of slices) {
      const sorted = [...s].sort((a, b) => b.score - a.score);
      const i = sorted.findIndex((x) => x.name === r.name);
      if (i >= 0) { scores.push(sorted[i].score); ranks.push(i + 1); }
    }
    r.ciLo = Math.min(r.score, ...scores); r.ciHi = Math.max(r.score, ...scores);
    r.rankLo = Math.min(...ranks); r.rankHi = Math.max(...ranks);
  }
  const rest = run(latestStats, ALL.filter((r) => r !== 'Americas'));
  return {
    rows,
    regionAgreement: spearmanByName(slices[1][1], rest),
    patchAgreement: prevStats ? spearmanByName(rows, slices[slices.length - 1][1]) : NaN,
    topGames: rows.reduce((a, r) => a + r.gamesTop, 0),
  };
}
