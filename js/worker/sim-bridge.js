'use strict';

/*
 * 시뮬레이션 워커 브리지 (실험, `?worker=1` + http(s) 에서만).
 * 워커(js/worker/sim-worker.js)가 보낸 스냅샷으로 복제 개체를 만들어 Game.render 와 개체 draw 를 그대로 쓴다.
 * 아직 지원하지 않는 것: 레벨업·편집기·일시정지 화면 (워커가 레벨업을 자동으로 넘긴다), 카드 편집.
 */
const SimBridge = {
  PROTOS: { Placed, Ally, Projectile, Pickup, Player, SkillDeck },
  ENEMY_STRIDE,

  supported() {
    return typeof Worker !== 'undefined' && /^https?:$/.test(location.protocol) && new URLSearchParams(location.search).has('worker');
  },

  attach(game) {
    const bridge = Object.create(this);
    bridge.game = game;
    bridge.gen = 0;
    bridge.latest = null;
    bridge.enemyPool = [];
    bridge.templates = new Map();
    bridge.typeIds = Object.keys(ENEMY_TYPES);
    bridge.guardSlot = { has: id => id === 'entityGuard' };
    bridge.armorSlot = { has: id => id === 'armor' };
    bridge.bothSlot = { has: id => id === 'entityGuard' || id === 'armor' };
    bridge.noSlot = { has: () => false };
    bridge.keysSent = '';
    bridge.worker = new Worker('js/worker/sim-worker.js' + (SIM_FAST_MATH ? '?math=fast' : '?math=exact'));
    bridge.worker.onmessage = ({ data }) => {
      if (data.type === 'snap') { if (data.gen === bridge.gen) bridge.latest = data; bridge.worker.postMessage({ type: 'ack' }); }
      else if (data.type === 'debug') bridge.debugResult = data.result;
    };
    bridge.worker.onerror = e => console.error('sim worker', e.message, e.filename, e.lineno);
    bridge.stats = { snapshots: 0, applyMs: 0 };
    game.driver = bridge;
    game.sim = bridge;
    window.addEventListener('resize', () => bridge.worker.postMessage({ type: 'resize', w: game.w, h: game.h }));
    return bridge;
  },

  /** Game.start 대신 불린다: 워커에 새 판을 시작시키고 화면을 전투 상태로 바꾼다. */
  start(game, route = rollStageRoute()) {
    game.events.clear();
    game.route = route;
    game.state = 'playing';
    game.player = null;
    this.gen++;
    this.latest = null;
    this.ended = false;
    UI.hideOverlay();
    UI.showHud(true);
    this.worker.postMessage({ type: 'start', gen: this.gen, route, w: game.w, h: game.h, debug: new URLSearchParams(location.search).has('debug') });
  },

  /** Game.update 대신 불린다 (타이틀 화면 제외): 최신 스냅샷을 적용하고 HUD·종료 화면만 갱신한다. */
  update(game, dt) {
    game.clock += dt;
    this.sendKeys();
    const snap = this.latest;
    if (snap) {
      this.latest = null;
      const t = performance.now();
      this.apply(snap);
      this.stats.applyMs += (performance.now() - t - this.stats.applyMs) * 0.1;
    }
    if (game.player) UI.updateHud(game);
    const over = game.state === 'gameover' || game.state === 'victory';
    if (over && !this.ended) {
      this.ended = true;
      UI.showEnd(game, game.state === 'victory');
    }
    if (over && Input.consume('Enter')) game.start();
    Input.endFrame();
  },

  sendKeys() {
    const keys = [...Input.keys].sort().join(',');
    if (keys === this.keysSent) return;
    this.keysSent = keys;
    this.worker.postMessage({ type: 'keys', keys: [...Input.keys] });
  },

  /** 평범한 객체를 해당 클래스의 프로토타입을 가진 복제 개체로 */
  revive(plain) {
    const proto = this.PROTOS[plain.__c];
    if (!proto) return plain;
    const o = Object.create(proto.prototype);
    // 투사체의 접근자 필드(SoA)는 복제 개체에서 자기 값으로 둔다 (그리기만 하는 복제는 SoA 슬롯을 쓰지 않는다)
    if (proto === Projectile) for (const k of [...PROJECTILE_SOA_PROPS, ...PROJECTILE_GUARD_PROPS]) Object.defineProperty(o, k, { value: undefined, writable: true, enumerable: true, configurable: true });
    Object.assign(o, plain);
    return o;
  },

  template(typeId) {
    let t = this.templates.get(typeId);
    if (!t) { t = new Enemy(typeId, 0, 0, 1); this.templates.set(typeId, t); }
    return t;
  },

  apply(snap) {
    const g = this.game, s = snap.scalars;
    Object.assign(g, s);
    g.stage = STAGES[g.stageIdx];
    g._enemyCount = snap.enemyCount;
    snap.player.deck = this.revive(snap.player.deck);
    g.player = this.revive(snap.player);
    for (const name of ['allies', 'objects', 'zones', 'projectiles', 'pickups']) g[name] = snap[name].map(o => this.revive(o));
    g.hazards = snap.hazards; g.particles = snap.particles; g.texts = snap.texts;
    // 이펙트는 그리기 쪽 캐시(_sparks)가 개체에 붙으므로 번호로 같은 복제 개체를 이어 쓴다
    const fxMap = this.fxMap ||= new Map(), seen = new Map();
    g.fx = snap.fx.map(f => {
      const old = fxMap.get(f._sid);
      const o = old ? Object.assign(old, f) : f;
      seen.set(f._sid, o);
      return o;
    });
    this.fxMap = seen;
    // 적: 종류별 견본(견본의 기본 필드·정의)에서 이어받아 바뀌는 필드만 덮는다
    const buf = snap.enemies, n = buf.length / this.ENEMY_STRIDE, pool = this.enemyPool, list = g.enemies = [];
    for (let i = 0; i < n; i++) {
      const o = i * this.ENEMY_STRIDE, typeId = this.typeIds[buf[o + 14]];
      let e = pool[i];
      if (!e || e.type !== typeId) {
        e = pool[i] = Object.create(this.template(typeId));
        e.type = typeId;
        e._si = ESoA.alloc(); e._pooled = true; ESoA.buffy[e._si] = 0;   // 견본이 아니라 자기 슬롯을 쓴다 (목록에서 빠져도 풀에 남으므로 해제하지 않는다)
        // 스냅샷이 보내지 않는 SoA 필드는 견본 값으로 채운다 (슬롯 재사용으로 남은 값을 읽지 않게)
        const t = this.template(typeId);
        for (const f of ['speed', 'damage', 'knockback', 'directFrozen', 'directMove', 'cardMove', 'strafe', 'kx', 'ky']) e[f] = t[f];
        e.dead = false;
      }
      e.x = buf[o]; e.y = buf[o + 1]; e.radius = buf[o + 2]; e.wobble = buf[o + 3]; e.ang = buf[o + 4];
      e.flash = buf[o + 5]; e.healT = buf[o + 6]; e.freezeT = buf[o + 7]; e.burnT = buf[o + 8];
      e.rootT = buf[o + 9]; e.markT = buf[o + 10]; e.fearT = buf[o + 11]; e.hp = buf[o + 12]; e.maxHp = buf[o + 13];
      e.sprite = buf[o + 15]; e.scale = buf[o + 16];
      const flags = buf[o + 17];
      e.boss = (flags & 1) !== 0;
      e.slot = flags & 6 ? (flags & 2 ? (flags & 4 ? this.bothSlot : this.guardSlot) : this.armorSlot) : this.noSlot;
      list.push(e);
    }
    this.stats.snapshots++;
    this.stats.simMs = snap.simMs; this.stats.snapMs = snap.snapMs;
  },
};
