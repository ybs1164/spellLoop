const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname, '../reports');
const r = JSON.parse(fs.readFileSync(path.join(dir,'balance-simulation.json'),'utf8'));
const name = Object.fromEntries([...r.catalog.actions,...r.catalog.targets].map(x=>[x.id,x.name]));
const f = x => x == null ? '—' : Number(x).toFixed(2);
const get = (t,a,s) => r.rows.find(x=>x.cards.length===2&&x.cards[0]===t&&x.cards[1]===a&&x.scenario===s&&!x.focused&&!x.variant);
const baseline = (t,s) => r.rows.find(x=>x.baseline&&x.cards[0]===t&&x.scenario===s);
const delta = row => row ? row.dps-(baseline(row.cards[0],row.scenario)?.dps||0) : null;
const label = cards => cards.map(x=>name[x]||({flurry:'직전 행동 2회 추가',sequence:'뒤 행동 1회 추가',rewind:'묶음 1회 반복',pursue:'처치 후 재시전'}[x])||x).join(' → ');
const proposals = {
  scatter:{delay:0.2,cd:1.8,per:0.2,reason:'직접 피해 60; 같은 코스트의 관통탄·부메랑 피해 16과 비교해 기본 재사용 비용 증가'},
  homing:{delay:0.2,cd:1.8,per:0.2,reason:'직접 피해 60; 투사체 도달 지연 없이 즉시 적용'},
  drain:{delay:0.2,cd:2.2,per:0.25,reason:'직접 피해 60에 회복 6을 동반하므로 공격 전용 카드보다 긴 재사용 비용'},
  snipe:{delay:0.3,cd:3.1,per:0.3,reason:'직접 피해 100; 단일·집군 모두 긴 기본 재사용 비용 필요'},
  frost:{delay:0.15,cd:0.55,per:0.15,reason:'피해 4에 제어 포함; 집군 제어율을 유지하면서 연계 대기를 단축하는 후보'},
  root:{delay:0.15,cd:2.0,per:0.2,reason:'1차 CD 기여값 1.10초에서도 보스 제어율 99.89%로 부족하여 2.00초로 재검증'},
  fear:{delay:0.2,cd:0.7,per:0.2,reason:'집군 제어율 6.67%; 적이 시야 밖으로 밀려나는 영향으로 1차 너프 후보 기각·현행 유지'},
  mark:{delay:0.1,cd:0.35,per:0.1,reason:'후속 공격과의 조합은 확인했으나 단독 재사용 비용 증가 근거 부족·현행 유지'},
  prolong:{delay:0.15,cd:1.0,per:0.2,reason:'남은 수명 ×1.5의 반복 증식 위험; 쿨타임만으로 해결 가능한지 수명 상한 별도 검토'},
  refresh:{delay:0.15,cd:1.0,per:0.2,reason:'초기 수명으로 갱신되는 지속 운용; 생성 카드와 합산 비용 평가'},
  orb:{delay:0.2,cd:1.4,per:0.6,reason:'집군에서 여러 구체의 범위 피해가 중첩되어 대상당 재사용 비용 증가'},
  mine:{delay:0.2,cd:1.4,per:0.6,reason:'집군에서 대상마다 설치한 지뢰의 범위 피해가 중첩되어 대상당 재사용 비용 증가'},
};
const lines=[
 '# 행동 카드 밸런스 시뮬레이션', '',
 `생성 시각: ${r.generatedAt}; ${r.catalog.targets.length}종 대상 × ${r.catalog.actions.length}종 행동 = ${r.compatibility.length}개 조합; 결과 ${r.rows.length}행, 실행 오류 ${r.errors.length}건, 총 ${r.rows.reduce((s,x)=>s+x.seeds,0)+(r.arenas||[]).reduce((s,x)=>s+x.seeds,0)}회 실행.`, '',
 '## 방법과 적용 범위', '',
 '- 현재 작업 트리의 실제 CARDS, SkillDeck, Game, Player, Enemy, 소환·설치물·투사체·장판 업데이트를 재사용했다; 게임 데이터와 타이밍 값은 변경하지 않았다.',
 `- 전체 유효 조합은 ${r.seeds}개 고정 시드로 각 ${r.seconds}초, 대표 조합은 30개 시드로 각 60초 실행했다; 시간 간격은 1/30초다.`,
 '- 일반 적은 체력 70의 외눈 거인, 보스는 심연 군주이며 집군은 3·8·20체 밀집 및 8체 분산이다; 마무리 조건은 체력 25%다.',
 '- 적 AI·접촉 피해·자동 스폰·레벨 보상 선택을 제외한 고정 압력 실험이다; 사망한 적은 다음 프레임에 같은 종류로 보충하고, 살아 있는 적의 체력과 상태는 유지한다.',
 '- 대상 카드에 필요한 아군·설치물·장판·탄환·아이템은 시작 시에만 배치하며 자연 만료·파괴·소모를 그대로 적용한다; 초기 개체 종류는 실행기의 setup에 명시했다.',
 '- 「직전 표적」은 초기 적 하나, 「쓰러진 자리」는 초기 좌표로 시작한다; 다른 슬롯이 표적·사망 위치를 지속 공급하는 조건과 구분해야 한다; 적 체력이 낮아지면 「마무리 대상」의 적용 범위는 실제로 변화한다.',
 '- 고정 압력 실험에서 플레이어 체력이 50 미만이면 50으로 보충하며 자기 피해는 별도로 기록한다; 실제 생존 비교는 아래 Game.step 전투에서만 수행한다.',
 '- DPS는 초과 피해를 제외한 체력 감소와 즉사로 제거한 잔여 체력의 합이다; 대상별 초기 지원 개체의 공격은 해당 대상만 배치한 무행동 기준 실험을 빼서 비교한다.',
 '- 제어율은 직접 빙결·속박·공포 또는 기존 상태 타이머의 유지 비율이다; 공포·넉백은 적을 시야 밖으로 이동시킬 수 있으므로 유지율 저하를 효과가 약하다는 근거로 단정하지 않는다.',
 '- 치유량은 실제 회복량이며 공격이 없는 실험에서 체력이 차면 효율이 낮게 측정된다; 보호막·철갑을 이 실험의 DPS로 순위화하지 않는다.',
 '- 반복·복합 조합을 검사했고 분열·연장·갱신 포함 조합은 180초 실행했다; 반복 비교는 3시드이며 복합 조합의 지원 개체 기준 차이 때문에 원시 DPS를 인과 효과로 해석하지 않는다.',
 '- 0 DPS는 효과 없음과 동의어가 아니다: 이동·자원·버프·제어·대상 소모를 함께 확인해야 한다.', '',
 '## 주요 공격 비교', '',
 '단일·보스는 「가장 가까운 적」, 집군은 「적」 대상 카드를 사용한다; 대상 카드의 코스트 차이도 포함한 실제 슬롯 효율이다; 아래 표는 전체 조사의 3시드 평균이며 후보 전후 표는 30시드 평균이다.', '',
 '| 행동 | 코스트 | 실행 대기 | 단일 DPS | 8체 밀집 DPS | 8체 분산 DPS | 보스 DPS |',
 '|---|---:|---:|---:|---:|---:|---:|',
];
for(const a of ['bolt','slash','explode','scatter','lance','homing','laser','snipe','drain','chain','poison','blades']){
 const c=r.catalog.actions.find(x=>x.id===a);
 lines.push(`| ${c.name} | ${c.cost} | ${f(c.delay)} | ${f(delta(get('nearestEnemy',a,'single')))} | ${f(delta(get('enemies',a,'dense8')))} | ${f(delta(get('enemies',a,'spread8')))} | ${f(delta(get('nearestEnemy',a,'boss')))} |`);
}
lines.push('', '## 제어 유지율', '', '| 행동 | 단일 | 8체 밀집 | 보스 |', '|---|---:|---:|---:|');
for(const a of ['frost','root','fear'])lines.push(`| ${name[a]} | ${f(get('nearestEnemy',a,'single')?.controlFraction*100)}% | ${f(get('enemies',a,'dense8')?.controlFraction*100)}% | ${f(get('nearestEnemy',a,'boss')?.controlFraction*100)}% |`);
lines.push('', '## 타이밍 조정안', '', '**후보값은 시뮬레이션에만 적용했다; 게임 파일에는 적용하지 않았으며, 실제 플레이 감각과 남은 역할별 검증을 거친 뒤 확정해야 한다.**', '',
 '기본 쿨타임 기여값과 추가 대상 비용을 행동 대기에서 분리한다: `기본 CD = max(0.6, 대상·반복 코스트 × 0.35 + Σ행동 CD 기여값)`; `추가 CD = Σ 추가 대상 수 × 대상당 비용 + 반복 실행 비용`; 실행 시간은 별도 delay를 사용한다.', '',
 '기존 행동 CD 기여값은 `행동 코스트 × 0.35`다; 행동 개별 쿨타임이 아니라 슬롯 전체 쿨타임에 합산할 값이다; 코스트 제한·동시 적용·최소 CD·무효 실행 CD는 유지한다.', '',
 '| 행동 | 실행 대기 기존→후보 | 기본 CD 기여 기존→후보 | 추가 대상당 CD 기존→후보 | 근거 |', '|---|---:|---:|---:|---|');
