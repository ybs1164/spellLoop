'use strict';

// 행동의 스탯 비율(ACTION_STAT_RATIOS)과 비율 반영 설명, 이동 입력 카드

// Ratios use the acting entity's stats; health effects use the recipient's max HP.
const ACTION_STAT_RATIOS = {
  bolt: { damage: 2, speed: 420 / 170 }, slash: { damage: 2.4 },
  explode: { damage: 2.6 }, frost: { damage: 0.4 },
  poison: { damage: 1.2 }, shockwave: { damage: 1.2 },
  scatter: { damage: 0.8, speed: 400 / 170 }, lance: { damage: 1.6, speed: 900 / 170 },
  boomerang: { damage: 1.6, speed: 520 / 170 }, homing: { damage: 4, speed: 2 },
  laser: { damage: 1.6 }, chain: { damage: 1.2 }, meteor: { damage: 4.8 },
  blades: { damage: 0.8 }, burn: { damage: 0.9 }, drain: { damage: 3.6, heal: 0.04 }, snipe: { damage: 10 },
  heal: { heal: 0.1 }, shield: { shield: 0.25 }, armor: { armor: 0.05 },
  blink: { distance: 160 / 170 }, dash: { distance: 1 }, pull: { pullDistance: 1.6 },
  vortex: { forceSpeed: 2.6 }, ward: { forceSpeed: 6 },
  summon: { summonHp: 0.5, summonAttack: 1.2, summonSpeed: 150 / 170 },
  archer: { summonHp: 0.5, summonAttack: 1, summonSpeed: 130 / 170 },
  orb: { summonHp: 0.3, summonAttack: 0.6 },
  mine: { summonHp: 0.2, summonAttack: 1, damage: 4 },
  turret: { summonHp: 0.6, summonAttack: 0.9 }, decoy: { summonHp: 0.25 },
};
for (const [id, speed] of Object.entries({ bolt: 150, slash: 80, explode: 260, shockwave: 520, scatter: 150, lance: 60, boomerang: 80, homing: 150, laser: 60, chain: 40, drain: 40, snipe: 80 })) {
  CARDS[id].fixedValues = { knockback: speed };
}
for (const [id, speed] of Object.entries({ bolt: 420, scatter: 400, lance: 900, boomerang: 520, homing: 340 })) {
  CARDS[id].projectileSpeed = speed;
  delete ACTION_STAT_RATIOS[id].speed;
}
const STAT_RATIO_LABELS = { attackPower: '공격력', moveSpeed: '이동 속도', maxHp: '최대 체력', knockback: '넉백',
  sight: '시야', reach: '사거리', defense: '방어력', shotPower: '탄 공격력', keepDistance: '유지 거리', xpReward: '경험치', shotSpeed: '탄속', shotCount: '발사 수', pierce: '관통', summonCount: '소환 수' };
function statRatioText(stat, ratio) {
  return `${STAT_RATIO_LABELS[stat]} ${Number((ratio * 100).toFixed(3))}%`;
}
function actionRatioStat(field) {
  return field === 'knockback' || field === 'forceSpeed' || field === 'pullDistance' ? 'knockback' : /Hp|heal|shield|armor/.test(field) ? 'maxHp' : /[Ss]peed|distance|knockback/.test(field) ? 'moveSpeed' : 'attackPower';
}
for (const [id, ratios] of Object.entries(ACTION_STAT_RATIOS)) {
  const card = CARDS[id];
  card.statRatios = Object.fromEntries(Object.entries(ratios).map(([field, ratio]) => [field, { stat: actionRatioStat(field), ratio }]));
  // Replace only damage literals, leaving unrelated counts, durations and ranges intact.
  card.desc = card.desc.replace(/피해 (\d+(?:\.\d+)?)/g, (_, amount) => `피해 ${statRatioText('attackPower', Number(amount) / 10)}`);
  if (card.projectileSpeed) card.desc += ` \ud0c4\uc18d ${card.projectileSpeed}.`;
  if (ratios.speed) card.desc += ` 탄속: 시전자 ${statRatioText('moveSpeed', ratios.speed)}.`;
  if (card.fixedValues?.knockback != null) card.desc += ` \ub109\ubc31 ${card.fixedValues.knockback}.`;
  if (ratios.knockback) card.desc += ` 넉백 속도: 시전자 ${statRatioText('knockback', ratios.knockback)}.`;
  if (ratios.summonHp != null) card.desc += ` 소환체 체력: 시전자 ${statRatioText('maxHp', ratios.summonHp)}.`;
  if (ratios.summonAttack != null) card.desc += ` 소환체 공격력: 시전자 ${statRatioText('attackPower', ratios.summonAttack)}.`;
  if (ratios.summonSpeed != null) card.desc += ` 소환체 이동 속도: 시전자 ${statRatioText('moveSpeed', ratios.summonSpeed)}.`;
}
CARDS.drain.desc += ' 피해를 주면 시전자 최대 체력의 6%를 회복한다.';
CARDS.heal.desc = '대상 최대 체력 10% 회복.';
CARDS.shield.desc = '6초간 대상 최대 체력 25%만큼 피해 흡수.';
CARDS.armor.desc = '6초간 매 타격 피해를 대상 최대 체력 5%만큼 감소.';
CARDS.blink.desc = `바라보는 방향으로 대상 ${statRatioText('moveSpeed', ACTION_STAT_RATIOS.blink.distance)} × 1초만큼 이동.`;
CARDS.dash.desc = '바라보는 방향으로 대상 이동 속도 100% × 1초만큼 돌진.';
CARDS.pull.desc = `선택한 대상을 시전자 쪽으로 최대 시전자 ${statRatioText('knockback', ACTION_STAT_RATIOS.pull.pullDistance)} × 1초만큼 끌어당긴다.`;
CARDS.vortex.desc += ` 끌어당기는 속도: 시전자 ${statRatioText('knockback', ACTION_STAT_RATIOS.vortex.forceSpeed)}.`;
CARDS.ward.desc += ` 밀어내는 속도: 시전자 ${statRatioText('knockback', ACTION_STAT_RATIOS.ward.forceSpeed)}.`;
CARDS.mine.desc += ' 일반 폭발 카드를 사용한다.';

const ALL_TARGET_KINDS = Object.keys(TARGET_KINDS).filter((k) => TARGET_KINDS[k].inAll);

CARDS.inputMove = {
  type: 'action', actionId: 'inputMove', name: '입력 방향 이동', icon: 'uiSpeed',
  weight: 0, group: 'entity', requires: ['position'], exclude: ['point'], accepts: ALL_KINDS.filter(k => k !== 'point'),
  effect: Object.freeze({ continuous: true, scaleRate: false }),
  desc: '화살표/WASD 입력 방향으로 대상을 이동 속도 스탯 × 1프레임만큼 이동시킨다.',
  run: (targets, env) => {
    const owner = env.owner || env.game.player, axis = Input.axis(), moving = !!(axis.x || axis.y);
    owner.moving = false;
    for (const t of targets) {
      const o = env.at(t);
      if (!o || o.dead) continue;
      o.moving = moving;
      if (!moving) continue;
      if (o.facing) o.facing = axis;
      const blocked = o.directFrozen || ['freeze', 'root', 'fear'].some(state => hasTargetState(o, state));
      const speed = (blocked ? 0 : entityStats(o).moveSpeed) * (o.stats?.moveSpeed ?? o.cardMove ?? 1) * (o.directMove ?? 1);
      o.x += axis.x * speed * env.frameDt;
      o.y += axis.y * speed * env.frameDt;
    }
  },
};
