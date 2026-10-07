// Runs the real combat loop with legal rewards, deck edits and steering inputs.
const fs = require('node:fs');
const results = [];
const sources = ['util', 'input', 'cards', 'entities', 'stages', 'upgrades', 'icons', 'ui', 'game'].map(name => fs.readFileSync(`js/${name}.js`, 'utf8')).join('\n')
  .replace('const SLOT_HEAT_UNIT = 1;', 'const SLOT_HEAT_UNIT = ' + (process.env.PLAY_HEAT_UNIT || 1) + ';');
new Function('console', 'TD', 'results', 'Math', sources + `
UI.hideOverlay = UI.showHud = UI.showEnd = () => {};
const testStage = ${process.env.PLAY_STAGE === undefined ? 'undefined' : Number(process.env.PLAY_STAGE)};
const checkpoint = ${process.env.PLAY_CHECKPOINT ? fs.readFileSync(process.env.PLAY_CHECKPOINT,'utf8') : 'null'};
let rng = 1;
Math.random = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296);
const preferred = ['frost', 'poison', 'chain', 'snipe', 'burn', 'explode', 'shield', 'heal', 'mark', 'bolt'];
function edit(g) {
  const d = g.player.deck;
  for (const id of d.inventory.slice()) {
    if (!preferred.includes(id)) continue;
    const target = ['heal', 'shield'].includes(id) ? 'self' : 'nearestEnemy';
    let s = d.slots.find(s => s.cards[0] === target);
    if (s && s.cards.length >= 4) {
      const worst = s.cards.slice(1).sort((a,b)=>preferred.indexOf(b)-preferred.indexOf(a))[0];
      if(preferred.indexOf(id)>=preferred.indexOf(worst))continue;
      d.move({src:'slot',slot:d.slots.indexOf(s),idx:s.cards.indexOf(worst)}, {dest:'inv'});
    }
    if (!s && d.inventory.includes(target) && d.expandSlot()) {
      s = d.slots.at(-1);
      d.move({src:'inv', idx:d.inventory.indexOf(target)}, {dest:'slot',slot:d.slots.indexOf(s)});
    }
    if (!s) continue;
    while (cardsCost([...s.cards,id]) > s.limit && d.costPoints > 0) {
      if (!d.raiseLimit(d.slots.indexOf(s))) break;
    }
    if (cardsCost([...s.cards,id]) <= s.limit)
      d.move({src:'inv',idx:d.inventory.indexOf(id)}, {dest:'slot',slot:d.slots.indexOf(s)});
  }
}
function steer(g) {
  const p = g.player;
  const loot = g.pickups.filter(o => !o.dead).sort((a,b) => dist2(p.x,p.y,a.x,a.y)-dist2(p.x,p.y,b.x,b.y))[0];
  const boss = g.enemies.find(e => e.boss && !e.dead);
  const goal = boss || loot;
  let best = -Infinity, axis = {x:0,y:0};
  for (let i=0;i<16;i++) {
    const a=i*TAU/16, x=Math.cos(a), y=Math.sin(a);
    const nx=p.x+x*65, ny=p.y+y*65;
    let score = goal ? -Math.hypot(nx-goal.x,ny-goal.y)*0.08 : 0;
    for (const e of g.enemies) {
      const distance=Math.hypot(nx-e.x,ny-e.y)-e.radius;
      if(distance<65) score-= (65-distance)*(e.boss ? 2 : 1);
    }
    for (const h of g.hazards) if (!h.dead && dist2(nx,ny,h.x,h.y)<75*75) score-=80;
    score += x*p.facing.x+y*p.facing.y;
    if(score>best){best=score;axis={x,y};}
  }
  return axis;
}
for(let seed=1;seed<=Number(${JSON.stringify(process.env.PLAY_SEEDS || '3')});seed++) {
  rng=seed;
  const g=Object.create(Game.prototype);
  Object.assign(g,{events:new EventBus(),hash:new SpatialHash(64),_near:[],w:1000,h:800,clock:0});
  const route = testStage === undefined ? (seed%3===1 ? [0,3,6] : seed%3===2 ? [1,4,7] : [2,5,7]) : [testStage];
  g.start(route);
  for(const method of ['addText','burst','circleFx','addFx','shake','showBanner','markTargets'])g[method]=()=>{};
  if(checkpoint){
    const row=checkpoint[0];
    const level=row.stages.at(-1).level;
    // Older reports retain the earned cards; reconstruct a legal minimum budget.
    const slots=row.deck.map(cards=>({cards,limit:Math.max(START_SLOT_LIMIT,cardsCost(cards))}));
    const spent=slots.reduce((n,s)=>n+s.limit-START_SLOT_LIMIT,0);
    const saved=row.checkpoint || {level,xp:0,xpNext:xpForLevel(level),slots,inventory:[],costPoints:5+level-1-spent};
    if(saved.costPoints<0 || saved.slots.some(s=>!SkillDeck.runnable(s)))throw new Error('Illegal checkpoint budget');
    Object.assign(g.player,{level:saved.level,xp:saved.xp,xpNext:saved.xpNext});
    Object.assign(g.player.deck,{slots:saved.slots.map(s=>({...s,cd:0,cast:null})),inventory:saved.inventory.slice(),costPoints:saved.costPoints});
  }
  g.openLevelUp=()=>{
    while(g.pendingLevelUps>0){
      const offers=rollRewards(g.player,REWARD_CHOICES);
      const id=offers.slice().sort((a,b)=>(preferred.indexOf(a)<0?99:preferred.indexOf(a))-(preferred.indexOf(b)<0?99:preferred.indexOf(b)))[0];
      applyReward(g.player,id,g);g.pendingLevelUps--;edit(g);
    }
  };
  let axis={x:0,y:0}, peak=0, ticks=0, nextLog=60;
  Input.axis=()=>axis;
  const stages=[];
  const enter=g.enterStage;
  g.enterStage=function(step,...args){stages.push({stage:this.stage.id,seconds:Math.round(this.stageTime()),hp:Math.round(this.player.hp),level:this.player.level});enter.call(this,step,...args);};
  while(g.state==='playing' && g.time<${Number(process.env.PLAY_SECONDS || 1100)}){
    if(ticks++%6===0)axis=steer(g);
    g.step(0.05);peak=Math.max(peak,g.enemies.length);
    if(g.time>=nextLog){console.log('seed '+seed+' stage '+g.stage.id+' time '+Math.round(g.time)+' hp '+Math.round(g.player.hp)+' level '+g.player.level);nextLog+=60;}
  }
  stages.push({stage:g.stage.id,seconds:Math.round(g.stageTime()),hp:Math.round(g.player.hp),level:g.player.level});
  const d=g.player.deck;
  const row={seed,route:route.map(i=>STAGES[i].id),state:g.state,seconds:Math.round(g.time),kills:g.kills,peak,stages,deck:d.slots.map(s=>s.cards),checkpoint:{level:g.player.level,xp:g.player.xp,xpNext:g.player.xpNext,slots:d.slots.map(s=>({limit:s.limit,cards:s.cards})),inventory:d.inventory,costPoints:d.costPoints}};
  results.push(row); console.log(JSON.stringify(row));
}
`)(console, new Proxy({}, {get:()=>0}), results, Object.create(Math));
fs.writeFileSync(process.env.PLAY_REPORT || 'reports/stage-playthrough.json', JSON.stringify(results, null, 2)+'\n');
