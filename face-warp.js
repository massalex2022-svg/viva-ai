/* VIVA AI 2.2 — deformazione fotogramma WebGL2.
 * Basato sul prototipo VIVA AI 2.0 LAB già provato.
 * Usa solo i punti del volto e la foto già caricati in locale.
 * Importando questa classe NON si modifica la voce né si scaricano modelli aggiuntivi.
 */
const vert = [
 '#version 300 es',
 'precision highp float;',
 'layout(location=0) in vec2 a_position;',
 'out vec2 v_uv;',
 'void main(){',
 '  gl_Position=vec4(a_position,0.0,1.0);',
 '  v_uv=vec2((a_position.x+1.0)*0.5,(1.0-a_position.y)*0.5);',
 '}'
].join('\n');
const frag = [
 '#version 300 es',
 'precision highp float;',
 'in vec2 v_uv;',
 'out vec4 fragColor;',
 'uniform sampler2D u_portrait;',
 'uniform vec2 u_brow0;',
 'uniform vec2 u_brow1;',
 'uniform vec2 u_mouth0;',
 'uniform vec2 u_mouth1;',
 'uniform float u_eyeSpan;',
 'uniform float u_aspect;',
 'uniform float u_raise;',
 'uniform float u_smile;',
 'uniform vec2 u_eye0;',
 'uniform vec2 u_eye1;',
 'uniform vec2 u_eyeSize0;',
 'uniform vec2 u_eyeSize1;',
 'uniform float u_blink;',
 'float softLocal(vec2 point,vec2 center,vec2 radius){',
 ' vec2 p=(point-center)/max(radius,vec2(0.0001));',
 ' return exp(-1.55*dot(p,p));',
 '}',
 'vec4 closedEye(vec2 uv,vec2 center,vec2 radius, float amount,vec4 current){',
 '  vec2 n=(uv-center)/max(radius,vec2(0.00001));',
 '  float edge=length(n);',
 '  float inside=1.0-smoothstep(0.69,1.13,edge);',
 '  float b=clamp(amount,0.0,1.0)*inside;',
 '  // Campioni della pelle sopra e sotto l’occhio originale.',
 '  vec2 upper=vec2(uv.x,center.y-radius.y*(1.55+0.10*clamp(-n.y,0.0,1.0)));',
 '  vec2 lower=vec2(uv.x,center.y+radius.y*(1.65+0.10*clamp(n.y,0.0,1.0)));',
 '  vec4 skinTop=texture(u_portrait,clamp(upper,vec2(0.001),vec2(0.999)));',
 '  vec4 skinBottom=texture(u_portrait,clamp(lower,vec2(0.001),vec2(0.999)));',
 '  float lowerMix=smoothstep(-0.13,0.13,n.y);',
 '  vec4 skin=mix(skinTop,skinBottom,lowerMix);',
 '  float crease=exp(-pow(n.y*14.0,2.0))*(1.0-smoothstep(0.20,0.93,abs(n.x)));',
 '  skin.rgb*=1.0-0.075*crease*amount;',
 '  return mix(current,skin,b);',
 '}',
 'void main(){',
 ' vec2 pos=v_uv;',
 ' float browRadiusX=max(0.028,u_eyeSpan*0.33);',
 ' float browRadiusY=max(0.019,browRadiusX*u_aspect*0.58);',
 ' float browInfluence=',
 '  softLocal(pos,u_brow0,vec2(browRadiusX,browRadiusY))+',
 '  softLocal(pos,u_brow1,vec2(browRadiusX,browRadiusY));',
 ' vec2 sampleUV=pos;',
 ' sampleUV.y+=u_raise*min(1.0,browInfluence);',
 ' float mouthRadiusX=max(0.027,u_eyeSpan*0.23);',
 ' float mouthRadiusY=max(0.016,mouthRadiusX*u_aspect*0.72);',
 ' float smileInfluence=',
 '  softLocal(pos,u_mouth0,vec2(mouthRadiusX,mouthRadiusY))+',
 '  softLocal(pos,u_mouth1,vec2(mouthRadiusX,mouthRadiusY));',
 ' sampleUV.y+=u_smile*min(1.0,smileInfluence);',
 ' vec4 pixel=texture(u_portrait,clamp(sampleUV,vec2(0.001),vec2(0.999)));',
 ' if(u_blink>0.001){',
 '   pixel=closedEye(pos,u_eye0,u_eyeSize0,u_blink,pixel);',
 '   pixel=closedEye(pos,u_eye1,u_eyeSize1,u_blink,pixel);',
 ' }',
 ' fragColor=pixel;',
 '}'
].join('\n');

