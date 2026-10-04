const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const sources = ['util', 'cards', 'entities', 'game'].map(file => fs.readFileSync(path.join(root, 'js', file + '.js'), 'utf8')).join('\n');
const context = new Function('console', 'TD', 'Input', 'Math', sources + `
let rngState = 1;
Math.random = () => { rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0; return rngState / 4294967296; };
const actions = Object.keys(CARDS).filter(k => CARDS[k].type === 'action');
const targets = Object.keys(CARDS).filter(k => CARDS[k].type === 'target');
function setup(seed, scenario, cards) {
  rngState = seed;
  const g = Object.create(Game.prototype);
  Object.assign(g, { player: new Player(0,0), enemies: [], projectiles: [], hazards: [], allies: [], objects: [], zones: [], pickups: [], fallen: [], fx: [], particles: [], texts: [], events: new EventBus(), hash: new SpatialHash(64), _near: [], time: 0, kills: 0, state: 'playing', stage:{dmgMul:1}, w: 1280, h: 720, cam: {x:0,y:0}, shakeMag:0, pendingLevelUps:0 });
  for (const k of ['addText','burst','circleFx','addFx','markTargets','shake','showBanner','onLevelUp']) g[k] = () => {};
  g.endRun = () => { g.player.hp = 100; };
  const p = g.player;
  p.hp = 50;
  p.deck.timer = 0;
  p.deck.slots = [{ limit:15, cards, cd:0, cast:null }];
  const n = scenario.n;
  const type = scenario.type || 'brute';
  for (let i=0;i<n;i++) {
    const a = scenario.spread ? i * TAU/n : rand(-0.3,0.3);
    const d = scenario.spread ? 250 : rand(145,175);
    const e = new Enemy(type, Math.cos(a)*d, Math.sin(a)*d, 1);
    if (scenario.wounded) e.hp = e.maxHp * 0.25;
    g.enemies.push(e);
  }
  p.deck.lastEnemy = g.enemies[0];
  for (let i=0;i<Math.min(n,6);i++) {
    const x=160+i*12, y=10;
    if(cards.includes('objects')||cards.includes('all'))g.objects.push(new Placed(['orb','mine','turret','decoy','barrel'][i%5],x,y,1));
    if(cards.includes('allies')||cards.includes('all'))g.allies.push(new Ally(i%2 ? 'archer':'knight',x,y));
    if(cards.includes('zones')||cards.includes('all'))g.zones.push({kind:'poison', x,y,r:60,life:4,max:4,tick:0,dead:false,rallyT:0});
    if(cards.includes('shots')||cards.includes('all'))g.projectiles.push(new Projectile({x,y,vx:100,vy:0,damage:10,life:1.5}));
    if(cards.includes('gems')||cards.includes('all'))g.pickups.push(new Pickup('gem',x,y,2));
    if(cards.includes('pickups')||cards.includes('all'))g.pickups.push(new Pickup(['heart','magnet','chest'][i%3],x,y));
    g.fallen.push({x,y,t:0});
  }
  g.rebuildHash();
  return g;
}
function run(seed, scenario, cards, seconds, tunings=null) {
  const originalDelays={};
  if(tunings)for(const [id,t] of Object.entries(tunings)){originalDelays[id]=CARDS[id].delay;CARDS[id].delay=t.delay;}
  const g = setup(seed, scenario, cards), p = g.player;
  const m = {damage:0, healing:0, selfDamage:0, controlled:0, casts:0, applications:0, cooldown:0, xp:0, maxEntities:0, firstDamage:null};
  const damage = g.damageEnemy;
  g.damageEnemy = function(e,...args) { const hp=e.hp; damage.call(this,e,...args); const v=Math.max(0,hp-Math.max(0,e.hp)); m.damage+=v; if(v && m.firstDamage===null)m.firstDamage=g.time; };
  const kill = g.killEnemy;
  g.killEnemy = function(e) { if(!e.dead) { m.damage+=Math.max(0,e.hp); if(m.firstDamage===null)m.firstDamage=g.time; } kill.call(this,e); };
  const heal = g.healTarget;
  g.healTarget = function(o,n) {const hp=o.hp; heal.call(this,o,n); if(o!==p&&Number.isFinite(hp))m.healing+=Math.max(0,o.hp-hp);};
  const playerHeal = p.heal.bind(p);
  p.heal = n => {const hp=p.hp;playerHeal(n);m.healing+=Math.max(0,p.hp-hp);};
  const gain = p.gainXp.bind(p);
  p.gainXp = (n,game) => {m.xp+=n*p.stats.xpGain;gain(n,game);};
  const end = p.deck.endCast.bind(p.deck);
  if(tunings){
    const step=p.deck.runStep.bind(p.deck);
    p.deck.runStep=(s,ctx,env)=>{const before=ctx.extraCooldown;const wait=step(s,ctx,env);const t=tunings[s.act];if(t&&wait){const units=(ctx.extraCooldown-before)/s.delay;ctx.extraCooldown=before+units*t.per;}return wait;};
  }
  p.deck.endCast = slot => {m.casts++;m.applications+=slot.cast.ctx.fired;const fired=slot.cast.ctx.fired;end(slot);if(tunings&&fired){const base=slot.cards.reduce((sum,id)=>sum+(CARDS[id].type==='action'?(tunings[id]?.cd??CARDS[id].cost*0.35):CARDS[id].cost*0.35),0);slot.cd=slot.cdMax=Math.max(0.6,base)+(slot.extraCooldown||0);}m.cooldown+=slot.cdMax;};
  // Fixed target pressure: killed enemies are replenished; living enemies retain HP/status.
  // Enemy AI and contact attacks are excluded to isolate card output and target-count costs.
  const dt=1/30;
  for(let f=0;f<seconds*30;f++) {
    g.time+=dt;
    for(let i=0;i<g.enemies.length;i++) if(g.enemies[i].dead) {
      const old=g.enemies[i], e=new Enemy(scenario.type||'brute',old.x,old.y,1);
      if(scenario.wounded)e.hp=e.maxHp*0.25;
      g.enemies[i]=e;
    }
    g.rebuildHash();
    g.updateTargetBuffs(dt);
    p.update(dt,g);
    for(const e of g.enemies) { if(e.directFrozen || e.directMove===0 || e.freezeT>0 || e.rootT>0 || e.fearT>0)m.controlled+=dt; }
    for(const a of g.allies)if(!a.dead)a.update(dt,g);
    for(const o of g.objects)if(!o.dead)o.update(dt,g);
    g.updateZones(dt);g.updateStatuses(dt);
    for(const pr of g.projectiles)if(!pr.dead)pr.update(dt,g);
    g.collideProjectiles();g.resolveProjectileEnds();g.updateHazards(dt);
    for(const pk of g.pickups)if(!pk.dead)pk.update(dt,g);
    for(const list of [g.projectiles,g.hazards,g.allies,g.objects,g.zones,g.pickups])compact(list);
    m.maxEntities=Math.max(m.maxEntities,g.allies.length+g.objects.length+g.zones.length+g.projectiles.length+g.pickups.length);
    if(p.hp<50){m.selfDamage+=50-p.hp;p.hp=50;}
    if(g.enemies.length>400 || m.maxEntities>2000)throw new Error('entity safety bound');
  }
  const result={...m,kills:g.kills,dps:m.damage/seconds,controlFraction:scenario.n?m.controlled/(seconds*scenario.n):0,meanCooldown:m.casts?m.cooldown/m.casts:0,remainingGemValue:g.pickups.filter(x=>x.kind==='gem').reduce((s,x)=>s+x.value,0),remainingLifetime:[...g.objects,...g.allies,...g.zones,...g.projectiles].reduce((s,x)=>s+(x.life||0),0)};
  if(tunings)for(const [id,delay] of Object.entries(originalDelays))CARDS[id].delay=delay;
  return result;
}
const catalog={actions:actions.map(id=>({id,name:CARDS[id].name,cost:CARDS[id].cost,delay:cardDelay(id)})),targets:targets.map(id=>({id,name:CARDS[id].name,cost:CARDS[id].cost}))};
const compatibility=[];
for(const t of targets)for(const a of actions){const g=setup(1,{n:8,wounded:true,type:'chestling'},[t,a]);const env=g.cardEnv();const selected=CARDS[t].resolve(env,{deck:g.player.deck});compatibility.push({target:t,action:a,selected:selected.length,applicable:selected.filter(x=>actionApplies(CARDS[a],x,env)).length,cost:cardsCost([t,a])});}
function arena(seed, tier, slots, tunings=null) {
  const saved={};
  if(tunings)for(const [id,t]of Object.entries(tunings)){saved[id]=CARDS[id].delay;CARDS[id].delay=t.delay;}
  const g=setup(seed,{n:0},[]),p=g.player;
  p.hp=100;
  p.deck.slots=slots.map(cards=>({limit:tier.budget,cards,cd:0,cast:null}));
  if(p.deck.slots.some(s=>!SkillDeck.runnable(s)))throw new Error('arena over budget');
  g.enemies=[];g.objects=[];g.allies=[];g.pickups=[];g.zones=[];g.projectiles=[];
  g.endRun=()=>{g.state='gameover';};
  g.openLevelUp=()=>{};
  g.updateBarrels=()=>{};
  let nextWave=0,damage=0,incoming=0,xp=0;
  g.updateSpawns=()=>{if(g.time>=nextWave){nextWave+=3;for(let i=0;i<tier.wave;i++){if(g.enemies.length>=400)break;const a=rand(0,TAU),d=rand(320,400);g.spawnEnemy(tier.types[i%tier.types.length],{x:p.x+Math.cos(a)*d,y:p.y+Math.sin(a)*d});}}};
  const oldDamage=g.damageEnemy;
  g.damageEnemy=function(e,...args){const hp=e.hp;oldDamage.call(this,e,...args);damage+=Math.max(0,hp-Math.max(0,e.hp));};
  const oldTake=p.takeDamage.bind(p);
  p.takeDamage=(n,game)=>{const hp=p.hp;oldTake(n,game);incoming+=Math.max(0,hp-p.hp);};
  p.gainXp=n=>{xp+=n*p.stats.xpGain;};
  if(tunings){const oldStep=p.deck.runStep.bind(p.deck);p.deck.runStep=(s,ctx,env)=>{const before=ctx.extraCooldown;const wait=oldStep(s,ctx,env);if(tunings[s.act]&&wait)ctx.extraCooldown=before+(ctx.extraCooldown-before)/s.delay*tunings[s.act].per;return wait;};const oldEnd=p.deck.endCast.bind(p.deck);p.deck.endCast=s=>{const fired=s.cast.ctx.fired;oldEnd(s);if(fired)s.cd=s.cdMax=Math.max(0.6,s.cards.reduce((sum,id)=>sum+(CARDS[id].type==='action'?(tunings[id]?.cd??CARDS[id].cost*0.35):CARDS[id].cost*0.35),0))+(s.extraCooldown||0);};}
  // Same deterministic movement policy in every build: continuous circular strafing.
  Input.axis=()=>({x:Math.cos(g.time*0.25),y:Math.sin(g.time*0.25)});
  while(g.time<180&&g.state==='playing')g.step(1/30);
  Input.axis=()=>({x:0,y:0});
  if(tunings)for(const [id,d]of Object.entries(saved))CARDS[id].delay=d;
  return {survival:g.time,kills:g.kills,damage,incoming,xp,hp:p.hp,survived:g.state==='playing'?1:0};
}
return {catalog, compatibility, simulate:run, cost:cardsCost, arena};
`)(console, new Proxy({}, { get: () => 0 }), { axis: () => ({x:0,y:0}) }, Object.create(Math));
const seeds = Number(process.env.BALANCE_SEEDS || 3);
const seconds = Number(process.env.BALANCE_SECONDS || 60);
const scenarios = [
  {id:'single',n:1}, {id:'dense3',n:3}, {id:'dense8',n:8}, {id:'dense20',n:20},
  {id:'spread8',n:8,spread:true}, {id:'boss',n:1,type:'overlord'}, {id:'wounded8',n:8,wounded:true}, {id:'empty',n:0},
];
const candidatePhase=process.env.BALANCE_PHASE==='candidates';
const fullPipeline=process.env.BALANCE_PHASE==='all';
const selectedActions=process.env.BALANCE_ACTIONS?.split(',');
const arenaPhase=process.env.BALANCE_PHASE==='arena';
const previous=candidatePhase||arenaPhase?JSON.parse(fs.readFileSync(path.join(root,'reports','balance-simulation.json'),'utf8')):null;
const rows=previous?previous.rows.filter(x=>arenaPhase||!x.variant||(selectedActions&&!selectedActions.includes(x.cards[1]))):[], errors=previous?previous.errors:[];
for(const row of rows)row.cost=context.cost(row.cards);
const cases = context.compatibility.filter(x=>x.applicable>0);
const aggregate = (cards,scenario,duration=seconds,sampleCount=seeds,tunings=null) => {
  const samples=[];
  for(let seed=1;seed<=sampleCount;seed++)samples.push(context.simulate(seed,scenario,cards,duration,tunings));
  const out={cards,scenario:scenario.id,seconds:duration,seeds:sampleCount,cost:context.cost(cards)};
  for(const k of Object.keys(samples[0])){const values=samples.map(x=>x[k]).filter(x=>x!==null);out[k]=values.length?values.reduce((a,b)=>a+b,0)/values.length:null;}
  out.dpsMin=Math.min(...samples.map(x=>x.dps));out.dpsMax=Math.max(...samples.map(x=>x.dps));
  return out;
};
if(!candidatePhase&&!arenaPhase)for (const scenario of scenarios) {
  rows.push({...aggregate([],scenario),baseline:true});
  for(const t of context.catalog.targets)rows.push({...aggregate([t.id],scenario),baseline:true});
  for(const c of cases)try{rows.push(aggregate([c.target,c.action],scenario));}catch(e){errors.push({cards:[c.target,c.action],scenario:scenario.id,error:e.stack}); if(errors.length<10)console.log(e.message);}
  console.log(scenario.id+': '+rows.length+' rows, '+errors.length+' errors');
}
if(!candidatePhase&&!arenaPhase&&!process.env.BALANCE_SECONDS)for(const scenario of scenarios.filter(s=>['single','dense8','boss'].includes(s.id))) {
 for(const a of context.catalog.actions) {
  const target=cases.find(c=>c.action===a.id&&c.target==='enemies')?.target||cases.find(c=>c.action===a.id&&c.target==='self')?.target||cases.find(c=>c.action===a.id)?.target;
  if(target)try{rows.push({...aggregate([target,a.id],scenario,60,30),focused:true});}catch(e){errors.push({cards:[target,a.id],scenario:scenario.id,error:e.stack});}
 }
 console.log('30-seed '+scenario.id+': '+rows.length+' rows');
}
const combos = [
 ['enemies','ifMarked','snipe'], ['enemies','frost','ifStopped','root'],
 ['ahead','turret','objects','rage'], ['ahead','turret','objects','focus'],
 ['ahead','turret','objects','refresh'], ['ahead','turret','objects','prolong'],
 ['gems','split'], ['gems','rage','absorb'], ['nearestEnemy','mark','snipe'],
];
for(const a of context.catalog.actions)for(const flow of ['ifLowHp','ifNear','ifEnemyNear','ifSingle']){
 const t=cases.find(c=>c.action===a.id&&c.target==='nearestEnemy')?.target || cases.find(c=>c.action===a.id)?.target;
 if(t)combos.push([t,flow,a.id]);
}
if(!candidatePhase&&!arenaPhase)for(const scenario of scenarios.filter(s=>['single','dense8','boss','wounded8'].includes(s.id))) {
 for(const cards of combos)try{rows.push(aggregate(cards,scenario,process.env.BALANCE_SECONDS?seconds:cards.some(x=>['split','refresh','prolong'].includes(x))?180:seconds));}catch(e){errors.push({cards,scenario:scenario.id,error:e.stack});}
 console.log('combos '+scenario.id+': '+rows.length+' rows, '+errors.length+' errors');
}
if(candidatePhase||fullPipeline){
 const tunings=JSON.parse(fs.readFileSync(path.join(root,'reports','balance-proposals.json'),'utf8')).proposals;
 for(const scenario of scenarios.filter(s=>['single','dense8','boss'].includes(s.id))){
  for(const a of Object.keys(tunings).filter(x=>!selectedActions||selectedActions.includes(x))){
   const targets=['prolong','refresh'].includes(a)?['objects']:['nearestEnemy','enemies'];
   for(const t of targets)for(const variant of ['control','candidate'])try{rows.push({...aggregate([t,a],scenario,60,30,variant==='candidate'?tunings:null),variant});}catch(e){errors.push({cards:[t,a],scenario:scenario.id,variant,error:e.stack});}
  }
  console.log('candidates '+scenario.id+': '+rows.length+' rows, '+errors.length+' errors');
 }
}
let arenas=previous?.arenas||[];
if(arenaPhase||fullPipeline){
 arenas=[];
 const tunings=JSON.parse(fs.readFileSync(path.join(root,'reports','balance-proposals.json'),'utf8')).proposals;
 Object.assign(tunings,{orb:{delay:0.2,cd:1.4,per:0.6},mine:{delay:0.2,cd:1.4,per:0.6}});
 const tiers=[{id:'early',budget:4,wave:3,types:['grunt','runner'],slots:[['nearestEnemy','bolt'],['ahead','orb']]},{id:'middle',budget:8,wave:5,types:['imp','mimic','darkKnight'],slots:[['nearestEnemy','snipe'],['enemies','bolt']]},{id:'late',budget:15,wave:8,types:['brute','pyro','darkKnight'],slots:[['enemies','ifMany','scatter'],['self','shield','regen','heal'],['ahead','turret','objects','refresh']]}];
 for(const tier of tiers)for(const variant of ['control','candidate']){const samples=[];for(let seed=1;seed<=30;seed++)try{samples.push(context.arena(seed,tier,tier.slots,variant==='candidate'?tunings:null));}catch(e){errors.push({arena:tier.id,variant,error:e.stack});break;}if(samples.length){const row={tier:tier.id,budget:tier.budget,slots:tier.slots,variant,seeds:samples.length};for(const k of Object.keys(samples[0]))row[k]=samples.reduce((sum,x)=>sum+x[k],0)/samples.length;arenas.push(row);console.log('arena '+tier.id+' '+variant+': '+JSON.stringify(row));}}
}
const result={generatedAt:new Date().toISOString(),seeds:previous?.seeds??seeds,seconds:previous?.seconds??seconds,dt:1/30,scenarios,catalog:context.catalog,compatibility:context.compatibility,rows,arenas,errors};
fs.mkdirSync(path.join(root,'reports'),{recursive:true});
fs.writeFileSync(path.join(root,'reports','balance-simulation.json'),JSON.stringify(result,null,2));
const cols=['cards','scenario','variant','cost','seconds','seeds','dps','dpsMin','dpsMax','kills','controlFraction','healing','selfDamage','xp','casts','applications','meanCooldown','firstDamage','maxEntities'];
fs.writeFileSync(path.join(root,'reports','balance-simulation.csv'),cols.join(',')+'\n'+rows.map(r=>cols.map(k=>Array.isArray(r[k])?r[k].join(' > '):r[k]??'').join(',')).join('\n'));
console.log('Saved reports; rows='+rows.length+', errors='+errors.length);
if(errors.length)process.exitCode=1;
