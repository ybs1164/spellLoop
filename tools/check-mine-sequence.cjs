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
  game.player.deck.slots = []; game.player.invuln = 10000;
  game.burst = game.addText = game.addFx = game.circleFx = game.shake = () => {};
  const waiting = new Placed('mine', 0, 0, 1);
  game.enemies = []; game.rebuildHash();
  waiting.update(0.01, game);
  assert.equal(waiting.dead, false, 'mine waits without a nearby enemy');
  // Real explosions can kill every triggering enemy before the next action.
  for (const hp of [1, 1000]) {
    const liveMine = new Placed('mine', 0, 0, 1);
    liveMine.slot.changed(); // Legacy edits must preserve the action stack too.
    const blastSlot = liveMine.slots.find(slot => slot.cards.includes('explode'));
    assert.deepEqual(Array.from(blastSlot.cards), ['entityEnemyInReach', 'entitySelf', 'explode', 'disappear']);
    const victim = new Enemy('grunt', 25, 0, 1);
    victim.hp = victim.maxHp = hp;
    game.enemies = [victim]; game.objects = [liveMine]; game.rebuildHash();
    const originalTest = CARDS.entityEnemyInReach.test;
    let conditionChecks = 0;
    CARDS.entityEnemyInReach.test = (...args) => { conditionChecks++; return originalTest(...args); };
    try { liveMine.update(0.01, game); }
    finally { CARDS.entityEnemyInReach.test = originalTest; }
    assert.equal(conditionChecks, 1, 'the action stack checks its condition only once');
    assert.equal(victim.hp < hp, true, 'explosion runs before disappearance');
    assert.equal(victim.dead, hp === 1, 'exercise lethal and nonlethal explosions');
    assert.equal(liveMine.dead, true, 'mine disappears even if its explosion kills the last enemy');
    const afterExplosion = victim.hp;
    liveMine.update(1, game); liveMine.slot.onDeath(game);
    assert.equal(victim.hp, afterExplosion, 'removed mine never explodes again');
  }

`, context);
console.log('Mine sequence: waits for enemies, explodes before removal, lethal/nonlethal damage and no repeat passed.');
