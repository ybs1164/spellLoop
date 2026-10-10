'use strict';

// 개체 타입 표(ENEMY_TYPES), 상태 이상 상수, 경험치 곡선

/*
 * 적 속성. 피해에는 원소(elem)가 붙고, 속성이 그 원소를 몇 배로 받을지 정한다.
 *  affinity: 원소 → 피해 배율.
 *  armor: 타격 한 번마다 깎는 고정 피해 (최소 1). 자잘한 다단히트에 강하다.
 *  guard: 바라보는 쪽(정면)에서 날아온 피해를 이 비율만큼 막는다. 방향은 피해의 넉백 방향으로 판정한다.
 * 원소: poison(독 장판) · fire(화상·유성) · frost(빙결)
 */
const TRAITS = {
  undead:  { name: '언데드', color: '#b39dff', desc: '일반 공격으로 처치할 수 있다' },
  fire:    { name: '화염',   color: '#ff7b2e', affinity: { frost: 2 }, desc: '빙결에 2배 피해' },
  armored: { name: '갑주',   color: '#c0c8d8', armor: 4,                          desc: '타격마다 피해 -4 (최소 1)' },
  shielded:{ name: '방패',   color: '#e9d8a6', guard: 0.85,                       desc: '정면 피해를 85% 막는다. 등·옆, 독·화상, 빙결 중엔 못 막는다' },
};

/*
 * 적 상태 이상. 하나에 효과 하나. 설명은 여기 한 곳에서만 쓰고, 카드는 이름과 지속시간만 적는다 (keys 로 이 설명을 붙인다).
 * 보스는 빙결이 40% 시간만 걸리고 공포에 걸리지 않는다.
 * 빙결·속박·공포는 합산하되 STATUS_CAPS × (1 - 상태 저항)을 넘지 않는다.
 */
const STATUS = {
  freeze: { name: '빙결', color: '#9fd8ff', desc: '완전히 멈춤 · 중첩 시 지속시간 합산(상한 있음)' },
  root:   { name: '속박', color: '#b5e48c', desc: '이동 불가 · 중첩 시 지속시간 합산(상한 있음)' },
  fear:   { name: '공포', color: '#ffd166', desc: '나에게서 도망 · 중첩 시 지속시간 합산(상한 있음)' },
  mark:   { name: '표식', color: '#ff5c5c', desc: '중첩당 받는 피해 +90% · 각각 만료' },
  burn:   { name: '화상', color: '#ff7b2e', desc: '중첩별 초당 피해 합산 · 각각 만료' },
};
const MARK_MAX_STACKS = 5;   // 표식 중첩 상한 (최대 +450%)
function markMultiplier(o) {
  const count = o.markStacks ? o.markStacks.reduce((n, s) => n + (s.time > 0 ? s.count ?? 1 : 0), 0) : (o.markT > 0 || o.directStates?.mark > 0 ? 1 : 0);
  return 1 + 0.9 * Math.min(count, MARK_MAX_STACKS);
}

const BOSS_FREEZE = 0.4;   // 보스가 받는 빙결 시간 배율
// 합산되는 제어 상태 이상의 기본 지속 상한(초). 실제 상한은 × (1 - 상태 저항).
const STATUS_CAPS = { freeze: 3, root: 4, fear: 4 };
function statusCap(o, key) { return STATUS_CAPS[key] * (1 - entityStats(o).statusResistance); }
/** 강제 이동(넉백·끌어당김·소용돌이·결계·공포 이동) 배율: 넉백 저항과 상태 저항을 함께 받는다. */
function forcedMoveScale(o) { const st = entityStats(o); return (1 - st.knockbackResistance) * (1 - st.statusResistance); }

/*
 * sprites: Tiny Dungeon 타일 후보(개체마다 무작위), scale: 도트 확대 배율(정수)
 * ai: chase(기본) | keep(거리 유지) · summon: 주기적으로 부하 소환 · shoot: 주기적으로 탄 발사
 * split: 죽으면 작은 적으로 분열 · elite: 체력바 표시 · tint: 스프라이트 색조
 */
