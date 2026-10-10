'use strict';

const Input = {
  keys: new Set(),
  pressed: new Set(),

  init() {
    const block = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab', 'F3']);
    window.addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (block.has(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  },

  down(...codes) { return codes.some((c) => this.keys.has(c)); },

  /** 이번 프레임에 눌렸는지 확인하고 소비한다 */
  consume(code) {
    const hit = this.pressed.has(code);
    this.pressed.delete(code);
    return hit;
  },

  axis() {
    let x = 0, y = 0;
    if (this.down('KeyA', 'ArrowLeft')) x -= 1;
    if (this.down('KeyD', 'ArrowRight')) x += 1;
    if (this.down('KeyW', 'ArrowUp')) y -= 1;
    if (this.down('KeyS', 'ArrowDown')) y += 1;
    const len = Math.hypot(x, y);
    return len ? { x: x / len, y: y / len } : { x: 0, y: 0 };
  },

  endFrame() { this.pressed.clear(); },
};
