const $ = (id) => document.getElementById(id);
let current = null; // ewgf stats payload for the selected patch
let icons = {}; // slug -> image path, from /api/icons

// Short Tekken-flavoured description (always shown) + longer explanation and a Wikipedia link
// (shown with "Explain methods").
const METHOD_INFO = {
  composite: {
    desc: 'Rewards characters that win a lot even though everyone plays them and knows the matchup. Penalizes rarely picked characters.',
    more: 'Score = A·W + B·P + C·W·P, where W is the win metric and P the pick rate, both turned into 0–1 (best = 1). The W·P term only pays out when a character is both strong and common.',
    wiki: ['Weighted sum model', 'https://en.wikipedia.org/wiki/Weighted_sum_model'],
  },
  wilson: {
    desc: 'Win rate, but a character only gets credit for what it has proven. Low-play characters are pushed down until they have the games to back it up.',
    more: 'Uses the lower end of the win rate\'s confidence interval: "we are X% sure the true win rate is at least this".',
    wiki: ['Wilson score interval', 'https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval'],
  },
  bayes: {
    desc: 'Win rate, with rarely played characters pulled toward average so a lucky week can\'t put them on top.',
    more: 'Empirical-Bayes beta-binomial shrinkage: each win rate is blended with the overall average, weighted by sample size. How hard to pull is estimated from how much win rates really vary.',
    wiki: ['Empirical Bayes', 'https://en.wikipedia.org/wiki/Empirical_Bayes_method'],
  },
  winrate: {
    desc: 'Plain wins divided by games. Simple but noisy for characters few people play.',
    more: 'Pair it with a higher min-games filter. Rare characters also tend to be played by dedicated mains, which inflates their numbers.',
  },
  vsNash: {
    desc: 'Who belongs in the best possible counterpick pool? Characters with no bad matchups against the strongest picks rise to the top.',
    more: 'Treats character select as a zero-sum game over the matchup chart and finds the pick mix that can\'t be exploited (Nash equilibrium). Score = win rate against that mix.',
    wiki: ['Nash equilibrium', 'https://en.wikipedia.org/wiki/Nash_equilibrium'],
  },
  vsBT: {
    desc: 'One power rating per character, fitted to every head-to-head result, like Elo for characters.',
    more: 'Bradley–Terry model fitted by maximum likelihood. Shown as expected win rate against an average opponent.',
    wiki: ['Bradley–Terry model', 'https://en.wikipedia.org/wiki/Bradley%E2%80%93Terry_model'],
  },
  vsUniform: {
    desc: 'How good are this character\'s matchups across the whole cast, ignoring what\'s popular right now?',
    more: 'Average of all head-to-head win rates, every opponent weighted equally. Removes the effect of the current meta.',
    wiki: ['Round-robin tournament', 'https://en.wikipedia.org/wiki/Round-robin_tournament'],
  },
  vsField: {
    desc: 'Win rate against the opponents people actually play right now.',
    more: 'Plain win rate from the collected matches. Includes the rarity edge: people play worse against characters they rarely see.',
  },
};
const CUT_INFO = {
  jenks: { desc: 'Tier borders go where the biggest gaps between scores are.', more: 'Minimizes the spread inside each tier.', wiki: ['Jenks natural breaks', 'https://en.wikipedia.org/wiki/Jenks_natural_breaks_optimization'] },
  quantile: { desc: 'Fixed share of the cast per tier, with the fewest characters at the top and bottom.', more: 'Tier sizes follow a bell shape, e.g. 2:5:7:5:2 for five tiers.', wiki: ['Quantile', 'https://en.wikipedia.org/wiki/Quantile'] },
  sd: { desc: 'Each tier is one standard deviation wide around the average.', more: 'Tiers have equal width in score, so a tier can be empty.', wiki: ['Standard score', 'https://en.wikipedia.org/wiki/Standard_score'] },
  overlap: { desc: 'Characters share a tier until one is provably worse than the tier leader.', more: 'A new tier starts when a character\'s confidence interval no longer overlaps the leader\'s. The data decides how many tiers there are.', wiki: ['Confidence interval', 'https://en.wikipedia.org/wiki/Confidence_interval'] },
};

