'use strict';

class GameDecoy {
  /** 미끼가 있으면 적이 대신 쫓는다. */
  /**
   * 유인 카드를 가질 수 있는 개체 목록 (allTargets 순서).
   * 목록이 같은 프레임에 늘어난 부분만 이어서 훑고, 정리(compact)·유인 슬롯 변경 시 다시 만든다.
   */
  decoyCandidates() {
    const lists = [this.enemies, this.objects, this.allies, this.zones, this.projectiles, this.hazards, this.pickups];
    let scan = this._decoyScan;
    if (!scan || scan.epoch !== entityDecoyEpoch) scan = this._decoyScan = { epoch: entityDecoyEpoch, lists: [] };
    for (let i = 0; i < lists.length; i++) {
      const arr = lists[i] || [];
      let entry = scan.lists[i];
      if (!entry || entry.arr !== arr || entry.n > arr.length) entry = scan.lists[i] = { arr, n: 0, found: [] };
      // 유인 카드를 가진 적 슬롯이 하나도 없으면 적 목록은 훑지 않는다 (적의 기본 카드에는 유인이 없다)
      if (entityDecoySlots <= 0 || i === 0 && entityDecoyEnemySlots <= 0) { entry.n = arr.length; continue; }
      for (; entry.n < arr.length; entry.n++) if (slotMayHaveDecoy(arr[entry.n])) entry.found.push(arr[entry.n]);
    }
    return scan.lists;
  }

  redirectedPlayerTarget(unit) {
    if (unit === this._redirectUnit) return this._redirectValue;   // 이번 개체 업데이트에서 이미 구했다 (step 이 미리 구해 둔다)
    return this.findRedirect(unit);
  }

  /** 켜진 유인 효과 (없으면 null). visitDecoy 와 인덱스가 같은 기준을 쓴다. */
  decoyEffectOf(owner) {
    const slot = owner.slot;
    if (!slot) return null;
    // 슬롯이 한 번이라도 갱신됐으면 켜진 메커니즘 표에서 바로 읽는다 (has·effect 와 같은 값).
    if (slot.enabled && slot.effects) return slot.enabled.has('entityDecoy') ? slot.effects.get('entityDecoy') || null : null;
    return slot.has('entityDecoy') ? slot.effect('entityDecoy') || null : null;
  }

  /**
   * 유인 인덱스: 켜진 유인(플레이어 → 목록 순서)을 격자 칸에 넣어 두고, 개체는 자기 칸의 후보만 본다.
   * 프레임마다·유인 슬롯이 켜지거나 꺼지거나 범위가 바뀔 때·개체가 늘어날 때 다시 만든다. 거리는 항상 현재 좌표로 잰다.
   * 대상 지정이 따로 있는 유인이 있으면 옛 방식(전부 훑기)으로 돌아간다.
   */
  /**
   * 「대기 슬롯 이벤트가 없고, decoyIndex() 가 지금 다시 만들지 않고 빈 표(켜진 유인 없음)를 돌려준다」면 true. decoyIndex 를 부르지 않으므로 캐시를 바꾸지 않는다
   * (napFast 가 decoyIndex 를 불러도 같은 결과·같은 캐시라, run_enemies 가 그 판정을 건너뛰어도 된다).
   */
  decoyQuiet() {
    if (this._slotEvents?.length) return false;
    const idx = this._decoyIdx;
    if (!idx || idx.linear || idx.grid.size || idx.stamp !== this._decoyStamp || idx.epoch !== entityDecoyEpoch) return false;
    return idx.sig === this.enemies.length + this.objects.length + this.allies.length + this.zones.length + this.projectiles.length + this.hazards.length + this.pickups.length;
  }

  decoyIndex() {
    const sig = this.enemies.length + this.objects.length + this.allies.length + this.zones.length + this.projectiles.length + this.hazards.length + this.pickups.length;
    let idx = this._decoyIdx;
    if (idx && idx.stamp === this._decoyStamp && idx.sig === sig && idx.epoch === entityDecoyEpoch) return idx;
    const CELL = 128, PAD = 48;
    idx = this._decoyIdx = { stamp: this._decoyStamp, sig, epoch: entityDecoyEpoch, grid: new Map(), linear: false };
    const lists = this.decoyCandidates();
    const add = (owner, wrap) => {
      if (idx.linear || owner.dead) return;
      const effect = this.decoyEffectOf(owner);
      if (!effect) return;
      const range = effect.range;
      const own = !effect.targets || effect.targets.length === 1 && this.targetObj(effect.targets[0]) === owner;
      if (!own || !(range <= 2000)) { idx.linear = true; return; }
      const en = { owner, wrap, r2: range * range };
      const reach = range + PAD, x0 = Math.floor((owner.x - reach) / CELL), x1 = Math.floor((owner.x + reach) / CELL);
      const y0 = Math.floor((owner.y - reach) / CELL), y1 = Math.floor((owner.y + reach) / CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
        const key = cx * 100003 + cy;
        const cell = idx.grid.get(key);
        if (cell) cell.push(en); else idx.grid.set(key, [en]);
      }
    };
    add(this.player, null);
    for (let i = 0; i < lists.length; i++) {
      const found = lists[i].found;
      for (let j = 0; j < found.length; j++) add(found[j], TARGET_LIST_WRAP[i]);
    }
    return idx;
  }

  findRedirect(unit) {
    const st = this._redirect ||= { best: null, distance: 0 };
    st.best = SELF_TARGET; st.distance = Infinity;
    if (unit === this.player) return st.best;
    const idx = this.decoyIndex();
    if (!idx.linear) {
      if (!idx.grid.size) return st.best;   // 켜진 유인이 없다
      const cell = idx.grid.get(Math.floor(unit.x / 128) * 100003 + Math.floor(unit.y / 128));
      if (cell) for (let i = 0; i < cell.length; i++) {
        const en = cell[i], o = en.owner;
        if (o === unit || o.dead) continue;
        const d = dist2(o.x, o.y, unit.x, unit.y);
        if (d < en.r2 && d < st.distance) { st.best = en.wrap ? en.wrap(o) : { kind: 'self' }; st.distance = d; }
      }
      return st.best;
    }
    this.visitDecoy(this.player, null, unit, st);
    const lists = this.decoyCandidates();
    for (let i = 0; i < lists.length; i++) {
      const found = lists[i].found;
      for (let j = 0; j < found.length; j++) this.visitDecoy(found[j], TARGET_LIST_WRAP[i], unit, st);
    }
    return st.best;
  }

  visitDecoy(owner, wrap, unit, st) {
    if (owner === unit || owner.dead) return;
    const effect = this.decoyEffectOf(owner);
    if (!effect) return;
    const r2 = effect.range ** 2;
    if (!effect.targets) {
      // 대상 지정이 없으면 유인 중심은 개체 자신이다: 거리부터 보고 가까울 때만 대상 래퍼를 만든다.
      const d = dist2(owner.x, owner.y, unit.x, unit.y);
      if (d < r2 && d < st.distance) { st.best = wrap ? wrap(owner) : { kind: 'self' }; st.distance = d; }
      return;
    }
    const targets = effect.targets;
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i], center = this.targetObj(target);
      if (center.dead || center === unit) continue;
      const d = dist2(center.x, center.y, unit.x, unit.y);
      if (d < r2 && d < st.distance) { st.best = target; st.distance = d; }
    }
  }
}
mixin(Game, GameDecoy);