function shader(gl,type,src){
 const obj=gl.createShader(type);
 if(!obj)throw Error('Shader WebGL non creato.');
 gl.shaderSource(obj,src);
 gl.compileShader(obj);
 if(!gl.getShaderParameter(obj,gl.COMPILE_STATUS)){
  const why=gl.getShaderInfoLog(obj);
  gl.deleteShader(obj);
  throw Error('Shader WebGL: '+why);
 }
 return obj;
}
function normPt(p,w,h){
 return {x:Math.min(1,Math.max(0,p.x/w)),y:Math.min(1,Math.max(0,p.y/h))};
}
export class FaceWarp {
 constructor(){
  this.canvas=document.createElement('canvas');
  this.gl=null;this.program=null;this.texture=null;this.vao=null;this.u=null;
  this.points=null;this.ready=false;this.failed=null;
 }
 _initialize(){
  const gl=this.canvas.getContext('webgl2',{alpha:false,antialias:false,preserveDrawingBuffer:true});
  if(!gl)throw Error('WebGL2 non disponibile sul browser.');
  const vs=shader(gl,gl.VERTEX_SHADER,vert),fs=shader(gl,gl.FRAGMENT_SHADER,frag);
  const p=gl.createProgram();
  gl.attachShader(p,vs);gl.attachShader(p,fs);gl.linkProgram(p);
  gl.deleteShader(vs);gl.deleteShader(fs);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error('Programma WebGL: '+gl.getProgramInfoLog(p));
  const vao=gl.createVertexArray();gl.bindVertexArray(vao);
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  const texture=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
  const names=['u_portrait','u_brow0','u_brow1','u_mouth0','u_mouth1','u_eyeSpan','u_aspect','u_raise','u_smile','u_eye0','u_eye1','u_eyeSize0','u_eyeSize1','u_blink'];
  const u=Object.fromEntries(names.map(name=>[name,gl.getUniformLocation(p,name)]));
  gl.useProgram(p);gl.uniform1i(u.u_portrait,0);
  this.gl=gl;this.program=p;this.texture=texture;this.vao=vao;this.u=u;
  this.canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();this.ready=false;this.failed='Contesto WebGL perso.';});
 }
 configure(source,eyes,brows,mouthCorners){
  this.ready=false;this.failed=null;
  if(!source?.width||!source?.height||!eyes||eyes.length!==2||!brows||brows.length!==2||!mouthCorners||mouthCorners.length!==2)
   return false;
  try{
   if(!this.gl)this._initialize();
   const {gl,texture}=this;
   this.canvas.width=source.width;
   this.canvas.height=source.height;
   gl.viewport(0,0,source.width,source.height);
   gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
   gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
   const w=source.width,h=source.height;
   const a=normPt(eyes[0],w,h),b=normPt(eyes[1],w,h);
   const eyeSpan=Math.hypot(a.x-b.x,a.y-b.y);
   if(!Number.isFinite(eyeSpan)||eyeSpan<.04)throw Error('Distanza tra gli occhi insufficiente.');
   const dimensions=eyes.map(e=>({
    x:Math.min(.14,Math.max(.008,(e.width||Math.abs(eyes[0].x-eyes[1].x)*.28)/w*.55)),
    y:Math.min(.08,Math.max(.004,(e.height||Math.max(6,(e.width||35)*.17))/h*1.18))
   }));
   this.points={eyes:[a,b],eyeSizes:dimensions,brows:brows.map(p=>normPt(p,w,h)),mouth:mouthCorners.map(p=>normPt(p,w,h)),eyeSpan};
   this.ready=true;
   return true;
  }catch(err){
   this.failed=err?.message||String(err);
   console.warn('VIVA AI: motore WebGL disattivato; continuo con il disegno precedente.',err);
   this.ready=false;
   return false;
  }
 }
 render(brow=0,smile=0,blink=0){
  if(!this.ready)return null;
  try{
   const {gl,program,vao,texture,u,points}=this;
   gl.useProgram(program);gl.bindVertexArray(vao);
   gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
   gl.uniform2f(u.u_brow0,points.brows[0].x,points.brows[0].y);
   gl.uniform2f(u.u_brow1,points.brows[1].x,points.brows[1].y);
   gl.uniform2f(u.u_mouth0,points.mouth[0].x,points.mouth[0].y);
   gl.uniform2f(u.u_mouth1,points.mouth[1].x,points.mouth[1].y);
   gl.uniform1f(u.u_eyeSpan,points.eyeSpan);
   gl.uniform1f(u.u_aspect,this.canvas.width/this.canvas.height);
   gl.uniform1f(u.u_raise,Math.max(0,Math.min(1,brow))*.028);
   gl.uniform1f(u.u_smile,Math.max(0,Math.min(1,smile))*.016);
   gl.uniform2f(u.u_eye0,points.eyes[0].x,points.eyes[0].y);
   gl.uniform2f(u.u_eye1,points.eyes[1].x,points.eyes[1].y);
   gl.uniform2f(u.u_eyeSize0,points.eyeSizes[0].x,points.eyeSizes[0].y);
   gl.uniform2f(u.u_eyeSize1,points.eyeSizes[1].x,points.eyeSizes[1].y);
   gl.uniform1f(u.u_blink,Math.max(0,Math.min(1,blink)));
   gl.drawArrays(gl.TRIANGLES,0,6);
   return this.canvas;
  }catch(err){
   this.failed=err?.message||String(err);
   this.ready=false;
   console.warn('VIVA AI: disegno WebGL interrotto, ripristino ritratto originale.',err);
   return null;
  }
 }
 dispose(){
  if(this.gl){
   try{this.gl.deleteTexture(this.texture);this.gl.deleteProgram(this.program);}catch{}
  }
  this.gl=null;this.ready=false;this.points=null;
 }
}
