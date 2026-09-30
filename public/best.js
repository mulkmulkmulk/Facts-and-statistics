// "Best estimate" tab. Two models:
//   meta       – top win rate + top pick rate + climb lift from ewgf per-rank stats (metasignals.js)
//   consensus  – practical / intrinsic / Nash from the collected matchup chart (consensus.js)

const BEST_DEFAULTS = {
  bModel: 'meta',
  // Lift at 0.75: best region split-half agreement (0.90 vs 0.87 at equal weights); 0.25–0.75 all reproduce about equally.
  mwW: '1', mwP: '1', mwL: '0.75', mTop: '29',
  bwI: '0.4', bwC: '0.4', bwP: '0.2', bMode: 'z', bK: '100', bRanks: 'auto', bScope: 'auto',
  bCut: 'jenks', bTiers: 'auto',
};
const BEST_FIELDS = Object.keys(BEST_DEFAULTS).filter((f) => f !== 'bModel');
let bestModel = 'meta';
let bestLatest = null, bestPrev = null, bestTimer = null, bestRun = 0;

// ---- data ------------------------------------------------------------------

const statsCache = new Map();
function bestStats(v) {
  if (!statsCache.has(v)) statsCache.set(v, api(`/api/stats?v=${v}`).then((d) => d.stats));
  return statsCache.get(v);
}

const RANK_CANDIDATES = [33, 29, 25, 21, 0]; // GoD IV+, GoD+, TK+, Fujin+, all
// "Enough data" for the matchup model: every character has this many games, nearly every matchup a real sample.
const ENOUGH = { charGames: 5000, pairGames: 200, pairShare: 0.9 };
const cellCache = new Map();

async function bestFetch(rankLo, version) {
  const q = new URLSearchParams({ rankLo, rankHi: RANKS.length - 1, version }).toString();
  if (!cellCache.has(q)) cellCache.set(q, api('/api/matchups?' + q).then((d) => (d.available ? d.cells : [])));
  return cellCache.get(q);
}

function enoughData(cells) {
  if (!cells.length) return false;
  const { n, G, games } = matchupMatrix(cells, true);
  if (Math.min(...games) < ENOUGH.charGames) return false;
  let ok = 0, pairs = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { pairs++; if (G[i][j] >= ENOUGH.pairGames) ok++; }
  return ok / pairs >= ENOUGH.pairShare;
}

// Highest rank floor first (least skill bias), latest patch before whole season.
async function pickMatchupData(s) {
  const ranks = s.bRanks === 'auto' ? RANK_CANDIDATES : [+s.bRanks];
  const scopes = s.bScope === 'auto' ? ['patch', 'season'] : [s.bScope];
  let last = null;
  for (const r of ranks) for (const sc of scopes) {
    const cells = await bestFetch(r, sc === 'patch' ? bestLatest : 'season');
    last = { rankLo: r, scope: sc, cells };
    if (enoughData(cells)) return { ...last, enough: true };
  }
  return { ...last, enough: false };
}

// ---- controls ----------------------------------------------------------------

function bestState() {
  return { bModel: bestModel, ...Object.fromEntries(BEST_FIELDS.map((f) => [f, $(f).value])) };
}

function setModel(m) {
  bestModel = m === 'consensus' ? 'consensus' : 'meta';
  document.querySelectorAll('[data-model]').forEach((b) => b.setAttribute('aria-checked', b.dataset.model === bestModel));
  document.querySelectorAll('#tab-best [data-for]').forEach((el) => { el.hidden = el.dataset.for !== bestModel; });
}

function syncBestControls() {
  for (const f of ['bwI', 'bwC', 'bwP']) $(f + 'Val').textContent = Math.round(+$(f).value * 100) + '%';
  const mw = ['mwW', 'mwP', 'mwL'], total = mw.reduce((a, f) => a + +$(f).value, 0) || 1;
  for (const f of mw) $(f + 'Val').textContent = Math.round((+$(f).value / total) * 100) + '%';
  $('bKVal').textContent = $('bK').value + ' games';
  $('bTiersWrap').hidden = $('bCut').value !== 'jenks';
}

function scheduleBest() {
  syncBestControls();
  store('best', JSON.stringify(bestState()));
  clearTimeout(bestTimer);
  bestTimer = setTimeout(renderBest, 150);
}

