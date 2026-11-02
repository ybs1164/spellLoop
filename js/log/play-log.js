'use strict';

// No SDK, login or gameplay dependency. Each run is one summary row (see supabase/play-logs.sql),
// kept in IndexedDB under its run UUID and upserted at stage entries and run end; retries overwrite server-side.
globalThis.PlayLog = (() => {
  const config = globalThis.PLAY_LOG_CONFIG || {};
  const enabled = !!(config.url && config.key);
  const build = config.build || 'unknown';
  const MAX_KEYS = 120;
  let db, game, run = null, busy = false;
  const status = { enabled, saved: 0, uploaded: 0, error: null };
  const fail = error => { status.error = String(error?.message || error); console.warn('[PlayLog]', status.error); };
  const num = (v, d = 2) => Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null;
  const int = v => Number.isFinite(v) ? Math.trunc(v) : null;
  const kindOf = o => o && typeof o === 'object' ? String(o.type || o.kind || o.constructor?.name || 'unknown').slice(0, 60) : 'none';
  // 이전 판의 원본 행동 기록 저장소는 더 이상 쓰지 않는다(브라우저 용량 정리).
  try { indexedDB.deleteDatabase('spell-loop-play-log'); } catch {}
  const ready = new Promise(resolve => {
    try {
      const request = indexedDB.open('amagos-run-log', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('runs', { keyPath: 'run' });
      request.onsuccess = () => { db = request.result; resolve(true); };
      request.onerror = () => { fail(request.error); resolve(false); };
    } catch (error) { fail(error); resolve(false); }
  });
  const transaction = (mode, action) => new Promise((resolve, reject) => {
    const tx = db.transaction('runs', mode);
    const request = action(tx.objectStore('runs'));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Log storage transaction failed'));
  });
  // 키 수를 묶어 둔 합계표 (판 하나의 요약 크기가 덱 크기 이상으로 늘지 않게)
  function add(map, key, value) {
    if (!(value > 0)) return;
    if (!map.has(key) && map.size >= MAX_KEYS) key = 'other';
    map.set(key, (map.get(key) || 0) + value);
  }
  const deckText = deck => (deck?.slots || []).map(s => `${cooldownText(slotCooldown(s))}:${s.cards.join('+')}`).join('|');
  function summary() {
    const p = game.player, pairs = (map, d) => [[...map.keys()], [...map.values()].map(v => num(v, d))];
    const [card_id, card_n] = pairs(run.cards, 0), [dmg_src, dmg_val] = pairs(run.dealt, 1), [hurt_src, hurt_val] = pairs(run.hurt, 1);
    return { run: run.id, build, started: run.started, result: run.result, duration: num(game.time || 0, 1),
      kills: int(game.kills), stage: int(game.stageStep), route: (game.route || []).map(int), stage_t: run.stageT,
      level: int(p?.level), hp: num(p?.hp, 1), deck: deckText(p?.deck), inventory: p?.deck?.inventory?.join(',') ?? null,
      picks: run.picks, card_id, card_n, dmg_src, dmg_val, hurt_src, hurt_val, edits: run.edits, w: int(game.w), h: int(game.h) };
  }
  // 저장은 판마다 한 레코드를 덮어쓴다. 최신 요약은 메모리에도 남겨 저장소가 없어도 내보낼 수 있다.
  let latest = null, saving = Promise.resolve();
  function save() {
    if (!run || !game?.player) return saving;
    const record = latest = summary();
    status.saved++;
    saving = saving.then(async () => { if (await ready) await transaction('readwrite', store => store.put(record)); }).catch(fail);
    return saving;
  }
  async function flush() {
    if (busy) return;
    busy = true;
    try {
      await saving;
      if (!enabled || !db) return;
      for (const record of await transaction('readonly', store => store.getAll())) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(`${config.url.replace(/\/$/, '')}/rest/v1/rpc/ingest_run_summary`, {
            method: 'POST', headers: { apikey: config.key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ s: record }), signal: controller.signal, keepalive: true,
          });
          if (!response.ok) throw new Error(`Supabase HTTP ${response.status}`);
          // 전송 중 같은 판이 다시 저장됐으면 그 최신본은 남겨 둔다.
          const current = await transaction('readonly', store => store.get(record.run));
          if (current && JSON.stringify(current) === JSON.stringify(record)) await transaction('readwrite', store => store.delete(record.run));
          status.uploaded++;
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
  function finish(result) {
    if (!run) return;
    run.result = result;
    save();
    run = null;
    void flush();
  }
  function attach(g) {
    game = g;
    wrap(g, 'start', () => finish('abandoned:restart'), () => {
      run = { id: crypto.randomUUID(), started: Date.now(), result: null, stageT: [num(g.time || 0, 1)], picks: [],
        cards: new Map(), dealt: new Map(), hurt: new Map(), edits: 0, nextSave: 30 };
      save();
    });
    wrap(g, 'enterStage', null, args => {
      if (!run || !(args[0] > 0)) return;
      run.stageT.push(num(g.time, 1));
      save(); void flush();
    });
    // 30초(게임 시간)마다 로컬에만 저장한다. 업로드는 스테이지 진입·판 종료·페이지 이탈 때만.
    wrap(g, 'update', null, () => { if (run && g.time >= run.nextSave) { run.nextSave = g.time + 30; save(); } });
    wrap(g, 'endRun', null, args => finish(args[0] ? 'victory' : 'defeat'));
    wrap(g, 'toTitle', () => finish('abandoned:title'));
    wrap(g, 'claimReward', args => {
      const [entry, i] = args, id = entry?.choices?.[i];
      if (run && id) run.picks.push(`${num(g.time, 1)}|${entry.kind}|${entry.choices.join(',')}|${id}`.slice(0, 300));
    });
    // 적에게 준 피해: 같은 대상에 대한 중첩 호출(damageEnemy → hurtEnemy 등)은 바깥 호출에서 한 번만 센다.
    const active = new Set();
    const source = () => g.actionCard ? String(cardBaseIdOfCard(g.actionCard) || 'card').slice(0, 60) : kindOf(g._collisionSource || g.actionActor);
    for (const name of ['damageEnemy', 'hurtEnemy', 'damageTarget', 'killEnemy', 'consumeTarget']) {
      const original = g[name];
      if (typeof original !== 'function') continue;
      g[name] = function (...args) {
        const o = run ? safe(() => name === 'damageTarget' ? g.targetObj(args[0]) : args[0]) : null;
        if (!o || typeof o !== 'object' || active.has(o)) return original.apply(this, args);
        const hp = o.hp, shield = o.shield || 0;
        active.add(o);
        try { return original.apply(this, args); }
        finally {
          active.delete(o);
          safe(() => run && add(run.dealt, source(), Math.max(0, hp - o.hp) + Math.max(0, shield - (o.shield || 0))));
        }
      };
    }
    wrap(Player.prototype, 'takeDamage', function () { return { hp: this.hp, shield: this.shield || 0 }; }, function (args, result, before) {
      if (run) add(run.hurt, kindOf(g._collisionSource || g.actionActor), Math.max(0, before.hp - this.hp) + Math.max(0, before.shield - (this.shield || 0)));
    });
    for (const name of ['addCard', 'move', 'moveSlot']) wrap(SkillDeck.prototype, name, null, () => { if (run) run.edits++; });
    window.addEventListener('pagehide', () => { save(); void flush(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { save(); void flush(); } });
    window.addEventListener('online', () => void flush());
    // 이전 방문에서 못 올린 요약(크래시·오프라인)을 올린다.
    void flush();
  }
  return { attach, status, flush, save,
    card(id) { if (run) safe(() => add(run.cards, String(id).slice(0, 60), 1)); },
    async exportPending() { await saving; return JSON.stringify({ runs: db ? await transaction('readonly', s => s.getAll()) : [], memory: latest }); },
  };
})();
