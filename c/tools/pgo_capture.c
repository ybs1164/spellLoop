#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "InstrProfiling.h"
#include "InstrProfilingInternal.h"
typedef struct {char *data;size_t size,capacity;} Capture;
static Capture capture;
static uint32_t write_capture(ProfDataWriter *writer,ProfDataIOVec *vectors,uint32_t count){
 Capture *c=writer->WriterCtx;
 for(uint32_t i=0;i<count;i++){
  size_t n=vectors[i].ElmSize*vectors[i].NumElm;
  if(n>SIZE_MAX-c->size)return 1;
  if(c->size+n>c->capacity){size_t cap=c->capacity?c->capacity:65536;while(cap<c->size+n)cap*=2;char *data=realloc(c->data,cap);if(!data)return 1;c->data=data;c->capacity=cap;}
  if(vectors[i].Data)memcpy(c->data+c->size,vectors[i].Data,n);else memset(c->data+c->size,0,n);
  c->size+=n;
 }
 return 0;
}
EMSCRIPTEN_KEEPALIVE uintptr_t bench_profile_buffer(void){capture.size=0;ProfDataWriter writer={write_capture,&capture};return lprofWriteData(&writer,lprofGetVPDataReader(),0)?0:(uintptr_t)capture.data;}
EMSCRIPTEN_KEEPALIVE int bench_profile_size(void){return (int)capture.size;}
