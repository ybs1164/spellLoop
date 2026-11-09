/* Spatial queries retain bucket/cell/entity order, including capped results. */
#include "world.h"
#include <string.h>
#if defined(__GNUC__) || defined(__clang__)
#define SPATIAL_NOINLINE __attribute__((noinline))
#else
#define SPATIAL_NOINLINE
#endif
#if defined(__wasm_simd128__)
#include <wasm_simd128.h>
#endif

static inline int cell_of(float v) { return (int)floorf(v / GRID_CELL); }
static inline int bucket(int cx,int cy) { return (int)(((unsigned)cx*73856093u^(unsigned)cy*19349663u)&(GRID_BUCKETS-1)); }
static inline bool compact_cell(int cx,int cy) { return (unsigned)cx+32768u<=65535u && (unsigned)cy+32768u<=65535u; }
static inline uint32_t cell_key(int cx,int cy) { return ((uint32_t)cx&65535u)|((uint32_t)cy<<16); }
typedef struct { unsigned first,end; } CandidateRun;
/* Snapshot candidate runs before any pair moves; retain cell/bucket order. */
static inline int append_indices(CandidateRun *restrict out,int n,unsigned first,unsigned end) {
  if(first>=end)return n;
  if(n && out[n-1].end==first)out[n-1].end=end;
  else out[n++]=(CandidateRun){first,end};
  return n;
}
static inline bool in_cell(float x,float y,int cx,int cy) {
  /* Preserve division underflow to negative zero and large-cell rounding. */
  if(x<0 && x>=-0x1p-144f)x=0;
  if(y<0 && y>=-0x1p-144f)y=0;
  if((unsigned)cx+8388608u>16777216u || (unsigned)cy+8388608u>16777216u)return cell_of(x)==cx&&cell_of(y)==cy;
  float left=cx*GRID_CELL,top=cy*GRID_CELL;
  return x>=left && x<left+GRID_CELL && y>=top && y<top+GRID_CELL;
}

static unsigned grid_build_links(World *w,uint32_t kind_mask) {
  unsigned count=0;
  Grid *g=&w->grid;
  for(int b=0;b<GRID_BUCKETS;b++)g->head[b]=-1;
  g->max_r=0;
  bool enemies_only = kind_mask == (1u << TK_ENEMY);
  for(int i=enemies_only?kind_scan_next(w,TK_ENEMY,0,w->hi):entity_scan_next(w,0,w->hi);i<w->hi;
      i=enemies_only?kind_scan_next(w,TK_ENEMY,i+1,w->hi):entity_scan_next(w,i+1,w->hi)) {
    if(!w->alive[i] || w->dying[i] || !(kind_mask&(1u<<w->kind[i])))continue;
    int b=bucket(cell_of(w->x[i]),cell_of(w->y[i]));
    g->next[i]=g->head[b];g->head[b]=i;count++;
    if(w->r[i]>g->max_r)g->max_r=w->r[i];
  }
  return count;
}

void grid_build(World *w,uint32_t kind_mask) {
  grid_build_links(w,kind_mask);grid_reindex(w);
}

void grid_reindex(World *w) {
  unsigned count=0;
  for(int b=0;b<GRID_BUCKETS;) {
#if defined(__wasm_simd128__)
    if(b+4<=GRID_BUCKETS && wasm_i32x4_all_true(wasm_i32x4_eq(wasm_v128_load(w->grid.head+b),wasm_i32x4_splat(-1)))) {
      wasm_v128_store(w->fast.grid_start+b,wasm_i32x4_splat((int)count));b+=4;continue;
    }
#endif
    w->fast.grid_start[b]=count;
    for(int i=w->grid.head[b];i>=0;i=w->grid.next[i]) {
      w->fast.grid_items[count]=(uint16_t)i;
      w->fast.grid_position[i]=count;
      w->fast.grid_bucket[count]=(uint16_t)b;
      count++;
    }
    b++;
  }
  w->fast.grid_start[GRID_BUCKETS]=count;
}

