'use strict';

const FONT = 'Galmuri11, "Malgun Gothic", sans-serif';
const TEXT_FONT = `bold 13px ${FONT}`;   // 피해 숫자
const BG_COLOR = '#10131c';

class GameRender {
  drawZones(ctx) {
    for (const z of this.zones) {
      if (!this.inView(z.x, z.y, z.r + 20)) continue;
      const fade = Math.min(1, z.life / 0.4, (z.max - z.life) / 0.15 + 0.2);
      ctx.globalAlpha = fade;
      switch (z.kind) {
        case 'healingField':
        case 'shieldField':
        case 'burningField': {
          const color = z.kind === 'healingField' ? '#5be37a' : z.kind === 'shieldField' ? '#7fb2ff' : '#ff7b2e';
          ctx.fillStyle = color;
          ctx.globalAlpha = fade * 0.18;
          Px.disc(ctx, z.x, z.y, z.r);
          ctx.globalAlpha = fade * 0.8;
          Px.arc(ctx, z.x, z.y, z.r, 0, TAU);
          Sprites.icon(ctx, z.kind === 'healingField' ? 'heal' : z.kind === 'shieldField' ? 'shield' : 'burn', z.x, z.y, 2);
          break;
        }
        case 'poison':
          ctx.fillStyle = Px.dither(ctx, 'rgba(88,200,90,0.45)');
          Px.disc(ctx, z.x, z.y, z.r);
          ctx.fillStyle = 'rgba(140,240,120,0.55)';
          for (let i = 0; i < 7; i++) {   // 부글거리는 도트 거품
            const a = i * 0.9 + this.clock * 0.7, rr = z.r * (0.25 + ((i * 37) % 10) / 14);
            const s = Px.G * (1 + ((this.clock * 3 + i) % 2 | 0));
            ctx.fillRect(Px.snap(z.x + Math.cos(a) * rr), Px.snap(z.y + Math.sin(a) * rr * 0.7), s, s);
          }
          break;
        case 'ward':
          ctx.fillStyle = Px.dither(ctx, 'rgba(255,224,138,0.18)');
          Px.disc(ctx, z.x, z.y, z.r);
          ctx.fillStyle = `rgba(255,224,138,${0.55 + Math.sin(this.clock * 8) * 0.2})`;
          Px.arc(ctx, z.x, z.y, z.r, 0, TAU);
          break;
        case 'vortex':
          ctx.fillStyle = 'rgba(196,155,255,0.6)';
          for (let i = 0; i < 3; i++) {
            const a = -this.clock * 5 + i * (TAU / 3);
            Px.arc(ctx, z.x, z.y, z.r * (0.35 + i * 0.22), a, a + 1.6);
          }
          break;
        case 'blades':
          ctx.globalAlpha = 1;
          for (let k = 0, count = z.slot.effect('orbit')?.count ?? 3; k < count; k++) {
            const a = z.spin + k * (TAU / count);
            Sprites.icon(ctx, 'blades', z.x + Math.cos(a) * z.r, z.y + Math.sin(a) * z.r, 2);
          }
          break;
        case 'slime':
          ctx.fillStyle = Px.dither(ctx, 'rgba(111,208,140,0.5)');
          Px.disc(ctx, z.x, z.y, z.r);
          ctx.fillStyle = 'rgba(170,240,180,0.6)';
          for (let i = 0; i < 9; i++) {   // 출렁이는 점액 방울
            const a = i * 0.7 + this.clock * 0.4, rr = z.r * (0.2 + ((i * 29) % 10) / 13);
            const s = Px.G * (1 + ((this.clock * 2 + i) % 2 | 0));
            ctx.fillRect(Px.snap(z.x + Math.cos(a) * rr), Px.snap(z.y + Math.sin(a) * rr * 0.7), s, s);
          }
          break;
        case 'abyss': {
          const t = 1 - z.life / z.max;
          ctx.fillStyle = Px.dither(ctx, 'rgba(60,0,40,0.55)', Px.G * 2);
          Px.disc(ctx, z.x, z.y, z.r, Px.G * 2);
          ctx.globalAlpha = fade * (0.45 + t * 0.35);
          ctx.fillStyle = '#140010';
          Px.disc(ctx, z.x, z.y, z.r * (0.4 + t * 0.2));
          ctx.globalAlpha = fade;
          ctx.fillStyle = 'rgba(255,59,107,0.75)';
          for (let i = 0; i < 4; i++) {
            const a = this.clock * 6 + i * (TAU / 4);
            Px.arc(ctx, z.x, z.y, z.r * (0.3 + i * 0.18), a, a + 1.3);
          }
          break;
        }
        case 'meteor': {
          const t = 1 - z.life / z.max;
          ctx.globalAlpha = 1;
          // 낙하 예고: 옅은 디더 원 위로 진한 원이 차오른다
          ctx.fillStyle = Px.dither(ctx, 'rgba(255,90,60,0.5)');
          Px.disc(ctx, z.x, z.y, z.r);
          ctx.fillStyle = 'rgba(255,90,60,0.3)';
          Px.disc(ctx, z.x, z.y, z.r * t);
          Sprites.icon(ctx, 'meteor', z.x + (1 - t) * 120, z.y - (1 - t) * 320, 3);
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  drawFx(ctx) {
    // 과밀이면 가장 최근 이펙트만 그린다
    const fx = this.fx, from = this.crowded ? Math.max(0, fx.length - CROWD_FX_DRAW) : 0;
    for (let fi = from; fi < fx.length; fi++) {
      const f = fx[fi];
      if (!this.fxInView(f)) continue;
      const t = 1 - f.life / f.max;   // 0 → 1
      ctx.globalAlpha = Math.max(0, 1 - t * t);
      switch (f.kind) {
        case 'circle':
          PixelCircle.draw(ctx, f, t);
          break;
        case 'slash': {
          ctx.fillStyle = '#ffffff';
          const w = t < 0.5 ? Px.G * 2 : Px.G;
          for (const d of [-0.5, 0.5]) {
            const a = f.ang + d * 1.6, cx = Math.cos(a) * f.r, cy = Math.sin(a) * f.r;
            Px.line(ctx, f.x - cx, f.y - cy, f.x + cx, f.y + cy, w);
          }
          break;
        }
        case 'beam':
          ctx.fillStyle = f.color;
          Px.line(ctx, f.x, f.y, f.x1, f.y1, f.w * (1 - t) + Px.G);
          if (f.w >= 6 && t < 0.6) { ctx.fillStyle = '#ffffff'; Px.line(ctx, f.x, f.y, f.x1, f.y1, Px.G); }
          break;
        case 'zap': {
          // 지그재그 번개 (지속 시간 동안 모양 고정)
          ctx.fillStyle = '#fff27a';
          let px = f.x, py = f.y;
          for (let i = 1; i <= 6; i++) {
            const k = i / 6, j = i === 6 ? 0 : (hash2(Math.round(f.x) + i, Math.round(f.y1)) - 0.5) * 22;
            const nx = f.x + (f.x1 - f.x) * k + j, ny = f.y + (f.y1 - f.y) * k - j;
            Px.line(ctx, px, py, nx, ny, Px.G);
            px = nx; py = ny;
          }
          break;
        }
        case 'icon':
          Sprites.icon(ctx, f.icon, f.x, f.y - f.off - t * 8, 2);
          break;
      }
    }
    ctx.globalAlpha = 1;
  }

  drawHazards(ctx) {
    const hazards = this.hazards;
    for (let hi = this.crowded ? Math.max(0, hazards.length - CROWD_HAZARD_DRAW) : 0; hi < hazards.length; hi++) {
      const h = hazards[hi];
      if (!this.inView(h.x, h.y, 20)) continue;

      const s = h.r + Math.sin(this.clock * 20 + h.x) * 1.5;
      ctx.fillStyle = `${h.color}55`;
      ctx.fillRect(Math.round(h.x - s - 3), Math.round(h.y - s - 3), (s + 3) * 2, (s + 3) * 2);
      ctx.fillStyle = h.color;
      ctx.fillRect(Math.round(h.x - s), Math.round(h.y - s), s * 2, s * 2);
      ctx.fillStyle = '#fff3c4';
      ctx.fillRect(Math.round(h.x - s / 2), Math.round(h.y - s / 2), s, s);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 렌더링                                                              */
  /* ------------------------------------------------------------------ */
  inView(x, y, r) {
    return Math.abs(x - this.cam.x) < this.w / 2 + r && Math.abs(y - this.cam.y) < this.h / 2 + r;
  }

  /**
   * 과밀(적이 갱신 상한보다 많음) 때의 적 그리기: 화면을 격자로 나눠 한 칸에 CROWD_DRAW_PER_CELL 마리까지만 그린다.
   * 겹쳐 쌓인 더미에서 가려지는 적을 건너뛰는 것이라 배열 순서대로 정해져 깜빡이지 않는다 (보스는 항상 그린다).
   */
  drawCrowd(ctx, pad) {
    const cell = CROWD_DRAW_CELL, cols = Math.ceil((this.w + 160) / cell), rows = Math.ceil((this.h + 160) / cell), size = cols * rows;
    let grid = this._crowdGrid;
    if (!grid || grid.length < size) grid = this._crowdGrid = new Uint8Array(size); else grid.fill(0, 0, size);
    const left = this.cam.x - this.w / 2 - 80, top = this.cam.y - this.h / 2 - 80;
    // inView 와 같은 식을 펼쳐 쓴다 (적 수천 마리를 훑는 자리)
    const camX = this.cam.x, camY = this.cam.y, hw = this.w / 2, hh = this.h / 2, bosses = this._frameBosses;
    for (const e of this.enemies) {
      if (e.boss) bosses.push(e);
      const r = Math.max(TILE * e.scale / 2 + e.radius * 0.15 + 2, e.radius + 24) + pad;
      if (!(Math.abs(e.x - camX) < hw + r && Math.abs(e.y - camY) < hh + r)) continue;
      if (!e.boss) {
        const cx = Math.floor((e.x - left) / cell), cy = Math.floor((e.y - top) / cell);
        if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) {
          const k = cy * cols + cx;
          if (grid[k] >= CROWD_DRAW_PER_CELL) continue;
          grid[k]++;
        }
      }
      e.draw(ctx, this.clock, this);
    }
  }

  /** 과밀(투사체가 SHOT_UPDATE_BUDGET 보다 많음) 때의 투사체 그리기: CROWD_SHOT_DRAW_CELL 칸마다 하나만 그린다 (같은 자리에 겹친 탄을 건너뛴다). */
  drawCrowdShots(ctx) {
    const cell = CROWD_SHOT_DRAW_CELL, cols = Math.ceil((this.w + 60) / cell), rows = Math.ceil((this.h + 60) / cell), size = cols * rows;
    let grid = this._shotGrid;
    if (!grid || grid.length < size) grid = this._shotGrid = new Uint8Array(size); else grid.fill(0, 0, size);
    const left = this.cam.x - this.w / 2 - 30, top = this.cam.y - this.h / 2 - 30;
    // GL 배치에 쌓는 중이면 기본 모양 탄은 기록기를 거치지 않고 바로 쌓는다 (그리는 사각형·순서는 같다)
    const fast = GLSprites.ok && ctx === GLSprites._rec, dotDraw = Projectile.prototype.draw;
    for (const pr of this.projectiles) {
      if (!this.inView(pr.x, pr.y, 30)) continue;
      if (pr.shape === 'dot') {
        const cx = Math.floor((pr.x - left) / cell), cy = Math.floor((pr.y - top) / cell);
        if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) {
          const k = cy * cols + cx;
          if (grid[k]) continue;
          grid[k] = 1;
        }
        if (fast && pr.draw === dotDraw && this.drawDotShot(pr)) { ctx.globalAlpha = 1; continue; }
      }
      pr.draw(ctx);
    }
  }

  /** Projectile.draw 의 기본 모양(꼬리 점 셋 + 탄두 + 흰 점, 끝나면 globalAlpha 1)과 같은 사각형을 GL 배치에 바로 쌓는다. 색을 해석할 수 없으면 false. */
  drawDotShot(pr) {
    const c = GLSprites.parseColor(pr.color);
    if (!c) return false;
    const x = pr.x, y = pr.y, vx = pr.vx, vy = pr.vy;
    const r = Math.max(3, Math.round(pr.radius)), sp = Math.hypot(vx, vy) || 1, ux = vx / sp, uy = vy / sp;
    const G = Px.G, body = r >= 5 ? G * 3 : G * 2;
    for (let i = 3; i >= 1; i--) {
      const sz = i === 3 ? G : body - G;
      GLSprites.rect(Math.round((x - ux * i * r * 1.4 - sz / 2) / G) * G, Math.round((y - uy * i * r * 1.4 - sz / 2) / G) * G, sz, sz, c[0], c[1], c[2], c[3] * (0.25 + (3 - i) * 0.12));
    }
    const bx = Math.round((x - body / 2) / G) * G, by = Math.round((y - body / 2) / G) * G, o = body > G * 2 ? G : 0;
    GLSprites.rect(bx, by, body, body, c[0], c[1], c[2], c[3]);
    GLSprites.rect(bx + o, by + o, G, G, 1, 1, 1, 1);
    return true;
  }

  /** 이펙트가 그리는 범위가 화면(흔들림 포함)에 걸치는가. 여유를 넉넉히 둬 결과 화면은 같다. */
  fxInView(f) {
    const margin = this.shakeMag + 32;
    if (f.kind === 'beam' || f.kind === 'zap') {
      const pad = (f.w || 0) + 24 + margin;
      const x0 = Math.min(f.x, f.x1), x1 = Math.max(f.x, f.x1), y0 = Math.min(f.y, f.y1), y1 = Math.max(f.y, f.y1);
      return x1 > this.cam.x - this.w / 2 - pad && x0 < this.cam.x + this.w / 2 + pad && y1 > this.cam.y - this.h / 2 - pad && y0 < this.cam.y + this.h / 2 + pad;
    }
    if (f.kind === 'icon') return this.inView(f.x, f.y, (f.off || 0) + 48 + margin);
    return this.inView(f.x, f.y, (f.r || 0) * 1.3 + 16 + margin);
  }

  render() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    // 바닥 패턴에 지우기 색·단계 색조까지 구워 두었으므로, 패턴이 있으면 화면 전체를 한 번만 칠한다
    const floor = Sprites.floorPattern(ctx, 3, BG_COLOR, this.player && this.stage && this.stage.ground);
    if (!floor) {
      ctx.fillStyle = BG_COLOR;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    const shaking = this.state === 'playing' && this.shakeMag > 0;
    const sx = shaking ? rand(-1, 1) * this.shakeMag : 0;
    const sy = shaking ? rand(-1, 1) * this.shakeMag : 0;

    ctx.save();
    const tx = Math.round(this.w / 2 - this.cam.x + sx), ty = Math.round(this.h / 2 - this.cam.y + sy);
    ctx.translate(tx, ty);
    this.drawGround(ctx, floor);

    if (this.player) {
      // 바닥 위 층부터 파티클까지 한 번에: gl 이면 2D 컨텍스트처럼 쓰는 기록기에 그려 WebGL 배치로 쌓고, 글자 앞에서 한 번 찍는다.
      // 그리는 순서는 2D 와 같다 (배치는 add 순서대로 블렌딩).
      const gl = GLSprites.enabled && Sprites.ready('td') && (GLSprites.ok || GLSprites.init());
      let rec = ctx;
      if (gl) { GLSprites.begin(ctx, this.dpr, tx, ty); rec = GLSprites.recorder(ctx); }
      this.drawZones(rec);
      for (const o of this.objects) if (this.inView(o.x, o.y, 30)) o.draw(rec);
      for (const pk of this.pickups) if (this.inView(pk.x, pk.y, 24)) pk.draw(rec);
      // 적이 실제로 그리는 범위(스프라이트·방패 r+24·머리 위 표시 r+18)만큼만 여유를 둔다
      const enemyPad = this.shakeMag + 2;
      // 화면 밖 보스 표시(drawScreenUI)가 적 전체를 다시 훑지 않도록 그리면서 보스를 모은다
      const bosses = this._frameBosses ||= [];
      bosses.length = 0;
      if (this.crowded) this.drawCrowd(rec, enemyPad);
      else for (const e of this.enemies) {
        if (e.boss) bosses.push(e);
        if (this.inView(e.x, e.y, Math.max(TILE * e.scale / 2 + e.radius * 0.15 + 2, e.radius + 24) + enemyPad)) e.draw(rec, this.clock, this);
      }
      for (const a of this.allies) if (this.inView(a.x, a.y, a.radius + 40 + this.shakeMag)) a.draw(rec);
      if (this.state !== 'gameover') this.player.draw(rec, this.clock);
      if (this.projectiles.length > SHOT_UPDATE_BUDGET) this.drawCrowdShots(rec);
      else for (const pr of this.projectiles) if (this.inView(pr.x, pr.y, 30)) pr.draw(rec);
      this.drawHazards(rec);
      this.drawFx(rec);

      const particles = this.particles, crowded = this.crowded;
      for (let pi = crowded ? Math.max(0, particles.length - CROWD_PARTICLE_DRAW) : 0; pi < particles.length; pi++) {
        const pt = particles[pi];
        if (!this.inView(pt.x, pt.y, 16 + this.shakeMag)) continue;
        rec.globalAlpha = Math.max(0, pt.life / pt.max);
        rec.fillStyle = pt.color;
        const s = pt.size > 3.2 ? Px.G * 2 : Px.G;
        rec.fillRect(Px.snap(pt.x - s / 2), Px.snap(pt.y - s / 2), s, s);
      }
      if (gl) GLSprites.flush();
      ctx.globalAlpha = 1;

      ctx.font = TEXT_FONT;
      ctx.textAlign = 'center';
      // 글꼴이 준비되면 숫자 글자는 그림자까지 구운 비트맵으로 찍는다 (fillText 두 번 → drawImage 한 번)
      const cached = this._fontReady || (this._fontReady = !!document.fonts?.check(TEXT_FONT));
      for (const t of this.texts) {
        if (!this.inView(t.x, t.y, 200 + this.shakeMag)) continue;
        // 도트 폰트 + 딱딱한 그림자 (벡터 외곽선 대신)
        const x = Math.round(t.x), y = Math.round(t.y);
        ctx.globalAlpha = Math.min(1, t.life / 0.3);
        if (cached) {
          // 글자 하나의 비트맵은 사는 동안 같다: 글자 객체에 붙여 두고 화면 배율이 바뀔 때만 다시 찾는다
          let b = t._bm;
          if (!b || b.dpr !== this.dpr) b = t._bm = this.textBitmap(ctx, t.text, t.color);
          ctx.drawImage(b.c, x - b.ox, y - b.oy, b.w, b.h);
          continue;
        }
        ctx.fillStyle = '#000000';
        ctx.fillText(t.text, x + 2, y + 2);
        ctx.fillStyle = t.color;
        ctx.fillText(t.text, x, y);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    if (this.player) this.drawScreenUI(ctx);
  }

  /** 그림자를 포함한 글자 비트맵 (화면 배율 해상도). 기준점 (ox, oy) 가 fillText 의 (x, y) 에 해당한다. */
  textBitmap(ctx, text, color) {
    const cache = this._textBitmaps || (this._textBitmaps = new Map());
    const key = `${color}|${text}`;
    let b = cache.get(key);
    if (b) return b;
    const m = ctx.measureText(text);
    const left = Math.ceil(m.actualBoundingBoxLeft) + 2, right = Math.ceil(m.actualBoundingBoxRight) + 4;
    const up = Math.ceil(m.actualBoundingBoxAscent) + 2, down = Math.ceil(m.actualBoundingBoxDescent) + 4;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round((left + right) * this.dpr));
    c.height = Math.max(1, Math.round((up + down) * this.dpr));
    const g = c.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.font = TEXT_FONT;
    g.textAlign = 'center';
    g.fillStyle = '#000000';
    g.fillText(text, left + 2, up + 2);
    g.fillStyle = color;
    g.fillText(text, left, up);
    if (cache.size >= 600) cache.clear();
    b = { c, ox: left, oy: up, w: left + right, h: up + down, dpr: this.dpr };
    cache.set(key, b);
    return b;
  }

  drawGround(ctx, floor) {
    const g = 64;
    const left = this.cam.x - this.w / 2 - g, right = this.cam.x + this.w / 2 + g;
    const top = this.cam.y - this.h / 2 - g, bottom = this.cam.y + this.h / 2 + g;
    if (floor) {
      ctx.fillStyle = floor;
      ctx.fillRect(left, top, right - left, bottom - top);
      return;
    }
    const cx0 = Math.floor(left / g), cx1 = Math.floor(right / g);
    const cy0 = Math.floor(top / g), cy1 = Math.floor(bottom / g);

    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    for (let cx = cx0; cx <= cx1; cx++) ctx.fillRect(cx * g, top, Px.G, bottom - top);
    for (let cy = cy0; cy <= cy1; cy++) ctx.fillRect(left, cy * g, right - left, Px.G);

    // 결정적 해시로 풀/돌 장식을 뿌린다
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const h = hash2(cx, cy);
        if (h > 0.22) continue;
        const px = Px.snap(cx * g + hash2(cx + 17, cy) * g);
        const py = Px.snap(cy * g + hash2(cx, cy + 31) * g);
        if (h < 0.05) {
          ctx.fillStyle = 'rgba(160,170,190,0.10)';
          Px.ellipse(ctx, px, py, 7, 4);
        } else {
          const G = Px.G;
          ctx.fillStyle = 'rgba(110,190,130,0.16)';
          ctx.fillRect(px - G * 2, py - G * 2, G, G * 2);
          ctx.fillRect(px, py - G * 3, G, G * 3);
          ctx.fillRect(px + G * 2, py - G * 2, G, G * 2);
        }
      }
    }
  }

  drawScreenUI(ctx) {
    const p = this.player;

    // 체력이 낮으면 붉은 비네트 (가장자리부터 계단식으로 짙어지는 도트 띠)
    const ratio = p.hp / p.stats.maxHp;
    if (ratio < 0.3 && this.state === 'playing') {
      const a = (0.3 - ratio) / 0.3 * (0.35 + Math.sin(this.clock * 6) * 0.1);
      const step = 12, bands = 5;
      for (let i = 0; i < bands; i++) {
        const k = i * step, w = this.w - k * 2, h = this.h - k * 2;
        ctx.fillStyle = i === bands - 1 ? Px.dither(ctx, `rgba(255,0,40,${(a * 0.5).toFixed(2)})`, 4) : `rgba(255,0,40,${(a * (1 - i / bands) * 0.6).toFixed(2)})`;
        ctx.fillRect(k, k, w, step); ctx.fillRect(k, this.h - k - step, w, step);
        ctx.fillRect(k, k + step, step, h - step * 2); ctx.fillRect(this.w - k - step, k + step, step, h - step * 2);
      }
    }

    // 화면 밖 보스 방향 표시 (이번 프레임에 그리며 모은 보스 목록)
    for (const e of this._frameBosses || this.enemies) {
      if (!e.boss || e.dead) continue;
      const sx = e.x - this.cam.x + this.w / 2, sy = e.y - this.cam.y + this.h / 2;
      if (sx >= 0 && sx <= this.w && sy >= 0 && sy <= this.h) continue;
      const m = 36;
      const ax = clamp(sx, m, this.w - m), ay = clamp(sy, m + 40, this.h - m);
      const ang = Math.atan2(sy - this.h / 2, sx - this.w / 2);
      const c = Math.cos(ang), s = Math.sin(ang);
      const pt = (x, y) => [ax + x * c - y * s, ay + x * s + y * c];
      ctx.fillStyle = e.boss ? '#ff3b6b' : '#ffd166';
      Px.poly(ctx, [pt(15, 0), pt(-9, -11), pt(-9, 11)]);
    }

    if (this.banner) {
      const b = this.banner;
      const t = b.life / b.max;
      ctx.globalAlpha = Math.min(1, t * 3, (1 - t) * 8);
      ctx.font = `bold 30px ${FONT}`;
      ctx.textAlign = 'center';
      const bx = Math.round(this.w / 2), by = Math.round(this.h * 0.24);
      ctx.fillStyle = '#000000';
      ctx.fillText(b.text, bx + 3, by + 3);
      ctx.fillStyle = b.color;
      ctx.fillText(b.text, bx, by);
      if (b.sub) {
        ctx.font = `15px ${FONT}`;
        const fit = (this.w - 32) / ctx.measureText(b.sub).width;
        if (fit < 1) ctx.font = `${Math.max(9, Math.floor(15 * fit))}px ${FONT}`;
        ctx.fillStyle = '#000000';
        ctx.fillText(b.sub, bx + 2, by + 32);
        ctx.fillStyle = '#e8ecf5';
        ctx.fillText(b.sub, bx, by + 30);
      }
      ctx.globalAlpha = 1;
    }
  }
}
mixin(Game, GameRender);