// Short description goes in the settings; the full explanation goes in the card above the tier list,
// so "Explain methods" works even while the settings are closed.
function setInfo(prefix, info, name) {
  $(prefix + 'Desc').textContent = info.desc;
  $(prefix + 'Name').textContent = name;
  $(prefix + 'More').innerHTML = `${info.desc} ${info.more}` + (info.wiki ? ` <a href="${info.wiki[1]}" target="_blank" rel="noopener">${info.wiki[0]} on Wikipedia ↗</a>` : '');
}

// ---- state <-> URL hash so a view can be shared ------------------------

const FIELDS = ['version', 'rankLo', 'rankHi', 'minGames', 'mirror', 'method', 'winBase', 'norm', 'wA', 'wB', 'wC', 'z', 'prior', 'cut', 'tiers', 'muPrior', 'muScope', 'rankStd'];
let activeTab = 'explore';

function readState() {
  const s = {};
  for (const f of FIELDS) { const el = $(f); s[f] = el.type === 'checkbox' ? el.checked : el.value; }
  s.regions = [...document.querySelectorAll('#regions input:checked')].map((i) => i.value);
  return s;
}

function writeHash() {
  const s = readState();
  const p = new URLSearchParams({ tab: activeTab });
  for (const f of FIELDS) p.set(f, s[f]);
  p.set('regions', s.regions.join('|'));
  history.replaceState(null, '', '#' + p.toString());
}

function hashState() {
  return Object.fromEntries(new URLSearchParams(location.hash.slice(1)).entries());
}

function applyState(s) {
  for (const f of FIELDS) {
    if (s[f] == null) continue;
    const el = $(f);
    if (el.type === 'checkbox') el.checked = s[f] === 'true';
    else el.value = s[f];
  }
}

// ---- shared helpers ----------------------------------------------------

function pct(x, d = 1) { return (x * 100).toFixed(d) + '%'; }

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function compact(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n.toLocaleString();
}

function setStatus(text, isError) {
  $('status').textContent = text;
  $('status').classList.toggle('error', !!isError);
}

function tile(c, tipHtml) {
  const d = document.createElement('div');
  d.className = 'tile';
  d.dataset.name = c.name;
  const initials = c.name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2);
  const icon = icons[slug(c.name)];
  if (icon) d.classList.add('has-img');
  const fresh = isNewCharacter(c.name);
  d.innerHTML = `${icon ? `<img alt="" src="${icon}" />` : ''}<span class="init">${initials}</span><span class="nm">${c.name}</span>` +
    (fresh ? '<span class="new-badge">NEW</span>' : '');
  const newNote = fresh ? `<br><span class="warn">Released ${daysSinceRelease(c.name)} days ago: release hype and players still learning make these numbers unreliable.</span>` : '';
  d.addEventListener('mouseenter', (e) => showTip(e, tipHtml(c) + newNote));
  d.addEventListener('mousemove', moveTip);
  d.addEventListener('mouseleave', hideTip);
  return d;
}

