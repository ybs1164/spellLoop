'use strict';

// No SDK, login or gameplay dependency. Rows are typed arrays per table (see supabase/play-logs.sql);
// durable batches are retried by stable UUID and deduplicated server-side by (run, seq).
globalThis.PlayLog = (() => {
  const config = globalThis.PLAY_LOG_CONFIG || {};
  const enabled = !!(config.url && config.key);
  const build = config.build || 'unknown';
  const uuid = () => crypto.randomUUID();
  let db, game, run, sequence = 0, pending = [], busy = false;
  let persisting = null, lastSnapshot = -1;
  let ids = new WeakMap(), nextId = 0, known = new Map();
  const repeatedCards = new Map();
  const status = { enabled, persisted: 0, uploaded: 0, error: null };
  const fail = error => { status.error = String(error?.message || error); console.warn('[PlayLog]', status.error); };
  const num = (v, d = 2) => Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null;
  const int = v => v == null || !['number', 'boolean'].includes(typeof v) || !Number.isFinite(+v) ? null : Math.trunc(+v);
  const text = (v, n = 200) => v == null ? null : String(v).slice(0, n);
  const json = v => text(JSON.stringify(v));
  const prim = list => list.filter(v => ['string', 'number', 'boolean'].includes(typeof v))
    .map(v => typeof v === 'number' ? num(v, 3) : v).join(',') || null;
  const pairs = o => o ? Object.entries(o).filter(([, v]) => v != null && v !== false)
    .map(([k, v]) => typeof v === 'number' ? `${k}=${num(v)}` : k).join(',') || null : null;
  const ready = new Promise(resolve => {
    try {
      const request = indexedDB.open('spell-loop-play-log', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('batches', { keyPath: 'id' });
      request.onsuccess = () => { db = request.result; resolve(true); };
      request.onerror = () => { fail(request.error); resolve(false); };
    } catch (error) { fail(error); resolve(false); }
  });
  const transaction = (mode, action) => new Promise((resolve, reject) => {
    const tx = db.transaction('batches', mode);
    const request = action(tx.objectStore('batches'));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Log storage transaction failed'));
  });
  function ref(o) {
    if (!o || typeof o !== 'object') return null;
    if (!ids.has(o)) ids.set(o, ++nextId);
    return ids.get(o);
  }
  // Row layouts: [run, seq, t, ...fields]; run/end rows have no seq.
  function row(table, fields) {
    if (!run) return;
    pending.push({ table, row: [run, ++sequence, num(game?.time || 0, 3), ...fields] });
    if (pending.length >= 128) void persist();
  }
  const event = (type, a = null, b = null, txt = null) => row('event', [type, int(a), int(b), text(txt)]);
  function entityFields(o) {
    const stats = entityStats(o);
    const slots = (o.deck ? o.deck.slots : o.slots || []).map(s => `${s.limit ?? ''}:${s.cards.join('+')}`).join('|');
    return [ref(o), text(o.type || o.kind || o.constructor?.name, 40), text(o.team, 40), int(o.level),
      ENTITY_STAT_NAMES.map(key => num(stats[key])), slots, pairs(o.buffs), pairs(o.directStates),
      o.deck?.inventory?.join(',') ?? null, num(o.deck?.costPoints)];
  }
  const position = o => row('pos', [ref(o), num(o.x, 1), num(o.y, 1), num(o.hp, 1), num(o.shield, 1), num(o.life, 1), !!o.dead]);
  // Definition rows are written at spawn and again only when the definition changes.
  function observe(o, signature, withPosition = true) {
    if (withPosition) position(o);
    const fields = entityFields(o), next = JSON.stringify(fields);
    if (next !== signature) row('entity', [signature === undefined ? 'S' : 'C', ...fields]);
    return next;
  }
  function spawn(o) {
    const signature = observe(o, undefined);
    known.set(ref(o), signature);
    return signature;
  }
  function persist() {
    drainCards();
    // Serialize writes; failed batches remain in memory, never silently discarded.
    if (persisting) return persisting;
    persisting = (async () => {
      if (!pending.length || !await ready) return;
      const pack = entries => {
        const rows = {};
        for (const e of entries) (rows[e.table] ||= []).push(e.row);
        return rows;
      };
      while (pending.length) {
        let count = Math.min(128, pending.length);
        const batch = { id: uuid(), build, rows: pack(pending.slice(0, count)) };
        // Leave room for PostgreSQL jsonb's canonical whitespace in its size check.
        while (new TextEncoder().encode(JSON.stringify(batch)).length > 350000) {
          if (count === 1) throw new Error('A log row exceeds the 350 KB upload limit; export pending logs');
          count = Math.ceil(count / 2);
          batch.rows = pack(pending.slice(0, count));
        }
        await transaction('readwrite', store => store.put(batch));
        pending.splice(0, count);
        status.persisted += count;
      }
    })().catch(fail).finally(() => { persisting = null; });
    return persisting;
  }
  function drainCards() {
    for (const card of repeatedCards.values()) pending.push({ table: 'card', row: card });
    repeatedCards.clear();
  }
  async function flush() {
    if (busy) return;
    busy = true;
    try {
      await persist();
      if (!enabled || !db) return;
      for (let i = 0; i < 20; i++) {
        const batches = await transaction('readonly', store => store.getAll(undefined, 1));
        if (!batches.length) break;
        const batch = batches[0];
        // Pre-schema (jsonb events) batches cannot be ingested any more.
        if (!batch.rows) { await transaction('readwrite', store => store.delete(batch.id)); continue; }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(`${config.url.replace(/\/$/, '')}/rest/v1/rpc/ingest_play_log`, {
            method: 'POST', headers: { apikey: config.key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ batch }), signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Supabase HTTP ${response.status}`);
          await transaction('readwrite', store => store.delete(batch.id));
          status.uploaded += Object.values(batch.rows).reduce((n, rows) => n + rows.length, 0);
          status.error = null;
        } finally { clearTimeout(timer); }
      }
    } catch (error) { fail(error); } finally { busy = false; }
  }
  function safe(fn) { try { return fn(); } catch (error) { fail(error); } }
  function wrap(object, name, before, after) {
    const original = object[name];
    if (typeof original !== 'function') return;
    object[name] = function (...args) {
      const context = safe(() => before?.call(this, args));
      const result = original.apply(this, args);
      safe(() => after?.call(this, args, result, context));
      return result;
    };
  }
  function snapshot(force = false) {
    if (!game.player || !run) return;
    const current = new Map();
    const full = force || game.time - lastSnapshot >= 1;
    for (const o of [game.player, ...game.enemies, ...game.allies, ...game.objects, ...game.zones, ...game.projectiles, ...game.hazards, ...game.pickups]) {
      const id = ref(o);
      if (!known.has(id)) current.set(id, spawn(o));
      else current.set(id, full ? observe(o, known.get(id)) : known.get(id));
    }
    for (const id of known.keys()) if (!current.has(id)) event('entity_removed', id);
    known = current;
    if (full) lastSnapshot = game.time;
  }
  function finish(result, kills) {
    if (!run) return;
    pending.push({ table: 'end', row: [run, Date.now(), result, int(kills), num(game?.time || 0, 3)] });
  }
  function attach(g) {
    game = g;
    wrap(g, 'start', () => {
      if (run) { finish('abandoned:restart'); }
      run = uuid(); sequence = 0; ids = new WeakMap(); nextId = 0; known.clear(); lastSnapshot = -1;
      pending.push({ table: 'run', row: [run, Date.now(), build, int(g.w), int(g.h)] });
    }, () => { event('run_ready', null, null, g.route); snapshot(true); });
    wrap(g, 'update', null, () => snapshot());
    for (const name of ['spawnEnemy', 'spawnProjectile', 'summonAlly', 'place', 'addZone']) {
      wrap(g, name, null, (args, result) => {
        if (!run || !result || known.has(ref(result))) return;
        spawn(result);
      });
    }
    for (const name of ['enterStage', 'pause', 'resume', 'openEditor', 'closeEditor', 'openInspector', 'closeInspector', 'onLevelUp', 'openLevelUp']) {
      wrap(g, name, null, args => { event(name, g.stageIdx, null, prim([g.state, ...args])); snapshot(true); });
    }
    wrap(g, 'endRun', null, args => { snapshot(true); finish(args[0] ? 'victory' : 'defeat', g.kills); run = null; void flush(); });
    wrap(g, 'toTitle', () => { finish('abandoned:title', g.kills); run = null; void flush(); });
    for (const name of ['damageEnemy', 'hurtEnemy', 'healEnemy', 'restoreEnemy', 'damageTarget', 'healTarget', 'addDebuff', 'killEnemy', 'consumeTarget']) {
      wrap(g, name, args => {
        const o = name === 'damageTarget' ? g.targetObj(args[0]) : args[0];
        return { o, hp: o?.hp, shield: o?.shield };
      }, (args, result, before) => {
        const value = typeof args[1] === 'number' ? num(args[1], 3) : null;
        row('damage', [name, ref(before.o), ref(g.actionActor || g.player), value, num(before.hp, 1), num(before.o?.hp, 1),
          num(before.shield, 1), num(before.o?.shield, 1), !!before.o?.dead, args.length > 2 || value == null ? text(prim(args.slice(1)), 100) : null]);
      });
    }
    for (const name of ['takeDamage', 'heal', 'gainXp', 'applyBuff']) {
      wrap(Player.prototype, name, function () { return { hp: this.hp, shield: this.shield }; }, function (args, result, before) {
        row('player', [name, text(prim(args), 100), num(before.hp, 1), num(before.shield, 1), num(this.hp, 1), num(this.shield, 1), int(this.level), num(this.xp, 1)]);
      });
    }
    wrap(Pickup.prototype, 'collect', function () { event('pickup_collect', ref(this), null, this.kind); });
    const rebuilt = () => {
      const player = g.player, id = ref(player);
      if (run && player && known.has(id)) known.set(id, observe(player, known.get(id), false));
    };
    for (const name of ['act', 'applyMove', 'pickLevelUp', 'refreshLevelUp']) {
      wrap(UI, name, args => event(`ui_${name}`, null, null, safe(() => json(args))), rebuilt);
    }
    wrap(UI, 'showLevelUp', args => event('reward_choices', args[3], null, safe(() => json(args[1]))));
    for (const name of ['addCard', 'move', 'moveSlot', 'expandSlot', 'raiseLimit', 'spendRefresh']) {
      wrap(SkillDeck.prototype, name, null, function (args, result) { event(`deck_${name}`, null, result, safe(() => json(args))); rebuilt(); });
    }
    const keys = new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyE','Tab','Escape','Digit1','Digit2','Digit3','Digit4','Digit5']);
    for (const type of ['keydown', 'keyup']) window.addEventListener(type, e => {
      if (keys.has(e.code) && !e.repeat) event('input', type === 'keydown', null, e.code);
    });
    window.addEventListener('blur', () => event('input_reset'));
    window.addEventListener('pagehide', () => { event('pagehide'); void persist(); });
    document.addEventListener('visibilitychange', () => { event('visibility', document.hidden); void flush(); });
    window.addEventListener('online', () => void flush());
    setInterval(() => void flush(), 3000);
    void flush();
  }
  return { attach, status, flush, persist, record: event,
    card(id, targets, env, slot) {
      if (!run) return;
      safe(() => {
        const slotText = slot?.cards?.join('+') ?? null, actor = ref(env.owner || game?.player);
        const targetText = targets.map(t => t.kind === 'point' ? `point:${num(t.x, 1)}:${num(t.y, 1)}` : `${t.kind}:${ref(env.at(t))}`).join(';');
        const key = run + '|' + id + '|' + actor + '|' + slotText + '|' + targetText, seq = ++sequence, time = num(game?.time || 0, 3);
        let entry = repeatedCards.get(key);
        if (!entry) {
          entry = [run, seq, time, text(id, 60), actor, text(slotText), text(targetText), [], []];
          repeatedCards.set(key, entry);
        }
        // Every execution is retained; repeated movement/passive actions share their payload.
        entry[7].push(seq); entry[8].push(time);
        if (entry[7].length >= 120 || repeatedCards.size >= 512) void persist();
      });
    },
    async exportPending() { await persist(); return JSON.stringify({ batches: db ? await transaction('readonly', s => s.getAll()) : [], memory: pending }); },
  };
})();
