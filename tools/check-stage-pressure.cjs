const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ctx = vm.createContext({ console, assert, TD: new Proxy({}, {get:()=>0}) });
for(const name of ['util','input','cards','entities','stages','icons','ui','game'])
  vm.runInContext(fs.readFileSync(`js/${name}.js`,'utf8'),ctx);
vm.runInContext(`
UI.hideOverlay=UI.showHud=()=>{};
const g=Object.create(Game.prototype);
Object.assign(g,{events:new EventBus(),hash:new SpatialHash(64),_near:[],w:1000,h:800,clock:0});
g.start([0,3,6]);
for(const stage of STAGES){
  g.stage=stage;g.stageStart=0;g.time=180;g.nextSwarmAt=Infinity;
  g.spawnedBosses=new Set(stage.bosses.map((_,i)=>i));g.bossSpawned=false;g.spawnAcc=0;
  let spawned=0;
  g.spawnEnemy=()=>{spawned++;};
  g.spawnPack=(_,n)=>{spawned+=n;};
  let rng=1;Math.random=()=>((rng=(Math.imul(rng,1664525)+1013904223)>>>0)/4294967296);
  for(let i=0;i<6000;i++)g.updateSpawns(0.01);
  const expected=(stage.rate[0]+(stage.rate[1]-stage.rate[0])*0.6)*60;
  assert.ok(Math.abs(spawned-expected)/expected<0.18,stage.id+' individual spawn budget');
  const normal=spawned;spawned=0;g.spawnAcc=0;g.bossSpawned=true;rng=1;
  for(let i=0;i<6000;i++)g.updateSpawns(0.01);
  assert.ok(spawned<normal*0.8 && spawned>normal*0.5,stage.id+' boss pressure reduction');
}
g.start([0,3,6]);
g.projectiles=[{team:'friendly'},{team:'hostile'}];
g.zones=[{team:'friendly'},{team:'hostile'}];
g.enemies=[{team:'hostile'}];g.hazards=[{}];g.spawnAcc=0.9;
const hp=g.player.hp,deck=g.player.deck,objects=g.objects;
g.enterStage(1);
assert.equal(g.enemies.length,0);assert.equal(g.hazards.length,0);
assert.deepEqual(g.projectiles,[{team:'friendly'}]);assert.deepEqual(g.zones,[{team:'friendly'}]);
assert.equal(g.spawnAcc,0);assert.equal(g.player.hp,hp);assert.equal(g.player.deck,deck);assert.equal(g.objects,objects);
console.log('All 8 stages: individual spawn budgets, boss pressure and stage transition passed.');
`,ctx);
