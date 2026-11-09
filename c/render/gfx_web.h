/* Web-only instanced quads; SDL remains the texture/window owner and fallback. */
#pragma once
#include <emscripten.h>

EM_JS(int, gfx_web_init, (), {
  if(!GL.currentContext || !GL.currentContext.GLctx)return 0;
  Module['gfxFastInit'] = function() {
    var gl = GL.currentContext.GLctx;
    var ext = gl.drawElementsInstanced ? {
      vertexAttribDivisorANGLE:function(i,d){gl.vertexAttribDivisor(i,d);},
      drawElementsInstancedANGLE:function(mode,n,type,offset,count){gl.drawElementsInstanced(mode,n,type,offset,count);}
    } : gl.getExtension('ANGLE_instanced_arrays');
    var vao = gl.createVertexArray ? {
      createVertexArrayOES:function(){return gl.createVertexArray();},
      bindVertexArrayOES:function(v){gl.bindVertexArray(v);},
      deleteVertexArrayOES:function(v){gl.deleteVertexArray(v);}
    } : gl.getExtension('OES_vertex_array_object');
    if (!ext) return null;
    function shader(kind, source) {
      var s = gl.createShader(kind); gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); return null; }
      return s;
    }
    var vertexInputs='attribute vec3 corner; attribute vec4 rect; attribute vec4 uv; attribute vec4 color; attribute vec4 aux; uniform vec2 resolution; uniform float density; varying vec2 texcoord; varying vec4 tint;';
    var vertexBody='void main(){vec4 box=rect;vec4 coords=uv;vec4 shade=color;bool paired=color.a<0.0;vec2 q=corner.xy;if(paired){if(corner.z<0.5){vec2 size=floor(aux.zw/2048.0);vec2 at=aux.zw-size*2048.0;box=vec4(aux.xy,size*3.0*density);coords=vec4(at,at+size)/2048.0;shade=vec4(0.0,0.0,0.0,0.35);}else shade.a=-shade.a;}else if(corner.z>0.5)q=vec2(0.0);vec2 p=box.xy+q*box.zw;gl_Position=vec4(p.x/resolution.x*2.0-1.0,1.0-p.y/resolution.y*2.0,0.0,1.0);texcoord=mix(coords.xy,coords.zw,q);tint=shade;';
    var vs = shader(gl.VERTEX_SHADER, vertexInputs+'varying vec4 config; varying vec2 localPos;'+vertexBody+'config=coords;localPos=(q-0.5)*box.zw;}');
    var fs = shader(gl.FRAGMENT_SHADER, [
      'precision highp float; uniform sampler2D image; uniform float density; varying vec2 texcoord; varying vec4 tint; varying vec4 config; varying vec2 localPos;',
      'float snapped(float v,float g){return floor(v/g+0.5)*g;}',
      'float band(float inner,float outer,vec2 p,float g){float yc=(floor(p.y/g)+0.5)*g;float yy=yc*yc;if(yy>outer*outer)return 0.0;float xo=snapped(sqrt(max(0.0,outer*outer-yy)),g);float xi=(inner>0.0&&yy<inner*inner)?snapped(sqrt(inner*inner-yy),g):0.0;return (abs(p.x)<xo&&abs(p.x)>=xi)?1.0:0.0;}',
      'void main(){if(config.x>=0.0){gl_FragColor=texture2D(image,texcoord)*tint;return;} float alpha=0.0;',
      'if(config.x < -3.5){float g=config.w;float k=(floor(localPos.y/g)+0.5)*g/config.z;if(k*k>=1.0)discard;float xo=snapped(config.y*sqrt(1.0-k*k),g);if(abs(localPos.x)>=xo)discard;alpha=tint.a;}',
      'else{float r=config.y;float g=r>90.0*density?6.0*density:3.0*density;float parity=mod(floor(localPos.x/g)+floor(localPos.y/g)+config.z,2.0);float checker=parity<0.5?1.0:0.0;float outer=0.0;float core=0.0;',
      'if(config.x > -1.5){outer=band(0.0,r,localPos,g)*checker*tint.a;core=band(0.0,r*0.62,localPos,g)*tint.a*config.w;}',
      'else if(config.x > -2.5){outer=band(r*0.55,r,localPos,g)*checker*tint.a;core=band(r*0.7,r*0.88,localPos,g)*tint.a*0.45;}',
      'else{outer=band(r*0.6,r,localPos,g)*checker*tint.a*0.7;} alpha=core+outer*(1.0-core);}',
      'if(alpha<=0.0)discard;gl_FragColor=vec4(tint.rgb,alpha);}'
    ].join('\n'));
    if (!vs || !fs) return null;
    var p = gl.createProgram(); gl.attachShader(p,vs); gl.attachShader(p,fs);
    ['corner','rect','uv','color','aux'].forEach(function(n,i){gl.bindAttribLocation(p,i,n);});
    gl.linkProgram(p); gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(p,gl.LINK_STATUS)) { gl.deleteProgram(p); return null; }
    var fastVS=shader(gl.VERTEX_SHADER,vertexInputs+vertexBody+'}');
    var fastFS=shader(gl.FRAGMENT_SHADER,'precision highp float; uniform sampler2D image; varying vec2 texcoord; varying vec4 tint; void main(){gl_FragColor=texture2D(image,texcoord)*tint;}');
    if(!fastVS || !fastFS){gl.deleteProgram(p);return null;}
    var fast=gl.createProgram();gl.attachShader(fast,fastVS);gl.attachShader(fast,fastFS);
    ['corner','rect','uv','color','aux'].forEach(function(n,i){gl.bindAttribLocation(fast,i,n);});
    gl.linkProgram(fast);gl.deleteShader(fastVS);gl.deleteShader(fastFS);
    if(!gl.getProgramParameter(fast,gl.LINK_STATUS)){gl.deleteProgram(p);gl.deleteProgram(fast);return null;}
    var corners=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,corners);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,0,0,1,0,0,1,1,0,0,1,0,0,0,1,1,0,1,1,1,1,0,1,1]),gl.STATIC_DRAW);
    var indices=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2,0,2,3,4,5,6,4,6,7]),gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,null);
    return {gl:gl,ext:ext,vao:vao,nearest:new WeakSet(),fastUniforms:{},analyticUniforms:{},program:p,fast:fast,corners:corners,indices:indices,buffers:[[],[],[]],frame:2,batch:0,resolution:gl.getUniformLocation(p,'resolution'),density:gl.getUniformLocation(p,'density'),sampler:gl.getUniformLocation(p,'image'),fastResolution:gl.getUniformLocation(fast,'resolution'),fastDensity:gl.getUniformLocation(fast,'density'),fastSampler:gl.getUniformLocation(fast,'image')};
  };
  Module['gfxFast'] = Module['gfxFastInit']();
  Module['gfxFastLost'] = false;
  if (!Module['gfxFastEvents']) {
    var canvas=GL.currentContext.GLctx.canvas;
    canvas.addEventListener('webglcontextlost',function(){Module['gfxFastLost']=true;});
    canvas.addEventListener('webglcontextrestored',function(){Module['gfxFast']=Module['gfxFastInit']();Module['gfxFastLost']=false;});
    Module['gfxFastEvents']=true;
  }
  return Module['gfxFast'] ? 1 : 0;
});