// ---- rendering ---------------------------------------------------------------

function applyTiers(rows, s) {
  if (s.bCut === 'overlap') {
    cutOverlap(rows).forEach((t, i) => { rows[i].tier = t; });
    return 'tiers split where ranges stop overlapping';
  }
  const j = jenksAuto(rows, 0.92, s.bTiers === 'auto' ? null : +s.bTiers);
  j.tiers.forEach((t, i) => { rows[i].tier = t; });
  return `${j.k} tiers explain ${Math.round(j.gvf * 100)}% of the spread`;
}

async function renderBest() {
  const run = ++bestRun;
  const s = bestState();
  try {
    if (s.bModel === 'consensus') await renderConsensus(s, run);
    else await renderMeta(s, run);
  } catch (e) {
    if (run === bestRun) $('bestSummary').textContent = 'Error: ' + e.message;
  }
}

async function renderMeta(s, run) {
  $('bestSummary').textContent = 'Loading ewgf stats…';
  const [latest, prev] = await Promise.all([bestStats(bestLatest), bestPrev ? bestStats(bestPrev).catch(() => null) : null]);
  if (run !== bestRun) return;
  const model = metaModel(latest, prev, {
    topLo: +s.mTop,
    weights: { winTop: +s.mwW, pickTop: +s.mwP, lift: +s.mwL },
  });
  const rows = model.rows;
  const note = applyTiers(rows, s);
  const agree = (v) => (Number.isNaN(v) ? '–' : v.toFixed(2));
  $('bestSummary').innerHTML = `<b>${shortRank(RANKS[+s.mTop])}</b> and up vs mid ranks · patch ${formatVersion(bestLatest)} · ` +
    `${compact(model.topGames)} top-rank games · regions agree <b>${agree(model.regionAgreement)}</b>` +
    (bestPrev ? ` · patches agree <b>${agree(model.patchAgreement)}</b>` : '') + ` · ${note}`;

  rows.forEach((c, i) => { c.rank = i + 1; });
  renderTierList($('bestList'), rows, [], metaTip);
  $('bestDetailsHint').innerHTML = 'Score = average of the three signals as z-scores (0 = average character). The bar spans the character\'s score across ' +
    'independent slices (Asia, Americas, Europe, other regions, previous patch); <b>rank range</b> is its best and worst position in those slices. ' +
    'Regions can differ for real (different metas), so a wide bar isn\'t only noise.';
  renderScoreTable(rows, ['Top win rate', 'Top pick rate', 'Climb lift', 'Top games'], (c) => [
    pct(c.winRaw, 2), pct(c.pickTop, 2), `${Math.exp(c.lift).toFixed(2)}×`, c.gamesTop.toLocaleString(),
  ]);
}

function metaTip(c) {
  return `<b>${c.name}</b> · #${c.rank} (${c.rankLo}–${c.rankHi} across slices)<br>
    Top win rate ${pct(c.winRaw, 2)}<br>Top pick rate ${pct(c.pickTop, 2)}<br>
    Climb lift ${Math.exp(c.lift).toFixed(2)}× (top share ÷ mid share)<br>${c.gamesTop.toLocaleString()} top-rank games`;
}

async function renderConsensus(s, run) {
  $('bestSummary').textContent = 'Picking data…';
  const data = await pickMatchupData(s);
  if (run !== bestRun) return;
  if (!data.cells.length) {
    $('bestList').innerHTML = '<p class="empty">No collected matchups yet. Start <code>node collector.js</code>.</p>';
    $('bestSummary').textContent = '';
    return;
  }
  $('bestSummary').textContent = 'Computing (bootstrapping 60 resamples)…';
  await new Promise((r) => setTimeout(r, 20)); // let the status paint before the heavy work
  const rows = consensus(data.cells, {
    k: +s.bK, mode: s.bMode,
    weights: { intrinsic: +s.bwI, competitive: +s.bwC, practical: +s.bwP },
  });
  if (run !== bestRun) return;
  const note = applyTiers(rows, s);
  const matches = data.cells.reduce((a, c) => a + c[2], 0) / 2;
  const scope = data.scope === 'patch' ? `patch ${formatVersion(bestLatest)}` : 'whole season';
  $('bestSummary').innerHTML = `<b>${shortRank(RANKS[data.rankLo])}</b> and up · ${scope} · ${compact(Math.round(matches))} matches · ${note}` +
    (data.enough ? '' : ' · <span class="warn">thin data: widen ranks or use the whole season</span>');

  rows.forEach((c, i) => { c.rank = i + 1; });
  renderTierList($('bestList'), rows, [], consensusTip);
  $('bestDetailsHint').innerHTML = 'Score = weighted combination (0 = average character). The bar shows the 90% interval from the bootstrap; ' +
    '<b>rank range</b> is where the character lands in 90% of resamples. Overlapping bars mean the order between them isn\'t certain.';
  renderScoreTable(rows, ['Practical', 'Intrinsic', 'Competitive', 'Nash mix'], (c) => [
    pct(c.practical, 2), pct(c.intrinsic, 2), pct(c.competitive, 2), c.nash ? pct(c.nash, 1) : '–',
  ]);
}