function renderTierList(el, rows, lowData, tipHtml) {
  el.innerHTML = '';
  const nTiers = rows.length ? Math.max(...rows.map((c) => c.tier)) + 1 : 0;
  for (let t = 0; t < nTiers; t++) {
    const row = document.createElement('div');
    row.className = 'tier';
    row.innerHTML = `<div class="tlabel" style="background:${TIER_COLORS[t % TIER_COLORS.length]}">${TIER_LABELS[t] || `T${t + 1}`}</div><div class="tiles"></div>`;
    rows.filter((c) => c.tier === t).forEach((c) => row.lastChild.appendChild(tile(c, tipHtml)));
    el.appendChild(row);
  }
  if (lowData.length) {
    const row = document.createElement('div');
    row.className = 'tier low';
    row.innerHTML = `<div class="tlabel">Low<br>data</div><div class="tiles"></div>`;
    lowData.forEach((c) => row.lastChild.appendChild(tile(c, tipHtml)));
    el.appendChild(row);
  }
  if (!rows.length && !lowData.length) { el.innerHTML = '<p class="empty">No games for this filter.</p>'; return; }
  const fresh = [...rows, ...lowData].filter((c) => isNewCharacter(c.name)).map((c) => c.name);
  if (fresh.length) {
    const note = document.createElement('p');
    note.className = 'new-note';
    note.innerHTML = `<span class="new-badge">NEW</span> ${fresh.join(', ')} ${fresh.length > 1 ? 'were' : 'was'} released less than ${NEW_CHARACTER_DAYS} days ago. ` +
      'Release hype and players still learning the character distort the numbers, so treat this placement as provisional.';
    el.appendChild(note);
  }
}

function tierBadge(t) {
  return `<span class="tb" style="background:${TIER_COLORS[t % TIER_COLORS.length]}">${TIER_LABELS[t] || t + 1}</span>`;
}

function showTip(e, html) {
  const t = $('tip');
  t.innerHTML = html;
  t.hidden = false;
  moveTip(e);
}
function moveTip(e) {
  const t = $('tip');
  t.style.left = Math.max(8, Math.min(e.clientX + 14, innerWidth - t.offsetWidth - 8)) + 'px';
  t.style.top = Math.min(e.clientY + 14, innerHeight - t.offsetHeight - 8) + 'px';
}
function hideTip() { $('tip').hidden = true; }

// ---- explorer: data loading ------------------------------------------------

async function loadVersion(v) {
  setStatus(`Loading patch ${formatVersion(v)}…`);
  current = await api(`/api/stats?v=${v}`);
  buildRegions();
  render();
}

function buildRegions() {
  const box = $('regions');
  if (box.dataset.built) return;
  box.dataset.built = '1';
  const prev = new Set(hashState().regions ? hashState().regions.split('|') : Object.keys(current.stats));
  for (const r of Object.keys(current.stats)) {
    const l = document.createElement('label');
    l.className = 'chip';
    l.innerHTML = `<input type="checkbox" value="${r}" ${prev.has(r) ? 'checked' : ''}/> ${r === 'Region Not Set' ? 'Unset' : r}`;
    l.querySelector('input').addEventListener('change', render);
    box.appendChild(l);
  }
}

// ---- explorer: rendering -----------------------------------------------------

