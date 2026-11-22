/* VIVA AI 2.0 LAB — deformazione reale dei pixel con WebGL2.
 * Non modifica app.js né photo-avatar.js. Nessuna foto esce dal browser.
 * Il primo prototipo mette a fuoco sopracciglia e sorriso, non il parlato.
 */
const $ = id => document.getElementById(id);
const status = $('status');
const canvas = $('warp-canvas');
const input = $('photo-file');
const strength = $('strength');
const strengthLabel = $('strength-label');
const original = $('original');
const automatic = $('automatic');
const testBrows = $('test-brows');
const testSmile = $('test-smile');

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
// Versione stabile e coerente fra bundle ESM e file WASM; seconda CDN automatica.
const MEDIAPIPE_SOURCES = [
 {name:'jsDelivr',module:'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs',wasm:'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm'},
 {name:'UNPKG',module:'https://unpkg.com/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs',wasm:'https://unpkg.com/@mediapipe/tasks-vision@0.10.21/wasm'}
];
const vertexShader = [
 '#version 300 es',
 'precision highp float;',
 'layout(location=0) in vec2 a_position;',
 'out vec2 v_uv;',
 'void main(){',
 'gl_Position=vec4(a_position,0.0,1.0);',
 'v_uv=vec2((a_position.x+1.0)*0.5,(1.0-a_position.y)*0.5);',
 '}'
].join('\n');
const fragmentShader = [
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
 'float softLocal(vec2 point,vec2 center,vec2 radius){',
 ' vec2 p=(point-center)/max(radius,vec2(0.0001));',
 ' return exp(-1.55*dot(p,p));',
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
 ' fragColor=texture(u_portrait,clamp(sampleUV,vec2(0.001),vec2(0.999)));',
 '}'
].join('\n');

