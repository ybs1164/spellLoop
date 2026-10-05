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
  game.events = new EventBus(); game.hash = createSpatialIndex(); game._near = [];
  game.w = 1000; game.h = 800; game.clock = 0;
  game.openLevelUp = function() { this.pendingLevelUps = 0; };
  game.start();
  const order = cards => cards.map(id => SLOT_SECTION_ORDER[CARDS[id].type]);
  const sorted = cards => order(cards).every((v, i, a) => !i || a[i - 1] <= v);

  // 카드 슬롯은 조건 → 대상 → 행동 칸으로 정렬된다.
  assert.deepEqual(sortSlotCards(['bolt', 'self', 'ifHurt', 'heal', 'nearestEnemy']), ['ifHurt', 'self', 'nearestEnemy', 'bolt', 'heal']);
  assert.deepEqual(slotSections(['ifHurt', 'self', 'heal']).map(s => [s.id, s.start, s.ids.length]), [['condition', 0, 1], ['target', 1, 1], ['action', 2, 1]]);
  const deck = game.player.deck;
  deck.inventory = ['ifHurt', 'heal'];
  deck.move({ src: 'inv', idx: 0 }, { dest: 'slot', slot: 0 });
  deck.move({ src: 'inv', idx: 0 }, { dest: 'slot', slot: 0, idx: 0 });
  assert.deepEqual(deck.slots[0].cards, ['ifHurt', 'nearestEnemy', 'heal', 'bolt'], 'inserting at the front lands at the front of its own section');

  // 대상 칸의 대상 카드는 합쳐서 같은 행동을 받는다.
  const pv = deck.preview(0, { cooldown: 1 });
  assert.equal(pv.steps.length, 2);
  deck.slots[0].cards = ['self', 'nearestEnemy', 'bolt'];
  const ctx = { deck, mul: 1, pendingFilters: [] }, env = game.cardEnv();
  game.enemies.push(new Enemy('grunt', game.player.x + 50, game.player.y, 1));
  deck.runCard('self', ctx, env, 0, []); deck.runCard('nearestEnemy', ctx, env, 1, []);
  assert.deepEqual(ctx.targets.map(t => t.kind).sort(), ['enemy', 'self']);
  assert.equal(ctx.chains.length, 1);

  // 모든 개체 슬롯도 같은 칸 순서를 따른다.
  const owners = [new Enemy('necro', 0, 0, 1), new Enemy('pyro', 0, 0, 1), new Ally('archer', 0, 0), new Placed('turret', 0, 0, 1), new Placed('mine', 0, 0, 1), new Pickup('gem', 0, 0, 1)];
  for (const owner of owners) for (const slot of owner.slots) assert.ok(sorted(slot.cards), owner.kind + ' ' + slot.cards.join(','));
  const necro = owners[0], summon = necro.slots.find(s => s.cards.some(id => cardBaseId(id) === 'summon'));
  assert.equal(CARDS[summon.cards[0]].type, 'filter');
  assert.equal(entityStats(necro).summonPeriod, 6);

  // 플레이어가 아닌 개체의 카드 슬롯은 닫힌 채로 그리고, 펼친 상태는 유지한다.
  game.enemies = [necro];
  UI.editorPage = 2; UI.showEditor(game);
  assert.ok(UI.html.includes('<details class="slot-toggle" data-entity="0">'));
  assert.ok(UI.html.includes('조건 카드 슬롯') && UI.html.includes('대상 카드 슬롯') && UI.html.includes('행동 카드 슬롯'));
  UI.openEntitySlots.add(necro); UI.showEditor(game);
  assert.ok(UI.html.includes('data-entity="0" open'));
  UI.editorPage = 0; UI.showEditor(game);
  assert.ok(!UI.html.includes('<details'), 'player slots are always open');
  assert.equal((UI.html.match(/data-section="filter"/g) || []).length, deck.slots.length);
`, context);
console.log('Slot sections: condition/target/action ordering, joined targets, entity slots and collapsible editor passed.');