function render() {
  syncControls();
  if (!current) return;
  const s = readState();
  writeHash();

  const lo = Math.min(+s.rankLo, +s.rankHi), hi = Math.max(+s.rankLo, +s.rankHi);
  const { rows: all, total } = ewgfRows(s.regions, lo, hi, s);

  const versus = VERSUS_METHODS.includes(s.method);
  const key = matchupKey(s, lo, hi);
  const muReady = key === muKey && muData;
  if (!muReady) ensureMatchups(key).then(render);
  if (versus && !(muReady && muData.available && muData.cells.length)) {
    $('tierlist').innerHTML = `<p class="empty">${!muReady ? 'Loading matchup data…'
      : muData.error ? 'Error: ' + muData.error
      : 'No collected matchups for this filter yet. Run collector.js, or switch matchup data to the whole season.'}</p>`;
    $('table').innerHTML = '';
    return;
  }

  const minGames = +s.minGames;
  let rows, lowData, info = {};
  if (versus) {
    // Score from the matchup matrix; "games" for the min-games filter = collected games.
    const vs = versusScores(muData.cells, s.method, +s.muPrior);
    const z = +s.z;
    for (const c of all) {
      const v = vs.get(c.name);
      c.vsGames = v ? v.games : 0;
      c.nash = v && v.nash;
      c.score = v ? v.score : 0;
      // Rough interval (binomial SE on the character's collected games), only used by the CI-overlap cut.
      const se = c.vsGames ? 0.5 / Math.sqrt(c.vsGames) : 1;
      c.ciLo = c.score - z * se; c.ciHi = c.score + z * se;
    }
    rows = all.filter((c) => c.vsGames >= minGames).sort((a, b) => b.score - a.score);
    lowData = all.filter((c) => c.vsGames < minGames).sort((a, b) => b.vsGames - a.vsGames);
  } else {
    rows = all.filter((c) => c.games >= minGames);
    lowData = all.filter((c) => c.games < minGames).sort((a, b) => b.games - a.games);
    info = rows.length ? scoreRows(rows, {
      method: s.method, winBase: s.winBase, norm: s.norm, z: +s.z, prior: +s.prior,
      wA: +s.wA, wB: +s.wB, wC: +s.wC,
    }) : {};
  }
  if (s.prior === '0' && info.priorAuto != null) $('priorVal').textContent = `auto ≈ ${Math.round(info.priorAuto).toLocaleString()}`;

  const tiers = assignTiers(rows, s.cut, +s.tiers);
  rows.forEach((c, i) => { c.tier = tiers[i]; });

  const scope = versus && s.muScope === 'season' ? 'Season 3' : `Patch ${formatVersion(current.gameVersion)}`;
  const amount = versus
    ? `${compact(Math.round(muData.cells.reduce((a, c) => a + c[2], 0) / 2))} matches`
    : `${compact(total)} character appearances`;
  const std = !versus && useRankStd(s, lo) ? ' · rank-standardized' : '';
  setStatus(`${shortRank(RANKS[lo])} → ${shortRank(RANKS[hi])} · ${scope} · ${amount}${std}`);
  showConsistency(s, lo, hi, rows.map((c) => c.name), versus);

  renderTierList($('tierlist'), rows, lowData, explorerTip);
  renderTable(rows, lowData, s, versus);
  muOrder = [...rows, ...lowData].map((c) => c.name);
  if (muReady) renderMatchups();
}

// Per-rank win rates only spread widely near the top, so standardization helps there and mostly adds
// noise from thin rank cells in wide/low ranges (checked on split-half consistency).
const RANK_STD_AUTO_FROM = 25; // Tekken King
function useRankStd(s, lo) {
  return s.rankStd === 'on' || (s.rankStd === 'auto' && lo >= RANK_STD_AUTO_FROM);
}

function ewgfRows(regions, lo, hi, s) {
  const agg = aggregate(current.stats, regions, lo, hi);
  if (s.mirror) applyMirrorCorrection(agg.rows); else useRaw(agg.rows);
  if (useRankStd(s, lo)) standardizeByRank(agg.rows, agg.rankG, agg.rankW);
  return agg;
}

// "Regions agree": the same method on Americas vs the other selected regions, as a rank correlation.
// Measures consistency (does the list reproduce on independent data?), not whether it's correct.
let consistencyRun = 0;
async function showConsistency(s, lo, hi, names, versus) {
  const run = ++consistencyRun;
  const a = s.regions.filter((r) => r === 'Americas'), b = s.regions.filter((r) => r !== 'Americas');
  if (!a.length || !b.length || names.length < 5) return;
  const keep = new Set(names);
  let sa, sb;
  if (versus) {
    const cells = (regs) => api('/api/matchups?' + new URLSearchParams({ rankLo: lo, rankHi: hi, regions: regs.join('|'), version: s.muScope === 'season' ? 'season' : s.version }))
      .then((d) => (d.available ? d.cells : []));
    const [ca, cb] = await Promise.all([cells(a), cells(b)]);
    if (run !== consistencyRun) return;
    const toRows = (cs) => [...versusScores(cs, s.method, +s.muPrior)].filter(([n]) => keep.has(n)).map(([name, v]) => ({ name, score: v.score }));
    sa = toRows(ca); sb = toRows(cb);
  } else {
    const opts = { method: s.method, winBase: s.winBase, norm: s.norm, z: +s.z, prior: +s.prior, wA: +s.wA, wB: +s.wB, wC: +s.wC };
    const scored = (regs) => { const r = ewgfRows(regs, lo, hi, s).rows.filter((c) => keep.has(c.name)); scoreRows(r, opts); return r; };
    sa = scored(a); sb = scored(b);
  }
  const rho = spearmanByName(sa, sb);
  if (Number.isNaN(rho)) return;
  const el = document.createElement('span');
  el.className = 'agree';
  el.title = 'The same method run separately on Americas and on the other selected regions, compared as a rank correlation (1 = same order). ' +
    'It shows how consistent the list is on independent data, not whether it is correct: plain popularity is very consistent too.';
  el.innerHTML = ` · regions agree <b>${rho.toFixed(2)}</b>`;
  $('status').appendChild(el);
}

