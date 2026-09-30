'use strict';

Sprites.init();
const game = new Game(document.getElementById('game'));
Input.init();
UI.init(game);
UI.showTitle();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) game.pause();
});

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);   // 탭 복귀 등 긴 프레임은 잘라낸다
  last = now;
  game.update(dt);
  game.render();
  Input.endFrame();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