for(const c of r.catalog.actions){const p=proposals[c.id];lines.push(`| ${c.name} | ${f(c.delay)}→${f(p?.delay??c.delay)} | ${f(c.cost*0.35)}→${f(p?.cd??c.cost*0.35)} | ${f(c.delay)}→${f(p?.per??c.delay)} | ${p?.reason||'현행 유지; 역할별 지표 또는 실제 생존전 검증 후 조정'} |`);}
lines.push('', '## 후보값 전후 비교 — 동일 30개 시드', '', '| 조합 | 조건 | DPS 기존→후보 | 제어율 기존→후보 | 평균 슬롯 CD 기존→후보 |', '|---|---|---:|---:|---:|');
for(const after of r.rows.filter(x=>x.variant==='candidate'&&((x.cards[0]==='enemies'&&x.scenario==='dense8')||(x.cards[0]==='nearestEnemy'&&x.cards[1]==='root'&&x.scenario==='boss')))){
 const before=r.rows.find(x=>x.variant==='control'&&x.scenario===after.scenario&&JSON.stringify(x.cards)===JSON.stringify(after.cards));
 lines.push(`| ${label(after.cards)} | ${after.scenario} | ${f(before?.dps)}→${f(after.dps)} | ${f(before?.controlFraction*100)}%→${f(after.controlFraction*100)}% | ${f(before?.meanCooldown)}→${f(after.meanCooldown)} |`);
}
lines.push('', '속박의 첫 후보(기본 CD 기여값 1.10초)는 단일 보스 제어율 99.89%를 그대로 유지하여 기각하고 2.00초로 재검증했다; 공포·표식의 기본 CD 증가안은 근거가 부족하여 현행 값을 유지한다.', '',
 '구체·지뢰는 후보 적용 후에도 집군 DPS가 각각 489.47·298.67로 높아 이 후보만으로 밸런스가 맞았다고 볼 수 없다; 추가 대상 비용의 추가 증가와 중첩 범위 피해에 비례하는 비용을 다음 검증 대상으로 삼는다; 마탄 역시 단일 DPS 24.83으로 일부 너프 후보보다 높으므로 최종 확정 전 저코스트 기준 카드까지 함께 비교해야 한다.', '',
 '## 실제 전투 업데이트 — 코스트 예산과 여러 슬롯', '',
 '실제 Game.step으로 적 AI·공격·접촉 충돌·아이템 획득·방어·치유를 실행했다; 초·중·후반은 실제 레벨 대신 슬롯 코스트 상한 4·8·15와 2·2·3개 슬롯의 고정 빌드로 정의하며, 보상 선택과 레벨 상승은 제외한다; 3초마다 3·5·8체가 등장하고 모든 빌드에서 같은 원형 이동 정책을 사용한다; 각 30개 시드, 최대 180초다.', '',
 '| 예산 단계 | 구성 | 평균 생존 초 기존→후보 | 180초 생존율 기존→후보 | 평균 처치 기존→후보 |', '|---|---|---:|---:|---:|');