function explorerTip(c) {
  const vs = c.vsGames != null && VERSUS_METHODS.includes($('method').value);
  return `<b>${c.name}</b><br>${c.games.toLocaleString()} games · pick ${pct(c.share * 2)}<br>
    Win ${pct(c.wr, 2)}${c.wrAdj !== c.wr ? ` (adj ${pct(c.wrAdj, 2)})` : ''}<br>` + (vs
    ? `${c.vsGames.toLocaleString()} collected games<br>${c.nash ? `Nash mix ${pct(c.nash)}<br>` : ''}Score ${pct(c.score, 2)}`
    : c.tier != null ? `CI ${pct(c.ciLo)} – ${pct(c.ciHi)}<br>Score ${c.score.toFixed(4)}` : 'Below min games');
}

function renderTable(rows, lowData, s, versus) {
  if (versus) return renderVersusTable(rows, lowData, s);
  const comp = s.method === 'composite';
  const adjusted = s.mirror || useRankStd(s, Math.min(+s.rankLo, +s.rankHi));
  const head = ['#', 'Tier', 'Character', 'Games', 'Pick', 'Win rate', adjusted ? 'Win (adjusted)' : null,
    `Wilson ${ {1.2816: 80, 1.6449: 90, 1.96: 95, 2.5758: 99}[s.z] }% CI`, 'Bayes', comp ? 'W' : null, comp ? 'P' : null, 'Score'].filter((h) => h !== null);
  const fmtScore = (v) => (comp ? v.toFixed(3) : pct(v, 2));
  const body = rows.map((c, i) => `<tr>
    <td>${i + 1}</td><td>${tierBadge(c.tier)}</td><td>${c.name}</td>
    <td class="n">${c.games.toLocaleString()}</td>
    <td class="n">${pct(c.share * 2)}</td>
    <td class="n">${pct(c.wr, 2)}</td>
    ${adjusted ? `<td class="n">${pct(c.wrAdj, 2)}</td>` : ''}
    <td class="n">${pct(c.ciLo, 1)} – ${pct(c.ciHi, 1)}</td>
    <td class="n">${pct(c.bayes, 2)}</td>
    ${comp ? `<td class="n">${c.W.toFixed(2)}</td><td class="n">${c.P.toFixed(2)}</td>` : ''}
    <td class="n strong">${fmtScore(c.score)}</td></tr>`).join('');
  const low = lowData.map((c) => `<tr class="lowrow"><td></td><td>–</td><td>${c.name}</td><td class="n">${c.games.toLocaleString()}</td><td class="n">${pct(c.share * 2)}</td><td class="n">${pct(c.wr, 2)}</td><td colspan="${head.length - 6}">below min games</td></tr>`).join('');
  $('table').innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}${low}</tbody>`;
}

function renderVersusTable(rows, lowData, s) {
  const nash = s.method === 'vsNash';
  const head = ['#', 'Tier', 'Character', 'Collected games', 'Pick (all ranked)', 'Win rate (all ranked)', nash ? 'Nash mix' : null, 'Score'].filter(Boolean);
  const cells = (c) => `<td>${c.name}</td><td class="n">${c.vsGames.toLocaleString()}</td><td class="n">${pct(c.share * 2)}</td><td class="n">${pct(c.wr, 2)}</td>`;
  const body = rows.map((c, i) => `<tr><td>${i + 1}</td><td>${tierBadge(c.tier)}</td>
    ${cells(c)}${nash ? `<td class="n">${c.nash ? pct(c.nash, 1) : '–'}</td>` : ''}
    <td class="n strong">${pct(c.score, 2)}</td></tr>`).join('');
  const low = lowData.map((c) => `<tr class="lowrow"><td></td><td>–</td>${cells(c)}<td colspan="${head.length - 6}">below min games</td></tr>`).join('');
  $('table').innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}${low}</tbody>`;
}

