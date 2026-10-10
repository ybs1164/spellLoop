'use strict';

class GameFx {
  addFx(f) {
    f.max = f.life; f.dead = false;
    pushCapped(this.fx, f, MAX_FX);
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
    pushCapped(this.texts, { x, y, text: String(text), color, life: 0.7, dead: false }, MAX_TEXTS);
  }

  burst(x, y, color, n) {
    for (let i = 0; i < Math.min(n, MAX_PARTICLES); i++) {
      const a = Math.random() * TAU, s = rand(60, 220);
      pushCapped(this.particles, {
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: rand(0.25, 0.55), max: 0.55, size: rand(2, 4.5), color, dead: false,
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