let modelPromise=null;
function getModel(){
 if(!modelPromise){
  modelPromise=(async()=>{
   const failures=[];
   for(const source of MEDIAPIPE_SOURCES){
    try{
     showStatus('Caricamento riconoscimento facciale da '+source.name+'…');
     const vision=await import(source.module);
     if(!vision.FilesetResolver?.forVisionTasks||!vision.FaceLandmarker?.createFromOptions){
       throw Error('Il modulo non esporta le funzioni MediaPipe attese');
     }
     const files=await vision.FilesetResolver.forVisionTasks(source.wasm);
     const model=await vision.FaceLandmarker.createFromOptions(files,{
      baseOptions:{modelAssetPath:MODEL_URL,delegate:'CPU'},
      runningMode:'IMAGE',numFaces:1,outputFaceBlendshapes:false
     });
     showStatus('Riconoscimento facciale caricato tramite '+source.name+'. Analizzo la foto…');
     return model;
    }catch(err){
     failures.push(source.name+': '+(err?.message||String(err)));
     console.warn('VIVA AI 2.0: caricamento MediaPipe fallito da '+source.name,err);
    }
   }
   throw Error('MediaPipe non è raggiungibile da nessuno dei due server. '+failures.join(' | ')+' Verifica la connessione o eventuali blocchi del browser.');
  })().catch(e=>{modelPromise=null;throw e});
 }
 return modelPromise;
}
function showStatus(message,isError=false){
 status.textContent=message;
 status.classList.toggle('error',Boolean(isError));
}
function compile(gl,type,source){
 const shader=gl.createShader(type);
 gl.shaderSource(shader,source);
 gl.compileShader(shader);
 if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){
  const why=gl.getShaderInfoLog(shader);
  gl.deleteShader(shader);
  throw Error('Shader WebGL: '+why);
 }
 return shader;
}
function startGraphics(){
 const gl=canvas.getContext('webgl2',{alpha:false,antialias:true,preserveDrawingBuffer:false});
 if(!gl)throw Error('WebGL2 non disponibile sul dispositivo o disattivato in Chrome.');
 const vertex=compile(gl,gl.VERTEX_SHADER,vertexShader);
 const fragment=compile(gl,gl.FRAGMENT_SHADER,fragmentShader);
 const program=gl.createProgram();
 gl.attachShader(program,vertex);gl.attachShader(program,fragment);
 gl.linkProgram(program);
 gl.deleteShader(vertex);gl.deleteShader(fragment);
 if(!gl.getProgramParameter(program,gl.LINK_STATUS)){
  throw Error('Collegamento WebGL: '+gl.getProgramInfoLog(program));
 }
 const vao=gl.createVertexArray();
 gl.bindVertexArray(vao);
 const buffer=gl.createBuffer();
 gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
 gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([
   -1,-1, 1,-1, -1,1,
   -1, 1, 1,-1,  1,1
 ]),gl.STATIC_DRAW);
 gl.enableVertexAttribArray(0);
 gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
 const tex=gl.createTexture();
 gl.activeTexture(gl.TEXTURE0);
 gl.bindTexture(gl.TEXTURE_2D,tex);
 gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
 gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
 gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
 gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
 gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
 const names=['u_portrait','u_brow0','u_brow1','u_mouth0','u_mouth1','u_eyeSpan','u_aspect','u_raise','u_smile'];
 const u=Object.fromEntries(names.map(n=>[n,gl.getUniformLocation(program,n)]));
 gl.useProgram(program);
 gl.uniform1i(u.u_portrait,0);
 return {gl,program,vao,tex,u};
}
let graphics=null,landmarks=null,animationFrame=0,activeKind='',activeStart=0,autoStart=0;
let session=0;
function resetActions(){
 activeKind='';activeStart=0;autoStart=performance.now();
}
function configureModelPoints(points){
 const center=(a,b)=>({x:(points[a].x+points[b].x)*.5,y:(points[a].y+points[b].y)*.5});
 const eyes=[center(33,133),center(362,263)];
 const brows=[points[105],points[334]];
 const ordered=eyes.map(eye=>brows.reduce((best,p)=>Math.abs(p.x-eye.x)<Math.abs(best.x-eye.x)?p:best,brows[0]));
 const eyeSpan=Math.hypot(eyes[0].x-eyes[1].x,eyes[0].y-eyes[1].y);
 if(!Number.isFinite(eyeSpan)||eyeSpan<0.075)throw Error('Occhi troppo piccoli o non riconosciuti con precisione.');
 return {brows:ordered,mouth:[points[61],points[291]],eyeSpan};
}
async function loadPhoto(file){
 if(!file)return;
 const turn=++session;
 if(file.size>18*1024*1024){showStatus('Immagine troppo grande: utilizza un JPEG o PNG di massimo 18 MB.',true);return;}
 if(!/^image\/(jpeg|png|webp)$/.test(file.type)){showStatus('Formato non supportato. Usa JPEG, PNG o WebP.',true);return;}
 for(const el of [strength,testBrows,testSmile,original,automatic])el.disabled=true;
 showStatus('Carico la fotografia sul dispositivo…');
 const url=URL.createObjectURL(file);
 let img;
 try{
  img=new Image();
  img.decoding='async';
  img.src=url;
  await img.decode();
  if(turn!==session)return;
  if(!graphics)graphics=startGraphics();
  const {gl,tex}=graphics;
  const ratio=Math.min(1,1100/img.naturalWidth,1100/img.naturalHeight);
  const w=Math.max(1,Math.round(img.naturalWidth*ratio));
  const h=Math.max(1,Math.round(img.naturalHeight*ratio));
  canvas.width=w;canvas.height=h;
  gl.viewport(0,0,w,h);
  const source=document.createElement('canvas');
  source.width=w;source.height=h;
  source.getContext('2d').drawImage(img,0,0,w,h);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
  $('empty').hidden=true;
  canvas.hidden=false;
  $('stage').classList.add('active');
  landmarks=null;
  render(performance.now());
  showStatus('Fotografia caricata. Rilevo automaticamente occhi, sopracciglia e bocca: il primo avvio può richiedere qualche secondo…');
  const detector=await getModel();
  if(turn!==session)return;
  const result=detector.detect(img).faceLandmarks;
  if(!result||!result.length)throw Error('Non ho riconosciuto un volto frontale. Prova una foto più ravvicinata e illuminata.');
  landmarks=configureModelPoints(result[0]);
  for(const el of [strength,testBrows,testSmile,original,automatic])el.disabled=false;
  original.checked=false;automatic.checked=false;
  resetActions();
  showStatus('Volto rilevato! Premi «Alza sopracciglia». Il movimento deforma i pixel della fotografia, non sposta un ritaglio.');
 }catch(e){
  if(turn!==session)return;
  console.error('VIVA AI 2.0:',e);
  showStatus('Non riesco ad avviare la deformazione: '+(e.message||String(e))+' La versione Gemini rimane disponibile.',true);
 }finally{URL.revokeObjectURL(url);}
}
function pulse(now){
 if(!activeKind)return 0;
 const age=(now-activeStart)/1000;
 if(age>2.15){activeKind='';return 0;}
 const e=Math.pow(Math.max(0,Math.sin(Math.PI*age/2.15)),0.65);
 return e*Math.pow(Math.sin(Math.PI*age/1.05),2);
}
function autoPulse(now,kind){
 if(!automatic.checked)return 0;
 const phase=((now-autoStart)%7500)/1000;
 if(kind==='brows'&&phase>0.9&&phase<2.15)return .75*Math.sin(Math.PI*(phase-.9)/1.25);
 if(kind==='smile'&&phase>4.5&&phase<5.65)return .60*Math.sin(Math.PI*(phase-4.5)/1.15);
 return 0;
}
function render(now){
 if(!graphics||!canvas.width)return;
 const {gl,program,vao,tex,u}=graphics;
 gl.useProgram(program);
 gl.bindVertexArray(vao);
 gl.activeTexture(gl.TEXTURE0);
 gl.bindTexture(gl.TEXTURE_2D,tex);
 const aspect=canvas.width/canvas.height;
 let brow=0,smile=0;
 if(landmarks&&!original.checked){
  const amount=Number(strength.value)/100;
  const amountPulse=pulse(now);
  brow=amount*((activeKind==='brows'?amountPulse:0)+autoPulse(now,'brows'));
  smile=amount*((activeKind==='smile'?amountPulse:0)+autoPulse(now,'smile'));
  brow=Math.min(1,brow);
  smile=Math.min(1,smile);
 }
 const points=landmarks||{brows:[{x:.35,y:.35},{x:.65,y:.35}],mouth:[{x:.45,y:.65},{x:.55,y:.65}],eyeSpan:.3};
 gl.uniform2f(u.u_brow0,points.brows[0].x,points.brows[0].y);
 gl.uniform2f(u.u_brow1,points.brows[1].x,points.brows[1].y);
 gl.uniform2f(u.u_mouth0,points.mouth[0].x,points.mouth[0].y);
 gl.uniform2f(u.u_mouth1,points.mouth[1].x,points.mouth[1].y);
 gl.uniform1f(u.u_eyeSpan,points.eyeSpan);
 gl.uniform1f(u.u_aspect,aspect);
 gl.uniform1f(u.u_raise,brow*.028);
 gl.uniform1f(u.u_smile,smile*.016);
 gl.drawArrays(gl.TRIANGLES,0,6);
}
function tick(time){
 render(time);
 animationFrame=requestAnimationFrame(tick);
}
function begin(kind){
 if(!landmarks){showStatus('Prima carica un ritratto in cui il riconoscimento del volto riesca.',true);return;}
 activeKind=kind;
 activeStart=performance.now();
 original.checked=false;
 showStatus(kind==='brows'
  ?'PROVA ATTIVA: osserva le sopracciglia. La pelle si deforma insieme ai lineamenti; puoi aumentare l’intensità.'
  :'PROVA ATTIVA: osserva gli angoli della bocca e delle guance.');
}
input.addEventListener('change',e=>void loadPhoto(e.target.files?.[0]));
strength.addEventListener('input',()=>{strengthLabel.textContent=strength.value+'%';});
testBrows.addEventListener('click',()=>begin('brows'));
testSmile.addEventListener('click',()=>begin('smile'));
automatic.addEventListener('change',()=>{resetActions();showStatus(automatic.checked
 ?'Micro-espressioni automatiche attive: sopracciglia e sorriso si alternano lentamente.'
 :'Micro-espressioni automatiche disattivate. Puoi usare i pulsanti di prova.');});
original.addEventListener('change',()=>showStatus(original.checked
 ?'Confronto attivo: stai osservando la fotografia originale, senza deformazioni.'
 :'Confronto disattivato: puoi riprovare l’animazione.'));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)resetActions();});
animationFrame=requestAnimationFrame(tick);
