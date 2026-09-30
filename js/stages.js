'use strict';

/*
 * 레벨 디자인: 15분을 5분씩 세 단계로 나눈다.
 *  - rate    : 단계 시작 → 끝의 초당 스폰 수 (단계 안에서 선형 증가)
 *  - dmgMul  : 이 단계에서 태어난 적의 접촉 피해 배율
 *  - pool    : [종류, 가중치, 단계 시작 후 등장 시각(초), 한 번에 나오는 무리 수]
 *  - swarm   : 1분마다 사방에서 몰려오는 포위 공격의 적
 *  - bossAt  : 단계 시작 후 보스가 나오는 시각(초)
 *  - ground  : 바닥 위에 덧칠하는 분위기 색
 *  - barrels : 주변에 유지되는 화약통 수
 * 체력은 단계와 별개로 시간이 흐를수록 계속 오른다 (Game.hpMul).
 */
const STAGE_LEN = 5 * 60;

const STAGES = [
  {
    name: '어둠의 동굴', color: '#8be9ff',
    hint: '탐욕 슬라임이 보석을 노린다',
    rate: [0.9, 5], dmgMul: 1,
    pool: [
      ['grunt', 6, 0, 1],
      ['runner', 3, 30, 1],
      ['rat', 2, 60, 5],
      ['greedy', 0.9, 40, 1],
      ['brute', 1, 150, 1],
    ],
    swarm: 'runner', boss: 'slimeKing', bossAt: 240,
    ground: null, barrels: 3,
  },
  {
    name: '망자의 묘역', color: '#b39dff',
    hint: '언데드와 저주탄을 조심하라',
    rate: [4, 10], dmgMul: 1.3,
    pool: [
      ['ghost', 6, 0, 1],
      ['grunt', 2, 0, 1],
      ['plagueRat', 3, 20, 4],
      ['brute', 1.2, 40, 1],
      ['necro', 0.5, 60, 1],
    ],
    swarm: 'ghost', boss: 'lich', bossAt: 240,
    ground: 'rgba(90,60,150,0.16)', barrels: 3,
  },
  {
    name: '불타는 심연', color: '#ff7b2e',
    hint: '화염·갑주·방패 — 등 뒤를 노려라',
    rate: [8, 18], dmgMul: 1.6,
    pool: [
      ['imp', 6, 0, 1],
      ['lavaSpider', 4, 0, 3],
      ['ghost', 1.5, 0, 1],
      ['pyro', 0.8, 30, 1],
      ['mimic', 0.6, 60, 1],
      ['darkKnight', 0.8, 100, 1],
    ],
    swarm: 'lavaSpider', boss: 'overlord', bossAt: 240,
    ground: 'rgba(170,40,20,0.16)', barrels: 4,
  },
];

/*
 * 던전 기믹 — 도감과 일시정지 화면에 보여 주는 요약. stages: 만나는 단계 (0부터)
 */
const GIMMICKS = [
  { icon: 'fBarrels', name: '화약통', stages: [0, 1, 2],
    desc: `${PLACED_TYPES.barrel.desc}. 불이 옆 화약통으로 번져 연쇄 폭발한다.` },
  { icon: 'harvest', name: '탐욕 슬라임', stages: [0],
    desc: '보석을 쫓아가 삼키고 커진다. 쓰러뜨리면 삼킨 보석을 1.5배로 뱉는다.' },
  { icon: 'curse', name: '저주 카드', stages: [1],
    desc: '사령술사·망령 군주의 보라 해골탄에 맞으면 슬롯에 「저주」 카드가 끼어든다.' },
  { icon: 'frost', name: '원소 반응', stages: [0, 1, 2],
    desc: '증기 폭발 — 불타는 적(화상·화염)에게 빙결. 인화 — 독 장판에 화상·유성·화약통, 또는 불타는 적이 닿으면 폭발한다.' },
  { icon: 'chest', name: '달아나는 보물 상자', stages: [0, 1, 2],
    desc: `단계마다 한 번 나타나 ${ENEMY_TYPES.chestling.escape}초 동안 도망친다. 잡으면 카드 선택 + 코스트 포인트. 속박·빙결로 붙잡자.` },
];

function stageIndexAt(time) { return Math.min(STAGES.length - 1, Math.floor(time / STAGE_LEN)); }

/** 단계 풀에서 지금 나올 수 있는 적 하나를 가중치로 뽑는다 → [종류, 무리 수] */
function rollStageEnemy(stage, tRel) {
  const open = stage.pool.filter((p) => tRel >= p[2]);
  let r = Math.random() * open.reduce((s, p) => s + p[1], 0);
  for (const p of open) if ((r -= p[1]) < 0) return p;
  return open[open.length - 1];
}