int grid_query(const World *w,float x,float y,float r,int *out,int cap) {
  r+=w->grid.max_r;
  int x0=cell_of(x-r),x1=cell_of(x+r),y0=cell_of(y-r),y1=cell_of(y+r),n=0;
  if((int64_t)(x1-x0+1)*(y1-y0+1)>GRID_BUCKETS) {
    for(unsigned p=0;p<w->fast.grid_start[GRID_BUCKETS]&&n<cap;p++)out[n++]=w->fast.grid_items[p];
    return n;
  }
  for(int cx=x0;cx<=x1;cx++)for(int cy=y0;cy<=y1;cy++) {
    int b=bucket(cx,cy);
    for(unsigned p=w->fast.grid_start[b];p<w->fast.grid_start[b+1]&&n<cap;p++) {
      int i=w->fast.grid_items[p];
      /* Public queries read live positions: cards can move nodes between builds. */
      if(in_cell(w->x[i],w->y[i],cx,cy))out[n++]=i;
    }
  }
  return n;
}

/* Private cell groups remove hash collisions from the hot separation query.
 * The ordinary API restores the public index; the tick path rebuilds it
 * after recycling, before the next public query. */
static struct {
  struct { uint32_t key,stamp; uint16_t group; } table[GRID_BUCKETS*2];
  uint16_t group_of[MAX_ENTITIES],original_bucket[MAX_ENTITIES];
  uint64_t members[MAX_ENTITIES/64];
  unsigned counts[GRID_BUCKETS],cursor[GRID_BUCKETS],ngroups;
  uint32_t stamp;
  bool active,fallback;
} cells;
static unsigned cell_slot(uint32_t key) {
  return ((unsigned)(int16_t)key*251u+(unsigned)(int16_t)(key>>16))&(GRID_BUCKETS*2-1);
}
static int cell_group(uint32_t key,bool create) {
  unsigned slot=cell_slot(key);
  while(cells.table[slot].stamp==cells.stamp) {
    if(cells.table[slot].key==key)return cells.table[slot].group;
    slot=(slot+1)&(GRID_BUCKETS*2-1);
  }
  if(!create || cells.ngroups==GRID_BUCKETS)return -1;
  unsigned group=cells.ngroups++;
  cells.table[slot].key=key;cells.table[slot].stamp=cells.stamp;cells.table[slot].group=(uint16_t)group;
  cells.counts[group]=0;
  return (int)group;
}
static void group_separation_cells(World *w,unsigned size,bool from_entities) {
  cells.active=false;cells.fallback=false;
  if(size<256)return;
  if(++cells.stamp==0){memset(cells.table,0,sizeof cells.table);cells.stamp=1;}
  cells.ngroups=0;
  bool dense = size * 4 >= (unsigned)w->hi;
  if (dense) memset(cells.group_of,0xff,(size_t)w->hi*sizeof *cells.group_of);
  else memset(cells.members,0,((size_t)w->hi+63)/64*sizeof *cells.members);
  unsigned limit=from_entities?(unsigned)w->hi:size;
  for(unsigned p=from_entities?(unsigned)kind_scan_next(w,TK_ENEMY,0,w->hi):0;p<limit;
      p=from_entities?(unsigned)kind_scan_next(w,TK_ENEMY,(int)p+1,w->hi):p+1) {
    int i=from_entities?(int)p:w->fast.grid_items[p];
    if(from_entities&&(!ent_live(w,i)||w->kind[i]!=TK_ENEMY))continue;
    int cx=cell_of(w->x[i]),cy=cell_of(w->y[i]);
    if(!compact_cell(cx,cy))return;
    int group=cell_group(cell_key(cx,cy),true);if(group<0)return;
    if (!dense) cells.members[i>>6]|=UINT64_C(1)<<(i&63);
    cells.group_of[i]=(uint16_t)group;cells.original_bucket[i]=from_entities?(uint16_t)bucket(cx,cy):w->fast.grid_bucket[p];cells.counts[group]++;
  }
  unsigned at=0;
  for(unsigned group=0;group<cells.ngroups;group++) {
    w->fast.grid_start[group]=at;at+=cells.counts[group];cells.cursor[group]=at;
  }
  /* Private queries only address allocated groups. Keep the working-set
   * sentinel; grid_reindex restores every public bucket before it is read. */
  w->fast.grid_start[cells.ngroups]=size;w->fast.grid_start[GRID_BUCKETS]=size;
  /* Descending IDs within each cell reproduce filtering of the original list. */
  for(int i=dense?0:index_next(cells.members,0,w->hi);i<w->hi;
      i=dense?i+1:index_next(cells.members,i+1,w->hi)) {
    if (dense && cells.group_of[i]==UINT16_MAX) continue;
    unsigned group=cells.group_of[i],p=--cells.cursor[group];
    w->fast.grid_items[p]=(uint16_t)i;w->fast.grid_position[i]=p;w->fast.grid_bucket[p]=(uint16_t)group;
  }
  cells.active=true;
}
static SPATIAL_NOINLINE int separation_bucket_fallback(const World *w,int owner,CandidateRun *out,int cap,float x,float y,float radius) {
  float r=radius+w->grid.max_r;
  int x0=cell_of(x-r),x1=cell_of(x+r),y0=cell_of(y-r),y1=cell_of(y+r),n=0,seen=0;
  if((int64_t)(x1-x0+1)*(y1-y0+1)>GRID_BUCKETS) {
    for(int b=0;b<GRID_BUCKETS&&seen<cap;b++)for(int i=w->grid.head[b];i>=0&&seen<cap;i=w->grid.next[i],seen++) {
      if(i>owner){unsigned p=w->fast.grid_position[i];n=append_indices(out,n,p,p+1);}
    }
    return n;
  }
  for(int cx=x0;cx<=x1;cx++)for(int cy=y0;cy<=y1;cy++) {
    for(int i=w->grid.head[bucket(cx,cy)];i>=0;i=w->grid.next[i]) {
      unsigned p=w->fast.grid_position[i];
      if(!in_cell(w->fast.grid_x[p],w->fast.grid_y[p],cx,cy))continue;
      if(i>owner)n=append_indices(out,n,p,p+1);
      if(++seen>=cap)return n;
    }
  }
  return n;
}