function consensusTip(c) {
  return `<b>${c.name}</b> · #${c.rank}${c.rankLo ? ` (likely ${c.rankLo}–${c.rankHi})` : ''}<br>
    Practical ${pct(c.practical, 1)} · Intrinsic ${pct(c.intrinsic, 1)}<br>
    Competitive ${pct(c.competitive, 1)}${c.nash ? ` · Nash mix ${pct(c.nash, 1)}` : ''}<br>
    ${c.games.toLocaleString()} games`;
}

// Shared details table: rank, tier, score + range bar, rank range, then model-specific columns.
function renderScoreTable(rows, extraHead, extraCells) {
  // The interval can sit slightly off the point estimate, so the scale covers both.
  const lo = Math.min(...rows.map((c) => Math.min(c.ciLo, c.score))), hi = Math.max(...rows.map((c) => Math.max(c.ciHi, c.score)));
  const x = (v) => ((v - lo) / (hi - lo || 1)) * 100;
  const head = ['#', 'Tier', 'Character', 'Score', 'Confidence', 'Rank range', ...extraHead];
  const body = rows.map((c) => {
    const a = Math.min(c.ciLo, c.score), b = Math.max(c.ciHi, c.score);
    return `<tr>
    <td>${c.rank}</td><td>${tierBadge(c.tier)}</td><td>${c.name}</td>
    <td class="n strong">${c.score.toFixed(2)}</td>
    <td class="ci-cell"><div class="ci"><span class="ci-bar" style="left:${x(a)}%;width:${Math.max(0.8, x(b) - x(a))}%;background:${TIER_COLORS[c.tier % TIER_COLORS.length]}"></span><span class="ci-dot" style="left:${x(c.score)}%"></span></div></td>
    <td class="n">${c.rankLo === c.rankHi ? c.rankLo : `${c.rankLo}–${c.rankHi}`}</td>
    ${extraCells(c).map((v) => `<td class="n">${v}</td>`).join('')}
  </tr>`;
  }).join('');
  $('bestTable').innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody>`;
}

// ---- init ------------------------------------------------------------------

async function initBest() {
  let saved = {};
  try { saved = JSON.parse(recall('best') || '{}'); } catch {}
  for (const f of BEST_FIELDS) $(f).value = saved[f] ?? BEST_DEFAULTS[f];
  setModel(saved.bModel || BEST_DEFAULTS.bModel);
  syncBestControls();
  for (const f of BEST_FIELDS) $(f).addEventListener('input', scheduleBest);
  document.querySelectorAll('[data-model]').forEach((b) => b.addEventListener('click', () => { setModel(b.dataset.model); scheduleBest(); }));
  $('bReset').addEventListener('click', () => { for (const f of BEST_FIELDS) $(f).value = BEST_DEFAULTS[f]; scheduleBest(); });
  $('bestTuneBtn').addEventListener('click', () => {
    const open = $('bestTune').hidden;
    $('bestTune').hidden = !open;
    $('bestTuneBtn').setAttribute('aria-expanded', open);
    $('bestTuneBtn').textContent = open ? 'Tune ▴' : 'Tune ▾';
  });
  const { latest, versions } = await appReady;
  bestLatest = latest;
  bestPrev = versions[versions.indexOf(latest) + 1] || null;
  renderBest();
}

initBest();
