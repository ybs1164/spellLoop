const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({ TD: new Proxy({}, { get: () => 0 }) });
vm.runInContext(fs.readFileSync('js/cards.js', 'utf8'), context);
const rows = vm.runInContext(`
  Object.entries(CARDS).filter(([id, card]) => card.type === 'action' && !id.includes('_')).map(([id, card]) => {
    const ratios = card.statRatios || card.effect?.statRatios;
    return { id, name: card.name, desc: card.desc, fixedValues: card.fixedValues || (card.effect?.knockback != null ? { knockback: card.effect.knockback } : {}), projectileSpeed: card.projectileSpeed || null, ratios: ratios ? Object.entries(ratios).map(([field, ref]) => ({ field, value: statRatioText(ref.stat, ref.ratio) })) : [] };
  })
`, context);
const fields = {
  damage: '피해', playerDamage: '플레이어 피해',
  speed: '속도', forceSpeed: '끌어당기기·밀어내기 속도', distance: '이동 거리(1초 기준)', pullDistance: '끌어당기는 거리(1초 기준)',
  heal: '회복', shield: '보호막', armor: '피해 감소', reduction: '피해 감소',
  summonHp: '소환체 최대 체력', summonAttack: '소환체 공격력', summonSpeed: '소환체 이동 속도',
  knockback: '넉백', initialSpeed: '초기 속도', maxSpeed: '최대 속도', acceleration: '초당 속도 증가',
};
const report = [
  '# 행동 카드 스탯 비율', '',
  '피해는 행동 주인의 공격력, 이동은 이동 속도, 끌어당기기·밀어내기는 넉백 스탯, 회복·보호막·피해 감소는 대상 최대 체력을 기준으로 실제 계산합니다. 끌어당기는 거리는 넉백 × 160% × 1초입니다. 타격 넉백과 탄속은 카드별 고정값이며 시전자 스탯과 독립적입니다. 소환체 스탯은 생성 시 시전자 스탯으로 정합니다.', '',
  '소환 수·발사 수·반복 주기·범위·수명·관통 횟수·회전 속도·경험치·보상·상태 내성 등은 기존 카드 설정을 유지합니다. 새 공통 스탯을 추가하지 않습니다.', '',
  '| 카드 | 스탯 비율 |', '| --- | --- |',
  ...rows.map(card => `| ${card.name} (${card.id}) | ${card.ratios.length ? card.ratios.map(ref => `${fields[ref.field] || ref.field}: ${ref.value}`).join(' / ') : card.desc}${Object.entries(card.fixedValues).map(([field, value]) => ` / ${fields[field] || field}: ${value} (개별 지정)`).join('')}${card.projectileSpeed ? ` / 탄속: ${card.projectileSpeed} (개별 지정)` : ''} |`), '',
  '개체 기믹 표는 도감 기본 카드 기준입니다. 적의 사격·아군 화살·갑주 등은 각 개체의 기존 피해·방어값을 유지하도록 생성 시 비율을 지정합니다. 탄속은 발사 카드에 저장하고, 생성된 투사체는 이 값을 자신의 이동 속도로 갖습니다.', '',
  '검증: `node tools/check-stat-ratios.cjs`. 표 갱신: `node tools/report-stat-ratios.cjs`.', '',
].join('\n');
fs.writeFileSync('reports/action-stat-ratios.md', report, 'utf8');
console.log(`Wrote ${rows.length} action cards to reports/action-stat-ratios.md`);
