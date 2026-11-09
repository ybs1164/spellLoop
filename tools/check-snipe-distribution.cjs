require('./lib/js-bundles.cjs');
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, assert, TD: new Proxy({}, { get: () => 0 }) });
for (const path of ['js/util.js', 'js/input.js', 'js/cards.js', 'js/entities.js', 'js/stages.js', 'js/icons.js', 'js/ui.js', 'js/game.js']) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
}
vm.runInContext(`
  UI.hideOverlay = UI.showHud = () => {};
  const game = Object.create(Game.prototype);
  game.events = new EventBus(); game.hash = new SpatialHash(64); game._near = [];
  game.w = 1000; game.h = 800; game.clock = 0; game.start();
  game.player.deck.slots = [];
  game.burst = game.addText = game.addFx = game.circleFx = game.shake = () => {};
  const env = game.cardEnv();
  const total = entityStats(game.player).attackPower * 10;
  for (const count of [1, 2, 5]) {
    game.enemies = Array.from({ length: count }, (_, i) => new Enemy('grunt', 100, i * 20, 1000));
    const dead = new Enemy('grunt', 200, 0, 1000); dead.dead = true;
    const far = new Enemy('grunt', 2000, 0, 1000);
    game.enemies.push(dead, far); game.rebuildHash();
    const before = game.enemies.map(e => e.hp);
    const slot = new EntitySlot(game.player, 'self', ['enemies', 'snipe']);
    slot.update(0.01, game, { deferTick: true });
    for (let i = 0; i < count; i++) assert.ok(Math.abs(before[i] - game.enemies[i].hp - total / count) < 1e-8, 'equal damage share for ' + count + ' targets');
    assert.equal(dead.hp, before[count], 'dead targets do not receive damage');
    assert.equal(far.hp, before[count + 1], 'unselected enemies do not receive damage');
  }
  game.enemies = [];
  CARDS.snipe.run([], env);
  const recipients = Array.from({ length: 2 }, () => new Ally('knight', 100, 0));
  recipients.forEach(a => { a.hp = a.maxHp = 10000; });
  game.player.stats.might = 1.5; game.player.cardMul = 2;
  const before = recipients.map(a => a.hp);
  CARDS.snipe.run(recipients.map(a => ({ kind: 'ally', a })), env);
  for (let i = 0; i < recipients.length; i++) assert.equal(before[i] - recipients[i].hp, total * 1.5 * 2 / 2, 'buffed damage is shared across other entity kinds');
  game.player.stats.might = 1; game.player.cardMul = 1;
  const orb = new Placed('orb', 0, 0, 1);
  const strike = orb.slot.cards.find(id => cardBaseId(id) === 'snipe');
  const targets = [new Enemy('grunt', 100, 0, 1000), new Enemy('grunt', 100, 20, 1000)];
  const hp = targets.map(e => e.hp);
  CARDS[strike].run(targets, game.cardEnv(orb));
  const expected = entityStats(orb).attackPower * entityActionConfig(orb, 'snipe').damageRatio;
  targets.forEach((e, i) => assert.equal(hp[i] - e.hp, expected, 'entity strike keeps per-target damage'));
  const nearGem = new Pickup('gem', 5, 0, 1);
  const farGem = new Pickup('gem', 1000000, 0, 4);
  const deadGem = new Pickup('gem', 10, 0, 1); deadGem.dead = true;
  game.pickups = [nearGem, farGem, deadGem, new Pickup('heart', 20, 0)];
  const gems = CARDS.gems.resolve(env);
  assert.equal(gems.length, 2, 'all living gems are selected regardless of distance');
  assert.ok(gems.some(t => t.g === nearGem) && gems.some(t => t.g === farGem));
  assert.ok(gems.every(t => t.kind === 'gem' && !t.g.dead && t.g.kind === 'gem'), 'other pickups and dead gems are excluded');
`, context);
console.log('Snipe distribution and unlimited gem targeting passed (single/empty selections, eligible targets, buffs, other entities and configured strikes).');
