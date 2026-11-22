/* VIVA AI 1.4.6 — anteprima labbra, palpebre e micro-movimenti su fotografia, elaborazione nel browser.
   MediaPipe rileva punti del volto, poi Web Audio guida un'apertura 2D approssimata della bocca.
   Nessuna foto viene caricata su un server per l'animazione. Non è un video AI fotorealistico. */
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const VISION_VERSION = '0.10.22';
let landmarkerPromise;
function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VISION_VERSION + '/vision_bundle.mjs');
      const files = await vision.FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VISION_VERSION + '/wasm'
      );
      return await vision.FaceLandmarker.createFromOptions(files, {
        baseOptions: {modelAssetPath: FACE_MODEL, delegate: 'CPU'},
        runningMode: 'IMAGE', numFaces: 1, outputFaceBlendshapes: false
      });
    })().catch(e => { landmarkerPromise = null; throw e; });
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
    this.shape=.48; this.intensity=.75; this.freq=null;
    this.eyes=[];this.blinkEnabled=true;this.headEnabled=false;
    this.blinkStart=-1;this.blinkTimer=null;this.blinkAmount=0;this.blinkDuration=245;
    this.browserSpeaking=false; this.browserStart=0;
    this.demoUntil=0;this.demoStart=0;this.manualPending=false;
    this.eyePending=false;this.eyeClicks=[];this.blinkTestTimer=null;
    this.diagTimer=null;this.diagOverlay=document.getElementById('eye-diagnostic-overlay');
    this.lidLayer=document.getElementById('eye-lid-layer');this.lidPatches=[];
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
  updateDisplay() {
    const editing=this.manualPending||this.eyePending;
    const showingCanvas=this.isVisible()&&!editing;
    this.canvas.hidden=!showingCanvas;
    if(this.photo.src && this.mode==='basic')this.photo.hidden=showingCanvas;
    if(this.lidLayer)this.lidLayer.hidden=!showingCanvas || !this.blinkEnabled || this.eyes.length!==2;
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
    this.ready=false; this.mouth=null;this.eyes=[];this.clearBlink();this.clearEyeDiagnosis();this.clearLids();
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
      this.ready=true;
      this.setupLids();
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
    this.setupLids();
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
    this.clearBlink();this.clearEyeDiagnosis();this.reset();
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
    this.eyePending=false;this.eyeClicks=[];
    this.photo.classList.remove('select-mouth');
    this.ready=true;
    this.setupLids();
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
      patch.style.width=(eye.width*scale*1.16)+'px';
      patch.style.height=(eye.height*scale*3.0)+'px';
      patch.style.setProperty('--eye-tilt',eye.angle+'rad');
      const top=document.createElement('div'),bottom=document.createElement('div'),seam=document.createElement('div');
      top.className='eye-lid-top';bottom.className='eye-lid-bottom';seam.className='eye-lid-seam';
      top.style.backgroundColor=this.skinColorAt(eye.cx,eye.cy-eye.height*2.1);
      bottom.style.backgroundColor=this.skinColorAt(eye.cx,eye.cy+eye.height*2.2);
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
    if(this.blinkTimer!==null)clearTimeout(this.blinkTimer);
    this.blinkTimer=null;
    if(!this.blinkEnabled||!this.isVisible()||!this.eyes.length)return;
    this.blinkTimer=setTimeout(()=>{
      this.blinkTimer=null;
      if(document.hidden){this.scheduleBlink();return;}
      this.startBlink();
    },2600+Math.random()*3700);
  }
  startBlink(duration=245) {
    if(!this.isVisible()||!this.blinkEnabled||!this.eyes.length)return false;
    this.blinkDuration=duration;
    this.playLidBlink(duration);
    this.blinkStart=performance.now();
    this.blinkAmount=0;
    this.run();
    return true;
  }
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
  testBlink() {
    if(!this.photo.src||!this.photo.naturalWidth){
      this.status('TEST NON AVVIATO: carica prima la fotografia e attendi che compaia.');return;
    }
    this.clearEyeDiagnosis();
    if(this.eyes.length!==2){
      this.status('Seleziona prima i due occhi con «Indica gli occhi sulla foto».');return;
    }
    if(!this.blinkEnabled){
      this.status('Attiva prima la casella «Battito delle palpebre».');return;
    }
    if(!this.isVisible()){
      this.status('Animazione non pronta. Verifica che sia attiva la modalità «Voce AI + labbra 2D».');return;
    }
    this.setupLids();
    if(this.lidPatches.length!==2){
      this.status('Non riesco a mostrare le palpebre sulla foto. Inviami uno screenshot.');return;
    }
    this.status('TEST PALPEBRE: gli occhi si chiudono due volte lentamente. I cerchi verdi sono disattivati.');
    if(this.blinkTestTimer!==null)clearTimeout(this.blinkTestTimer);
    if(this.blinkTimer!==null)clearTimeout(this.blinkTimer);
    this.blinkTestTimer=null;this.blinkTimer=null;
    this.startBlink(1050);
    this.blinkTestTimer=setTimeout(()=>{
      this.blinkTestTimer=null;this.startBlink(1050);
    },1480);
  }
  setBlinkEnabled(value) {
    this.blinkEnabled=Boolean(value);
    this.clearBlink();
    if(this.lidLayer)this.lidLayer.hidden=!this.isVisible()||!this.blinkEnabled;
    if(this.blinkEnabled)this.scheduleBlink();
    if(this.ready)this.draw(this.level,this.shape);
  }
  setHeadEnabled(value) {
    this.headEnabled=Boolean(value);
    if(this.ready)this.draw(this.level,this.shape);
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
    this.intensity=clamp(Number(value)||.75,.35,1.25);
    if(this.ready&&!this.frame)this.draw(this.level,this.shape);
  }
  setMode(mode) {
    this.mode=mode;
    if(mode!=='basic'){this.reset();this.clearBlink();this.manualPending=false;this.eyePending=false;this.eyeClicks=[];}
    else {this.setupLids();this.scheduleBlink();}
    this.updateDisplay();
  }
  setEnabled(value) {
    this.enabled=Boolean(value);
    if(!this.enabled){this.reset();this.clearBlink();this.manualPending=false;this.eyePending=false;this.eyeClicks=[];this.photo.classList.remove('select-mouth');}
    if(this.enabled && !this.ready && this.photo.src) void this.loadPhoto();
    else {this.updateDisplay();if(this.enabled)this.scheduleBlink();}
  }
  setBrowserSpeaking(value) {
    this.browserSpeaking=Boolean(value);
    if(value){this.browserStart=performance.now();this.run();}
    else this.reset();
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
    this.armAudio();
    this.run();
  }
  onAudioStop(){
    if(!this.browserSpeaking && this.demoUntil<performance.now() && this.blinkStart<0)this.reset();
  }
  run(){
    if(!this.isVisible()||this.frame)return;
    this.frame=requestAnimationFrame(this.paint);
  }
  reset(){
    if(this.frame)cancelAnimationFrame(this.frame);
    this.frame=0;this.level=0;this.shape=.48;
    if(this.ready)this.draw(0,this.shape);
  }
  paint(time){
    this.frame=0;
    if(!this.isVisible())return;
    const playing=!this.audio.paused && !this.audio.ended && !!this.audio.currentSrc;
    const demo=this.demoUntil>time;
    const blinking=this.blinkStart>=0;
    if(!playing && !this.browserSpeaking && !demo && !blinking){this.reset();return;}
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
    if(blinking){
      const phase=(time-this.blinkStart)/this.blinkDuration;
      if(phase>=1){
        this.blinkStart=-1;this.blinkAmount=0;this.scheduleBlink();
      }else{
        // Contrazione rapida e riapertura più dolce.
        const t=clamp(phase,0,1);
        this.blinkAmount=Math.pow(Math.sin(Math.PI*t),1.25);
      }
    }
    this.draw(this.level,this.shape);
    this.frame=requestAnimationFrame(this.paint);
  }
  draw(openness,shape=.48) {
    if(!this.source)return;
    const ctx=this.ctx, m=this.mouth, w=this.canvas.width, h=this.canvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.save();
    if(this.headEnabled && this.level>.08){
      // Rotazione inferiore a 0.2 gradi, niente traslazione su/giù.
      const angle=Math.sin(performance.now()/1700)*.0024*this.level;
      ctx.translate(w*.5,h*.5);
      ctx.rotate(angle);
      ctx.scale(1.006,1.006);
      ctx.translate(-w*.5,-h*.5);
    }
    ctx.drawImage(this.source,0,0);
    if(!this.lidPatches.length)this.paintEyes(ctx,this.blinkAmount);
    const amount=m?clamp(openness*this.intensity,0,1):0;
    if(amount<.07||!m){ctx.restore();return;}

    const width=m.width;
    const x=m.cx;
    const middle=(m.top+m.bottom)*.5;
    const span=width*clamp(.75+(shape-.5)*.32,.66,.84);
    const radiusX=span*.5;
    const opening=width*(.015+.105*amount)*amount;
    const halfHeight=Math.max(.7,Math.min(width*.115,Math.max((m.bottom-m.top)*.5,0)+opening*.65));
    const cxLeft=x-radiusX,cxRight=x+radiusX;
    const lowerShift=clamp(opening*.46,0,width*.053);

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
    ++this.seq; this.reset();this.clearBlink();this.clearEyeDiagnosis();this.clearLids();this.eyePending=false;this.eyeClicks=[];
    try{this.audioContext?.close();}catch{}
  }
}