/* When the complete query fits below the cap, older IDs need no accounting.
 * Snapshot the same descending-ID runs, including holes from earlier pushes. */
static inline int separation_small_query(const World *w,CandidateRun *out,int cap,int x0,int x1,int y0,int y1,const unsigned *cuts) {
  int64_t width=(int64_t)x1-x0+1,height=(int64_t)y1-y0+1;
  if(!w->fast.grid_compact || !compact_cell(x0,y0) || !compact_cell(x1,y1) || width<=0 || height<=0 || width>16 || height>16 || width*height>16)return -1;
  int groups[16],ngroups=0;unsigned matches=0;
  for(int cx=x0;cx<=x1;cx++)for(int cy=y0;cy<=y1;cy++) {
    int b=cell_group(cell_key(cx,cy),false);if(b<0)continue;
    groups[ngroups++]=b;matches+=w->fast.grid_match_count[b];
    if(matches>(unsigned)cap)return -1;
  }
  int n=0;
  for(int g=0;g<ngroups;g++) {
    unsigned b=(unsigned)groups[g],first=w->fast.grid_start[b],end=cuts[b];
    if(first>=end || !w->fast.grid_match_count[b])continue;
    if(w->fast.grid_match_count[b]==w->fast.grid_start[b+1]-first) {
      n=append_indices(out,n,first,end);continue;
    }
    for(unsigned p=first;p<end;) {
      unsigned base=p&~63u,limit=end<base+64?end:base+64;
      uint64_t bits=w->fast.grid_matches[base>>6]&(~UINT64_C(0)<<(p&63));
      if(limit-base<64)bits&=(UINT64_C(1)<<(limit-base))-1;
      while(bits) {
        unsigned offset=(unsigned)__builtin_ctzll(bits);
        uint64_t shifted=bits>>offset;
        unsigned run=shifted==UINT64_MAX?64:(unsigned)__builtin_ctzll(~shifted);
        n=append_indices(out,n,base+offset,base+offset+run);
        if(offset+run==64)break;
        bits&=UINT64_MAX<<(offset+run);
      }
      p=base+64;
    }
  }
  return n;
}

