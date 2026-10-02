// Tekken 8 rank ladder in ascending order (ewgf.gg's naming).
const RANKS = [
  'Beginner', '1st Dan', '2nd Dan', 'Fighter', 'Strategist', 'Combatant', 'Brawler', 'Ranger',
  'Cavalry', 'Warrior', 'Assailant', 'Dominator', 'Vanquisher', 'Destroyer', 'Eliminator',
  'Garyu', 'Shinryu', 'Tenryu', 'Mighty Ruler', 'Flame Ruler', 'Battle Ruler',
  'Fujin', 'Raijin', 'Kishin', 'Bushin',
  'Tekken King', 'Tekken Emperor', 'Tekken God', 'Tekken God Supreme',
  'God of Destruction', 'God of Destruction I', 'God of Destruction II', 'God of Destruction III',
  'God of Destruction IV', 'God of Destruction V', 'God of Destruction VI', 'God of Destruction VII',
  'God of Destruction Infinity',
];

const RANK_PRESETS = [
  { short: 'All', label: 'All ranks', lo: 'Beginner', hi: 'God of Destruction Infinity' },
  { short: 'Purple', label: 'Purple ranks (Garyu – Battle Ruler)', lo: 'Garyu', hi: 'Battle Ruler' },
  { short: 'Blue', label: 'Blue ranks (Fujin – Bushin)', lo: 'Fujin', hi: 'Bushin' },
  { short: 'TK+', label: 'Tekken King and up', lo: 'Tekken King', hi: 'God of Destruction Infinity' },
  { short: 'GoD+', label: 'God of Destruction and up', lo: 'God of Destruction', hi: 'God of Destruction Infinity' },
  { short: 'GoD4+', label: 'God of Destruction IV and up', lo: 'God of Destruction IV', hi: 'God of Destruction Infinity' },
];

// DLC release dates (base roster: 2024-01-26). Sources: tekkenhistory.com, esports.gg, finalweapon.net.
const RELEASES = {
  Eddy: '2024-04-04', Lidia: '2024-07-25', Heihachi: '2024-10-03', Clive: '2024-12-20',
  Anna: '2025-04-01', Fahkumram: '2025-07-07', 'Armor King': '2025-10-16', 'Miary Zo': '2025-12-04',
  Kunimitsu: '2026-06-01', Bob: '2026-08-19',
};
// Release hype and players still learning the character distort pick rate, lift and win rate for a while.
const NEW_CHARACTER_DAYS = 60;

// Characters not in RELEASES: the first time one appears in the collected matches counts as its release,
// as long as that's clearly after collection started (otherwise it was just already there).
const autoReleases = {};
function setAutoReleases({ firstSeen = {}, observedFrom } = {}) {
  if (!observedFrom) return;
  for (const [name, at] of Object.entries(firstSeen)) if (at > observedFrom + 86400000) autoReleases[name] = at;
}

function daysSinceRelease(name) {
  const at = RELEASES[name] ? Date.parse(RELEASES[name]) : autoReleases[name];
  return at ? Math.floor((Date.now() - at) / 86400000) : null;
}
function isNewCharacter(name) {
  const d = daysSinceRelease(name);
  return d != null && d < NEW_CHARACTER_DAYS;
}

function shortRank(r) { return r.replace('God of Destruction', 'GoD').replace('Infinity', '∞'); }

const TIER_COLORS = ['#ff7f7f', '#ffbf7f', '#ffdf7f', '#ffff7f', '#bfff7f', '#7fff7f', '#7fffff', '#7fbfff', '#bf7fff'];
const TIER_LABELS = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

function formatVersion(v) {
  const s = String(v).padStart(5, '0');
  return `${Number(s.slice(0, 1))}.${s.slice(1, 3)}.${s.slice(3, 5)}`;
}

function slug(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
