'use strict';

class GameSpatial {
  /* ------------------------------------------------------------------ */
  /* 충돌                                                                */
  /* ------------------------------------------------------------------ */
  rebuildHash() {
    this.hash.clear();
    this._reach = MAX_ENEMY_RADIUS;   // 적 조회 반경 여유 (과밀일 때 separateEnemies 가 실제 값으로 줄인다)
    let teams = 0;
    for (const e of this.enemies) if (!e.dead) { this.hash.insert(e); teams |= teamBit(e.team ?? 'friendly'); }
    this._enemyTeams = teams;   // 해시에 든 적 팀 비트 합 (해시 안의 적은 이번 프레임 도중 팀이 바뀌지 않는다)
  }

  /**
   * 겹친 적을 서로 밀어낸다. 공간 해시와 같은 칸·같은 순서로 이웃을 훑되 좌표를 타입 배열에 옮겨 계산한다
   * (적마다 객체 형태가 달라 속성 읽기가 느리다). 계산 순서와 값은 객체에서 직접 하던 것과 같다.
   */
  separateEnemies() {
    const list = this.enemies, n = list.length, hash = this.hash, cs = hash.cs;
    let buf = this._sep;
    if (!buf || buf.x.length < n) {
      const size = Math.max(n, 2 * (buf?.x.length || 256));
      buf = this._sep = { x: new Float64Array(size), y: new Float64Array(size), r: new Float64Array(size), w: new Float64Array(size), at: new Int32Array(size) };
    }
    const X = buf.x, Y = buf.y, R = buf.r, W = buf.w, AT = buf.at;
    // rebuildHash 직후라 지금 좌표가 해시에 넣은 좌표와 같다. 해시의 칸 연결 목록(살아 있는 적, 배열 순서)을 그대로 이웃 목록으로 쓴다.
    // 해시 항목 k 는 k 번째 살아 있는 적이므로, 적 객체를 읽지 않고 AT[k] 로 배열 번호를 얻는다.
    let maxR = 0, k = 0;
    // 화면 밖 먼 적(갱신이 드문 적)은 스스로 밀려나지 않는다 (W = -1). 이웃으로는 그대로 남아 가까운 적을 밀어낸다.
    const p = this.player, lodX = this.w / 2 + FAR_ENEMY_MARGIN, lodY = this.h / 2 + FAR_ENEMY_MARGIN;
    // 적이 상한보다 많으면 stride 번째마다 한 마리씩만 스스로 밀려나게 한다 (나머지는 W = -1, 이웃으로만 남는다). 상한 이하면 전부 처리한다.
    const stride = n > ENEMY_UPDATE_BUDGET ? Math.ceil(n / SEPARATE_BUDGET) : 1, phase = (this._enemyTick | 0) % stride;
    for (let i = 0; i < n; i++) {
      const e = list[i], r = e.radius;
      X[i] = e.x; Y[i] = e.y; R[i] = r;
      W[i] = e.boss ? 0.05 : (i + phase) % stride || Math.abs(e.x - p.x) > lodX || Math.abs(e.y - p.y) > lodY ? -1 : 0.5;
      if (!e.dead) { AT[k++] = i; if (r > maxR) maxR = r; }
    }
    if (!hash.n) return;
    // 겹칠 수 있는 이웃은 반지름 합 이내뿐이다: 해시 조회 범위를 이번 프레임의 가장 큰 반지름까지만 잡는다
    // (MAX_ENEMY_RADIUS 는 증폭된 보스 같은 최악의 경우라, 작은 적이 대부분일 때 훑는 칸이 몇 배 많았다).
    const next = hash.next, head = hash.head, slotStamp = hash.slotStamp, stamp = hash.stamp, CX = hash.cx, CY = hash.cy;
    // 앞서 처리한 적이 밀려난 만큼 그 적의 해시 칸은 지금 좌표와 어긋난다: 지금까지 밀린 최대 거리의 두 배(자기 이동분 포함)를 여유로 더한다.
    let shift2 = 0, slack = SEPARATE_SLACK;
    const scanCap = stride > 1 ? SEPARATE_SCAN_CAP : Infinity;
    for (let ai = 0; ai < n; ai++) {
      const xa = X[ai], ya = Y[ai], ra = R[ai], wa = W[ai];
      if (wa < 0) continue;
      const reach = Math.min(ra + maxR + slack, ra + MAX_ENEMY_RADIUS);
      const x0 = Math.floor((xa - reach) / cs), x1 = Math.floor((xa + reach) / cs);
      const y0 = Math.floor((ya - reach) / cs), y1 = Math.floor((ya + reach) / cs);
      let ax = xa, ay = ya, seen = 0;
      scan: for (let cx = x0; cx <= x1; cx++) {
        const hx = Math.imul(cx, 73856093);
        for (let cy = y0; cy <= y1; cy++) {
          const slot = (hx ^ Math.imul(cy, 19349663)) & (HASH_SLOTS - 1);
          if (slotStamp[slot] !== stamp) continue;
          for (let k = head[slot]; k >= 0; k = next[k]) {
            if (CX[k] !== cx || CY[k] !== cy) continue;
            if (++seen > scanCap) break scan;   // 과밀 때 한 적이 훑는 이웃 수 상한 (밀집한 더미 속 하나가 수백 마리를 훑지 않게)
            const bi = AT[k];
            if (bi === ai) continue;
            const dx = ax - X[bi], dy = ay - Y[bi];
            const min = ra + R[bi];
            const d2 = dx * dx + dy * dy;
            if (d2 >= min * min) continue;
            if (d2 === 0) { ax += rand(-1, 1); continue; }
            const d = Math.sqrt(d2);
            const push = ((min - d) / d) * wa;   // 쌍마다 양쪽이 각자 절반씩 밀려남
            ax += dx * push;
            ay += dy * push;
          }
        }
      }
      X[ai] = ax; Y[ai] = ay;
      const mx = ax - xa, my = ay - ya, m2 = mx * mx + my * my;
      if (m2 > shift2) { shift2 = m2; slack = Math.min(MAX_ENEMY_RADIUS, SEPARATE_SLACK + 2 * Math.sqrt(m2)); }
    }
    for (let i = 0; i < n; i++) { const e = list[i]; e.x = X[i]; e.y = Y[i]; }
    // 과밀(적이 갱신 상한보다 많음)이면 이후 충돌 조회 반경을 이번 프레임 최대 반지름 + 밀린 거리 + 여유로 줄인다 (보통 때는 그대로 최악값).
    if (n > ENEMY_UPDATE_BUDGET) this._reach = Math.min(MAX_ENEMY_RADIUS, maxR + Math.sqrt(shift2) + 24);
  }