for(const tier of ['early','middle','late']){const b=r.arenas?.find(x=>x.tier===tier&&x.variant==='control'),a=r.arenas?.find(x=>x.tier===tier&&x.variant==='candidate');if(a&&b)lines.push(`| ${tier} / ${a.budget} | ${a.slots.map(label).join('<br>')} | ${f(b.survival)}→${f(a.survival)} | ${f(b.survived*100)}%→${f(a.survived*100)}% | ${f(b.kills)}→${f(a.kills)} |`);}
lines.push('', '이는 특정 이동 정책과 고정 빌드의 비교이며 모든 덱·플레이 방식에 일반화하지 않는다; 중반 생존율이 낮으면 빌드에 방어·제어 카드가 없다는 조건도 함께 고려한다.');
lines.push('', '## 지원·자원 역할의 별도 지표', '', '| 조합 | 조건 | 실제 회복량 | 지원 개체 순증 DPS | 획득 XP+잔여 보석 가치 | 무행동 기준 XP+보석 가치 | 잔여 수명 합 |', '|---|---|---:|---:|---:|---:|---:|');
for(const [t,a]of [['self','heal'],['self','mend'],['self','regen'],['allies','rage'],['allies','focus'],['objects','prolong'],['objects','refresh'],['gems','rage'],['gems','split'],['gems','magnet'],['gems','absorb']]){
 const x=get(t,a,'dense8'),b=baseline(t,'dense8');if(x)lines.push(`| ${label([t,a])} | dense8 / ${x.seconds}초 | ${f(x.healing)} | ${f(delta(x))} | ${f(x.xp+x.remainingGemValue)} | ${f((b?.xp||0)+(b?.remainingGemValue||0))} | ${f(x.remainingLifetime)} |`);
}
lines.push('', '수명은 설치물·아군·장판·투사체 전체의 합이며, 보석 가치는 실험 종료 시점의 잠재 획득량이다; 실제 습득 속도와 구분한다; 다른 개체의 재생 버프 회복은 이 healing 계측에 포함하지 않으므로 회복 카드를 비교할 때는 자신 대상 결과를 사용한다.');
lines.push('', '## 전체 행동의 대표 결과', '', '| 행동 | 대상 | 단일 순증 DPS | 8체 순증 DPS | 단일 회복량 | 집군 평균 CD |', '|---|---|---:|---:|---:|---:|');
for(const a of r.catalog.actions){const preferred={heal:'self',mend:'self',shield:'self',regen:'self',armor:'self',haste:'self',amplify:'self',rage:'allies',focus:'allies',prolong:'objects',refresh:'objects',rally:'allies',magnet:'gems'}[a.id];const t=preferred||r.compatibility.find(c=>c.action===a.id&&c.target==='enemies'&&c.applicable)?.target||r.compatibility.find(c=>c.action===a.id&&c.target==='self'&&c.applicable)?.target||r.compatibility.find(c=>c.action===a.id&&c.applicable)?.target;const one=get(t,a.id,'single'),many=get(t,a.id,'dense8');lines.push(`| ${a.name} | ${name[t]} | ${f(delta(one))} | ${f(delta(many))} | ${f(one?.healing)} | ${f(many?.meanCooldown)} |`);}
lines.push('', '## 주요 복합 조합', '', '| 조합 | 조건 | 실행 초 | DPS | 제어율 | 최대 개체 수 | 잔여 수명 합 |', '|---|---|---:|---:|---:|---:|---:|');
for(const row of r.rows.filter(x=>!x.baseline&&x.cards.length>2&&['dense8','boss','wounded8'].includes(x.scenario)&&x.cards.some(c=>['pursue','refresh','prolong','focus','rage','mark'].includes(c))).slice(0,45))lines.push(`| ${label(row.cards)} | ${row.scenario} | ${row.seconds} | ${f(row.dps)} | ${f(row.controlFraction*100)}% | ${f(row.maxEntities)} | ${f(row.remainingLifetime)} |`);
lines.push('', '## 다음 검증', '',
 '1. 검증한 후보 중 산탄·유도탄·흡혈·저격·속박을 우선 조정 대상으로 삼되, 약한 관통탄·레이저의 별도 상향과 범위 중첩 카드의 추가 대상 비용을 함께 조정한다.',
 '2. 무한 제어·수명 증가·자원 증식은 최악 조합을 180초 이상 다시 검사하며 시간 조정만으로 해결되지 않는 경우 상한 정책을 별도 결정한다.',
 '3. 이미 확인한 코스트 4·8·15 고정 빌드 외에 더 많은 덱과 이동 정책을 검증하고, 회복·방어 카드는 같은 피해 압력에서 유효 회복·흡수량으로 개별 평가한다.',
 '4. 현재 산탄·유도탄·레이저 등은 직접 피해로 처리되며 범위·투사체 역할이 다를 수 있으므로 타이밍으로 구분할지 동작을 변경할지 결정한다.',
 '5. 기존 check-card-costs, check-targets, check-batches, check-slots, check-enemy-damage 검증은 모두 통과했다.', '',
 '재현(PowerShell): `$env:BALANCE_PHASE="all"; node tools/simulate-balance.cjs`; `Remove-Item Env:BALANCE_PHASE`; `node tools/summarize-balance.cjs`; 원시 자료는 balance-simulation.json과 balance-simulation.csv다; 전체 실행 전에 balance-proposals.json이 있어야 한다.',
);
fs.writeFileSync(path.join(dir,'balance-report.md'),lines.join('\n')+'\n');
fs.writeFileSync(path.join(dir,'balance-proposals.json'),JSON.stringify({status:'simulation-candidates-not-applied',proposals},null,2));
console.log(lines.slice(lines.indexOf('## 주요 공격 비교'),lines.indexOf('## 타이밍 조정안')).join('\n'));
