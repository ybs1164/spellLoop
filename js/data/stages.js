'use strict';

/*
 * 레벨 디자인: 보스마다 테마 스테이지 하나. 한 판은 1 → 2 → 3단계로 진행하고,
 * 단계마다 그 tier 의 스테이지 중 하나를 무작위로 고른다. 보스를 쓰러뜨리면 다음 단계, 3단계 보스를 쓰러뜨리면 승리.
 *  - tier    : 등장 단계 (1~3)
 *  - hp      : 단계 시작 체력 배율 (단계 안에서 시간이 흐를수록 Game.hpMul 이 더 올린다)
 *  - hpScale : 단계 전체 체력 배수 (hpMul 전체에 곱한다)
 *  - rate    : 단계 시작 → STAGE_LEN 시점의 초당 스폰 수 (선형 증가, 이후 유지)
 *  - dmgMul  : 이 스테이지 적의 접촉 피해 배율
 *  - pool    : [종류, 가중치, 단계 시작 후 등장 시각(초), 한 번에 나오는 무리 수]
 *  - swarm   : 1분마다 사방에서 몰려오는 포위 공격의 적
 *  - bosses  : [{ type, at }] 단계 시작 후 등장 시각(초). 모두 쓰러뜨리면 다음 단계
 *  - ground  : 바닥 위에 덧칠하는 분위기 색
 *  - barrels : 주변에 유지되는 화약통 수
 */
const STAGE_LEN = 5 * 60;

const STAGES = [
  {
    id: 'slimeNest', tier: 1, name: '슬라임 둥지', color: '#6fd08c',
    hint: '끈적한 무리 — 분열하는 왕을 광역으로 쓸어라',
    hp: 1, rate: [0.9, 5], dmgMul: 1,
    pool: [
      ['grunt', 8, 0, 1],
      ['grunt', 3, 20, 4],
      ['rat', 2, 60, 5],
      ['brute', 0.8, 120, 1],
    ],
    swarm: 'grunt', bosses: [{ type: 'slimeKing', at: 210 }],
    ground: 'rgba(60,150,80,0.14)', barrels: 3,
  },
  {
    id: 'mossGarden', tier: 1, name: '이끼 온실', color: '#5be37a',
    hint: '치유사가 넘치는 정원 — 회복보다 빠르게 몰아쳐라',
    hp: 1.1, rate: [1, 5.5], dmgMul: 1,
    pool: [
      ['grunt', 6, 0, 1],
      ['shaman', 1.4, 30, 1],
      ['rat', 2, 45, 5],
      ['runner', 2, 60, 1],
      ['brute', 0.8, 140, 1],
    ],
    swarm: 'grunt', bosses: [{ type: 'bloomMatriarch', at: 210 }],
    ground: 'rgba(80,180,90,0.12)', barrels: 3,
  },
  {
    id: 'batBarracks', tier: 1, name: '박쥐 병영', color: '#ffd166',
    hint: '격려받는 군단 — 지휘관부터 끊어라',
    hp: 1.2, rate: [1.2, 6], dmgMul: 1.1,
    pool: [
      ['runner', 6, 0, 1],
      ['rat', 3, 20, 5],
      ['grunt', 2, 0, 1],
      ['bannerlord', 0.6, 60, 1],
      ['brute', 1, 100, 1],
    ],
    swarm: 'runner', bosses: [{ type: 'warMarshal', at: 240 }],
    ground: 'rgba(160,120,50,0.12)', barrels: 4,
  },
  {
    id: 'graveyard', tier: 2, name: '망자의 묘역', color: '#b39dff',
    hint: '끝없이 일어나는 유령 — 사령술사를 먼저 처치하라',
    hp: 1.6, hpScale: 10, rate: [3, 9], dmgMul: 1.3,
    pool: [
      ['ghost', 6, 0, 1],
      ['plagueRat', 3, 20, 4],
      ['grunt', 1.5, 0, 1],
      ['necro', 0.6, 50, 1],
      ['brute', 1, 80, 1],
    ],
    swarm: 'ghost', bosses: [{ type: 'lich', at: 240 }],
    ground: 'rgba(90,60,150,0.16)', barrels: 3,
  },
  {
    id: 'sealedSanctum', tier: 2, name: '봉인된 성소', color: '#c49bff',
    hint: '속박과 저주탄 — 멈춰 서면 끝장이다',
    hp: 1.7, hpScale: 10, rate: [3, 9], dmgMul: 1.3,
    pool: [
      ['ghost', 5, 0, 1],
      ['hexer', 1.2, 20, 1],
      ['plagueRat', 3, 30, 4],
      ['shaman', 0.6, 60, 1],
      ['necro', 0.4, 120, 1],
    ],
    swarm: 'plagueRat', bosses: [{ type: 'bindingOracle', at: 240 }],
    ground: 'rgba(130,80,170,0.15)', barrels: 3,
  },
  {
    id: 'ironBastion', tier: 2, name: '철벽 요새', color: '#c0c8d8',
    hint: '방패와 갑주의 행군 — 등 뒤와 측면을 노려라',
    hp: 1.9, hpScale: 10, rate: [3, 8], dmgMul: 1.4,
    pool: [
      ['grunt', 4, 0, 1],
      ['runner', 3, 0, 1],
      ['darkKnight', 0.9, 30, 1],
      ['mimic', 0.6, 60, 1],
      ['bannerlord', 0.5, 60, 1],
      ['brute', 1, 40, 1],
    ],
    swarm: 'runner', bosses: [{ type: 'bastionWarden', at: 240 }],
    ground: 'rgba(120,130,150,0.14)', barrels: 4,
  },
  {
    id: 'cinderCaldera', tier: 3, name: '잿불 화구', color: '#ff7b2e',
    hint: '화염 탄막과 용암 거미 — 빙결로 불을 꺼라',
    hp: 2.4, hpScale: 100, rate: [6, 15], dmgMul: 1.6,
    pool: [
      ['imp', 6, 0, 1],
      ['lavaSpider', 4, 0, 3],
      ['emberling', 1.5, 20, 2],
      ['pyro', 0.8, 30, 1],
      ['mimic', 0.4, 90, 1],
    ],
    swarm: 'lavaSpider', bosses: [{ type: 'cinderTyrant', at: 240 }],
    ground: 'rgba(170,40,20,0.16)', barrels: 4,
  },
  {
    id: 'abyssThrone', tier: 3, name: '심연의 옥좌', color: '#ff3b6b',
    hint: '모든 위협이 모이는 곳 — 갑주 군주의 탄막을 버텨라',
    hp: 2.8, hpScale: 100, rate: [8, 18], dmgMul: 1.7,
    pool: [
      ['imp', 5, 0, 1],
      ['lavaSpider', 3, 0, 3],
      ['ghost', 1.5, 0, 1],
      ['pyro', 0.8, 30, 1],
      ['hexer', 0.6, 30, 1],
      ['darkKnight', 0.8, 60, 1],
      ['mimic', 0.6, 90, 1],
      ['bannerlord', 0.5, 60, 1],
      ['emberling', 1.2, 20, 2],
    ],
    swarm: 'imp', bosses: [{ type: 'overlord', at: 240 }],
    ground: 'rgba(150,20,60,0.16)', barrels: 4,
  },
];