// ---- explorer: matchup chart ---------------------------------------------------

let muData = null, muKey = '', muOrder = [], muPending = null;

function matchupKey(s, lo, hi) {
  return new URLSearchParams({ rankLo: lo, rankHi: hi, regions: s.regions.join('|'), version: s.muScope === 'season' ? 'season' : s.version }).toString();
}

// Fetch matchup cells for a filter once; concurrent renders share the in-flight request.
function ensureMatchups(key) {
  if (key === muKey && muPending) return muPending;
  muKey = key;
  muData = null;
  muPending = api('/api/matchups?' + key)
    .then((d) => { if (key === muKey) muData = d; })
    .catch((e) => { if (key === muKey) muData = { error: e.message }; })
    .finally(() => { if (key === muKey) muPending = null; });
  return muPending;
}

function renderMatchups() {
  const table = $('mu'), status = $('muStatus');
  if (!muData || $('muSection').hidden) return;
  if (muData.error) { status.textContent = 'Error: ' + muData.error; return; }
  if (!muData.available) {
    status.textContent = 'No matchup data yet. Run `node collector.js` to start collecting.';
    table.innerHTML = '';
    return;
  }
  // Pool a→b with the flipped b→a so the rank filter's "beats lower-ranked opponents" edge cancels
  // (same as the versus scoring); cells then mirror each other: a vs b = 100 − b vs a.
  const raw = new Map(muData.cells.map(([a, b, g, w]) => [a + '|' + b, { g, w }]));
  const byPair = new Map();
  for (const [k, ab] of raw) {
    const [a, b] = k.split('|'), ba = raw.get(b + '|' + a) || { g: 0, w: 0 };
    const g = ab.g + ba.g, w = ab.w + ba.g - ba.w;
    byPair.set(k, { g, w });
    byPair.set(b + '|' + a, { g, w: g - w });
  }
  const min = +$('muMin').value;
  const inFilter = muData.cells.reduce((a, c) => a + c[2], 0) / 2;
  status.textContent = `${compact(Math.round(inFilter))} matches in this filter` +
    ($('muScope').value === 'season' ? ' · whole season' : muData.versions.includes(+$('version').value) ? '' : ' · selected patch not in collected data');

  const order = muOrder.filter((n) => muData.cells.some((c) => c[0] === n));
  const icon = (n) => icons[slug(n)] ? `<img src="${icons[slug(n)]}" alt="${n}" title="${n}">` : `<span title="${n}">${n.slice(0, 3)}</span>`;
  let html = `<thead><tr><th></th>${order.map((n) => `<th>${icon(n)}</th>`).join('')}</tr></thead><tbody>`;
  for (const a of order) {
    html += `<tr><th>${icon(a)}</th>`;
    for (const b of order) {
      const c = byPair.get(a + '|' + b);
      if (a === b) { html += '<td class="mirror"></td>'; continue; }
      if (!c || c.g < min) { html += `<td class="few" data-a="${a}" data-b="${b}" data-g="${c ? c.g : 0}"></td>`; continue; }
      const wr = c.w / c.g;
      html += `<td style="background:${wrColor(wr)}" data-a="${a}" data-b="${b}" data-g="${c.g}" data-w="${c.w}">${Math.round(wr * 100)}</td>`;
    }
    html += '</tr>';
  }
  table.innerHTML = html + '</tbody>';
}