static SPATIAL_NOINLINE int separation_general(const World *restrict w,int owner,CandidateRun *restrict out,int cap,int x0,int x1,int y0,int y1,const unsigned *restrict cuts) {
  int n=0,seen=0;
  if((int64_t)(x1-x0+1)*(y1-y0+1)>GRID_BUCKETS) {
    for(unsigned p=0;p<w->fast.grid_start[GRID_BUCKETS]&&seen<cap;p++,seen++)if(w->fast.grid_items[p]>owner)n=append_indices(out,n,p,p+1);
    return n;
  }
  for(int cx=x0;cx<=x1;cx++)for(int cy=y0;cy<=y1;cy++) {
    int b=cells.active?cell_group(cell_key(cx,cy),false):bucket(cx,cy);
    if(cells.active && (!compact_cell(cx,cy) || b<0))continue;
    unsigned p=w->fast.grid_start[b],end=w->fast.grid_start[b+1];
    bool compact=w->fast.grid_compact;
    if(compact && !compact_cell(cx,cy))continue;
    uint32_t key=cell_key(cx,cy);
    if(compact && w->fast.grid_uniform[b] && key==w->fast.grid_canonical[b]) {
      /* Entity IDs descend within each bucket. Count older matching nodes
       * with popcount while retaining their consumption of the query cap. */
      unsigned cut=cuts[b],matches=w->fast.grid_match_count[b];
      if(!matches)continue;
      if(cut<=p) { seen+=(int)matches;if(seen>=cap)return n;continue; }
      if(matches==end-p) {
        unsigned take=matches<(unsigned)(cap-seen)?matches:(unsigned)(cap-seen);
        n=append_indices(out,n,p,p+take<cut?p+take:cut);
        seen+=(int)take;if(seen>=cap)return n;continue;
      }
      while(p<end) {
        unsigned base=p&~63u,limit=end<base+64?end:base+64;
        uint64_t bits=w->fast.grid_matches[base>>6]&(~UINT64_C(0)<<(p&63));
        if(limit-base<64)bits&=(UINT64_C(1)<<(limit-base))-1;
        int count=__builtin_popcountll(bits);
        if(count>cap-seen) {
          int remaining=cap-seen;
          while(remaining>0 && base<cut) {
            unsigned first=(unsigned)__builtin_ctzll(bits);
            uint64_t shifted=bits>>first;
            unsigned run=shifted==UINT64_MAX?64:(unsigned)__builtin_ctzll(~shifted);
            unsigned take=run<(unsigned)remaining?run:(unsigned)remaining;
            unsigned end=base+first+take;
            n=append_indices(out,n,base+first,end<cut?end:cut);
            remaining-=(int)take;
            if(first+run==64)break;
            bits&=UINT64_MAX<<(first+run);
          }
          return n;
        }
        seen+=count;
        if(cut<=base)bits=0;
        else if(cut-base<64)bits&=(UINT64_C(1)<<(cut-base))-1;
        while(bits) {
          unsigned first=(unsigned)__builtin_ctzll(bits);
          uint64_t shifted=bits>>first;
          unsigned run=shifted==UINT64_MAX?64:(unsigned)__builtin_ctzll(~shifted);
          n=append_indices(out,n,base+first,base+first+run);
          if(first+run==64)break;
          bits&=UINT64_MAX<<(first+run);
        }
        if(seen>=cap)return n;
        p=base+64;
      }
      continue;
    }
#if defined(__wasm_simd128__)
    {
      for(;p+4<=end;p+=4) {
        unsigned mask=wasm_i32x4_bitmask(compact?wasm_i32x4_eq(wasm_v128_load(w->fast.grid_cell_key+p),wasm_i32x4_splat((int32_t)key)):wasm_v128_and(wasm_i32x4_eq(wasm_v128_load(w->fast.grid_cell_x+p),wasm_i32x4_splat(cx)),wasm_i32x4_eq(wasm_v128_load(w->fast.grid_cell_y+p),wasm_i32x4_splat(cy))));
        if(mask==15 && seen+4<=cap) {
          if(w->fast.grid_items[p+3]>owner) {n=append_indices(out,n,p,p+4);}
          else if(w->fast.grid_items[p]>owner)for(unsigned q=p;q<p+4;q++)if(w->fast.grid_items[q]>owner)n=append_indices(out,n,q,q+1);
          seen+=4;if(seen>=cap)return n;
          continue;
        }
        while(mask) {
          unsigned q=p+(unsigned)__builtin_ctz(mask);mask&=mask-1;
          if(w->fast.grid_items[q]>owner)n=append_indices(out,n,q,q+1);
          if(++seen>=cap)return n;
        }
      }
    }
#endif
    for(;p<end;p++) {
      if(compact?w->fast.grid_cell_key[p]!=key:(w->fast.grid_cell_x[p]!=cx||w->fast.grid_cell_y[p]!=cy))continue;
      if(w->fast.grid_items[p]>owner)n=append_indices(out,n,p,p+1);
      /* Older entities still consume the original cap. */
      if(++seen>=cap)return n;
    }
  }
  return n;
}