const ENEMY_TYPES = {
  bloomMatriarch: { name: '재생의 모체', hp: 6500, speed: 42, radius: 34, damage: 16, xp: 0, color: '#5be37a', sprites: [TD.slime], scale: 6, boss: true,
    ai: 'keep', keep: 180, summon: { type: 'grunt', n: 4, cd: 9 },
    slotRecipes: [{ cards: ['entityHurt', 'entitySelf', 'heal'], period: 12 }],
    bossHint: '12초마다 체력 10% 회복 · 표식과 집중 화력으로 회복 사이에 몰아치거나 화상·독으로 압박하세요.' },
  warMarshal: { name: '군단의 지휘자', hp: 9000, speed: 48, radius: 36, damage: 20, xp: 0, color: '#ffd166', sprites: [TD.darkKnight], scale: 6, boss: true,
    summon: { type: 'runner', n: 4, cd: 10 },
    slotRecipes: [{ cards: ['all', 'rage', 'focus'], team: 'same', range: 160, period: 7 }],
    bossHint: '주변 군단을 격려 · 광역·연쇄로 부하를 정리하거나 속박으로 지휘자와 군단을 분리하세요.' },
  bastionWarden: { name: '철벽의 수문장', hp: 15000, speed: 44, radius: 38, damage: 24, xp: 0, color: '#c0c8d8', sprites: [TD.darkKnight], scale: 6, boss: true, traits: ['shielded', 'armored'],
    shoot: { cd: 5, n: 8, speed: 150, damage: 10, ring: true },
    bossHint: '정면 방패와 갑주 · 빙결로 방패를 멈추거나 소환수·회전 칼날로 측후면을 공격하세요; 화상도 유효합니다.' },
  bindingOracle: { name: '속박의 예언자', hp: 18000, speed: 48, radius: 34, damage: 20, xp: 0, color: '#c49bff', sprites: [TD.cultist], scale: 6, boss: true, traits: ['undead'],
    ai: 'keep', keep: 240, shoot: { cd: 4, n: 1, speed: 170, damage: 12 },
    slotRecipes: [{ cards: ['all', 'mark', 'root'], team: 'opposing', range: 170, period: 7 }],
    bossHint: '170 안 표식·속박 · 원거리·설치물로 거리를 유지하거나 보호막·치유를 준비하고 접근하세요.' },
  cinderTyrant: { name: '잿불의 폭군', hp: 30000, speed: 50, radius: 42, damage: 30, xp: 0, color: '#ff7b2e', sprites: [TD.demon], scale: 7, boss: true, traits: ['fire'],
    shoot: { cd: 4, n: 12, speed: 160, damage: 12, ring: true }, summon: { type: 'lavaSpider', n: 3, cd: 12 },
    bossHint: '화염 탄막과 거미 군단 · 빙결의 화염 약점, 광역 제어와 이동 빌드를 활용하세요.' },
  shaman: { name: '회복 주술사', hp: 40, speed: 55, radius: 13, damage: 5, xp: 5, color: '#5be37a', sprites: [TD.cultist], scale: 3, ai: 'keep', keep: 140, gimmick: 'medic' },
  bannerlord: { name: '전투 지휘관', hp: 100, speed: 50, radius: 16, damage: 12, xp: 8, color: '#ffd166', sprites: [TD.darkKnight], scale: 3, elite: true, gimmick: 'command' },
  hexer: { name: '속박 술사', hp: 50, speed: 58, radius: 13, damage: 8, xp: 6, color: '#c49bff', sprites: [TD.cultist], scale: 3, ai: 'keep', keep: 260,
    shoot: { cd: 3, n: 1, speed: 190, damage: 6, projectileKind: 'curseBolt' } },
  emberling: { name: '잔불 정령', hp: 22, speed: 90, radius: 11, damage: 8, xp: 3, color: '#ff9d5c', sprites: [TD.demon], scale: 3, traits: ['fire'], deathZone: 'burningField' },
  /* 1단계 · 어둠의 동굴 */
  grunt:     { name: '슬라임',     hp: 10,   speed: 62,  radius: 12, damage: 6,  xp: 1,  color: '#6fd08c', sprites: [TD.slime], scale: 3 },
  runner:    { name: '박쥐',       hp: 6,    speed: 118, radius: 9,  damage: 5,  xp: 1,  color: '#f2a541', sprites: [TD.bat], scale: 2 },
  rat:       { name: '굴쥐',       hp: 4,    speed: 135, radius: 8,  damage: 3,  xp: 1,  color: '#c49a6c', sprites: [TD.rat], scale: 2 },
  brute:     { name: '외눈 거인',  hp: 70,   speed: 40,  radius: 22, damage: 16, xp: 6,  color: '#e9b36b', sprites: [TD.cyclops], scale: 4, elite: true },
  slimeKing: { name: '슬라임 왕',  hp: 9000,  speed: 50,  radius: 40, damage: 22, xp: 0,  color: '#6fd08c', sprites: [TD.slime], scale: 7, boss: true,
               split: { type: 'grunt', n: 12 },
               bossHint: '쓰러지면 슬라임 12마리로 분열 · 폭발·독 장판 같은 광역 공격을 준비해 두세요.' },

  /* 2단계 · 망자의 묘역 (언데드) */
  ghost:     { name: '유령',       hp: 16,   speed: 78,  radius: 11, damage: 8,  xp: 2,  color: '#cfd6e6', sprites: [TD.ghost], scale: 3, traits: ['undead'] },
  plagueRat: { name: '역병 쥐',    hp: 8,    speed: 140, radius: 8,  damage: 5,  xp: 1,  color: '#9aa4b8', sprites: [TD.rat2], scale: 2, traits: ['undead'] },
  necro:     { name: '사령술사',   hp: 60,   speed: 60,  radius: 13, damage: 10, xp: 8,  color: '#b39dff', sprites: [TD.cultist], scale: 3, traits: ['undead'], elite: true,
               ai: 'keep', keep: 240, summon: { type: 'ghost', n: 3, cd: 6 } },
  lich:      { name: '망령 군주',  hp: 22000, speed: 46,  radius: 36, damage: 30, xp: 0,  color: '#b39dff', sprites: [TD.cultist], scale: 6, boss: true, traits: ['undead'],
               summon: { type: 'ghost', n: 6, cd: 5 },
               bossHint: '5초마다 유령 6마리 소환 · 관통·연쇄로 유령을 정리하며 본체에 화력을 모으세요.' },

  /* 3단계 · 불타는 심연 (화염 · 갑주) */
  imp:       { name: '화염 마귀',  hp: 26,   speed: 100, radius: 12, damage: 10, xp: 2,  color: '#ff7b2e', sprites: [TD.demon], scale: 3, traits: ['fire'] },
  lavaSpider:{ name: '용암 거미',  hp: 14,   speed: 145, radius: 9,  damage: 8,  xp: 1,  color: '#ff9d5c', sprites: [TD.spider], scale: 2, traits: ['fire'] },
  pyro:      { name: '화염 술사',  hp: 45,   speed: 64,  radius: 13, damage: 10, xp: 6,  color: '#ff5c3d', sprites: [TD.pyro], scale: 3, traits: ['fire'], elite: true,
               ai: 'keep', keep: 260, shoot: { cd: 2.4, n: 1, speed: 230, damage: 12 } },
  mimic:     { name: '미믹',       hp: 110,  speed: 74,  radius: 16, damage: 18, xp: 10, color: '#d8a15a', sprites: [TD.mimic], scale: 3, traits: ['armored'], elite: true },
  darkKnight:{ name: '타락 기사',  hp: 150,  speed: 58,  radius: 16, damage: 20, xp: 12, color: '#8a93a8', sprites: [TD.darkKnight], scale: 3, traits: ['shielded'], elite: true },
  /* 모든 단계 · 한 번씩 나타나 도망친다. 잡으면 보물 상자. */
  overlord:  { name: '심연 군주',  hp: 36000, speed: 52,  radius: 42, damage: 34, xp: 0,  color: '#ff3b6b', sprites: [TD.demon], scale: 7, boss: true, traits: ['fire', 'armored'],
               shoot: { cd: 3, n: 14, speed: 180, damage: 16, ring: true },
               bossHint: '3초마다 14방향 탄막 · 화염과 갑주 — 빙결의 큰 한 방과 탄막 사이 이동이 핵심입니다.' },
};
const MAX_ENEMY_RADIUS = 64; // 증폭으로 커진 보스의 충돌 범위도 포함

function xpForLevel(level) {
  return Math.floor(5 + (level - 1) * 6 + Math.pow(level - 1, 1.5));
}

function drawShadow(ctx, x, y, rx) {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  Px.ellipse(ctx, x, y, rx, Math.max(Px.G, rx * 0.36));
}