// Diverging scale: red below 50%, green above, saturating at ±10 points.
function wrColor(wr) {
  const t = Math.max(-1, Math.min(1, (wr - 0.5) / 0.1));
  const hue = t < 0 ? 0 : 130;
  return `hsl(${hue} 60% ${40 - Math.abs(t) * 12}% / ${0.15 + Math.abs(t) * 0.85})`;
}

$('mu').addEventListener('mouseover', (e) => {
  const td = e.target.closest('td[data-a]');
  if (!td) return;
  const { a, b, g, w } = td.dataset;
  showTip(e, `<b>${a}</b> vs <b>${b}</b><br>` + (w ? `${pct(w / g, 1)} over ${(+g).toLocaleString()} games` : `only ${(+g).toLocaleString()} games`));
});
$('mu').addEventListener('mousemove', (e) => { if (!$('tip').hidden) moveTip(e); });
$('mu').addEventListener('mouseleave', hideTip);
$('muMin').addEventListener('change', renderMatchups);

// Show only the options relevant to the chosen method / cut.
function syncControls() {
  const m = $('method').value, cut = $('cut').value;
  const usesWilson = m === 'wilson' || cut === 'overlap' || (m === 'composite' && $('winBase').value === 'wilson');
  const usesBayes = m === 'bayes' || (m === 'composite' && $('winBase').value === 'bayes');
  $('versusOpts').hidden = !VERSUS_METHODS.includes(m);
  $('muPriorVal').textContent = $('muPrior').value;
  $('compositeOpts').hidden = m !== 'composite';
  $('wilsonOpts').hidden = !usesWilson;
  $('bayesOpts').hidden = !usesBayes;
  $('tierCountWrap').hidden = cut === 'overlap';
  $('noOpts').hidden = ['compositeOpts', 'wilsonOpts', 'bayesOpts', 'versusOpts'].some((id) => !$(id).hidden);
  setInfo('method', METHOD_INFO[m], $('method').selectedOptions[0].text);
  setInfo('cut', CUT_INFO[cut], $('cut').selectedOptions[0].text.toLowerCase());
  for (const k of ['wA', 'wB', 'wC']) $(k + 'Val').textContent = (+$(k).value).toFixed(2);
  $('tiersVal').textContent = $('tiers').value;
  $('minGamesVal').textContent = (+$('minGames').value).toLocaleString();
  if ($('prior').value !== '0') $('priorVal').textContent = (+$('prior').value).toLocaleString();
}

// ---- page chrome: tabs, drawers, explain toggle, source status ------------------

function setPane(pane) {
  pane = ['data', 'scoring', 'tiers'].includes(pane) ? pane : 'data';
  document.querySelectorAll('.side-tabs [data-pane]').forEach((b) => b.setAttribute('aria-selected', b.dataset.pane === pane));
  document.querySelectorAll('#controls [data-pane-id]').forEach((f) => { f.hidden = f.dataset.paneId !== pane; });
}

function setTab(tab) {
  activeTab = tab === 'best' ? 'best' : 'explore';
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === activeTab));
  $('tab-best').hidden = activeTab !== 'best';
  $('tab-explore').hidden = activeTab !== 'explore';
  if (current) writeHash();
}

function toggleDrawer(btn, open) {
  const el = $(btn.dataset.drawer);
  open = open ?? el.hidden;
  el.hidden = !open;
  btn.setAttribute('aria-expanded', open);
  btn.textContent = btn.textContent.replace(/[▾▴]$/, open ? '▴' : '▾');
  if (open && btn.dataset.drawer === 'muSection') renderMatchups();
}