/* No cards/callbacks run during separation: publish the working set at the end. */
static int separation_query(const World *restrict w,int owner,CandidateRun *restrict out,int cap,float x,float y,float radius,const unsigned *restrict cuts) {
  float r=radius+w->grid.max_r;
  int x0=cell_of(x-r),x1=cell_of(x+r),y0=cell_of(y-r),y1=cell_of(y+r);
  if(cells.active && (cells.fallback || (int64_t)(x1-x0+1)*(y1-y0+1)>GRID_BUCKETS))
    return separation_bucket_fallback(w,owner,out,cap,x,y,radius);
  if(cells.active) {
    int n=separation_small_query(w,out,cap,x0,x1,y0,y1,cuts);
    if(n>=0)return n;
  }
  return separation_general(w,owner,out,cap,x0,x1,y0,y1,cuts);
}

static SPATIAL_NOINLINE void separate_unindexed(World *w) {
  int near[512];
  for(int i=kind_next(w,TK_ENEMY,0,w->hi);i<w->hi;i=kind_next(w,TK_ENEMY,i+1,w->hi)) {
    if(!ent_live(w,i))continue;
    int n=grid_query(w,w->x[i],w->y[i],w->r[i],near,512);
    for(int k=0;k<n;k++) {
      int j=near[k];if(j<=i||w->dying[j])continue;
      float dx=w->x[j]-w->x[i],dy=w->y[j]-w->y[i],rr=w->r[i]+w->r[j],d2=dx*dx+dy*dy;
      if(d2>=rr*rr)continue;
      float d=sqrtf(d2);if(d<1e-4f){dx=1;dy=0;d=1;}
      float push=(rr-d)*0.5f,wi=w->r[j]/rr,wj=w->r[i]/rr,ux=dx/d,uy=dy/d;
      w->x[i]-=ux*push*wi*2;w->y[i]-=uy*push*wi*2;
      w->x[j]+=ux*push*wj*2;w->y[j]+=uy*push*wj*2;
    }
  }
}