/* Reuse uploads only after three frames; never overwrite an earlier batch. */
EM_JS(void, gfx_web_begin, (), {
  var s=Module['gfxFast'];
  if(s){s.frame=(s.frame+1)%3;s.batch=0;}
});

EM_JS(void, gfx_web_draw, (const float *data, int count, int texture, int width, int height, float density, int premultiplied, int analytic, int dual, int clip, int cx, int cy, int cw, int ch), {
  var s=Module['gfxFast'],gl=GL.currentContext.GLctx;
  if (Module['gfxFastLost']) return;
  if (!s) return;
  gl.viewport(0,0,width,height);
  if(clip){gl.enable(gl.SCISSOR_TEST);gl.scissor(cx,height-cy-ch,cw,ch);}else gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.enable(gl.BLEND);
  gl.blendEquationSeparate(gl.FUNC_ADD,gl.FUNC_ADD);
  gl.blendFuncSeparate(premultiplied?gl.ONE:gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(analytic?s.program:s.fast);
  var uniforms=analytic?s.analyticUniforms:s.fastUniforms;
  if(uniforms.width!==width||uniforms.height!==height){gl.uniform2f(analytic?s.resolution:s.fastResolution,width,height);uniforms.width=width;uniforms.height=height;}
  if(uniforms.density!==density){gl.uniform1f(analytic?s.density:s.fastDensity,density);uniforms.density=density;}
  var tex=GL.textures[texture];
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,tex);
  /* Every gfx texture is nearest-only, including when SDL draws cached layers. */
  if(tex&&!s.nearest.has(tex)){gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);s.nearest.add(tex);}
  var buffers=s.buffers[s.frame],batch=s.batch++;
  var upload=buffers[batch];
  if(!upload) {
    upload=buffers[batch]={buffer:gl.createBuffer(),capacity:0,vao:null};
    if(s.vao) {
      upload.vao=s.vao.createVertexArrayOES();s.vao.bindVertexArrayOES(upload.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER,s.corners);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,12,0);s.ext.vertexAttribDivisorANGLE(0,0);
      gl.bindBuffer(gl.ARRAY_BUFFER,upload.buffer);
      for(var i=1;i<5;i++){gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,4,gl.FLOAT,false,64,(i-1)*16);s.ext.vertexAttribDivisorANGLE(i,1);}
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,s.indices);s.vao.bindVertexArrayOES(null);
    }
  }
  if(s.vao)s.vao.bindVertexArrayOES(upload.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER,upload.buffer);
  var bytes=count*64;
  if(bytes>upload.capacity){var capacity=4096;while(capacity<bytes)capacity*=2;gl.bufferData(gl.ARRAY_BUFFER,capacity,gl.DYNAMIC_DRAW);upload.capacity=capacity;}
  gl.bufferSubData(gl.ARRAY_BUFFER,0,HEAPF32.subarray(data>>2,(data>>2)+count*16));
  if(!s.vao) {
    gl.bindBuffer(gl.ARRAY_BUFFER,s.corners);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,12,0);s.ext.vertexAttribDivisorANGLE(0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,upload.buffer);
    for(var i=1;i<5;i++){gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,4,gl.FLOAT,false,64,(i-1)*16);s.ext.vertexAttribDivisorANGLE(i,1);}
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,s.indices);
  }
  s.ext.drawElementsInstancedANGLE(gl.TRIANGLES,dual?12:6,gl.UNSIGNED_SHORT,0,count);
  if(s.vao)s.vao.bindVertexArrayOES(null);
  else {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,null);
    for(var i=1;i<5;i++)s.ext.vertexAttribDivisorANGLE(i,0);
    gl.disableVertexAttribArray(3);gl.disableVertexAttribArray(4);
  }
});

EM_JS(void, gfx_web_quit, (), {
  var s=Module['gfxFast'];
  if(s){s.gl.deleteProgram(s.program);s.gl.deleteProgram(s.fast);s.gl.deleteBuffer(s.corners);s.gl.deleteBuffer(s.indices);s.buffers.forEach(function(frame){frame.forEach(function(upload){s.gl.deleteBuffer(upload.buffer);if(s.vao&&upload.vao)s.vao.deleteVertexArrayOES(upload.vao);});});}
  Module['gfxFast']=null;
});
