// save.js — versioned saves.
// Everything the game stores is wrapped as { version: <format version>, data: <value> }
// (saves made before 0.8 used v instead of version, and still load).
// When a format changes, bump its version below and add one migration step that
// turns the old data into the new shape. Old saves are upgraded when they load.
(function () {
  // Current format version for each stored key.
  const VERSIONS = {
    'flatspace.current': 4, // the craft being built: { name, parts: [saved parts] }
    'flatspace.crafts': 4, // saved craft: { [name]: [saved parts] }
    'flatspace.milestones': 1, // milestone keys: [string]
    'flatspace.subassemblies': 2, // saved subassemblies: [{ name, parts: [saved parts] }]
    'flatspace.settings': 1, // game settings: { pixelSize }
  };

  // Part ids that were renamed. Step 1 → 2 applies these.
  const RENAMED_PARTS = { thumper: 'rumbler' };
  const renameIds = (partIds) =>
    Array.isArray(partIds) ? partIds.map((partId) => RENAMED_PARTS[partId] || partId) : partIds;
  // Step 2 → 3: a stack of part ids becomes a part tree (see partgraph.js for the format).
  const stackToTree = (partIds) => Flatspace.serialParts(Flatspace.stackToParts(partIds));

  // Step 3 → 4: saved parts use full names (rot → rotation, len → length, sym → symmetryGroup,
  // chuteAlt → chuteAltitude), the surface node is 'surface' instead of 'srf', and the side
  // decoupler's id is 'sidedecoupler' instead of 'radec'.
  const OLD_FIELD_NAMES = { rot: 'rotation', len: 'length', sym: 'symmetryGroup', chuteAlt: 'chuteAltitude' };
  const OLD_PART_IDS = { radec: 'sidedecoupler' };
  const fullNames = (savedParts) =>
    Array.isArray(savedParts)
      ? savedParts.map((savedPart) => {
          const renamed = {};
          for (const [field, value] of Object.entries(savedPart)) {
            renamed[OLD_FIELD_NAMES[field] || field] = value;
          }
          if (renamed.node === 'srf') {
            renamed.node = 'surface';
          }
          renamed.id = OLD_PART_IDS[renamed.id] || renamed.id;
          return renamed;
        })
      : savedParts;

  // MIGRATIONS[key][n] upgrades data from version n to version n + 1.
  // Version 0 is anything saved before saves were versioned (the prototype).
  const MIGRATIONS = {
    'flatspace.current': [
      (data) => data, // 0 → 1: wrapped, same shape
      (data) => Object.assign({}, data, { parts: renameIds(data.parts) }), // 1 → 2: renamed part ids
      (data) => Object.assign({}, data, { parts: stackToTree(data.parts) }), // 2 → 3: part tree
      (data) => Object.assign({}, data, { parts: fullNames(data.parts) }), // 3 → 4: full field names
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
      (data) => {
        const out = {};
        for (const name of Object.keys(data || {})) {
          out[name] = fullNames(data[name]);
        }
        return out;
      },
    ],
    'flatspace.milestones': [(data) => data],
    'flatspace.subassemblies': [
      (data) => data,
      (data) =>
        Array.isArray(data)
          ? data.map((subassembly) => Object.assign({}, subassembly, { parts: fullNames(subassembly.parts) }))
          : data,
    ],
    'flatspace.settings': [(data) => data],
  };

  // Upgrade stored data to the current version. Returns undefined if it can't be read.
  Flatspace.migrate = (key, stored) => {
    if (stored === undefined || stored === null) {
      return undefined;
    }
    let version = 0;
    let data = stored;
    if (typeof stored === 'object' && !Array.isArray(stored) && 'data' in stored) {
      if ('version' in stored) {
        version = stored.version;
        data = stored.data;
      } else if ('v' in stored) {
        version = stored.v; // saved before 0.8
        data = stored.data;
      }
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
  Flatspace.store.load = (key, fallback) => {
    const data = Flatspace.migrate(key, Flatspace.store.get(key, undefined));
    return data === undefined ? fallback : data;
  };

  // Write a value in the current format.
  Flatspace.store.save = (key, data) => Flatspace.store.set(key, { version: VERSIONS[key] || 0, data });

  Flatspace.SAVE_VERSIONS = VERSIONS;

  // ---------- Craft files ----------
  // A craft file is JSON: { format: 'flatspace-craft', version, game, name, parts }, where
  // version is the part-tree save format (the same as 'flatspace.current') and parts are
  // saved parts (partgraph.js). The share text is the same JSON, base64-encoded after a
  // prefix, so it survives being pasted into chats and forums.
  const PREFIX = 'FLATSPACE-CRAFT-1:';
  const craftObject = (name, parts) => ({
    format: 'flatspace-craft',
    version: VERSIONS['flatspace.current'],
    game: Flatspace.VERSION,
    name,
    parts: Flatspace.serialParts(parts),
  });
  Flatspace.craftToJSON = (name, parts) => JSON.stringify(craftObject(name, parts), null, 1);
  Flatspace.craftToText = (name, parts) =>
    PREFIX + btoa(unescape(encodeURIComponent(JSON.stringify(craftObject(name, parts)))));

  // Read a craft file or share text. Returns { name, parts } (saved parts, upgraded to the
  // current format, with unknown parts and everything attached to them left out, counted
  // in skipped) or { error }.
  Flatspace.craftFromText = (text) => {
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
    const data = Flatspace.migrate('flatspace.current', {
      version: craft.version || 0,
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
      if (drop.has(partIndex) || !Flatspace.PART[list[partIndex].id]) {
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