static inline void update_cell(World *w,unsigned p,float x,float y,const float *xs,const float *ys) {
  int cx=cell_of(x),cy=cell_of(y);
  if(w->fast.grid_compact) {
    if(compact_cell(cx,cy)) {
      uint32_t key=cell_key(cx,cy);
      if(key!=w->fast.grid_cell_key[p]) {
        uint32_t old=w->fast.grid_cell_key[p];
        w->fast.grid_cell_key[p]=key;
        unsigned b=w->fast.grid_bucket[p];
        if(cells.active && key!=w->fast.grid_canonical[b] && bucket(cx,cy)==cells.original_bucket[w->fast.grid_items[p]])cells.fallback=true;
        if(w->fast.grid_uniform[b]) {
          uint64_t bit=UINT64_C(1)<<(p&63);
          if(key==w->fast.grid_canonical[b]) {w->fast.grid_matches[p>>6]|=bit;w->fast.grid_match_count[b]++;}
          else if(old==w->fast.grid_canonical[b]) {w->fast.grid_matches[p>>6]&=~bit;w->fast.grid_match_count[b]--;}
        }
      }
      return;
    }
    /* Leave the compact representation immediately if a push crosses its
     * range; full coordinates preserve arbitrary large-world behavior. */
    w->fast.grid_compact=false;
    if(cells.active)cells.fallback=true;
    for(unsigned q=0;q<w->fast.grid_start[GRID_BUCKETS];q++) {
      w->fast.grid_cell_x[q]=cell_of(xs[q]);w->fast.grid_cell_y[q]=cell_of(ys[q]);
    }
  }
  w->fast.grid_cell_x[p]=cx;w->fast.grid_cell_y[p]=cy;
}

static struct {bool valid;float pair[16][16][4];} radius_meta;
static void prepare_radius_meta(const float *radii,int n,const float weights[16][16][4]) {
  radius_meta.valid=false;if(n>16)return;
  for(int i=0;i<n;i++)if(!(radii[i]>0&&isfinite(radii[i])))return;
  for(int a=0;a<n;a++)for(int b=0;b<n;b++) {
    float rr=radii[a]+radii[b];radius_meta.pair[a][b][0]=rr;radius_meta.pair[a][b][1]=rr*rr;
    radius_meta.pair[a][b][2]=weights[a][b][0];radius_meta.pair[a][b][3]=weights[a][b][2];
  }
  radius_meta.valid=true;
}

