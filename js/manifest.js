'use strict';

/*
 * 스크립트 로드 목록의 단일 원본. 모듈 없이 file:// 로도 열려야 하므로 classic script 를 이 순서대로 읽는다.
 *  - index.html 의 <script> 목록은 `node tools/build-index.cjs` 가 groups 에서 만든다.
 *  - 시뮬레이션 워커(js/worker/sim-worker.js)는 worker 목록을 importScripts 한다.
 *  - tools/*.cjs 는 tools/lib/js-bundles.cjs 를 통해 `js/<그룹>.js` 를 그룹 파일 연결본으로 읽는다.
 * 같은 그룹 안에서는 위에서 아래로 정의가 먼저 와야 한다 (전역 const/class 는 로드 시점에 순서가 중요하다).
 */
globalThis.JS_MANIFEST = (() => {
  const groups = {
    util: ['core/util.js'],
    pixel: ['core/pixel.js'],
    input: ['core/input.js'],
    icons: ['core/icons.js'],
    cards: [
      'cards/slot-sections.js', 'cards/targets.js', 'data/card-defs.js', 'data/card-ratios.js', 'cards/skill-deck.js',
      'cards/entity-cards.js', 'cards/entity-stats.js', 'cards/frozen.js', 'cards/entity-behavior.js', 'cards/entity-configured.js',
      'cards/entity-gimmicks.js', 'cards/entity-slot.js', 'cards/cooldown.js', 'cards/slot-rules.js',
      'cards/slot-runtime.js', 'cards/slot-events.js',
    ],
    sprites: ['core/sprites.js'],
    entities: [
      'entities/types.js', 'entities/player.js', 'entities/enemy-soa.js', 'entities/enemy.js', 'entities/ally.js', 'entities/placed.js',
      'entities/projectile-soa.js', 'entities/projectile.js', 'entities/pickup.js',
    ],
    stages: ['data/stages.js'],
    upgrades: ['data/upgrades.js'],
    ui: ['ui/ui.js', 'ui/hud.js', 'ui/card-html.js', 'ui/codex.js', 'ui/editor.js', 'ui/overlay.js'],
    game: [
      'sim/tuning.js', 'sim/game.js',   // Game 본체 다음에 메서드 묶음(믹스인)이 붙는다
      'sim/wasm-core-data.js', 'sim/wasm-core.js', 'sim/nap-turn.js', 'sim/spawn.js', 'sim/spatial.js', 'sim/projectiles.js', 'sim/card-env.js', 'sim/decoy.js', 'sim/damage.js',
      'sim/actions-attack.js', 'sim/actions-status.js', 'sim/actions-move.js', 'sim/actions-summon.js',
      'sim/zones.js', 'sim/fx.js', 'sim/hazards.js', 'render/gl-sprites.js', 'render/render.js',
    ],
    'log-config': ['log/log-config.js'],
    'play-log': ['log/play-log.js'],
    'sim-bridge': ['worker/protocol.js', 'worker/sim-bridge.js'],
    main: ['main.js'],
  };
  const main = Object.values(groups).flat();
  const NOT_IN_WORKER = new Set([...groups.pixel, ...groups['log-config'], ...groups['play-log'], ...groups['sim-bridge'], ...groups.main]);
  return { groups, main, worker: [...main.filter(p => !NOT_IN_WORKER.has(p)), 'worker/protocol.js'] };
})();
