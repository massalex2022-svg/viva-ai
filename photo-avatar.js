/* VIVA AI 1.4 — anteprima labbra, palpebre e micro-movimenti su fotografia, elaborazione nel browser.
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
    this.blinkStart=-1;this.blinkTimer=null;this.blinkAmount=0;
    this.browserSpeaking=false; this.browserStart=0;
    this.demoUntil=0;this.demoStart=0;this.manualPending=false;
    this.analyser=null; this.audioContext=null; this.samples=null;
    audio.addEventListener('play', () => { void this.onAudioPlay(); });
    audio.addEventListener('pause', () => this.onAudioStop());
    audio.addEventListener('ended', () => this.onAudioStop());
    this.paint= this.paint.bind(this);
    this.photo.addEventListener('click',ev=>this.placeManualMouth(ev));
  }
  isVisible() { return this.ready && this.enabled && this.mode==='basic'; }
  updateDisplay() {
    this.canvas.hidden=!this.isVisible();
    if(this.isVisible()) this.photo.hidden=true;
    else if(this.photo.src && this.mode==='basic') this.photo.hidden=false;
  }
  async loadPhoto() {
    const seq=++this.seq;
    this.ready=false; this.mouth=null;this.eyes=[];this.clearBlink(); this.manualPending=false; this.photo.classList.remove('select-mouth'); this.onAudioStop();
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
    this.reset();this.clearBlink();this.eyes=[];
    this.ready=false;
    this.manualPending=true;
    this.updateDisplay();
    this.photo.classList.add('select-mouth');
    this.status('Clicca esattamente al centro della bocca nella fotografia. Poi usa «Prova il movimento».');
  }
  placeManualMouth(ev) {
    if(!this.manualPending || !this.enabled)return;
    const nw=this.photo.naturalWidth,nh=this.photo.naturalHeight;
    if(!nw||!nh)return;
    const w=Math.min(nw,900),h=Math.round(nh*w/nw);
    const rect=this.photo.getBoundingClientRect();
    const scale=Math.max(rect.width/nw,rect.height/nh);
    const renderedW=nw*scale,renderedH=nh*scale;
    const offsetX=(rect.width-renderedW)*.5;
    const offsetY=(rect.height-renderedH)*.3; // object-position: center 30%
    const x=(ev.clientX-rect.left-offsetX)/scale*w/nw;
    const y=(ev.clientY-rect.top-offsetY)/scale*h/nh;
    if(x<0||y<0||x>=w||y>=h){this.status('Clicca all’interno del volto, al centro delle labbra.');return;}
    this.canvas.width=w;this.canvas.height=h;
    this.source=document.createElement('canvas');
    this.source.width=w;this.source.height=h;
    this.source.getContext('2d').drawImage(this.photo,0,0,w,h);
    const width=clamp(w*.13,22,Math.max(23,w*.2));
    this.mouth={cx:x,top:y-width*.022,bottom:y+width*.022,outer:y+width*.16,width};
    this.ready=true;this.manualPending=false;this.photo.classList.remove('select-mouth');
    this.status('Bocca impostata a mano. Il battito degli occhi richiede il rilevamento automatico del volto.');
    this.draw(0);this.updateDisplay();
    this.status('Bocca impostata manualmente. Ora prova il movimento; per i battiti degli occhi serve una foto riconosciuta automaticamente.');
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
  clearBlink() {
    if(this.blinkTimer!==null)clearTimeout(this.blinkTimer);
    this.blinkTimer=null;this.blinkStart=-1;this.blinkAmount=0;
  }
  scheduleBlink() {
    if(this.blinkTimer!==null)clearTimeout(this.blinkTimer);
    this.blinkTimer=null;
    if(!this.blinkEnabled||!this.enabled||!this.ready||!this.eyes.length||this.mode!=='basic')return;
    this.blinkTimer=setTimeout(()=>{
      this.blinkTimer=null;
      if(document.hidden){this.scheduleBlink();return;}
      this.startBlink();
    },2600+Math.random()*3700);
  }
  startBlink() {
    if(!this.isVisible()||!this.blinkEnabled||!this.eyes.length)return false;
    this.blinkStart=performance.now();
    this.run();
    return true;
  }
  testBlink() {
    if(!this.blinkEnabled){this.status('Attiva prima «Battito palpebre».');return;}
    if(!this.ready || !this.eyes.length){
      this.status('Non posso muovere le palpebre: serve una foto frontale con occhi riconosciuti automaticamente.');
      return;
    }
    this.status('TEST PALPEBRE: osserva gli occhi. Il battito dura circa un quarto di secondo.');
    this.startBlink();
  }
  setBlinkEnabled(value) {
    this.blinkEnabled=Boolean(value);
    this.clearBlink();
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
      const rx=eye.width*.47,half=eye.height*.83;
      // Maschera locale e texture ricavata dalla pelle sopra la palpebra.
      // Resta una simulazione 2D, non una generazione 3D del volto.
      ctx.beginPath();
      ctx.ellipse(0,0,rx,half,0,0,Math.PI*2);
      ctx.clip();
      ctx.globalAlpha=Math.min(.96,blink*.96);
      ctx.rotate(-eye.angle);
      ctx.translate(-eye.cx,-eye.cy);
      const x=Math.max(0,eye.cx-eye.width*.52);
      const drawWidth=Math.min(this.canvas.width-x,eye.width*1.04);
      const sampleTop=Math.max(0,eye.cy-eye.height*1.45);
      const skinBand=Math.max(1.5,eye.height*.38);
      const targetTop=eye.cy-eye.height*.9;
      const targetH=eye.height*1.8;
      ctx.drawImage(this.source,x,sampleTop,drawWidth,skinBand,x,targetTop,drawWidth,targetH);
      ctx.restore();
      // Linea della palpebra chiusa (molto sottile, senza oscurare l'occhio).
      if(blink>.56){
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
    if(mode!=='basic'){this.reset();this.clearBlink();}
    else this.scheduleBlink();
    this.updateDisplay();
  }
  setEnabled(value) {
    this.enabled=Boolean(value);
    if(!this.enabled){this.reset();this.clearBlink();this.manualPending=false;this.photo.classList.remove('select-mouth');}
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
    if(!this.browserSpeaking && this.demoUntil<performance.now())this.reset();
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
      const phase=(time-this.blinkStart)/245;
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
    if(!this.source||!this.mouth)return;
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
    this.paintEyes(ctx,this.blinkAmount);
    const amount=clamp(openness*this.intensity,0,1);
    if(amount<.07){ctx.restore();return;}

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
    ++this.seq; this.reset();this.clearBlink();
    try{this.audioContext?.close();}catch{}
  }
}
