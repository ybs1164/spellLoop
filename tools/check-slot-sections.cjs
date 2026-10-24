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
  UI.open = function(html, mode) { this.html = html; this.mode = mode; };
  UI.overlay = { querySelector: () => null };
  const game = Object.create(Game.prototype);
  game.events = new EventBus(); game.hash = new SpatialHash(64); game._near = [];
  game.w = 1000; game.h = 800; game.clock = 0;
  game.openLevelUp = function() { this.pendingLevelUps = 0; };
  game.start();
  const order = cards => cards.map(id => SLOT_SECTION_ORDER[CARDS[id].type]);
  const sorted = cards => order(cards).every((v, i, a) => !i || a[i - 1] <= v);

  // 순서가 뒤섞인 카드 목록(개체 슬롯)은 연쇄 → 대상 → 행동 칸으로 정렬된다.
  assert.deepEqual(sortSlotCards(['bolt', 'self', 'artifactThorns', 'heal', 'nearestEnemy']), ['artifactThorns', 'self', 'nearestEnemy', 'bolt', 'heal']);
  // 대상 → 행동 → 연쇄 순환을 지킨 목록은 놓인 순서가 곧 실행 순서다.
  const chainStack = ['nearestEnemy', 'bolt', 'on_hit', 'eventSubject', 'frost'];
  assert.deepEqual(normalizeSlotCards(chainStack), chainStack);
  assert.equal(slotNextType([]), null);
  assert.equal(slotNextType(['nearestEnemy']), 'action');
  assert.equal(slotNextType(['nearestEnemy', 'bolt']), 'artifact');
  assert.equal(slotNextType(chainStack), 'artifact');
  assert.equal(slotNextType(['artifactThorns', 'self', 'heal']), 'artifact', 'the first card sets the cycle');
  assert.equal(slotNextType(['artifactThorns']), 'target');
  assert.equal(slotNextType(['bolt']), 'artifact');

  // 편집: 맨 뒤 빈 칸에는 다음 순서의 종류만 놓을 수 있고, 같은 종류의 놓인 카드 자리는 교체된다.
  const deck = game.player.deck;
  deck.slots[0].cards = ['nearestEnemy', 'bolt'];
  deck.inventory = ['heal', 'artifactThorns', 'self', 'frost', 'nearestEnemy'];
  assert.match(deck.move({ src: 'inv', idx: 0 }, { dest: 'slot', slot: 0 }), /연쇄/, 'a chain cell follows an action');
  assert.equal(deck.move({ src: 'inv', idx: 1 }, { dest: 'slot', slot: 0 }), null);
  assert.deepEqual(deck.slots[0].cards, ['nearestEnemy', 'bolt', 'artifactThorns']);
  assert.equal(deck.move({ src: 'inv', idx: 1 }, { dest: 'slot', slot: 0 }), null, 'target follows chain');
  assert.equal(deck.move({ src: 'inv', idx: 1 }, { dest: 'slot', slot: 0 }), null, 'action follows target');
  assert.deepEqual(deck.slots[0].cards, ['nearestEnemy', 'bolt', 'artifactThorns', 'self', 'frost']);
  assert.equal(deck.move({ src: 'inv', idx: 1 }, { dest: 'slot', slot: 0, idx: 0 }), null, 'same-kind card replaces');
  assert.deepEqual(deck.slots[0].cards.slice(0, 2), ['nearestEnemy', 'bolt']);
  assert.ok(deck.inventory.includes('heal') && deck.inventory.includes('nearestEnemy'), 'replaced card returns to the inventory');
  assert.match(deck.move({ src: 'inv', idx: 0 }, { dest: 'slot', slot: 0, idx: 0 }), /대상/, 'kinds cannot replace each other');
  // 중간 카드를 빼면 그 뒤 카드도 보관함으로 돌아간다. 첫 카드나 마지막 카드는 혼자 빠진다.
  assert.equal(deck.move({ src: 'slot', slot: 0, idx: 2 }, { dest: 'inv' }), null);
  assert.deepEqual(deck.slots[0].cards, ['nearestEnemy', 'bolt']);
  assert.match(deck.notice, /2장/);
  assert.equal(deck.move({ src: 'slot', slot: 0, idx: 0 }, { dest: 'inv' }), null);
  assert.deepEqual(deck.slots[0].cards, ['bolt']);
  assert.equal(deck.notice, null);

  // 한 슬롯의 대상 카드는 하나이고, 연쇄 뒤의 대상 카드는 연쇄 슬롯의 몫이다.
  deck.slots[0].cards = ['self', 'bolt', 'on_hit', 'nearestEnemy', 'heal'];
  const env = game.cardEnv();
  game.enemies.push(new Enemy('grunt', game.player.x + 50, game.player.y, 1));
  assert.deepEqual(selectSlotTargets(deck.slots[0], env).map(t => t.kind), ['self']);
  assert.equal(slotAnalysis(deck.slots[0]).chainRest.join(), 'on_hit,nearestEnemy,heal');

  // 모든 개체 슬롯도 같은 칸 순서를 따른다.
  const owners = [new Enemy('necro', 0, 0, 1), new Enemy('pyro', 0, 0, 1), new Ally('archer', 0, 0), new Placed('turret', 0, 0, 1), new Placed('mine', 0, 0, 1), new Pickup('gem', 0, 0, 1)];
  for (const owner of owners) for (const slot of owner.slots) assert.ok(sorted(slot.cards), owner.kind + ' ' + slot.cards.join(','));
  const necro = owners[0], summon = necro.slots.find(s => s.cards.some(id => cardBaseId(id) === 'summon'));
  assert.equal(slotCooldown(summon), 6, 'the summon period is the summon card cooldown');
  assert.equal(entityStats(necro).summonPeriod, 6);

  // 플레이어가 아닌 개체의 카드 슬롯은 닫힌 채로 그리고, 펼친 상태는 유지한다.
  game.enemies = [necro];
  UI.editorPage = 2; UI.showEntityEditor(game);
  assert.ok(UI.html.includes('<details class="slot-toggle" data-entity="0">'));
  assert.ok(!UI.html.includes('카드 슬롯</div>') && !UI.html.includes('data-section'), 'entity slots are one strip, not sections');
  assert.ok(UI.html.includes('class="slot-cards slot-strip"'));
  UI.openEntitySlots.add(necro); UI.showEntityEditor(game);
  assert.ok(UI.html.includes('data-entity="0" open'));
  UI.editorPage = 0; UI.showEditor(game);
  assert.ok(!UI.html.includes('<details'), 'player slots are always open');
  assert.equal((UI.html.match(/slot-strip dropzone/g) || []).length, deck.slots.length);
  assert.equal((UI.html.match(/cell next/g) || []).length, deck.slots.length, 'each slot shows its next empty cell');
  assert.ok(UI.html.includes('data-type="artifact"') && UI.html.includes('data-type=""'), 'next cell follows the first card');

  // 편집기에는 개체 조회 진입 UI가 없고, I 키 조회는 원래 화면으로 돌아온다.
  assert.ok(!UI.html.includes('data-act="entity-page"'));
  assert.ok(!UI.html.includes('inspector'));
  UI.game = game;
  UI.updateHud = () => {};
  UI.hideOverlay = () => { UI.mode = null; };
  UI.showPause = () => { UI.mode = 'pause'; };
  const press = key => { Input.pressed.add(key); game.update(0); Input.endFrame(); };
  for (const state of ['playing', 'paused', 'levelup', 'editor']) {
    let rewardsRestored = 0;
    UI.levelUpBack = () => { rewardsRestored++; UI.mode = 'levelup'; };
    game.state = state;
    const cardsBefore = JSON.stringify(deck.slots);
    press('KeyI');
    assert.equal(game.state, 'inspector');
    assert.equal(UI.mode, 'inspector');
    UI.editorPage = 1;
    press('ArrowLeft'); assert.equal(UI.editorPage, 6);
    press('ArrowRight'); assert.equal(UI.editorPage, 1);
    press(state === 'paused' ? 'Escape' : 'KeyI');
    assert.equal(game.state, state);
    assert.equal(JSON.stringify(deck.slots), cardsBefore);
    if (state === 'levelup') assert.equal(rewardsRestored, 1);
    if (state === 'editor') assert.equal(UI.mode, 'editor');
  }
  game.state = 'editor';
  press('ArrowRight');
  assert.equal(UI.mode, 'editor', 'arrow keys cannot open entity inspection from the editor');
  game.editorLevelUpBack = () => { UI.mode = 'levelup'; };
  press('KeyI'); press('KeyI'); press('KeyE');
  assert.equal(game.state, 'levelup', 'inspection preserves the editor reward return path');
`, context);
console.log('Slot cycle: target/action/chain ordering, editing rules, chain stage split, entity slots and collapsible editor passed.');
