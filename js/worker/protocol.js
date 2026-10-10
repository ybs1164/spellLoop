'use strict';

// 시뮬레이션 워커와 메인 스레드 브리지가 같이 쓰는 스냅샷 형식.
// 적은 필드 ENEMY_STRIDE 개씩 Float32Array 에 담아 보낸다 (순서는 sim-worker.js 의 적 직렬화와 sim-bridge.js 의 apply 가 같아야 한다).
const ENEMY_STRIDE = 20;
