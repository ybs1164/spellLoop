'use strict';

// No SDK, login or gameplay dependency. Durable batches are retried by stable UUID.
globalThis.PlayLog = (() => {
  const config = globalThis.PLAY_LOG_CONFIG || {};
  const enabled = !!(config.url && config.key);
  const uuid = () => crypto.randomUUID();
  let db, game, run, sequence = 0, frame = 0, pending = [], busy = false;
  let persisting = null, lastSnapshot = -1;
  let ids = new WeakMap(), nextId = 0, known = new Map();
  const repeatedCards = new Map();
  const status = { enabled, persisted: 0, uploaded: 0, error: null };
  const fail = error => { status.error = String(error?.message || error); console.warn('[PlayLog]', status.error); };
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
  function entity(o) {
    if (!o) return null;
    const stats = {};
    for (const key of ENTITY_STAT_NAMES) stats[key] = entityStats(o)[key];
    return { id: ref(o), kind: o.type || o.kind || o.constructor?.name, team: o.team,
      x: o.x, y: o.y, hp: o.hp, shield: o.shield, dead: !!o.dead, life: o.life,
      level: o.level, xp: o.xp, stats, buffs: { ...o.buffs }, states: { ...o.directStates },
      slots: (o.deck ? o.deck.slots : o.slots || []).map(s => ({ cards: [...s.cards], limit: s.limit, cd: s.cd })),
      inventory: o.deck?.inventory?.slice(), costPoints: o.deck?.costPoints };
  }
  function record(type, data = {}) {
    if (!run) return;
    pending.push({ run, seq: ++sequence, frame, time: type === 'run_start' ? 0 : game?.time || 0, at: Date.now(), type, data });
    if (pending.length >= 128) void persist();
  }
  function persist() {
    drainCards();
    // Serialize writes; failed batches remain in memory, never silently discarded.
    if (persisting) return persisting;
    persisting = (async () => {
      if (!pending.length || !await ready) return;
      while (pending.length) {
        let events = pending.slice(0, 128);
        const batch = { id: uuid(), build: config.build || 'unknown', events };
        // Leave room for PostgreSQL jsonb's canonical whitespace in its size check.
        while (new TextEncoder().encode(JSON.stringify(batch)).length > 350000) {
          if (events.length === 1) throw new Error('A log event exceeds the 350 KB upload limit; export pending logs');
          events = events.slice(0, Math.ceil(events.length / 2));
          batch.events = events;
        }
        await transaction('readwrite', store => store.put(batch));
        pending.splice(0, events.length);
        status.persisted += events.length;
      }
    })().catch(fail).finally(() => { persisting = null; });
    return persisting;
  }
  function drainCards() {
    pending.push(...repeatedCards.values());
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
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(`${config.url.replace(/\/$/, '')}/rest/v1/rpc/ingest_play_log`, {
            method: 'POST', headers: { apikey: config.key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ batch }), signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Supabase HTTP ${response.status}`);
          await transaction('readwrite', store => store.delete(batch.id));
          status.uploaded += batch.events.length;
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
      const id = ref(o); current.set(id, true);
      if (!known.has(id)) record('entity_spawn', entity(o));
      else if (full) record('entity_snapshot', entity(o));
    }
    for (const id of known.keys()) if (!current.has(id)) record('entity_removed', { id });
    known = current;
    if (full) lastSnapshot = game.time;
  }
  function attach(g) {
    game = g;
    wrap(g, 'start', () => {
      if (run) record('run_abandoned', { reason: 'restart' });
      run = uuid(); sequence = 0; frame = 0; ids = new WeakMap(); nextId = 0; known.clear(); lastSnapshot = -1;
      record('run_start', { build: config.build, viewport: { width: g.w, height: g.h } });
    }, () => { record('run_ready', { route: g.route }); snapshot(true); });
    wrap(g, 'update', () => { if (run) frame++; }, () => snapshot());
    for (const name of ['spawnEnemy', 'spawnProjectile', 'summonAlly', 'place', 'addZone']) {
      wrap(g, name, null, (args, result) => {
        if (!run || !result || known.has(ref(result))) return;
        known.set(ref(result), true);
        record('entity_spawn', entity(result));
      });
    }
    for (const name of ['enterStage', 'pause', 'resume', 'openEditor', 'closeEditor', 'openInspector', 'closeInspector', 'onLevelUp', 'openLevelUp']) {
      wrap(g, name, null, args => { record(name, { args, state: g.state, stage: g.stageIdx }); snapshot(true); });
    }
    wrap(g, 'endRun', null, args => { snapshot(true); record('run_end', { victory: args[0], kills: g.kills, player: entity(g.player) }); run = null; void flush(); });
    wrap(g, 'toTitle', () => { record('run_abandoned', { reason: 'title', player: entity(g.player) }); run = null; void flush(); });
    for (const name of ['damageEnemy', 'hurtEnemy', 'healEnemy', 'restoreEnemy', 'damageTarget', 'healTarget', 'addDebuff', 'killEnemy', 'consumeTarget']) {
      wrap(g, name, args => {
        const o = name === 'damageTarget' ? g.targetObj(args[0]) : args[0];
        return { o, hp: o?.hp, shield: o?.shield };
      }, (args, result, before) => record(name, { target: ref(before.o), value: args[1], hpBefore: before.hp, hpAfter: before.o?.hp,
        shieldBefore: before.shield, shieldAfter: before.o?.shield, dead: before.o?.dead, actor: ref(g.actionActor || g.player),
        parameters: args.slice(1).filter(v => v == null || ['string', 'number', 'boolean'].includes(typeof v)) }));
    }
    for (const name of ['takeDamage', 'heal', 'gainXp', 'applyBuff']) {
      wrap(Player.prototype, name, function () { return { hp: this.hp, shield: this.shield }; }, function (args, result, before) {
        record(`player_${name}`, { value: args[0], before, player: entity(this) });
      });
    }
    wrap(Pickup.prototype, 'collect', function () { record('pickup_collect', entity(this)); });
    for (const name of ['act', 'applyMove', 'pickLevelUp', 'refreshLevelUp']) {
      wrap(UI, name, args => record(`ui_${name}`, { args: JSON.parse(JSON.stringify(args)) }), () => record('player_build', entity(g.player)));
    }
    wrap(UI, 'showLevelUp', args => record('reward_choices', { choices: args[1], leveled: args[3] }));
    for (const name of ['addCard', 'move', 'moveSlot', 'expandSlot', 'raiseLimit', 'spendRefresh']) {
      wrap(SkillDeck.prototype, name, null, function (args, result) { record(`deck_${name}`, { args, result, player: entity(g.player) }); });
    }
    const keys = new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyE','Tab','Escape','Digit1','Digit2','Digit3','Digit4','Digit5']);
    for (const type of ['keydown', 'keyup']) window.addEventListener(type, e => {
      if (keys.has(e.code) && !e.repeat) record('input', { type, code: e.code });
    });
    window.addEventListener('blur', () => record('input_reset'));
    window.addEventListener('pagehide', () => { record('pagehide'); void persist(); });
    document.addEventListener('visibilitychange', () => { record('visibility', { hidden: document.hidden }); void flush(); });
    window.addEventListener('online', () => void flush());
    setInterval(() => void flush(), 3000);
    void flush();
  }
  return { attach, status, flush, persist, record, entity,
    card(id, targets, env, slot) {
      if (!run) return;
      safe(() => {
        const data = { card: id, slot: slot ? { ...slot, cards: slot.cards?.slice() } : null, actor: ref(env.owner || game?.player),
          targets: targets.map(t => t.kind === 'point' ? { kind: 'point', x: t.x, y: t.y } : { kind: t.kind, id: ref(env.at(t)) }) };
        const key = run + JSON.stringify(data), seq = ++sequence;
        let event = repeatedCards.get(key);
        if (!event) {
          event = { run, seq, frame, time: game?.time || 0, at: Date.now(), type: 'card_execute', data, executions: [] };
          repeatedCards.set(key, event);
        }
        // Every execution is retained; repeated movement/passive actions share their payload.
        event.executions.push([seq, frame, game?.time || 0]);
        if (event.executions.length >= 120 || repeatedCards.size >= 512) void persist();
      });
    },
    async exportPending() { await persist(); return JSON.stringify({ batches: db ? await transaction('readonly', s => s.getAll()) : [], memory: pending }); },
  };
})();