static void separate_packed(World *restrict w,float *restrict xs,float *restrict ys,const float *restrict rs,const uint8_t *restrict radius_ids,const float weights[restrict static 16][16][4],CandidateRun *restrict near,unsigned *restrict cuts,bool cached_weights) {
  unsigned size=w->fast.grid_start[GRID_BUCKETS];
  bool dense = size * 4 >= (unsigned)w->hi;
  for(int i=dense?0:index_next(cells.members,0,w->hi);i<w->hi;
      i=dense?i+1:index_next(cells.members,i+1,w->hi)) {
    unsigned own=w->fast.grid_position[i];
    if(own<size && w->fast.grid_items[own]==i)cuts[w->fast.grid_bucket[own]]=own;
    if(!w->alive[i] || w->dying[i] || w->kind[i]!=TK_ENEMY)continue;
    int n=separation_query(w,i,near,512,xs[own],ys[own],rs[own],cuts);
    float ix=xs[own],iy=ys[own],ri=rs[own];
    const float (*owner_weights)[4]=cached_weights?weights[radius_ids[own]]:NULL;
    const float (*owner_meta)[4]=radius_meta.valid?radius_meta.pair[radius_ids[own]]:NULL;
#if defined(__wasm_simd128__)
    int tested=0,skipped=0;
#endif
    for(int run=0;run<n;run++)for(unsigned k=near[run].first;k<near[run].end;) {
      unsigned end=k+1;
#if defined(__wasm_simd128__)
      /* Only groups whose scalar operations are all no-ops can be skipped. */
      if(k+4<=near[run].end && (tested<8 || skipped*4>=tested)) {
        v128_t px=wasm_v128_load(xs+k),py=wasm_v128_load(ys+k),pr=wasm_v128_load(rs+k);
        v128_t dx=wasm_f32x4_sub(px,wasm_f32x4_splat(ix)),dy=wasm_f32x4_sub(py,wasm_f32x4_splat(iy)),rr=wasm_f32x4_add(pr,wasm_f32x4_splat(ri));
        v128_t distance=wasm_f32x4_add(wasm_f32x4_mul(dx,dx),wasm_f32x4_mul(dy,dy));
        tested++;
        if(wasm_i32x4_all_true(wasm_f32x4_ge(distance,wasm_f32x4_mul(rr,rr)))){skipped++;k+=4;continue;}
        end=k+4;
      }
#endif
      for(;k<end;k++) {
        unsigned p=k;
        const float *meta=owner_meta?owner_meta[radius_ids[p]]:NULL;
        float jx=xs[p],jy=ys[p],rj=meta?0:rs[p];
        float dx=jx-ix,dy=jy-iy,rr=meta?meta[0]:ri+rj,d2=dx*dx+dy*dy;
        if(d2>=(meta?meta[1]:rr*rr))continue;
        float d=sqrtf(d2);
        if(d<1e-4f){dx=1;dy=0;d=1;}
        float wi,wj;const float *pair=NULL;
        if(meta){wi=meta[2];wj=meta[3];}
        else if(cached_weights) {
          pair=owner_weights[radius_ids[p]];
          wi=pair[0];wj=pair[2];
        } else {wi=rj/rr;wj=ri/rr;}
        float push=(rr-d)*0.5f;
#if defined(__wasm_simd128__)
        /* The four coordinate contributions are independent after the scalar
         * distance is known. SIMD uses the same divisions and multiplication
         * order, without reciprocal approximations or reassociation. */
        v128_t direction=wasm_f32x4_div(wasm_f32x4_make(dx,dy,dx,dy),wasm_f32x4_splat(d));
        v128_t factors;
        if(meta){v128_t data=wasm_v128_load(meta);factors=wasm_i32x4_shuffle(data,data,2,2,3,3);}
        else factors=pair?wasm_v128_load(pair):wasm_f32x4_make(wi,wi,wj,wj);
        v128_t delta=wasm_f32x4_mul(wasm_f32x4_mul(wasm_f32x4_mul(direction,wasm_f32x4_splat(push)),factors),wasm_f32x4_splat(2));
        v128_t base=wasm_f32x4_make(ix,iy,jx,jy);
        v128_t minus=wasm_f32x4_sub(base,delta),plus=wasm_f32x4_add(base,delta);
        ix=wasm_f32x4_extract_lane(minus,0);iy=wasm_f32x4_extract_lane(minus,1);
        xs[p]=wasm_f32x4_extract_lane(plus,2);ys[p]=wasm_f32x4_extract_lane(plus,3);
#else
        float ux=dx/d,uy=dy/d;
        ix-=ux*push*wi*2;iy-=uy*push*wi*2;
        xs[p]=jx+ux*push*wj*2;ys[p]=jy+uy*push*wj*2;
#endif
        update_cell(w,p,xs[p],ys[p],xs,ys);
      }
    }
    xs[own]=ix;ys[own]=iy;
    update_cell(w,own,ix,iy,xs,ys);
  }
}

