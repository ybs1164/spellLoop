// 실제 JS 생성자/행동과 C 생성자의 모든 기본 스탯·행동 쿨타임을 비교한다.
require('./lib/js-bundles.cjs');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({ console, TD: new Proxy({}, { get: () => 0 }) });
for (const file of ['js/util.js', 'js/input.js', 'js/icons.js', 'js/cards.js', 'js/entities.js', 'js/stages.js', 'js/upgrades.js', 'js/ui.js', 'js/game.js'])
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
const expected = JSON.parse(vm.runInContext(`JSON.stringify((() => {
  Math.random = () => 0.5;
  UI.hideOverlay = UI.showHud = () => {};
  const game = Object.create(Game.prototype);
  game.events = new EventBus(); game.hash = new SpatialHash(64); game._near = []; game._nearStruct = []; game.structHashes = new Map(); game._structCount = 0;
  game.w = 960; game.h = 540; game.clock = 0; game.start([0]);
  const list = [], add = (key, o) => {
    const st = entityStats(o), slots = o.slots || o.deck?.slots || [];
    list.push({ key, team: {friendly:0, hostile:1, neutral:2}[entityTeam(o)],
      stats: Object.fromEntries(ENTITY_STAT_NAMES.map(k => [k, st[k]])),
      slots: slots.map(s => ({ cooldown: slotCooldown(s), actions: s.cards.filter(id => CARDS[id].type === 'action').map(cardBaseId) })) });
  };
  add('player:player', game.player);
  for (const id of Object.keys(ENEMY_TYPES)) add('enemy:' + id, new Enemy(id, 1000, 1000, 1));
  for (const id of Object.keys(ALLY_TYPES)) add('ally:' + id, game.summonAlly(id, {x:0,y:0}));
  for (const id of Object.keys(PLACED_TYPES)) {
    if (id === 'barrel') add('object:' + id, new Placed(id, 0, 0, 1));
    else { game.place(id, {x:0,y:0}, null); add('object:' + id, game.objects.at(-1)); }
  }
  for (const id of ZONE_KINDS) add('zone:' + id, createZone(id, game.player, {x:0,y:0}, null));
  for (const id of ['gem','vitalGem','magnet','chest']) add('pickup:' + id, new Pickup(id, 0, 0, 1));
  add('shot:bolt', new Projectile({source:game.player, vx:420, radius:5, damage:10, knockback:100, pierce:1, life:1.4}));
  const curse = {kind:'curseBolt', source:game.player, team:'friendly', x:0,y:0,vx:190,vy:0,r:7,damage:6,life:3.5,max:3.5,dead:false};
  entitySlot(curse, 'shot'); add('shot:curseBolt', curse);
  return list;
})())`, context));
const exe = process.argv[2] || path.join(root, 'c/build/desktop', process.platform === 'win32' ? 'amagos_cli.exe' : 'amagos_cli');
const actual = JSON.parse(execFileSync(exe, ['--probe'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
let checks = 0;
const errors = [];
for (const e of expected) {
  const a = actual.find(a => a.key === e.key);
  if (!a) { errors.push(e.key + ': missing'); continue; }
  const compare = (label, av, ev) => {
    checks++;
    if (typeof av === 'number' && typeof ev === 'number' ? Math.abs(av - ev) > 1e-3 : av !== ev)
      errors.push(e.key + '.' + label + ': C=' + JSON.stringify(av) + ', JS=' + JSON.stringify(ev));
  };
  compare('team', a.team, e.team);
  for (const [key, value] of Object.entries(e.stats)) {
    if (e.key.startsWith('enemy:') && key === 'moveSpeed') {
      checks++;
      if (a.stats[key] < Math.round(value * 0.9) || a.stats[key] > Math.round(value * 1.1)) errors.push(e.key + ': randomized speed out of bounds');
    } else compare('stats.' + key, a.stats[key], value);
  }
  // 기본 기믹을 한 슬롯에 합치는 것은 실행 결과에 영향이 없다. 행동별 주기를 비교한다.
  const actions = slots => slots.flatMap(s => s.actions.map(id => ({id, cooldown:s.cooldown})));
  const aa = actions(a.slots), ea = actions(e.slots);
  compare('actionCount', aa.length, ea.length);
  const seen = new Map();
  for (const action of ea) {
    const occurrence = seen.get(action.id) || 0; seen.set(action.id, occurrence + 1);
    const match = aa.filter(a => a.id === action.id)[occurrence];
    compare('action.' + action.id + '.' + occurrence, match?.cooldown, action.cooldown);
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('C/JS parity: ' + expected.length + ' entities, ' + checks + ' checks passed');
