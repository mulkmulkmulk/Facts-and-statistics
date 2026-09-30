// ewgf.gg data access, shared by server.js (local) and scripts/build-data.js (static site).
//
// ewgf's public API only covers individual players, so character stats come from the statistics page:
//   - GET  /statistics  → the page's embedded data holds availableVersions + latest-patch stats
//   - POST /statistics with Next-Action: <getVersionStatistics id> → any patch
// The action id changes on every ewgf deploy, so it's rediscovered from the page's JS files, which also
// hold ewgf's character id → name map (used to name characters in the Wavu replay feed).
// Used with the permission of the ewgf.gg developer.

const ORIGIN = 'https://ewgf.gg';
const UA = 'Mozilla/5.0 (tekken-facts; non-profit stats site)';

function decodeRsc(html) {
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let m, out = '';
  while ((m = re.exec(html))) out += JSON.parse('"' + m[1] + '"');
  return out;
}

// Brace-match the JSON value that starts right after `key` in `s`.
function extractJson(s, key) {
  const at = s.indexOf(key);
  if (at < 0) return null;
  const start = at + key.length;
  const open = s[start], close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  return null;
}

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.text();
}

// Scan the page's JS files for the version-stats action id and the character id map.
async function scanChunks(html) {
  const chunks = [...new Set(html.match(/\/_next\/static\/chunks\/[\w-]+\.js/g) || [])];
  let actionId = null, charIds = null;
  for (const c of chunks) {
    if (actionId && charIds) break;
    const js = await get(ORIGIN + c).catch(() => '');
    const a = js.match(/createServerReference\)\("([0-9a-f]+)"[^)]*"getVersionStatistics"\)/);
    if (a) actionId = a[1];
    const m = js.match(/"characterIdMap",0,\{([^}]+)\}/);
    if (m) charIds = Object.fromEntries([...m[1].matchAll(/(\d+):"([^"]+)"/g)].map(([, id, name]) => [id, name]));
  }
  return { actionId, charIds };
}

// Versions list, latest-patch stats, action id and character map in one go.
async function fetchPage() {
  const html = await get(ORIGIN + '/statistics');
  const rsc = decodeRsc(html);
  const versions = extractJson(rsc, '"availableVersions":');
  const latest = extractJson(rsc, '"initialData":');
  if (!versions || !latest) throw new Error('Could not find stats in the ewgf.gg page (site layout may have changed)');
  const { actionId, charIds } = await scanChunks(html);
  return { fetchedAt: Date.now(), versions, latest, actionId, charIds };
}

async function callVersionAction(version, actionId) {
  const r = await fetch(ORIGIN + '/statistics', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Next-Action': actionId, Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify([version]),
  });
  if (!r.ok) throw new Error(`action HTTP ${r.status}`);
  const line = (await r.text()).split('\n').find((l) => l.startsWith('1:'));
  if (!line) throw new Error('unexpected action response');
  return JSON.parse(line.slice(2));
}

// Stats for one patch. `page` is from fetchPage(); a stale action id (ewgf redeployed) is rediscovered once.
async function fetchVersion(version, page) {
  if (version === page.latest.gameVersion) return page.latest;
  try {
    return await callVersionAction(version, page.actionId);
  } catch {
    page.actionId = (await scanChunks(await get(ORIGIN + '/statistics'))).actionId;
    return callVersionAction(version, page.actionId);
  }
}

module.exports = { fetchPage, fetchVersion };
