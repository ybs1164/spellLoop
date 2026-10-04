const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, assert, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js', 'js/entities.js', 'js/game.js', 'js/stages.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
vm.runInContext(`
  const game = Object.create(Game.prototype);
  game.player = new Player(0, 0);
  game.enemies = []; game.zones = [];
  game.circleFx = game.burst = game.addText = game.shake = () => {};
  const owner = new Enemy('brute', 10, 20, 1);
  const target = { x: 500, y: 600 };
  game.actionActor = owner;
  let center;
  game.blast = game.hitCircle = (x, y) => { center = [x, y]; };
  for (const effect of [
    { damageRatio: 1, radius: 70, consumeSource: true },
    { damageRatio: 1, radius: 70 },
    { damageRatio: 1, radiusRatio: 1, knockbackRatio: 1 }
  ]) {
    owner.dead = false; owner.r = 70;
    game.actionCard = { actionId: 'explode', effect };
    game.explode(target);
    assert.deepEqual(center, [target.x, target.y]);
    owner.slot.kind = 'zone';
    game.explode(target);
    assert.deepEqual(center, [target.x, target.y]);
    owner.slot.kind = 'enemy';
  }
  owner.dead = false;
  let summoned;
  game.spawnEnemy = (kind, at) => {
    summoned = at;
    return new Enemy(kind, at.x, at.y, 1);
  };
  game.configuredSummon(target, { type: 'grunt', n: 1 });
  assert.ok(Math.hypot(summoned.x - target.x, summoned.y - target.y) < 100);
  assert.ok(Math.hypot(summoned.x - owner.x, summoned.y - owner.y) > 500);
  for (const id of ['vortex', 'ward']) {
    const attached = new Enemy('brute', 100, 0, 1);
    const selected = new Enemy('brute', 200, 0, 1);
    owner.directTarget = { kind: 'enemy', e: attached };
    game.actionCard = { actionId: id, effect: { continuous: true, attached: true, speedRatio: 1 } };
    game[id](selected, { kind: 'enemy', e: selected }, 0.1);
    assert.equal(attached.x, 100);
    assert.notEqual(selected.x, 200);
    game[id](owner, { kind: 'enemy', e: owner }, 0.1);
    assert.notEqual(attached.x, 100);
  }
`, context);
console.log('Configured explosions, summons and attached field actions respect selected targets.');