/** 풀에 이 적이 나오는 스테이지 번호 */
function stagesWith(type) { return STAGES.flatMap((s, i) => (s.pool.some((p) => p[0] === type) ? [i] : [])); }
const ALL_STAGES = STAGES.map((_, i) => i);

/*
 * 던전 기믹 — 도감과 일시정지 화면에 보여 주는 요약. stages: 만나는 스테이지 (0부터)
 */
const GIMMICKS = [
  { icon: 'burn', name: '잔불 정령', stages: stagesWith('emberling'), desc: '사망하면 6초간 화상 장판을 남긴다. 장판은 적군 소유이며 다른 팀에만 화상을 적용한다.' },
  { icon: 'fBarrels', name: '화약통', stages: ALL_STAGES,
    desc: `${PLACED_TYPES.barrel.desc}. 불이 옆 화약통으로 번져 연쇄 폭발한다.` },
];

const STAGE_TIERS = 3;

/** 한 판의 진행 순서: 1~3단계마다 스테이지 하나씩 무작위 → STAGES 번호 배열 */
function rollStageRoute() {
  return Array.from({ length: STAGE_TIERS }, (_, t) => {
    const options = STAGES.flatMap((s, i) => (s.tier === t + 1 ? [i] : []));
    return options[Math.floor(Math.random() * options.length)];
  });
}

function stageBosses(stage) { return stage.bosses; }
function stageBossSummary(stage) {
  return stageBosses(stage).map(({ type, at }) => `${Math.floor(at / 60)}분${at % 60 ? ` ${at % 60}초` : ''}에 ${ENEMY_TYPES[type].name}`).join(' · ');
}

/** 단계 풀에서 지금 나올 수 있는 적 하나를 가중치로 뽑는다 → [종류, 무리 수] */
function rollStageEnemy(stage, tRel) {
  const open = stage.pool.filter((p) => tRel >= p[2]);
  let r = Math.random() * open.reduce((s, p) => s + p[1], 0);
  for (const p of open) if ((r -= p[1]) < 0) return p;
  return open[open.length - 1];
}
