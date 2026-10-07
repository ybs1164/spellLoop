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

  // 카드 슬롯은 이벤트 → 대상 → 행동 칸으로 정렬된다.
  assert.deepEqual(sortSlotCards(['bolt', 'self', 'on_hurt', 'heal', 'nearestEnemy']), ['on_hurt', 'self', 'nearestEnemy', 'bolt', 'heal']);
  assert.deepEqual(slotSections(['on_hurt', 'self', 'heal']).map(s => [s.id, s.start, s.ids.length]), [['event', 0, 1], ['target', 1, 1], ['action', 2, 1]]);
  const deck = game.player.deck;
  deck.slots[0].cards = ['nearestEnemy', 'bolt'];
  deck.inventory = ['on_hurt', 'heal'];
  deck.move({ src: 'inv', idx: 0 }, { dest: 'slot', slot: 0 });
  deck.move({ src: 'inv', idx: 0 }, { dest: 'slot', slot: 0, idx: 0 });
  assert.deepEqual(deck.slots[0].cards, ['on_hurt', 'nearestEnemy', 'heal', 'bolt'], 'inserting at the front lands at the front of its own section');

  // 대상 칸의 대상 카드는 합쳐서 같은 행동을 받는다.
  const pv = deck.preview(0);
  assert.equal(pv.steps.length, 2);
  deck.slots[0].cards = ['self', 'nearestEnemy', 'bolt'];
  const env = game.cardEnv();
  game.enemies.push(new Enemy('grunt', game.player.x + 50, game.player.y, 1));
  assert.deepEqual(selectSlotTargets(deck.slots[0], env).map(t => t.kind).sort(), ['enemy', 'self']);

  // 모든 개체 슬롯도 같은 칸 순서를 따른다.
  const owners = [new Enemy('necro', 0, 0, 1), new Enemy('pyro', 0, 0, 1), new Ally('archer', 0, 0), new Placed('turret', 0, 0, 1), new Placed('mine', 0, 0, 1), new Pickup('gem', 0, 0, 1)];
  for (const owner of owners) for (const slot of owner.slots) assert.ok(sorted(slot.cards), owner.kind + ' ' + slot.cards.join(','));
  const necro = owners[0], summon = necro.slots.find(s => s.cards.some(id => cardBaseId(id) === 'summon'));
  assert.equal(CARDS[summon.cards.find(id => CARDS[id].type === 'event')].type, 'event');
  assert.equal(entityStats(necro).summonPeriod, 6);

  // 플레이어가 아닌 개체의 카드 슬롯은 닫힌 채로 그리고, 펼친 상태는 유지한다.
  game.enemies = [necro];
  UI.editorPage = 2; UI.showEntityEditor(game);
  assert.ok(UI.html.includes('<details class="slot-toggle" data-entity="0">'));
  assert.ok(UI.html.includes('이벤트 카드 슬롯') && UI.html.includes('대상 카드 슬롯') && UI.html.includes('행동 카드 슬롯'));
  UI.openEntitySlots.add(necro); UI.showEntityEditor(game);
  assert.ok(UI.html.includes('data-entity="0" open'));
  UI.editorPage = 0; UI.showEditor(game);
  assert.ok(!UI.html.includes('<details'), 'player slots are always open');
  assert.equal((UI.html.match(/data-section="event"/g) || []).length, deck.slots.length);

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
console.log('Slot sections: condition/target/action ordering, joined targets, entity slots and collapsible editor passed.');
