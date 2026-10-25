// save.js — versioned saves.
// Everything the game stores is wrapped as { v: <format version>, data: <value> }.
// When a format changes, bump its version below and add one migration step that
// turns the old data into the new shape. Old saves are upgraded when they load.
(function () {
  // Current format version for each stored key.
  const VERSIONS = {
    'flatspace.current': 3, // the craft being built: { name, parts: [saved parts] }
    'flatspace.crafts': 3, // saved craft: { [name]: [saved parts] }
    'flatspace.milestones': 1, // milestone keys: [string]
    'flatspace.subassemblies': 1, // saved subassemblies: [{ name, parts: [saved parts] }]
    'flatspace.settings': 1, // game settings: { pixelSize }
  };

  // Part ids that were renamed. Step 1 → 2 applies these.
  const RENAMED_PARTS = { thumper: 'rumbler' };
  const renameIds = (partIds) =>
    Array.isArray(partIds) ? partIds.map((partId) => RENAMED_PARTS[partId] || partId) : partIds;
  // Step 2 → 3: a stack of part ids becomes a part tree (see partgraph.js for the format).
  const stackToTree = (partIds) => FS.serialParts(FS.stackToParts(partIds));

  // MIGRATIONS[key][n] upgrades data from version n to version n + 1.
  // Version 0 is anything saved before saves were versioned (the prototype).
  const MIGRATIONS = {
    'flatspace.current': [
      (data) => data, // 0 → 1: wrapped, same shape
      (data) => Object.assign({}, data, { parts: renameIds(data.parts) }), // 1 → 2: renamed part ids
      (data) => Object.assign({}, data, { parts: stackToTree(data.parts) }), // 2 → 3: part tree
    ],
    'flatspace.crafts': [
      (data) => data,
      (data) => {
        const out = {};
        for (const name of Object.keys(data || {})) {
          out[name] = renameIds(data[name]);
        }
        return out;
      },
      (data) => {
        const out = {};
        for (const name of Object.keys(data || {})) {
          out[name] = stackToTree(data[name]);
        }
        return out;
      },
    ],
    'flatspace.milestones': [(data) => data],
    'flatspace.subassemblies': [(data) => data],
    'flatspace.settings': [(data) => data],
  };

  // Upgrade stored data to the current version. Returns undefined if it can't be read.
  FS.migrate = (key, stored) => {
    if (stored === undefined || stored === null) {
      return undefined;
    }
    let version = 0;
    let data = stored;
    if (typeof stored === 'object' && !Array.isArray(stored) && 'v' in stored && 'data' in stored) {
      version = stored.v;
      data = stored.data;
    }
    const target = VERSIONS[key] || 0;
    if (version > target) {
      return undefined;
    } // saved by a newer version of the game
    const steps = MIGRATIONS[key] || [];
    try {
      while (version < target) {
        data = steps[version++](data);
      }
    } catch (error) {
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
  const craftObject = (name, parts) => ({
    format: 'flatspace-craft',
    version: VERSIONS['flatspace.current'],
    game: FS.VERSION,
    name,
    parts: FS.serialParts(parts),
  });
  FS.craftToJSON = (name, parts) => JSON.stringify(craftObject(name, parts), null, 1);
  FS.craftToText = (name, parts) =>
    PREFIX + btoa(unescape(encodeURIComponent(JSON.stringify(craftObject(name, parts)))));

  // Read a craft file or share text. Returns { name, parts } (saved parts, upgraded to the
  // current format, with unknown parts and everything attached to them left out, counted
  // in skipped) or { error }.
  FS.craftFromText = (text) => {
    let craft;
    try {
      text = String(text).trim();
      if (text.startsWith(PREFIX)) {
        text = decodeURIComponent(escape(atob(text.slice(PREFIX.length).replace(/\s+/g, ''))));
      }
      craft = JSON.parse(text);
    } catch (error) {
      return { error: 'That is not a Flatspace craft: it could not be read.' };
    }
    if (!craft || craft.format !== 'flatspace-craft' || !Array.isArray(craft.parts)) {
      return { error: 'That is not a Flatspace craft file.' };
    }
    if ((craft.version || 0) > VERSIONS['flatspace.current']) {
      return { error: 'That craft was made with a newer version of the game. Update the game to load it.' };
    }
    const data = FS.migrate('flatspace.current', {
      v: craft.version || 0,
      data: { name: craft.name, parts: craft.parts },
    });
    if (!data || !Array.isArray(data.parts)) {
      return { error: 'That craft file is damaged.' };
    }
    // leave out unknown parts, and anything attached to them
    const list = data.parts;
    const drop = new Set();
    const isDropped = (partIndex, depth = 0) => {
      if (partIndex < 0 || depth > list.length) {
        return false;
      }
      if (drop.has(partIndex) || !FS.PART[list[partIndex].id]) {
        return true;
      }
      return isDropped(list[partIndex].parent, depth + 1);
    };
    list.forEach((serialPart, partIndex) => {
      if (isDropped(partIndex)) {
        drop.add(partIndex);
      }
    });
    const keep = list.map((serialPart, partIndex) => partIndex).filter((partIndex) => !drop.has(partIndex));
    const newIndex = new Map(keep.map((oldIndex, newPosition) => [oldIndex, newPosition]));
    const parts = keep.map((oldIndex) =>
      Object.assign({}, list[oldIndex], {
        parent: list[oldIndex].parent >= 0 ? (newIndex.get(list[oldIndex].parent) ?? -1) : -1,
      }),
    );
    return { name: String(data.name || 'Imported craft').slice(0, 32), parts, skipped: drop.size };
  };
})();
