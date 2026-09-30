// Bandai character ids as used by the Wavu replay feed. The live list comes from ewgf's characterIdMap
// (lib/ewgf.js); this copy is only the fallback if that can't be read. Unknown ids still get a name, so a
// newly released character shows up in matchups before anyone updates this file.
const FALLBACK_CHAR_IDS = {
  0: 'Paul', 1: 'Law', 2: 'King', 3: 'Yoshimitsu', 4: 'Hwoarang', 5: 'Xiaoyu', 6: 'Jin', 7: 'Bryan', 8: 'Kazuya',
  9: 'Steve', 10: 'Jack-8', 11: 'Asuka', 12: 'Devil Jin', 13: 'Feng', 14: 'Lili', 15: 'Dragunov', 16: 'Leo',
  17: 'Lars', 18: 'Alisa', 19: 'Claudio', 20: 'Shaheen', 21: 'Nina', 22: 'Lee', 23: 'Kuma', 24: 'Panda',
  28: 'Zafina', 29: 'Leroy', 32: 'Jun', 33: 'Reina', 34: 'Azucena', 35: 'Victor', 36: 'Raven', 38: 'Eddy',
  39: 'Lidia', 40: 'Heihachi', 41: 'Clive', 42: 'Anna', 43: 'Fahkumram', 44: 'Armor King', 45: 'Miary Zo',
  46: 'Kunimitsu', 47: 'Bob',
};

const REGION_IDS = { 'Region Not Set': -1, Asia: 0, 'Middle East': 1, Oceania: 2, Americas: 3, Europe: 4 };

// Merge the live map over the fallback; name any other id we've seen in the data.
function charNames(live, seenIds = []) {
  const names = { ...FALLBACK_CHAR_IDS, ...(live || {}) };
  for (const id of seenIds) if (!names[id]) names[id] = `Character ${id}`;
  return names;
}

module.exports = { FALLBACK_CHAR_IDS, REGION_IDS, charNames };
