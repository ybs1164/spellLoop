#include "world.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
static unsigned long long digest=1469598103934665603ull;
static void hash(const void *ptr,size_t n){const unsigned char *p=ptr;while(n--){digest^=*p++;digest*=1099511628211ull;}}
#define H(v) hash(&(v),sizeof(v))
int main(int argc,char **argv){
  int seed=argc>1?atoi(argv[1]):1,mode=argc>2?atoi(argv[2]):0,ticks=argc>3?atoi(argv[3]):2400;
  char err[256];if(!data_init(err,sizeof err))return 2;cards_impl_init();World*w=world_create(seed);game_new(w);
  int p=ent_index(w,w->player); SimInput in={{0,0}};
  if(mode==1){
    const char *defs[][9]={{"nearestEnemy","frost","chain","poison"},{"ahead","decoy","turret"},{"randomPoint","archer","mine"},{"self","heal","shield"}};
    for(int k=1;k<6;k++){Slot*s=slot_of(w,w->player,k);if(!s)break;s->n=0;for(int j=0;k<=4&&j<9&&defs[k-1][j];j++)s->cards[s->n++]=card_find(defs[k-1][j]);}
  }
  if(mode==2){
    w->spawn_acc=-1e9f;w->barrel_cd=1e9f;w->next_swarm=1e9f;
    Ctx c={.w=w,.actor=p,.owner=p,.rule=RULE_NONE};
    for(int i=0;i<400;i++){float x=(i%20-10)*42,y=(i/20-10)*32;int e=ent_index(w,spawn_enemy(w,i%2?ENEMY_GRUNT:ENEMY_RUNNER,x,y));w->hp[e]=w->stat[e][STAT_MAX_HP]=1e9f;}
    for(int i=0;i<200;i++)spawn_shot(&c,i%20*32-320,i/20*32-160,120,30,5,1,0,100,1000,0x8BE9FFFFu,SHAPE_DOT);
    for(int i=0;i<5;i++){spawn_placed(&c,OBJ_DECOY,(Vec2){100+i*30,150},NULL);spawn_ally(&c,ALLY_KIND_KNIGHT,(Vec2){-100-i*30,-150});}
  }
  if(mode==3) {
    w->spawn_acc=-1e9f;w->barrel_cd=1e9f;w->next_swarm=1e9f;
    for(int i=0;i<3000;i++){
      int e=ent_index(w,spawn_enemy(w,i%3==0?ENEMY_GRUNT:i%3==1?ENEMY_RUNNER:ENEMY_BRUTE,(i%75-37)*13,(i/75-20)*15));
      w->hp[e]=w->stat[e][STAT_MAX_HP]=1e9f;
    }
  }
  if(mode>=4) {
    w->spawn_acc=-1e9f;w->barrel_cd=1e9f;w->next_swarm=1e9f;
    Ctx c={.w=w,.actor=p,.owner=p,.rule=RULE_NONE};
    if(mode==4) {
      int first=w->hi;
      for(int k=0;k<16000;k++)ent_spawn(w,TK_POINT,TEAM_NEUTRAL,0,0,1);
      for(int i=first;i<w->hi;i++)ent_free(w,i);
    }
    for(int k=0;k<(mode==4?40:300);k++) {
      int e=ent_index(w,spawn_enemy(w,k%2?ENEMY_GRUNT:ENEMY_BRUTE,(k%25-12)*19,(k/25-6)*21));
      w->hp[e]=w->stat[e][STAT_MAX_HP]=1e6f;
      if(mode==6) {
        w->r[e]=6.75f+k%19;
        add_debuff(w,e,DB_MARK,0.2f+k%5,0,1);
        add_debuff(w,e,DB_BURN,0.1f+k%3,17,1);
        if(k%4==0)add_debuff(w,e,DB_FREEZE,0.7f,0,1);
        if(k%7==0)cast_buff(&c,CB_HASTE,&(Target){TK_ENEMY,0,ent_handle(w,e),w->x[e],w->y[e]});
      }
    }
    if(mode!=4)for(int k=0;k<300;k++)spawn_shot(&c,k%25*19-238,k/25*21-125,120,30,5,1,0,100,10,0x8BE9FFFFu,SHAPE_DOT);
    if(mode==7) {
      Handle temporary=ent_spawn(w,TK_POINT,TEAM_FRIENDLY,0,0,1);
      uint16_t idle[]={CARD_ENTITY_SELF,CARD_ENTITY_MOVE};
      for(int k=0;k<60000;k++)slot_add(w,temporary,idle,2);
      ent_free(w,ent_index(w,temporary));
    }
    if(mode==5 || mode==7)for(int k=0;k<12;k++) {
      int o=ent_index(w,spawn_placed(&c,OBJ_ORB,(Vec2){k*9-54,50},NULL));
      uint16_t watched[]={CARD_ARTIFACT_THORNS,CARD_SELF,CARD_HEAL};
      uint16_t complete[]={CARD_ARTIFACT_BELL,CARD_ENTITY_SELF,CARD_HEAL};
      slot_add(w,ent_handle(w,o),watched,3);slot_add(w,ent_handle(w,o),complete,3);
    }
  }
  bool timing=getenv("AMAGOS_REPLAY_TIMING")!=NULL;
  clock_t started=timing?clock():0;
  for(int t=0;t<ticks&&w->state==GS_PLAYING;t++){
    w->hp[p]=w->stat[p][STAT_MAX_HP];
    float a=(float)w->time*.6f;in.move=(Vec2){-sinf(a),cosf(a)};
    if((mode==5 || mode==7) && t%7==0)emit_event(w,w->player,EV_HURT,w->player,w->x[p],w->y[p],1);
    sim_step(w,&in);
  }
  if(timing)fprintf(stderr,"replay_cpu_ms=%.6f\n",1000.0*(double)(clock()-started)/CLOCKS_PER_SEC);
  if(argc>5) {
    FILE *file=fopen(argv[5],"rb");if(!file)return 3;
    fseek(file,0,SEEK_END);long len=ftell(file);rewind(file);
    if(len<=0){fclose(file);return 3;}
    uint8_t *bytes=malloc((size_t)len);bool read=fread(bytes,1,(size_t)len,file)==(size_t)len;fclose(file);
    World *loaded=world_create(1);bool ok=read&&save_read(loaded,bytes,(size_t)len);free(bytes);
    if(!ok){world_destroy(loaded);world_destroy(w);return 4;}
    world_destroy(w);w=loaded;
  }
  if(argc>4 && strcmp(argv[4],"-")) {
    size_t len=save_write(w,NULL,0);uint8_t *bytes=malloc(len);save_write(w,bytes,len);
    FILE *file=fopen(argv[4],"wb");if(!file){free(bytes);return 3;}
    bool ok=fwrite(bytes,1,len,file)==len;fclose(file);free(bytes);if(!ok)return 3;
  }
  H(w->hi);H(w->free_head);H(w->player);H(w->state);H(w->tick);H(w->time);H(w->kills);H(w->xp);H(w->level);H(w->rng);H(w->fx_rng);
  H(w->stage);H(w->route);H(w->stage_step);H(w->stage_start);H(w->boss_spawned);H(w->spawned_bosses);H(w->clear_t);
  H(w->spawn_acc);H(w->next_swarm);H(w->barrel_cd);H(w->enemy_count);H(w->pending_levelups);H(w->nrewards);H(w->ninv);H(w->inventory);H(w->nvars);
  H(w->reward_kinds);H(w->nreward_kinds);H(w->notice);H(w->xp_next);H(w->view_w);H(w->view_h);H(w->prey);H(w->last_enemy);H(w->nfallen);
  for(int k=0;k<ARRAY_LEN(w->fallen);k++){H(w->fallen[k].x);H(w->fallen[k].y);H(w->fallen[k].t);}
  H(w->might);H(w->area);H(w->duration);H(w->move_mul);H(w->armor);H(w->cooldown_mul);H(w->pbuff);H(w->shield_t);H(w->hurt_t);
  H(w->shake);H(w->banner);H(w->banner_life);H(w->banner_max);H(w->banner_text);H(w->banner_sub);H(w->banner_color);
  for(int k=0;k<MAX_REWARDS;k++){H(w->rewards[k].kind);H(w->rewards[k].n);H(w->rewards[k].level);H(w->rewards[k].choices);}
  for(int v=0;v<w->nvars;v++) {
    const Variant*x=&w->vars[v];H(x->base);H(x->cd_op);H(x->cd_value);H(x->nkv);
    for(int k=0;k<x->nkv;k++){H(x->kv[k].key);H(x->kv[k].num);H(x->kv[k].str);H(x->kv[k].is_str);}
  }
  H(w->nevents);
  for(int k=0;k<w->nevents;k++) {
    const Event*e=&w->events[k];H(e->kind);H(e->depth);H(e->owner);H(e->subject);H(e->x);H(e->y);H(e->damage);H(e->exclude);H(e->emitter);H(e->only_slot);
  }
#define FIELD(type,name) hash(w->name,sizeof(type)*(size_t)w->hi);
  ENTITY_FIELDS(FIELD)
#undef FIELD
  hash(w->stat,sizeof w->stat[0]*w->hi);hash(w->cbuff,sizeof w->cbuff[0]*w->hi);hash(w->marks,sizeof w->marks[0]*w->hi);hash(w->burns,sizeof w->burns[0]*w->hi);hash(w->hit_mem,sizeof w->hit_mem[0]*w->hi);
  H(w->slot_hi);H(w->slot_free);
  for(int i=0;i<w->hi;i++) {
#define EF(name) H(w->eff[i].name)
    EF(mask);EF(hit_rule);EF(aff_elem);EF(move_target.kind);EF(move_target.player_sel);EF(move_target.h);EF(move_target.x);EF(move_target.y);
    EF(move_speed);EF(keep);EF(hit_damage);EF(hit_knock);EF(decoy_range);EF(guard_reduction);EF(guard_front);EF(aff_mul);EF(resist_freeze);
    EF(fear_immune);EF(hit_pierce_set);EF(hit_pierce);EF(hit_repeat);EF(orbit_count);EF(orbit_speed);EF(orbit_r);
    EF(boom_accel);EF(boom_max);EF(boom_collect);EF(homing_turn);EF(homing_range);EF(armor_reduction);
#undef EF
  }
  H(w->ntexts);hash(w->texts,sizeof w->texts[0]*w->ntexts);
  H(w->nparts);hash(w->parts,sizeof w->parts[0]*w->nparts);
  H(w->nefx);hash(w->efx,sizeof w->efx[0]*w->nefx);
  for(int k=0;k<w->slot_hi;k++){const Slot*s=&w->slots[k];H(s->owner);H(s->cards);H(s->vars);H(s->n);H(s->linked);H(s->cd);H(s->link_expires);H(s->link_actor);H(s->enter);H(s->nenter);H(s->enter_any);H(s->next);}
  printf("{\"seed\":%d,\"mode\":%d,\"ticks\":%llu,\"hash\":\"%016llx\",\"kills\":%d,\"hi\":%d,\"slots\":%d}\n",seed,mode,(unsigned long long)w->tick,digest,w->kills,w->hi,w->slot_hi);
  world_destroy(w);return 0;
}
