// readCombatStat(owner, id) 가 EntityCombatStats 접근자와 같은 값을 내는지, STAT_ORDER 가 접근자 목록을 빠짐없이 덮는지 확인한다.
require('./lib/js-bundles.cjs');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({ console, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js', 'js/entities.js', 'js/game.js']) vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
vm.runInContext(`
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const missing = ENTITY_STAT_NAMES.filter(n => !(n in STAT_ID));
  assert(!missing.length, '읽기 함수가 없는 스탯: ' + missing);
  assert(STAT_ORDER.every(n => ENTITY_STAT_NAMES.includes(n)), 'STAT_ORDER 에 접근자에 없는 이름');
  const game = Object.create(Game.prototype);
  game.player = new Player(0, 0);
  const owners = [];
  for (const type of Object.keys(ENEMY_TYPES)) owners.push(new Enemy(type, 0, 0, 1.7));
  owners.push(game.player);
  for (const e of owners.slice()) { const c = entityStats(e); c.attackPower = 7.4; c.moveSpeed = 123.6; c.knockback = 31.2; c.range = 40.6; c.pierce = 3; }
  const ally = Object.create(null); Object.assign(ally, { x: 0, y: 0, hp: 5, maxHp: 9, kind: 'knight', stats: { maxHp: 11.4, cooldownRate: 1 }, baseSpeed: 150.4, life: 4, r: 12 });
  owners.push(ally);
  let compared = 0;
  for (const o of owners) {
    const c = entityStats(o);
    for (const name of ENTITY_STAT_NAMES) {
      const a = readCombatStat(o, STAT_ID[name]), b = c[name];
      assert(Object.is(a, b) || (a !== a && b !== b), (o.type || o.kind) + '.' + name + ': ' + a + ' != ' + b);
      compared++;
    }
  }
  console.log('Stat reader checks passed (' + compared + ' comparisons).');
`, context);