static void separate_prepared(World *w,bool restore_grid) {
  static CandidateRun near[512];
  static unsigned cuts[GRID_BUCKETS];
  float radii[16],weights[16][16][4];int nradii=0;
  unsigned size=w->fast.grid_start[GRID_BUCKETS];
  if (!cells.active) {
    memset(cells.members,0,((size_t)w->hi+63)/64*sizeof *cells.members);
    for (unsigned p=0;p<size;p++) {
      unsigned i=w->fast.grid_items[p];cells.members[i>>6]|=UINT64_C(1)<<(i&63);
    }
  }
  w->fast.grid_compact=true;
  for(unsigned p=0;p<size;p++) {
    int i=w->fast.grid_items[p];
    if(w->dying[i]){separate_unindexed(w);return;}
    w->fast.grid_x[p]=w->x[i];w->fast.grid_y[p]=w->y[i];w->fast.grid_r[p]=w->r[i];
    w->fast.grid_cell_x[p]=cell_of(w->x[i]);w->fast.grid_cell_y[p]=cell_of(w->y[i]);
    w->fast.grid_cell_key[p]=cell_key(w->fast.grid_cell_x[p],w->fast.grid_cell_y[p]);
    w->fast.grid_compact &= compact_cell(w->fast.grid_cell_x[p],w->fast.grid_cell_y[p]);
    if(nradii<=16) {
      int k=0;while(k<nradii && k<16 && radii[k]!=w->r[i])k++;
      if(k==nradii || k==16){if(k<16)radii[k]=w->r[i];nradii++;}
      w->fast.grid_radius_id[p]=(uint8_t)k;
    }
  }
  bool cached_weights=nradii<=16;
  for(unsigned p=0;p<(size+63)/64;p++)w->fast.grid_matches[p]=0;
  unsigned groups=cells.active?cells.ngroups:GRID_BUCKETS;
  for(unsigned b=0;b<groups;b++) {
    unsigned first=w->fast.grid_start[b],end=w->fast.grid_start[b+1];
    cuts[b]=end;
    w->fast.grid_match_count[b]=end-first;
    w->fast.grid_uniform[b]=first<end;
    if(first==end)continue;
    uint32_t key=w->fast.grid_cell_key[first];w->fast.grid_canonical[b]=key;
    for(unsigned p=first+1;p<end;p++)if(w->fast.grid_cell_key[p]!=key){w->fast.grid_uniform[b]=0;break;}
    if(w->fast.grid_uniform[b])for(unsigned p=first;p<end;p++) {
      int i=w->fast.grid_items[p];
      if(cells.active && cells.original_bucket[i]!=bucket(w->fast.grid_cell_x[p],w->fast.grid_cell_y[p])){w->fast.grid_match_count[b]--;continue;}
      w->fast.grid_matches[p>>6]|=UINT64_C(1)<<(p&63);
    }
  }
  if(cached_weights)for(int a=0;a<nradii;a++)for(int b=0;b<nradii;b++) {
    float rr=radii[a]+radii[b];
    weights[a][b][0]=weights[a][b][1]=radii[b]/rr;
    weights[a][b][2]=weights[a][b][3]=radii[a]/rr;
  }
  if(cells.active)for(unsigned p=0;p<size;p++) {
    int i=w->fast.grid_items[p];
    if(cells.original_bucket[i]!=bucket(w->fast.grid_cell_x[p],w->fast.grid_cell_y[p])){cells.fallback=true;break;}
  }
  prepare_radius_meta(radii,nradii,weights);
  separate_packed(w,w->fast.grid_x,w->fast.grid_y,w->fast.grid_r,w->fast.grid_radius_id,weights,near,cuts,cached_weights);
  for(unsigned p=0;p<w->fast.grid_start[GRID_BUCKETS];p++) {
    int i=w->fast.grid_items[p];w->x[i]=w->fast.grid_x[p];w->y[i]=w->fast.grid_y[p];
  }
  if(cells.active){if(restore_grid)grid_reindex(w);cells.active=false;}
}

void separate_enemies(World *w) {
  cells.active=false;
  unsigned size=w->fast.grid_start[GRID_BUCKETS];
  for(int i=kind_next(w,TK_ENEMY,0,w->hi);i<w->hi;i=kind_next(w,TK_ENEMY,i+1,w->hi))if(ent_live(w,i)) {
    unsigned p=w->fast.grid_position[i];
    if(p>=size||w->fast.grid_items[p]!=i){separate_unindexed(w);return;}
  }
  /* Validate all members before temporarily changing their packed order. */
  for(unsigned p=0;p<size;p++)if(w->dying[w->fast.grid_items[p]]){separate_unindexed(w);return;}
  group_separation_cells(w,size,false);
  separate_prepared(w,true);
}

/* The next tick phase rebuilds the public index after recycling. Cell groups
 * can be packed straight from live IDs without constructing that index twice. */
void separate_enemies_for_tick(World *w) {
  unsigned size=grid_build_links(w,1u<<TK_ENEMY);
  cells.active=false;
  group_separation_cells(w,size,true);
  if(!cells.active)grid_reindex(w);
  separate_prepared(w,false);
}
