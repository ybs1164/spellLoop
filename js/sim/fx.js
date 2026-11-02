'use strict';

const fxFollowIds = new WeakMap();
let fxFollowSeq = 0;
const fxCell = v => Math.round(v / FX_DEDUPE_GRID);

/** 중복 억제 키: 종류·모양 + 자리(따라가는 이펙트는 대상, 아니면 격자 칸. 선은 두 끝점) */
function fxKey(f) {
  let at;
  if (f.follow) {
    at = fxFollowIds.get(f.follow);
    if (at === undefined) fxFollowIds.set(f.follow, at = ++fxFollowSeq);
    at = 'o' + at;
  } else at = fxCell(f.x) + ',' + fxCell(f.y);
  switch (f.kind) {
    case 'circle': return 'c' + at + '|' + f.color + '|' + f.style + '|' + Math.round(f.r / 4);
    case 'beam': return 'b' + at + ',' + fxCell(f.x1) + ',' + fxCell(f.y1) + '|' + f.color + '|' + f.w;
    case 'zap': return 'z' + at + ',' + fxCell(f.x1) + ',' + fxCell(f.y1);
    case 'icon': return 'i' + at + '|' + f.icon;
    default: return f.kind + at;
  }
}

class GameFx {
  /** 과밀 프레임인가: 이펙트·글자·파티클을 CROWD_MAX_* 까지만 쌓는다 */
  get fxCrowded() { return this.enemies.length > ENEMY_UPDATE_BUDGET || this.projectiles.length > SHOT_UPDATE_BUDGET; }

  addFx(f) {
    f.max = f.life; f.dead = false;
    if (this.fxRepeated(f)) return;
    if (this.fx.length >= CROWD_MAX_FX && this.fxCrowded) return;
    pushCapped(this.fx, f, MAX_FX);
  }

  /**
   * 같은 키의 이펙트가 FX_DEDUPE_WINDOW 초 안에 생겼는가. 키 표는 두 세대를 번갈아 쓴다:
   * 창 하나가 지나면 옛 세대를 비우고 새 세대를 옛 세대로 넘기므로, 항목을 하나씩 지우지 않아도 표가 커지지 않는다.
   */
  fxRepeated(f) {
    const now = this.time, key = fxKey(f);
    if (!(now >= this._fxGenAt && now - this._fxGenAt < FX_DEDUPE_WINDOW)) {
      const old = this._fxOld || new Map();
      old.clear();
      this._fxOld = this._fxNew || new Map(); this._fxNew = old; this._fxGenAt = now;
    }
    const at = this._fxNew.get(key) ?? this._fxOld.get(key);
    // 새 판으로 시간이 되돌아간 뒤의 옛 기록(at > now)은 무시한다
    if (at !== undefined && at <= now && now - at < FX_DEDUPE_WINDOW) return true;
    this._fxNew.set(key, now);
    return false;
  }

  /**
   * 원형 도트 이펙트 (PixelCircle 이 그린다). 외곽선 없이 면과 도트 조각만 쓴다.
   * o: { life, follow, style: 'burst'|'wave'|'pulse', fill: 바깥 띠 진하기(0~1), spark: 반짝이 색, sparks: 개수 }
   */
  circleFx(x, y, r, color, o = {}) {
    // 반짝이 배치는 8가지 중 하나: 같은 묶음의 원이 합성 도장을 나눠 쓰게 한다 (난수 소비는 그대로)
    this.addFx({ kind: 'circle', x, y, r, color, life: 0.35, style: 'burst', seed: randInt(0, 7), ...o });
  }

  updateFx(dt) {
    for (const f of this.fx) {
      if (f.follow) { f.x = f.follow.x; f.y = f.follow.y; }
      if ((f.life -= dt) <= 0) f.dead = true;
    }
    compact(this.fx);
  }

  /* ------------------------------------------------------------------ */
  /* 연출                                                                */
  /* ------------------------------------------------------------------ */
  shake(m) { this.shakeMag = Math.max(this.shakeMag, m); }

  /** 단계 시작 배너: 한 줄 힌트 + 보스 시각. 적 특성·기믹의 자세한 설명은 일시정지 화면에 */
  stageBanner() {
    const st = this.stage;
    this.showBanner(`${this.stageStep + 1}단계 · ${st.name}`, st.color,
      `${st.hint} · ${stageBossSummary(st)}`);
  }

  showBanner(text, color, sub) { this.banner = { text, color, sub, life: sub ? 4 : 2.5, max: sub ? 4 : 2.5 }; }

  addText(x, y, text, color) {
    if (this.texts.length >= CROWD_MAX_TEXTS && this.fxCrowded) return;
    pushCapped(this.texts, { x, y, text: String(text), color, life: 0.7, dead: false }, MAX_TEXTS);
  }

  burst(x, y, color, n) {
    const room = this.fxCrowded ? CROWD_MAX_PARTICLES - this.particles.length : Infinity;
    for (let i = 0; i < Math.min(n, MAX_PARTICLES); i++) {
      const a = Math.random() * TAU, s = rand(60, 220), life = rand(0.25, 0.55), size = rand(2, 4.5);
      if (i >= room) continue;
      pushCapped(this.particles, {
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life, max: 0.55, size, color, dead: false,
      }, MAX_PARTICLES);
    }
  }

  updateEffects(dt) {
    for (const pt of this.particles) {
      pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      pt.vx *= 0.9; pt.vy *= 0.9;
      if ((pt.life -= dt) <= 0) pt.dead = true;
    }
    for (const t of this.texts) {
      t.y -= 40 * dt;
      if ((t.life -= dt) <= 0) t.dead = true;
    }
    if (this.fx) this.updateFx(dt);
    compact(this.particles);
    compact(this.texts);
  }
}
mixin(Game, GameFx);
