'use strict';

/*
 * 효과음·배경음. 시뮬레이션 상태는 건드리지 않고 Game/Player/Pickup 메서드 호출을 엿들어 소리만 낸다 (워커·도구에서는 붙이지 않는다).
 * 모든 이벤트가 소리를 낸다. 한 프레임 안의 같은 소리는 같은 순간에 겹쳐 울리는 것이므로 한 목소리로 합치고, 개수만큼 조금씩 커진다.
 * 자주 울리는 소리(탄·피격·처치·보석 등)는 짧고 부드러운 합성음, 드문 소리는 음원 파일. 음원: assets/CREDITS.md
 */
const Sound = (() => {
  // 이름: [음원 파일 또는 합성음 이름, 음량]
  const SFX = {
    shoot: ['~shoot', 0.12],
    beam: ['~beam', 0.16],
    slash: ['~slash', 0.18],
    hit: ['~hit', 0.1],
    kill: ['~kill', 0.16],
    explode: ['~explode', 0.3],
    gem: ['~gem', 0.08],
    bigExplode: ['explode2', 0.55],
    chest: ['chest', 0.6],
    magnet: ['magnet', 0.5],
    levelup: ['levelup', 0.5],
    pick: ['pick', 0.5],
    hurt: ['hurt', 0.55],
    gameover: ['gameover', 0.7],
    click: ['click', 0.35],
    pauseIn: ['pause_in', 0.45],
    pauseOut: ['pause_out', 0.45],
    boss: ['boss', 0.6],
    swarm: ['swarm', 0.5],
    clear: ['clear', 0.7],
    victory: ['victory', 0.7],
  };
  const BGM = { title: 'title.ogg', stage0: 'stage1.ogg', stage1: 'stage2.mp3', stage2: 'stage3.mp3', ending: 'ending.ogg' };
  const BGM_VOLUME = 0.35, STORE_KEY = 'amagos.sound';
  const SAMPLE_RATE = 22050;

  // 합성음: [길이(초), 표본 함수(t, 진행률 0..1, 잡음)]. 모두 짧은 감쇠 곡선을 곱해 끝이 딱 끊기지 않게 한다.
  const SYNTH = {
    shoot: [0.05, (t, k) => tri(t * lerpF(900, 520, k)) * env(k, 3)],
    beam: [0.09, (t, k) => tri(t * lerpF(640, 300, k)) * env(k, 2)],
    slash: [0.06, (t, k, n) => n * env(k, 4) * 0.8],
    hit: [0.03, (t, k, n) => (n * 0.5 + tri(t * 180) * 0.5) * env(k, 5)],
    kill: [0.07, (t, k) => tri(t * lerpF(320, 110, k)) * env(k, 3)],
    explode: [0.22, (t, k, n) => n * env(k, 3)],
    gem: [0.05, (t, k) => Math.sin(TAU * t * lerpF(1250, 1650, k)) * env(k, 2)],
  };
  // 주파수가 바뀌는 음: 진행률 k 에서의 위상을 t·f(k) 로 근사한다 (짧은 소리라 차이가 들리지 않는다)
  const lerpF = (a, b, k) => a + (b - a) * k;
  const tri = (x) => 4 * Math.abs(x - Math.floor(x + 0.5)) - 1;
  const env = (k, p) => Math.min(1, k * 40) * Math.pow(1 - k, p);

  const ctxClass = typeof AudioContext !== 'undefined' ? AudioContext : null;
  const buffers = new Map(), fallbacks = new Map(), pending = new Map();
  let ac = null, out = null, flushQueued = false;
  let settings = { muted: false, volume: 1 };
  let music = null, musicKey = null, wanted = null, ducked = false, unlocked = false;

  function load() {
    try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch { }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { }
  }

  function synth(name) {
    const [dur, fn] = SYNTH[name], n = Math.ceil(dur * SAMPLE_RATE);
    const buf = ac.createBuffer(1, n, SAMPLE_RATE), data = buf.getChannelData(0);
    let seed = 1234567, lp = 0;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      lp += ((seed / 2 ** 31 - 1) - lp) * 0.35;   // 거친 잡음을 낮은 쪽으로 눌러 부드럽게
      data[i] = fn(i / SAMPLE_RATE, i / n, lp * 2);
    }
    return buf;
  }

  /** 음원 파일을 버퍼로. file:// 처럼 fetch 가 막히면 HTMLAudioElement 로 재생한다 */
  async function loadFile(name, file) {
    try {
      const res = await fetch(`assets/audio/sfx/${file}.wav`);
      if (!res.ok) throw new Error(res.status);
      buffers.set(name, await ac.decodeAudioData(await res.arrayBuffer()));
    } catch {
      const a = new Audio(`assets/audio/sfx/${file}.wav`);
      a.preload = 'auto';
      fallbacks.set(name, a);
    }
  }

  function initAudio() {
    if (ac || !ctxClass) return;
    ac = new ctxClass();
    // 소리가 많이 겹쳐도 깨지지 않게 마지막에 압축기를 둔다
    out = ac.createDynamicsCompressor();
    out.threshold.value = -12; out.ratio.value = 8;
    out.connect(ac.destination);
    for (const [name, [src]] of Object.entries(SFX)) {
      if (src[0] === '~') buffers.set(name, synth(src.slice(1)));
      else void loadFile(name, src);
    }
  }

  /** 효과음 한 번. 이번 프레임의 같은 소리와 합쳐 프레임 끝에 낸다 */
  function play(name) {
    if (!unlocked || settings.muted || !SFX[name]) return;
    pending.set(name, (pending.get(name) || 0) + 1);
    if (!flushQueued) { flushQueued = true; queueMicrotask(flush); }
  }

  function flush() {
    flushQueued = false;
    for (const [name, count] of pending) {
      // 같은 순간 n 개가 겹치면 그만큼 커지되, 수천 개여도 귀가 아프지 않게 로그로 키운다
      const volume = Math.min(1, SFX[name][1] * settings.volume * (1 + Math.log2(count) * 0.35));
      const buf = buffers.get(name);
      if (buf && ac) {
        const src = ac.createBufferSource(), gain = ac.createGain();
        src.buffer = buf; gain.gain.value = volume;
        src.connect(gain).connect(out);
        src.start();
      } else if (fallbacks.has(name)) {
        const a = fallbacks.get(name).cloneNode();
        a.volume = volume;
        a.play().catch(() => { });
      }
    }
    pending.clear();
  }

  function syncMusic() {
    const key = unlocked && !settings.muted && BGM[wanted] ? wanted : null;
    if (key !== musicKey) {
      music?.pause();
      music = null; musicKey = key;
      if (key) {
        music = new Audio(`assets/audio/bgm/${BGM[key]}`);
        music.loop = key !== 'ending';
        music.play().catch(() => { });
      }
    }
    if (music) music.volume = BGM_VOLUME * settings.volume * (ducked ? 0.35 : 1);
  }

  function setMusic(key) { wanted = key; syncMusic(); }

  function toggleMute() {
    settings.muted = !settings.muted;
    save();
    syncMusic();
    return settings.muted;
  }

  /** 브라우저 자동 재생 제한: 첫 입력 뒤부터 소리를 낸다 */
  function unlock() {
    initAudio();
    if (ac?.state === 'suspended') void ac.resume();
    if (unlocked) return;
    unlocked = true;
    syncMusic();
  }

  function wrap(obj, name, after) {
    const fn = obj[name];
    if (typeof fn !== 'function') return;
    obj[name] = function (...args) {
      const before = after.before?.call(this, ...args);
      const result = fn.apply(this, args);
      try { after.call(this, args, before, result); } catch { }
      return result;
    };
  }
  const hook = (obj, name, before, after) => { after.before = before; wrap(obj, name, after); };

  function attach(g) {
    load();
    for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, unlock, { capture: true });
    document.addEventListener('click', (e) => { if (e.target.closest?.('button, .card, [data-act]')) play('click'); }, true);

    const friendly = (o) => entityTeam(o) !== 'hostile';
    hook(g, 'start', null, () => { ducked = false; setMusic(`stage${g.stageStep}`); });
    hook(g, 'enterStage', null, (args) => { if (args[0] > 0) setMusic(`stage${args[0]}`); });
    hook(g, 'toTitle', null, () => { ducked = false; setMusic('title'); });
    hook(g, 'pause', () => g.state, (args, state) => { if (state === 'playing') { play('pauseIn'); ducked = true; syncMusic(); } });
    hook(g, 'resume', null, () => { play('pauseOut'); ducked = false; syncMusic(); });
    hook(g, 'endRun', null, (args) => {
      if (args[0]) { play('victory'); setMusic('ending'); }
      else { play('gameover'); setMusic(null); }
    });
    hook(g, 'step', () => g.clearT, (args, clearT) => { if (clearT === null && g.clearT !== null && g.state === 'playing') play('clear'); });
    hook(g, 'updateSpawns', () => [g.spawnedBosses.size, g.nextSwarmAt], (args, [bosses, swarm]) => {
      if (g.spawnedBosses.size > bosses) play('boss');
      else if (g.nextSwarmAt !== swarm) play('swarm');
    });

    hook(g, 'spawnProjectile', null, (args, _, pr) => { if (pr && friendly(pr)) play('shoot'); });
    hook(g, 'slash', null, () => play('slash'));
    hook(g, 'laser', null, () => play('beam'));
    hook(g, 'blast', null, () => play('explode'));
    hook(g, 'damageEnemy', null, () => play('hit'));
    hook(g, 'killEnemy', (e) => e.dead, (args, wasDead) => { if (!wasDead) play(args[0].boss ? 'bigExplode' : 'kill'); });
    hook(g, 'onLevelUp', null, () => play('levelup'));
    hook(g, 'claimReward', null, () => play('pick'));

    hook(Player.prototype, 'takeDamage', function () { return this.hp; }, function (args, hp) { if (this.hp < hp && !this.dead) play('hurt'); });
    hook(Pickup.prototype, 'collect', function () { return this.collectionDone; }, function (args, done) {
      if (done) return;
      play({ chest: 'chest', magnet: 'magnet' }[this.kind] || 'gem');
    });

    setMusic(g.state === 'title' ? 'title' : null);
  }

  return { attach, play, setMusic, toggleMute, get muted() { return settings.muted; } };
})();
