// save.js — versioned saves.
// Everything the game stores is wrapped as { v: <format version>, data: <value> }.
// When a format changes, bump its version below and add one migration step that
// turns the old data into the new shape. Old saves are upgraded when they load.
(function () {
  // Current format version for each stored key.
  const VERSIONS = {
    'flatspace.current': 3,    // the craft being built: { name, parts: [saved parts] }
    'flatspace.crafts': 3,     // saved craft: { [name]: [saved parts] }
    'flatspace.milestones': 1, // milestone keys: [string]
    'flatspace.subassemblies': 1, // saved subassemblies: [{ name, parts: [saved parts] }]
  };

  // Part ids that were renamed. Step 1 → 2 applies these.
  const RENAMED_PARTS = { thumper: 'rumbler' };
  const renameIds = (ids) => (Array.isArray(ids) ? ids.map((id) => RENAMED_PARTS[id] || id) : ids);
  // Step 2 → 3: a stack of part ids becomes a part tree (see partgraph.js for the format).
  const stackToTree = (ids) => FS.serialParts(FS.stackToParts(ids));

  // MIGRATIONS[key][n] upgrades data from version n to version n + 1.
  // Version 0 is anything saved before saves were versioned (the prototype).
  const MIGRATIONS = {
    'flatspace.current': [
      (d) => d,                                              // 0 → 1: wrapped, same shape
      (d) => Object.assign({}, d, { parts: renameIds(d.parts) }), // 1 → 2: renamed part ids
      (d) => Object.assign({}, d, { parts: stackToTree(d.parts) }), // 2 → 3: part tree
    ],
    'flatspace.crafts': [
      (d) => d,
      (d) => {
        const out = {};
        for (const name of Object.keys(d || {})) out[name] = renameIds(d[name]);
        return out;
      },
      (d) => {
        const out = {};
        for (const name of Object.keys(d || {})) out[name] = stackToTree(d[name]);
        return out;
      },
    ],
    'flatspace.milestones': [(d) => d],
    'flatspace.subassemblies': [(d) => d],
  };

  // Upgrade stored data to the current version. Returns undefined if it can't be read.
  FS.migrate = (key, stored) => {
    if (stored === undefined || stored === null) return undefined;
    let v = 0, data = stored;
    if (typeof stored === 'object' && !Array.isArray(stored) && 'v' in stored && 'data' in stored) {
      v = stored.v; data = stored.data;
    }
    const target = VERSIONS[key] || 0;
    if (v > target) return undefined; // saved by a newer version of the game
    const steps = MIGRATIONS[key] || [];
    try {
      while (v < target) data = steps[v++](data);
    } catch (e) {
      return undefined;
    }
    return data;
  };

  // Read a stored value, upgraded to the current format, or the fallback.
  FS.store.load = (key, fallback) => {
    const data = FS.migrate(key, FS.store.get(key, undefined));
    return data === undefined ? fallback : data;
  };

  // Write a value in the current format.
  FS.store.save = (key, data) => FS.store.set(key, { v: VERSIONS[key] || 0, data });

  FS.SAVE_VERSIONS = VERSIONS;

  // ---------- Craft files ----------
  // A craft file is JSON: { format: 'flatspace-craft', version, game, name, parts }, where
  // version is the part-tree save format (the same as 'flatspace.current') and parts are
  // saved parts (partgraph.js). The share text is the same JSON, base64-encoded after a
  // prefix, so it survives being pasted into chats and forums.
  const PREFIX = 'FLATSPACE-CRAFT-1:';
  const craftObject = (name, parts) => ({ format: 'flatspace-craft', version: VERSIONS['flatspace.current'], game: FS.VERSION, name, parts: FS.serialParts(parts) });
  FS.craftToJSON = (name, parts) => JSON.stringify(craftObject(name, parts), null, 1);
  FS.craftToText = (name, parts) => PREFIX + btoa(unescape(encodeURIComponent(JSON.stringify(craftObject(name, parts)))));

  // Read a craft file or share text. Returns { name, parts } (saved parts, upgraded to the
  // current format, with unknown parts and everything attached to them left out, counted
  // in skipped) or { error }.
  FS.craftFromText = (text) => {
    let obj;
    try {
      text = String(text).trim();
      if (text.startsWith(PREFIX)) text = decodeURIComponent(escape(atob(text.slice(PREFIX.length).replace(/\s+/g, ''))));
      obj = JSON.parse(text);
    } catch (e) {
      return { error: 'That is not a Flatspace craft: it could not be read.' };
    }
    if (!obj || obj.format !== 'flatspace-craft' || !Array.isArray(obj.parts)) return { error: 'That is not a Flatspace craft file.' };
    if ((obj.version || 0) > VERSIONS['flatspace.current']) return { error: 'That craft was made with a newer version of the game. Update the game to load it.' };
    const data = FS.migrate('flatspace.current', { v: obj.version || 0, data: { name: obj.name, parts: obj.parts } });
    if (!data || !Array.isArray(data.parts)) return { error: 'That craft file is damaged.' };
    // leave out unknown parts, and anything attached to them
    const list = data.parts;
    const drop = new Set();
    const isDropped = (i, depth = 0) => {
      if (i < 0 || depth > list.length) return false;
      if (drop.has(i) || !FS.PART[list[i].id]) return true;
      return isDropped(list[i].parent, depth + 1);
    };
    list.forEach((s, i) => { if (isDropped(i)) drop.add(i); });
    const keep = list.map((_, i) => i).filter((i) => !drop.has(i));
    const newIndex = new Map(keep.map((i, k) => [i, k]));
    const parts = keep.map((i) => Object.assign({}, list[i], { parent: list[i].parent >= 0 ? newIndex.get(list[i].parent) ?? -1 : -1 }));
    return { name: String(data.name || 'Imported craft').slice(0, 32), parts, skipped: drop.size };
  };
})();
