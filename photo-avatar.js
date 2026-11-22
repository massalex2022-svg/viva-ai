/* VIVA AI 2.3 — anteprima labbra, palpebre e micro-movimenti su fotografia, elaborazione nel browser.
   MediaPipe rileva punti del volto, poi Web Audio guida un'apertura 2D approssimata della bocca.
   Nessuna foto viene caricata su un server per l'animazione. Non è un video AI fotorealistico. */
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
// Stessa versione e doppio CDN del laboratorio WebGL verificato sul Chromebook.
const VISION_VERSION = '0.10.21';
const VISION_CDNS = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@'+VISION_VERSION,
  'https://unpkg.com/@mediapipe/tasks-vision@'+VISION_VERSION
];
let landmarkerPromise;
function getLandmarker() {
  if(!landmarkerPromise){
    landmarkerPromise=(async()=>{
      const errors=[];
      for(const base of VISION_CDNS){
        try{
          const vision=await import(base+'/vision_bundle.mjs');
          const files=await vision.FilesetResolver.forVisionTasks(base+'/wasm');
          return await vision.FaceLandmarker.createFromOptions(files,{
            baseOptions:{modelAssetPath:FACE_MODEL,delegate:'CPU'},
            runningMode:'IMAGE',numFaces:1,outputFaceBlendshapes:false
          });
        }catch(err){
          errors.push((err?.message||String(err)));
          console.warn('VIVA AI MediaPipe: provo il server alternativo.',err);
        }
      }
      throw Error('Rilevamento automatico non raggiungibile. '+errors.join(' | '));
    })().catch(err=>{landmarkerPromise=null;throw err});
  }
  return landmarkerPromise;
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

export class PhotoAvatarMotion {
  constructor({photo, canvas, audio, status}) {
    this.photo=photo; this.canvas=canvas; this.audio=audio; this.status=status;
    this.ctx=canvas.getContext('2d', {alpha:false});
    this.enabled=true; this.mode='basic'; this.ready=false; this.mouth=null;
    this.source=null; this.frame=0; this.seq=0; this.level=0;
    this.shape=.48; this.intensity=1.20; this.browIntensity=.35; this.freq=null;
    this.eyes=[];this.blinkEnabled=false;this.headEnabled=false;
    this.expressionEnabled=false;this.browAnchors=[];this.browPatches=[];this.expressionTimer=null;
    // WebGL è opzionale: il modulo viene caricato solo attivando le espressioni 2.0.
    this.warp=null;this.warpConstructor=null;this.warpModulePromise=null;this.warpRaise=0;this.warpSmile=0;
    this.expressionDemoStart=0;this.expressionDemoUntil=0;this.voiceExpressionStart=0;
    this.blinkStart=-1;this.blinkTimer=null;this.blinkAmount=0;this.blinkDuration=245;
    this.browserSpeaking=false; this.browserStart=0;
    this.demoUntil=0;this.demoStart=0;this.manualPending=false;
    this.eyePending=false;this.eyeClicks=[];this.blinkTestTimer=null;
    this.diagTimer=null;this.diagOverlay=document.getElementById('eye-diagnostic-overlay');
    this.lidLayer=document.getElementById('eye-lid-layer');this.lidPatches=[];
    this.browLayer=document.getElementById('brow-motion-layer');
    this.analyser=null; this.audioContext=null; this.samples=null;
    audio.addEventListener('play', () => { void this.onAudioPlay(); });
    audio.addEventListener('pause', () => this.onAudioStop());
    audio.addEventListener('ended', () => this.onAudioStop());
    this.paint= this.paint.bind(this);
    this.photo.addEventListener('click',ev=>{if(this.eyePending)this.placeManualEye(ev);else this.placeManualMouth(ev);});
    this.selectLayer=document.getElementById('face-select-layer');
    this.selectPrompt=document.getElementById('face-select-prompt');
    this.selectMarkers=document.getElementById('face-select-markers');
    this.selectLayer.addEventListener('pointerdown',ev=>{
      ev.preventDefault();
      if(this.eyePending)this.placeManualEye(ev);
      else if(this.manualPending)this.placeManualMouth(ev);
    });
  }
  isVisible() { return this.enabled && this.mode==='basic' && !!this.source && (!!this.mouth || this.eyes.length>0); }
  useWarpBlink() { return false; } // Battito disattivato: scelta esplicita per evitare artefatti.
  updateDisplay() {
    const editing=this.manualPending||this.eyePending;
    const showingCanvas=this.isVisible()&&!editing;
    this.canvas.hidden=!showingCanvas;
    if(this.photo.src && this.mode==='basic')this.photo.hidden=showingCanvas;
    if(this.lidLayer)this.lidLayer.hidden=true; // Nessuna palpebra sovrapposta.
    if(this.browLayer)this.browLayer.hidden=true; // Vecchie patch CSS disattivate: deformazione WebGL sul canvas.
    const selecting=editing&&this.mode==='basic'&&this.enabled&&!!this.photo.src;
    this.selectLayer.hidden=!selecting;
    if(selecting){
      this.selectPrompt.textContent=this.eyePending
        ?(this.eyeClicks.length===0?'🎯 CLICCA SUL PRIMO OCCHIO':'🎯 CLICCA SUL SECONDO OCCHIO')
        :'🎯 CLICCA AL CENTRO DELLA BOCCA';
    } else {
      this.selectMarkers.replaceChildren();
    }
  }
  showMarker(ev) {
    if(this.selectLayer.hidden)return;
    const r=this.selectLayer.getBoundingClientRect();
    const marker=document.createElement('span');
    marker.className='face-pick-marker';
    marker.style.left=((ev.clientX-r.left)/r.width*100)+'%';
    marker.style.top=((ev.clientY-r.top)/r.height*100)+'%';
    marker.textContent=String(this.eyeClicks.length);
    this.selectMarkers.appendChild(marker);
  }
  async loadPhoto() {
    const seq=++this.seq;
    this.ready=false; this.mouth=null;this.eyes=[];this.browAnchors=[];this.warpRaise=0;this.warpSmile=0;if(this.warp)this.warp.ready=false;this.stopExpressions();this.clearBrows();this.resetHeadPose();this.clearBlink();this.clearEyeDiagnosis();this.clearLids();
    this.manualPending=false;this.eyePending=false;this.eyeClicks=[];
    this.photo.classList.remove('select-mouth');this.onAudioStop();
    this.updateDisplay();
    if (!this.enabled) { this.status('Animazione disattivata: attivala per rilevare il volto.'); return; }
    try {
      if (!this.photo.complete || !this.photo.naturalWidth) await this.photo.decode();
      if(seq!==this.seq)return;
      this.status('Individuo bocca e lineamenti sulla foto (gratuito)...');
      const detector=await getLandmarker();
      if(seq!==this.seq)return;
      const faces=detector.detect(this.photo).faceLandmarks;
      if (!faces?.length) throw Error('volto non riconosciuto. Prova una foto frontale, ben illuminata e con una sola persona.');
      const points=faces[0];
      const w=Math.min(this.photo.naturalWidth, 900);
      const scale=w/this.photo.naturalWidth;
      const h=Math.round(this.photo.naturalHeight*scale);
      this.canvas.width=w; this.canvas.height=h;
      this.source=document.createElement('canvas');
      this.source.width=w;this.source.height=h;
      this.source.getContext('2d').drawImage(this.photo,0,0,w,h);
      const pt=i=>({x:points[i].x*w,y:points[i].y*h});
      const left=pt(61), right=pt(291), upper=pt(13), lower=pt(14), lip=pt(17);
      const width=Math.hypot(right.x-left.x,right.y-left.y);
      if(width<12 || !Number.isFinite(width))throw Error('bocca troppo piccola. Usa un primo piano frontale.');
      this.mouth={
        cx:(left.x+right.x)*.5,
        top:Math.min(upper.y,lower.y),
        bottom:Math.max(upper.y,lower.y),
        outer:Math.max(lip.y,lower.y+width*.07),
        width
      };
      this.eyes=this.prepareEyes(points,w,h);
      // FaceMesh: i punti 105 e 334 sono sulla zona delle sopracciglia.
      // Associamo ciascun sopracciglio all'occhio più vicino nell'immagine.
      const brows=[pt(105),pt(334)];
      this.browAnchors=this.eyes.map(eye=>brows.reduce((best,p)=>
        Math.abs(p.x-eye.cx)<Math.abs(best.x-eye.cx)?p:best,brows[0]));
      this.ready=true;
      this.setupLids();this.setupBrows();
      if(this.expressionEnabled)void this.prepareWarp();
      this.level=0; this.draw(0); this.updateDisplay();
      this.scheduleBlink();
      this.status(this.eyes.length===2
        ? 'Bocca e occhi riconosciuti. Prova «Battito di palpebre» o avvia Gemini.'
        : 'Bocca riconosciuta; occhi non rilevati con sufficiente precisione. Usa una fotografia frontale per i battiti.');
    } catch (e) {
      if(seq!==this.seq)return;
      this.ready=false;this.updateDisplay();
      this.status('Rilevamento automatico non riuscito: '+(e?.message||'errore del rilevamento')+' Puoi premere «Indica la bocca sulla foto».');
    }
  }
  pickMouth() {
    if(!this.photo.src || !this.photo.naturalWidth){
      this.status('Prima carica una foto con il volto ben visibile.');return;
    }
    ++this.seq; // Ignora eventuale riconoscimento automatico ancora in corso.
    this.reset();this.clearBlink();this.clearEyeDiagnosis();this.eyePending=false;this.eyeClicks=[];
    this.ready=false;
    this.manualPending=true;
    this.updateDisplay();
    this.photo.classList.add('select-mouth');
    this.status('Clicca esattamente al centro della bocca nella fotografia. Poi usa «Prova il movimento».');
  }
  pointFromClick(ev) {
    const nw=this.photo.naturalWidth,nh=this.photo.naturalHeight;
    if(!nw||!nh)return null;
    const w=Math.min(nw,900),h=Math.round(nh*w/nw);
    const rect=this.photo.getBoundingClientRect();
    if(rect.width<=0||rect.height<=0)return null;
    const scale=Math.max(rect.width/nw,rect.height/nh);
    const offsetX=(rect.width-nw*scale)*.5;
    const offsetY=(rect.height-nh*scale)*.3;
    const x=(ev.clientX-rect.left-offsetX)/scale*w/nw;
    const y=(ev.clientY-rect.top-offsetY)/scale*h/nh;
    return (x>=0&&x<w&&y>=0&&y<h)?{x,y,w,h}:null;
  }
  placeManualMouth(ev) {
    if(!this.manualPending || !this.enabled)return;
    const point=this.pointFromClick(ev);
    if(!point){this.status('Clicca all’interno del volto, al centro delle labbra.');return;}
    const {x,y,w,h}=point;
    this.canvas.width=w;this.canvas.height=h;
    this.source=document.createElement('canvas');
    this.source.width=w;this.source.height=h;
    this.source.getContext('2d').drawImage(this.photo,0,0,w,h);
    const width=clamp(w*.13,22,Math.max(23,w*.2));
    this.mouth={cx:x,top:y-width*.022,bottom:y+width*.022,outer:y+width*.16,width};
    this.ready=true;this.manualPending=false;this.photo.classList.remove('select-mouth');
    this.setupLids();this.setupBrows();
    if(this.warp)this.warp.ready=false;
    if(this.expressionEnabled)void this.prepareWarp();
    this.draw(0);this.updateDisplay();
    if(this.eyes.length)this.scheduleBlink();
    this.status(this.eyes.length===2
      ?'Bocca e occhi impostati. Premi «Prova battito palpebre».'
      :'Bocca impostata. Per i battiti premi «Indica gli occhi» e clicca su entrambi.');
  }
  pickEyes() {
    if(!this.enabled){this.status('Attiva «Anima le labbra» prima.');return;}
    if(!this.photo.src||!this.photo.naturalWidth){this.status('Carica prima una foto con gli occhi visibili.');return;}
    ++this.seq; // Non permettere al riconoscimento in corso di sovrascrivere la selezione.
    this.clearBlink();this.clearEyeDiagnosis();this.stopExpressions();this.clearBrows();this.reset();
    if(!this.source){
      const w=Math.min(this.photo.naturalWidth,900),h=Math.round(this.photo.naturalHeight*w/this.photo.naturalWidth);
      this.canvas.width=w;this.canvas.height=h;
      this.source=document.createElement('canvas');
      this.source.width=w;this.source.height=h;
      this.source.getContext('2d').drawImage(this.photo,0,0,w,h);
    }
    this.manualPending=false;this.eyePending=true;this.eyeClicks=[];
    this.photo.classList.add('select-mouth');
    this.updateDisplay();
    this.status('Mirino attivo sulla foto: clicca sul PRIMO occhio, poi sull’ALTRO.');
  }
  placeManualEye(ev) {
    if(!this.eyePending||!this.enabled)return;
    const point=this.pointFromClick(ev);
    if(!point){this.status('Clicca al centro dell’occhio dentro la foto.');return;}
    this.eyeClicks.push(point);
    this.showMarker(ev);
    if(this.eyeClicks.length<2){
      this.updateDisplay();
      this.status('Primo occhio segnato! Ora clicca al centro dell’ALTRO occhio.');return;
    }
    const [first,second]=this.eyeClicks;
    const sep=Math.hypot(first.x-second.x,first.y-second.y);
    const photoW=Math.min(this.photo.naturalWidth,900);
    if(sep<photoW*.06){
      this.eyeClicks=[];
      this.selectMarkers.replaceChildren();
      this.updateDisplay();
      this.status('I due clic sono troppo vicini. Seleziona di nuovo i due occhi.');return;
    }
    const mouthWidth=this.mouth?.width||photoW*.09;
    const eyeWidth=clamp(Math.min(mouthWidth*.76,sep*.58),Math.max(12,photoW*.022),photoW*.16);
    const angle=Math.atan2(second.y-first.y,second.x-first.x);
    this.eyes=[first,second].map(p=>({cx:p.x,cy:p.y,width:eyeWidth,height:eyeWidth*.20,angle}));
    this.browAnchors=[]; // Le stime automatiche non valgono per occhi indicati manualmente.
    this.eyePending=false;this.eyeClicks=[];
    this.photo.classList.remove('select-mouth');
    this.ready=true;
    this.setupLids();this.setupBrows();
    if(this.warp)this.warp.ready=false;
    if(this.expressionEnabled)void this.prepareWarp();
    this.updateDisplay();
    this.draw(this.level,this.shape);this.scheduleBlink();
    this.status('Occhi posizionati! Premi «Prova battito palpebre»: ora funziona anche senza selezionare la bocca.');
  }
  testMotion() {
    if(!this.enabled){this.status('Attiva prima «Anima le labbra».');return;}
    if(!this.ready){this.status('Il volto non è pronto: premi «Indica la bocca sulla foto», clicca sulla bocca e riprova.');return;}
    this.demoStart=performance.now();
    this.demoUntil=this.demoStart+3200;
    this.status('TEST: movimento più morbido, con aperture diverse e pause. Osserva soprattutto la naturalezza delle labbra.');
    this.run();
  }
  prepareEyes(points,w,h) {
    // Facemesh: 33/133 e 362/263 sono gli angoli; 159/145 e 386/374 le palpebre.
    const groups=[[33,133,159,145],[362,263,386,374]];
    const eyeList=[];
    for(const [a,b,up,down] of groups){
      const p=i=>({x:points[i].x*w,y:points[i].y*h});
      const left=p(a),right=p(b),upper=p(up),lower=p(down);
      const span=Math.hypot(right.x-left.x,right.y-left.y);
      const opening=Math.hypot(lower.x-upper.x,lower.y-upper.y);
      if(!Number.isFinite(span)||span<16||opening<2.4||opening>span*.48)continue;
      const cx=(left.x+right.x)*.5,cy=(upper.y+lower.y)*.5;
      const angle=Math.atan2(right.y-left.y,right.x-left.x);
      // Evita che la toppa oltrepassi i confini della fotografia.
      if(cx-span*.64<0||cx+span*.64>w||cy-opening*2<0||cy+opening*2>h)continue;
      eyeList.push({cx,cy,width:span,height:opening,angle});
    }
    return eyeList;
  }
  clearBrows() {
    this.browPatches=[];
    if(this.browLayer){this.browLayer.replaceChildren();this.browLayer.hidden=true;}
  }
  setupBrows() { this.clearBrows(); } // vecchie patch eliminate (erano quasi invisibili).
  stopExpressions() {
    if(this.expressionTimer!==null)clearTimeout(this.expressionTimer);
    this.expressionTimer=null;
    this.expressionDemoUntil=0;
    this.warpRaise=0;this.warpSmile=0;
  }
  scheduleExpression() { /* Ora l'animazione è temporizzata nel ciclo voce. */ }
  setupWarp() {
    if(!this.warp||!this.expressionEnabled||!this.source||this.eyes.length!==2)return false;
    const eyes=this.eyes.map(e=>({x:e.cx,y:e.cy,width:e.width,height:e.height}));
    const brows=this.eyes.map((e,i)=>this.browAnchors[i]??{x:e.cx,y:e.cy-Math.max(10,e.height*2.55)});
    let mouthCorners;
    if(this.mouth){
      mouthCorners=[
        {x:this.mouth.cx-this.mouth.width*.5,y:(this.mouth.top+this.mouth.bottom)*.5},
        {x:this.mouth.cx+this.mouth.width*.5,y:(this.mouth.top+this.mouth.bottom)*.5}
      ];
    }else{
      const mid=(eyes[0].x+eyes[1].x)*.5;
      const distance=Math.hypot(eyes[0].x-eyes[1].x,eyes[0].y-eyes[1].y);
      const y=(eyes[0].y+eyes[1].y)*.5+distance*.65;
      mouthCorners=[{x:mid-distance*.2,y},{x:mid+distance*.2,y}];
    }
    return this.warp.configure(this.source,eyes,brows,mouthCorners);
  }
  async prepareWarp() {
    if(!this.expressionEnabled)return false;
    if(!this.source||this.eyes.length!==2){
      this.status('Per le espressioni WebGL carica una foto e indica entrambi gli occhi.');
      return false;
    }
    if(this.warp?.ready)return true;
    try{
      if(!this.warpConstructor){
        if(!this.warpModulePromise)this.warpModulePromise=import('./face-warp.js?v=220');
        const module=await this.warpModulePromise;
        if(!this.expressionEnabled)return false;
        this.warpConstructor=module.FaceWarp;
        if(!this.warpConstructor)throw Error('Modulo WebGL non valido.');
      }
      if(!this.warp)this.warp=new this.warpConstructor();
      const ok=this.setupWarp();
      if(!ok){
        this.status('Espressioni WebGL non disponibili: '+(this.warp.failed||'coordinate non pronte')+'. Gemini, labbra e palpebre restano utilizzabili.');
        return false;
      }
      this.updateDisplay();
      if(this.ready)this.draw(this.level,this.shape);
      this.status('Espressioni WebGL 2.2 pronte: occhi, sopracciglia e sorriso sono deformati nella foto.');
      return true;
    }catch(err){
      this.warpModulePromise=null;
      console.warn('VIVA AI WebGL disattivato, versione classica intatta:',err);
      this.status('Non riesco a caricare le espressioni WebGL: '+(err?.message||err)+'. Gemini, labbra e palpebre continuano a funzionare.');
      return false;
    }
  }
  setExpressionEnabled(value) {
    this.expressionEnabled=Boolean(value);
    this.stopExpressions();
    this.clearBrows();
    if(this.expressionEnabled){void this.prepareWarp();}
    else {this.draw(this.level,this.shape);this.status('WebGL disattivato. Ripristinate le palpebre classiche; voce e labbra restano attive.');}
    this.updateDisplay();
  }
  async testExpression() {
    if(!this.expressionEnabled){
      this.status('Attiva prima «Espressioni 2.0 · WebGL», poi premi di nuovo il pulsante.');
      return;
    }
    if(!await this.prepareWarp())return;
    this.expressionDemoStart=performance.now();
    this.expressionDemoUntil=this.expressionDemoStart+3100;
    this.status('TEST WebGL: prima si alzano le sopracciglia, poi compare un lieve sorriso. Le intensità sono ora separate.');
    this.run();
  }
  updateWarpMotion(time,speaking,demonstrating) {
    if(!this.expressionEnabled||!this.warp?.ready){this.warpRaise=0;this.warpSmile=0;return;}
    const wave=(t,from,length)=>t>=from&&t<=from+length?Math.pow(Math.sin(Math.PI*(t-from)/length),1.15):0;
    const strength=clamp(this.browIntensity,0,1.5);
    if(demonstrating){
      const t=(time-this.expressionDemoStart)/1000;
      this.warpRaise=clamp(wave(t,.15,1.10)*.90*strength,0,1);
      this.warpSmile=clamp(wave(t,1.50,1.15)*.75*strength,0,1);
    }else if(speaking){
      const t=Math.max(0,(time-this.voiceExpressionStart)/1000);
      const phase=t%8.9;
      // Micro-espressioni intermittentI, non un sorriso stampato sulla faccia.
      this.warpRaise=clamp((wave(phase,.6,1.05)*.45+wave(phase,5.4,.92)*.32)*strength,0,.70);
      this.warpSmile=clamp(wave(phase,3.1,1.8)*.26*strength,0,.40);
      if(this.level>.32)this.warpSmile*=.30; // Evita che il sorriso alteri la sincronizzazione labiale.
    }else{
      this.warpRaise=0;this.warpSmile=0;
    }
  }
  resetHeadPose(){
    for(const node of [this.canvas,this.lidLayer,this.browLayer]){
      if(node?.style)node.style.transform='';
    }
  }
  updateHeadPose(time,active){
    if(!this.headEnabled||!active){this.resetHeadPose();return;}
    // Il movimento è minuscolo e coordinato fra ritratto e palpebre.
    const degrees=Math.sin(time/1900)*.11;
    const pose='rotate('+degrees.toFixed(3)+'deg) scale(1.003)';
    for(const node of [this.canvas,this.lidLayer]){
      if(node?.style)node.style.transform=pose;
    }
  }
  clearLids() {
    if(!this.lidLayer)return;
    this.lidPatches=[];
    this.lidLayer.replaceChildren();
    this.lidLayer.hidden=true;
  }
  skinColorAt(x,y) {
    // Colore locale preso dalla stessa foto (non un colore della pelle predefinito).
    const ctx=this.source?.getContext?.('2d',{willReadFrequently:true});
    if(!ctx)return 'rgb(179,145,129)';
    const sx=clamp(Math.round(x)-3,0,Math.max(0,this.canvas.width-7));
    const sy=clamp(Math.round(y)-3,0,Math.max(0,this.canvas.height-7));
    try {
      const px=ctx.getImageData(sx,sy,7,7).data;
      let r=0,g=0,b=0,n=0;
      for(let i=0;i<px.length;i+=4){
        if(px[i+3]<100)continue;
        r+=px[i];g+=px[i+1];b+=px[i+2];n++;
      }
      return n?'rgb('+Math.round(r/n)+','+Math.round(g/n)+','+Math.round(b/n)+')':'rgb(179,145,129)';
    }catch{return 'rgb(179,145,129)';}
  }
  skinTextureAt(eye,upper) {
    // Campione reale della pelle immediatamente sopra o sotto l'occhio.
    // Viene estratto solo nel browser, senza inviare immagini a servizi esterni.
    const source=this.source;
    if(!source?.width||!source?.height)return null;
    const span=eye.width*1.08;
    const band=Math.max(2,eye.height*.95);
    const startY=upper ? eye.cy-eye.height*2.18 : eye.cy+eye.height*1.20;
    const left=clamp(eye.cx-span/2,0,Math.max(0,source.width-span));
    const top=clamp(startY,0,Math.max(0,source.height-band));
    const width=Math.min(span,source.width-left),height=Math.min(band,source.height-top);
    if(width<3||height<2)return null;
    try{
      const texture=document.createElement('canvas');
      texture.width=Math.max(12,Math.round(eye.width*1.15));
      texture.height=Math.max(8,Math.round(eye.height*1.25));
      const ctx=texture.getContext('2d');
      if(!ctx)return null;
      ctx.imageSmoothingEnabled=true;
      ctx.imageSmoothingQuality='high';
      ctx.drawImage(source,left,top,width,height,0,0,texture.width,texture.height);
      return texture.toDataURL('image/png');
    }catch(err){console.warn('VIVA AI: texture palpebra non disponibile',err);return null;}
  }
  setupLids() {
    this.clearLids();
    if(!this.lidLayer||this.eyes.length!==2||!this.source||!this.canvas.width)return;
    const rect=this.lidLayer.parentElement?.getBoundingClientRect();
    if(!rect?.width||!rect?.height)return;
    const scale=Math.max(rect.width/this.canvas.width,rect.height/this.canvas.height);
    const offsetX=(rect.width-this.canvas.width*scale)*.5;
    const offsetY=(rect.height-this.canvas.height*scale)*.3;
    for(const eye of this.eyes){
      const patch=document.createElement('div');
      patch.className='eye-lid-patch';
      patch.style.left=(offsetX+eye.cx*scale)+'px';
      patch.style.top=(offsetY+eye.cy*scale)+'px';
      patch.style.width=(eye.width*scale*1.09)+'px';
      patch.style.height=(eye.height*scale*2.65)+'px';
      patch.style.setProperty('--eye-tilt',eye.angle+'rad');
      const top=document.createElement('div'),bottom=document.createElement('div'),seam=document.createElement('div');
      top.className='eye-lid-top';bottom.className='eye-lid-bottom';seam.className='eye-lid-seam';
      top.style.backgroundColor=this.skinColorAt(eye.cx,eye.cy-eye.height*1.7);
      bottom.style.backgroundColor=this.skinColorAt(eye.cx,eye.cy+eye.height*1.7);
      const upperSkin=this.skinTextureAt(eye,true);
      const lowerSkin=this.skinTextureAt(eye,false);
      if(upperSkin)top.style.backgroundImage='url("'+upperSkin+'")';
      if(lowerSkin)bottom.style.backgroundImage='url("'+lowerSkin+'")';
      patch.appendChild(top);patch.appendChild(bottom);patch.appendChild(seam);
      this.lidLayer.appendChild(patch);this.lidPatches.push(patch);
    }
    this.lidLayer.hidden=!this.isVisible()||!this.blinkEnabled||this.manualPending||this.eyePending;
  }
  playLidBlink(duration) {
    if(!this.lidPatches.length)this.setupLids();
    if(!this.lidPatches.length)return;
    for(const patch of this.lidPatches){
      patch.classList.remove('blink-now');
      patch.style.setProperty('--blink-duration',duration+'ms');
      // Riavvio indipendente dall'animazione canvas: evita i fotogrammi bloccati.
      void patch.offsetWidth;
      patch.classList.add('blink-now');
    }
  }
  clearBlink() {
    if(this.blinkTimer!==null)clearTimeout(this.blinkTimer);
    if(this.blinkTestTimer!==null)clearTimeout(this.blinkTestTimer);
    this.blinkTimer=null;this.blinkTestTimer=null;this.blinkStart=-1;this.blinkAmount=0;
    for(const patch of this.lidPatches)patch.classList.remove('blink-now');
  }
  scheduleBlink() {
    // Nessun battito automatico o timer: la foto degli occhi resta invariata.
    if(this.blinkTimer!==null)clearTimeout(this.blinkTimer);
    this.blinkTimer=null;this.blinkStart=-1;this.blinkAmount=0;
  }
  startBlink() { return false; } // Non attivabile neanche per errore.
  clearEyeDiagnosis() {
    if(this.diagTimer!==null)clearTimeout(this.diagTimer);
    this.diagTimer=null;
    if(this.diagOverlay){this.diagOverlay.hidden=true;this.diagOverlay.replaceChildren();}
  }
  showEyeDiagnosis() {
    if(!this.diagOverlay)return 'unavailable';
    this.clearEyeDiagnosis();
    const frame=this.diagOverlay.parentElement;
    const rect=frame?.getBoundingClientRect();
    if(!rect?.width||!rect?.height)return 'unavailable';
    const configured=Boolean(this.eyes.length===2 && this.source && this.canvas.width && this.canvas.height);
    const heading=document.createElement('div');
    heading.className='eye-diagnostic-heading';
    heading.textContent=configured
      ?'TEST VISIVO ATTIVO · CERCHI SUGLI OCCHI'
      :'TEST VISIVO ATTIVO · OCCHI NON CONFIGURATI';
    this.diagOverlay.appendChild(heading);
    const w=this.canvas.width,h=this.canvas.height;
    const scale=configured?Math.max(rect.width/w,rect.height/h):1;
    const offsetX=configured?(rect.width-w*scale)*.5:0;
    const offsetY=configured?(rect.height-h*scale)*.3:0;
    const positions=configured?this.eyes:[
      {cx:rect.width*.36,cy:rect.height*.39,width:38,height:14},
      {cx:rect.width*.64,cy:rect.height*.39,width:38,height:14}
    ];
    positions.forEach((eye,i)=>{
      const marker=document.createElement('div');
      marker.className='eye-diagnostic-marker';
      marker.textContent=String(i+1);
      const x=configured?offsetX+eye.cx*scale:eye.cx;
      const y=configured?offsetY+eye.cy*scale:eye.cy;
      marker.style.left=x+'px';
      marker.style.top=y+'px';
      marker.style.width=Math.max(42,eye.width*scale*1.5)+'px';
      marker.style.height=Math.max(32,eye.height*scale*4)+'px';
      this.diagOverlay.appendChild(marker);
    });
    this.diagOverlay.hidden=false;
    // Mantieni i riferimenti visivi abbastanza a lungo da poterli osservare.
    this.diagTimer=setTimeout(()=>this.clearEyeDiagnosis(),7500);
    return configured?'eyes':'preview';
  }
  setHeadEnabled(value) {
    this.headEnabled=Boolean(value);
    if(!this.headEnabled)this.resetHeadPose();
  }
  paintEyes(ctx, blink) {
    if(blink<=.01||!this.eyes.length)return;
    for(const eye of this.eyes){
      ctx.save();
      ctx.translate(eye.cx,eye.cy);
      ctx.rotate(eye.angle);
      const rx=eye.width*.49,half=eye.height*1.16;
      // Maschera locale e texture ricavata dalla pelle sopra la palpebra.
      // Resta una simulazione 2D, non una generazione 3D del volto.
      ctx.beginPath();
      ctx.ellipse(0,0,rx,half,0,0,Math.PI*2);
      ctx.clip();
      ctx.globalAlpha=Math.min(1,blink*1.04);
      ctx.rotate(-eye.angle);
      ctx.translate(-eye.cx,-eye.cy);
      const x=Math.max(0,eye.cx-eye.width*.52);
      const drawWidth=Math.min(this.canvas.width-x,eye.width*1.04);
      const sampleTop=Math.max(0,eye.cy-eye.height*2.6);
      const skinBand=Math.max(2,eye.height*.8);
      const targetTop=eye.cy-eye.height*1.25;
      const targetH=eye.height*2.5;
      ctx.drawImage(this.source,x,sampleTop,drawWidth,skinBand,x,targetTop,drawWidth,targetH);
      ctx.restore();
      // Linea della palpebra chiusa (molto sottile, senza oscurare l'occhio).
      if(blink>.42){
        ctx.save();ctx.translate(eye.cx,eye.cy);ctx.rotate(eye.angle);
        ctx.beginPath();
        ctx.moveTo(-rx*.9,0);
        ctx.quadraticCurveTo(0,eye.height*.18,rx*.9,0);
        ctx.strokeStyle='rgba(70,45,44,'+(blink*.39)+')';
        ctx.lineWidth=Math.max(.55,eye.width*.013);
        ctx.stroke();ctx.restore();
      }
    }
  }
  setIntensity(value) {
    this.intensity=clamp(Number(value)||1.2,.4,2.4);
    if(this.ready&&!this.frame)this.draw(this.level,this.shape);
  }
  setBrowIntensity(value) {
    this.browIntensity=clamp(Number(value)/100,0,1.5);
    if(this.ready&&!this.frame)this.draw(this.level,this.shape);
  }
  setMode(mode) {
    this.mode=mode;
    if(mode!=='basic'){this.stopExpressions();this.resetHeadPose();this.reset();this.clearBlink();this.manualPending=false;this.eyePending=false;this.eyeClicks=[];}
    else {this.setupLids();this.setupBrows();this.scheduleBlink();}
    this.updateDisplay();
  }
  setEnabled(value) {
    this.enabled=Boolean(value);
    if(!this.enabled){this.stopExpressions();this.resetHeadPose();this.reset();this.clearBlink();this.manualPending=false;this.eyePending=false;this.eyeClicks=[];this.photo.classList.remove('select-mouth');}
    if(this.enabled && !this.ready && this.photo.src) void this.loadPhoto();
    else {this.updateDisplay();if(this.enabled)this.scheduleBlink();}
  }
  setBrowserSpeaking(value) {
    this.browserSpeaking=Boolean(value);
    if(value){this.browserStart=performance.now();this.voiceExpressionStart=this.browserStart;this.run();}
    else {this.stopExpressions();this.resetHeadPose();this.reset();}
  }
  armAudio() {
    try {
      if(!this.analyser) {
        const AudioCtor=window.AudioContext||window.webkitAudioContext;
        if(!AudioCtor)throw Error('Web Audio non supportato');
        this.audioContext=new AudioCtor();
        const source=this.audioContext.createMediaElementSource(this.audio);
        this.analyser=this.audioContext.createAnalyser();
        this.analyser.fftSize=2048;
        this.analyser.smoothingTimeConstant=.52;
        source.connect(this.analyser);
        this.analyser.connect(this.audioContext.destination);
        this.samples=new Uint8Array(this.analyser.fftSize);
        this.freq=new Uint8Array(this.analyser.frequencyBinCount);
      }
      if(this.audioContext.state==='suspended')void this.audioContext.resume().catch(e=>console.warn(e));
    } catch(e) {
      console.warn('VIVA AI: analisi audio non disponibile',e);
    }
  }
  async onAudioPlay(){
    if(!this.isVisible())return;
    this.armAudio();this.voiceExpressionStart=performance.now();this.run();
  }
  onAudioStop(){
    if(!this.browserSpeaking){this.stopExpressions();this.resetHeadPose();}
    if(!this.browserSpeaking && this.demoUntil<performance.now() && this.blinkStart<0)this.reset();
  }
  run(){
    if(!this.isVisible()||this.frame)return;
    this.frame=requestAnimationFrame(this.paint);
  }
  reset(){
    if(this.frame)cancelAnimationFrame(this.frame);
    this.frame=0;this.level=0;this.shape=.48;
    this.warpRaise=0;this.warpSmile=0;
    this.resetHeadPose();
    if(this.ready)this.draw(0,this.shape);
  }
  paint(time){
    this.frame=0;
    if(!this.isVisible())return;
    const playing=!this.audio.paused && !this.audio.ended && !!this.audio.currentSrc;
    const demo=this.demoUntil>time;
    const blinking=false; // Nessuna chiusura degli occhi.
    const demoExpression=this.expressionDemoUntil>time;
    if(!playing && !this.browserSpeaking && !demo && !blinking && !demoExpression){this.reset();return;}
    this.updateHeadPose(time,playing||this.browserSpeaking);
    this.updateWarpMotion(time,playing||this.browserSpeaking,demoExpression);
    let target=0;
    let shapeTarget=.48;
    if(demo) {
      const t=(time-this.demoStart)/1000;
      const syllables=Math.pow(Math.max(0,Math.sin(t*10.8)),.8);
      target=clamp(.12+.8*syllables,0,1);
      shapeTarget=clamp(.5+.28*Math.sin(t*3.5),.14,.86);
    } else if(playing && this.analyser && this.audioContext?.state==='running'){
      this.analyser.getByteTimeDomainData(this.samples);
      let sum=0;
      for(const x of this.samples){const d=(x-128)/128;sum+=d*d;}
      const rms=Math.sqrt(sum/this.samples.length);
      // Noise gate e attacco/rilascio: la bocca si chiude nelle pause.
      target=clamp((rms-.015)*12,0,1);
      if(target<.07)target=0;
      if(this.freq){
        this.analyser.getByteFrequencyData(this.freq);
        const bins=this.freq.length;
        const hz=this.audioContext.sampleRate/this.analyser.fftSize;
        let low=0,high=0,nLow=0,nHigh=0;
        for(let i=Math.max(1,Math.floor(220/hz));i<Math.min(bins,Math.ceil(850/hz));i++){low+=this.freq[i];nLow++;}
        for(let i=Math.max(1,Math.floor(1000/hz));i<Math.min(bins,Math.ceil(2800/hz));i++){high+=this.freq[i];nHigh++;}
        const diff=(nHigh?high/nHigh:0)-(nLow?low/nLow:0);
        // Forma indicativa da timbro/energia: non è riconoscimento dei fonemi.
        shapeTarget=clamp(.53+diff/210,.22,.79);
      }
    } else if(this.browserSpeaking) {
      // La voce Chrome non fornisce l'onda audio; animazione indicativa.
      const t=(time-this.browserStart)/1000;
      target=clamp(.32+.3*Math.sin(t*12)+.15*Math.sin(t*5.7),0,1);
      shapeTarget=clamp(.5+.2*Math.sin(t*3.6),.22,.78);
    }
    const smoothing=target>this.level?.31:.19;
    this.level+=(target-this.level)*smoothing;
    this.shape+=(shapeTarget-this.shape)*.17;
    if(this.level<.035)this.level=0;
    this.draw(this.level,this.shape);
    this.frame=requestAnimationFrame(this.paint);
  }
  draw(openness,shape=.48) {
    if(!this.source)return;
    const ctx=this.ctx, m=this.mouth, w=this.canvas.width, h=this.canvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.save();
    // Gli eventuali movimenti della testa sono applicati a tutti gli strati DOM
    // in updateHeadPose(), non solo al canvas.
    let face=this.source;
    if(this.expressionEnabled&&this.warp?.ready&&(this.warpRaise>.001||this.warpSmile>.001)){
      face=this.warp.render(this.warpRaise,this.warpSmile)||this.source;
    }
    ctx.drawImage(face,0,0);
    // La fotografia degli occhi resta sempre originale; nessuna palpebra viene disegnata.
    const amount=m?clamp(openness*this.intensity,0,1):0;
    if(amount<.07||!m){ctx.restore();return;}

    const width=m.width;
    const x=m.cx;
    const middle=(m.top+m.bottom)*.5;
    const span=width*clamp(.75+(shape-.5)*.32,.66,.84);
    const radiusX=span*.5;
    const opening=width*(.014+.15*amount)*amount;
    const halfHeight=Math.max(.7,Math.min(width*.20,Math.max((m.bottom-m.top)*.5,0)+opening*.85));
    const cxLeft=x-radiusX,cxRight=x+radiusX;
    const lowerShift=clamp(opening*.48,0,width*.065);

    // Muovi lievemente il labbro inferiore usando texture dalla stessa fotografia.
    // La maschera arrotondata evita una cucitura rettangolare visibile.
    if(lowerShift>.6){
      const lipHeight=Math.max(width*.10,m.outer-m.bottom+width*.10);
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(x,m.bottom+lipHeight*.3,width*.48,lipHeight*.8+lowerShift*.6,0,0,Math.PI*2);
      ctx.clip();
      ctx.globalAlpha=clamp(amount*.68,0,.68);
      ctx.drawImage(this.source,0,lowerShift);
      ctx.restore();
    }

    // Fessura interna: curve di Bézier con angoli sottili, anziché un'ellisse nera.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cxLeft,middle);
    ctx.bezierCurveTo(x-radiusX*.61,middle-halfHeight*.87,x-radiusX*.25,middle-halfHeight,x,middle-halfHeight);
    ctx.bezierCurveTo(x+radiusX*.25,middle-halfHeight,x+radiusX*.61,middle-halfHeight*.87,cxRight,middle);
    ctx.bezierCurveTo(x+radiusX*.64,middle+halfHeight*.66,x+radiusX*.23,middle+halfHeight,x,middle+halfHeight);
    ctx.bezierCurveTo(x-radiusX*.23,middle+halfHeight,x-radiusX*.64,middle+halfHeight*.66,cxLeft,middle);
    ctx.closePath();
    const cavity=ctx.createLinearGradient(x,middle-halfHeight,x,middle+halfHeight);
    cavity.addColorStop(0,'#40252b');
    cavity.addColorStop(.43,'#25151a');
    cavity.addColorStop(1,'#5a333b');
    ctx.fillStyle=cavity;
    ctx.globalAlpha=clamp(amount*.91,0,.91);
    ctx.fill();

    // Leggera luce sul labbro inferiore, attenuata per evitare contorni caricaturali.
    ctx.beginPath();
    ctx.moveTo(x-radiusX*.78,middle+halfHeight*.39);
    ctx.quadraticCurveTo(x,middle+halfHeight*1.3,x+radiusX*.78,middle+halfHeight*.39);
    ctx.strokeStyle='rgba(199,135,137,.28)';
    ctx.lineWidth=Math.max(.5,width*.010)*clamp(amount,.1,1);
    ctx.stroke();
    ctx.restore();
    ctx.restore(); // trasformazione discreta del volto
  }
  dispose(){
    ++this.seq;this.stopExpressions();this.resetHeadPose();this.reset();this.clearBlink();this.clearEyeDiagnosis();this.clearLids();this.clearBrows();this.warp?.dispose();this.warp=null;this.eyePending=false;this.eyeClicks=[];
    try{this.audioContext?.close();}catch{}
  }
}