  /** (x, y) 반경 r 안의 살아 있는 적 수 (공간 해시 기준, skip 제외) */
  countNearEnemies(x, y, r, skip) {
    const near = this.hash.query(x, y, r, this._count ||= []), r2 = r * r;
    let n = 0;
    for (const o of near) if (o !== skip && !o.dead && dist2(o.x, o.y, x, y) <= r2) n++;
    return n;
  }

  /** 설치물·아군을 투사체 판정용 해시에 넣는다. _so 는 objects→allies 배열 순서. */
  rebuildStructHash() {
    const hashes = this.structHashes ||= new Map();
    this._nearStruct ||= [];
    for (const hash of hashes.values()) hash.clear();
    let order = 0, live = 0;
    const add = o => {
      o._so = order++;
      if (o.dead) return;
      live++;
      const team = o.team ?? 'friendly';
      let hash = hashes.get(team);
      if (!hash) hashes.set(team, hash = new SpatialHash(64));
      hash.insert(o);
    };
    for (const o of this.objects) add(o);
    for (const a of this.allies || []) add(a);
    this._structCount = live;
  }

  /** 충돌 규칙이 통과시키는 팀의 설치물·아군만 모은다 (entityCanHit 이 어차피 걸러낼 팀은 조회하지 않는다). 배열 순서는 _so 로 맞춘다. */
  queryStructs(s, hit, reach) {
    const out = this._nearStruct, rule = hit.hitTeamRule ?? 'opposing', sourceTeam = entityTeam(s);
    out.length = 0;
    for (const [team, hash] of this.structHashes) {
      const pass = rule === 'same' ? sourceTeam === team : rule === 'friendly' ? team === 'friendly' : rule === 'hostile' ? team === 'hostile'
        : rule === 'all' ? true : sourceTeam !== team;
      if (pass) hash.queryInto(s.x, s.y, reach, out);
    }
    return out.length > 1 ? out.sort(byStructOrder) : out;
  }

  nearestEnemies(x, y, n, range) {
    const r2 = range * range;
    if (n === 1) {
      // 가장 가까운 하나: 정렬 없이 훑는다 (같은 거리면 앞선 적, 안정 정렬과 같은 결과)
      let best = null, bestD = Infinity;
      for (const e of this.enemies) {
        if (e.dead) continue;
        const d = dist2(x, y, e.x, e.y);
        if (d <= r2 && (best === null || d < bestD)) { best = e; bestD = d; }
      }
      return best ? [best] : [];
    }
    const list = [];
    for (const e of this.enemies) {
      if (e.dead) continue;
      const d = dist2(x, y, e.x, e.y);
      if (d <= r2) list.push([d, e]);
    }
    list.sort((a, b) => a[0] - b[0]);
    return list.slice(0, n).map((v) => v[1]);
  }
}
mixin(Game, GameSpatial);