function store(key, val) { try { localStorage.setItem(key, val); } catch {} }
function recall(key) { try { return localStorage.getItem(key); } catch { return null; } }

async function refreshSources() {
  try {
    const c = await api('/api/collector');
    const d = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    $('srcMu').textContent = c.available ? `${compact(c.matches)} matches · ${d(c.from)} – ${d(c.to)}` : 'not collected yet';
  } catch { $('srcMu').textContent = 'unavailable'; }
}

// ---- init ------------------------------------------------------------------

let resolveReady;
const appReady = new Promise((r) => { resolveReady = r; });

async function init() {
  for (const id of ['rankLo', 'rankHi']) {
    $(id).innerHTML = RANKS.map((r, i) => `<option value="${i}">${id === 'rankLo' ? 'From ' : 'To '}${r}</option>`).join('');
  }
  $('rankLo').value = RANKS.indexOf('God of Destruction IV');
  $('rankHi').value = RANKS.length - 1;
  for (const p of RANK_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = p.short; b.title = p.label;
    b.addEventListener('click', () => { $('rankLo').value = RANKS.indexOf(p.lo); $('rankHi').value = RANKS.indexOf(p.hi); render(); });
    $('rankPresets').appendChild(b);
  }

  const saved = hashState();
  applyState(saved);
  setTab(saved.tab || recall('tab') || 'explore');
  setPane(recall('pane'));
  document.querySelectorAll('.side-tabs [data-pane]').forEach((b) => b.addEventListener('click', () => { setPane(b.dataset.pane); store('pane', b.dataset.pane); }));
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => { setTab(b.dataset.tab); store('tab', activeTab); }));
  document.querySelectorAll('[data-drawer]').forEach((b) => b.addEventListener('click', () => toggleDrawer(b)));
  $('settingsToggle').addEventListener('click', () => {
    const open = !$('controls').classList.contains('open');
    $('controls').classList.toggle('open', open);
    $('settingsToggle').setAttribute('aria-expanded', open);
  });
  $('explain').checked = recall('explain') === '1';
  document.body.classList.toggle('explain', $('explain').checked);
  $('explain').addEventListener('change', () => { document.body.classList.toggle('explain', $('explain').checked); store('explain', $('explain').checked ? '1' : '0'); });

  document.querySelectorAll('#controls select, #controls input').forEach((el) => {
    if (el.id === 'version') return;
    el.addEventListener('input', render);
  });
  $('method').addEventListener('input', render);
  $('version').addEventListener('change', () => loadVersion(+$('version').value).catch(fail));
  $('refresh').addEventListener('click', async () => {
    $('refresh').disabled = true;
    try {
      const r = await api('/api/refresh');
      $('srcEwgf').textContent = `patch ${formatVersion(r.latest)} · updated ${ago(r.fetchedAt)}`;
      await loadVersion(+$('version').value);
    } catch (e) { fail(e); }
    $('refresh').disabled = false;
  });

  refreshSources();
  if (STATIC) $('refresh').hidden = true; // the static site is rebuilt daily; nothing to refresh on demand
  [icons] = await Promise.all([
    api('/api/icons').catch(() => ({})),
    api('/api/characters').then(setAutoReleases).catch(() => {}),
  ]);
  try {
    const { versions, latest, fetchedAt, source } = await api('/api/versions');
    $('srcEwgf').textContent = `patch ${formatVersion(latest)} · ${source || 'ewgf.gg'} · updated ${ago(fetchedAt)}`;
    $('version').innerHTML = versions.map((v) => `<option value="${v}">${formatVersion(v)}${v === latest ? ' (latest)' : ''}</option>`).join('');
    $('version').value = saved.version && versions.includes(+saved.version) ? saved.version : latest;
    resolveReady({ latest, versions });
    await loadVersion(+$('version').value);
  } catch (e) { fail(e); }
}

function fail(e) { setStatus('Error: ' + e.message, true); }

init();
