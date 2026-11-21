/* VIVA AI 1.3 — anteprima labbra su fotografia, elaborazione nel browser.
   MediaPipe rileva punti del volto, poi Web Audio guida un'apertura 2D approssimata della bocca.
   Nessuna foto viene caricata su un server per l'animazione. Non è un video AI fotorealistico. */
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const VISION_VERSION = '0.10.22';
let landmarkerPromise;
function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VISION_VERSION + '/+esm');
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
    this.browserSpeaking=false; this.browserStart=0;
    this.analyser=null; this.audioContext=null; this.samples=null;
    audio.addEventListener('play', () => { void this.onAudioPlay(); });
    audio.addEventListener('pause', () => this.onAudioStop());
    audio.addEventListener('ended', () => this.onAudioStop());
    this.paint= this.paint.bind(this);
  }
  isVisible() { return this.ready && this.enabled && this.mode==='basic'; }
  updateDisplay() {
    this.canvas.hidden=!this.isVisible();
    if(this.isVisible()) this.photo.hidden=true;
    else if(this.photo.src && this.mode==='basic') this.photo.hidden=false;
  }
  async loadPhoto() {
    const seq=++this.seq;
    this.ready=false; this.mouth=null; this.onAudioStop();
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
      this.ready=true;
      this.level=0; this.draw(0); this.updateDisplay();
      this.status('Volto riconosciuto. Durante la voce Gemini la bocca seguirà il volume dell’audio.');
    } catch (e) {
      if(seq!==this.seq)return;
      this.ready=false;this.updateDisplay();
      this.status('Animazione non disponibile: '+(e?.message||'errore del rilevamento')+' La conversazione resta attiva.');
    }
  }
  setMode(mode) {
    this.mode=mode;
    if(mode!=='basic')this.reset();
    this.updateDisplay();
  }
  setEnabled(value) {
    this.enabled=Boolean(value);
    if(!this.enabled)this.reset();
    if(this.enabled && !this.ready && this.photo.src) void this.loadPhoto();
    else this.updateDisplay();
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
        this.analyser.fftSize=1024;
        this.analyser.smoothingTimeConstant=.72;
        source.connect(this.analyser);
        this.analyser.connect(this.audioContext.destination);
        this.samples=new Uint8Array(this.analyser.fftSize);
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
    if(!this.browserSpeaking)this.reset();
  }
  run(){
    if(!this.isVisible()||this.frame)return;
    this.frame=requestAnimationFrame(this.paint);
  }
  reset(){
    if(this.frame)cancelAnimationFrame(this.frame);
    this.frame=0;this.level=0;
    if(this.ready)this.draw(0);
  }
  paint(time){
    this.frame=0;
    if(!this.isVisible())return;
    const playing=!this.audio.paused && !this.audio.ended && !!this.audio.currentSrc;
    if(!playing && !this.browserSpeaking){this.reset();return;}
    let target=0;
    if(playing && this.analyser && this.audioContext?.state==='running'){
      this.analyser.getByteTimeDomainData(this.samples);
      let sum=0;
      for(const x of this.samples){const d=(x-128)/128;sum+=d*d;}
      target=clamp(Math.sqrt(sum/this.samples.length)*10,.0,1);
    } else if(this.browserSpeaking) {
      // Il browser non espone la forma d'onda della sintesi Chrome: movimento solo indicativo.
      const t=(time-this.browserStart)/1000;
      target=clamp(.45+.25*Math.sin(t*15)+.15*Math.sin(t*8.5),0,1);
    }
    this.level+=(target-this.level)*.36;
    this.draw(this.level);
    this.frame=requestAnimationFrame(this.paint);
  }
  draw(openness) {
    if(!this.source||!this.mouth)return;
    const ctx=this.ctx, m=this.mouth, w=this.canvas.width, h=this.canvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.drawImage(this.source,0,0);
    if(openness<.045)return;
    // La geometria è intenzionalmente leggera: apre lo spazio tra le labbra
    // e sposta una piccola porzione del labbro inferiore senza deformare tutto il ritratto.
    const width=m.width;
    const gap=Math.max(0,(width*.155)*openness);
    const innerTop=m.top;
    const lipBottom=m.bottom;
    const cx=m.cx;
    const rx=width*.40;
    const centerY=(innerTop+lipBottom+gap)*.5;
    const radiusY=Math.max(1.5,((lipBottom-innerTop)+gap)*.5);
    ctx.save();
    const grad=ctx.createLinearGradient(cx,innerTop,cx,lipBottom+gap);
    grad.addColorStop(0,'#261319');
    grad.addColorStop(.65,'#4c222c');
    grad.addColorStop(1,'#35171f');
    ctx.beginPath();
    ctx.ellipse(cx,centerY,rx,radiusY,0,0,Math.PI*2);
    ctx.fillStyle=grad;
    ctx.globalAlpha=clamp(openness*1.25,0,1);
    ctx.fill();
    ctx.restore();
    // Tratto inferiore delle labbra: ridisegnato qualche pixel più in basso.
    const fromY=clamp(Math.floor(lipBottom),0,h-2);
    const bandH=Math.min(h-fromY,Math.max(3,Math.round(m.outer-lipBottom+width*.11)));
    const fromX=clamp(Math.floor(cx-width*.52),0,w-2);
    const bandW=Math.min(w-fromX,Math.max(3,Math.round(width*1.04)));
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx,lipBottom+bandH*.35+gap*.35,width*.52,bandH*.78+gap*.5,0,0,Math.PI*2);
    ctx.clip();
    ctx.globalAlpha=clamp(openness*.94,0,1);
    ctx.drawImage(this.source,fromX,fromY,bandW,bandH,fromX,fromY+gap,bandW,bandH);
    ctx.restore();
  }
  dispose(){
    ++this.seq; this.reset();
    try{this.audioContext?.close();}catch{}
  }
}
