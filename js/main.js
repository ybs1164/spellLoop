'use strict';

Sprites.init();
const game = new Game(document.getElementById('game'));
PlayLog.attach(game);
Input.init();
UI.init(game);
UI.showTitle();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) game.pause();
});

// F3: 성능 오버레이 (업데이트·렌더 시간과 개체 수)
const perf = { on: false, update: 0, render: 0 };
function drawPerf() {
  const ctx = game.ctx, g = game;
  const lines = [
    `update ${perf.update.toFixed(2)}ms  render ${perf.render.toFixed(2)}ms`,
    `enemies ${g.enemies?.length ?? 0}  shots ${(g.projectiles?.length ?? 0) + (g.hazards?.length ?? 0)}  pickups ${g.pickups?.length ?? 0}`,
    `allies ${g.allies?.length ?? 0}  objects ${g.objects?.length ?? 0}  zones ${g.zones?.length ?? 0}  fx ${(g.fx?.length ?? 0) + (g.particles?.length ?? 0)}`,
  ];
  ctx.font = `12px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(8, 48, 330, lines.length * 16 + 8);
  ctx.fillStyle = '#9dffb0';
  lines.forEach((line, i) => ctx.fillText(line, 14, 66 + i * 16));
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);   // 탭 복귀 등 긴 프레임은 잘라낸다
  last = now;
  if (Input.consume('F3')) perf.on = !perf.on;
  const t0 = performance.now();
  game.update(dt);
  const t1 = performance.now();
  game.render();
  const t2 = performance.now();
  // 0.1 지수 평균으로 흔들림을 줄인다
  perf.update += (t1 - t0 - perf.update) * 0.1;
  perf.render += (t2 - t1 - perf.render) * 0.1;
  if (perf.on) drawPerf();
  Input.endFrame();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
