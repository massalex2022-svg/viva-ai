import { PhotoAvatarMotion } from './photo-avatar.js?v=2110';
import { analyzeSpeechWav } from './lip-sync.js?v=250';
/* VIVA AI: interfaccia pubblica, nessuna API key privata nel browser. */
const $ = (id) => document.getElementById(id);
const state = {
  mode: 'basic', photo: null, photoUrl: null, manager: null,
  worker: localStorage.getItem('viva_worker') || '',
  token: sessionStorage.getItem('viva_token') || '',
  messages: [], active: false, busy: false, recognition: null,
  voices: [], lastAgentMessage: '', voiceSource:'standard', voiceFile:null, voicePreviewUrl:null,
  convertedVoiceFile:null, playingUrl:null, speechJob:0, voiceEngine:'gemini',
  lastSpokenText:'', browserUtterance:null, browserStartTimer:null, browserWatchdogTimer:null, browserRetryTimer:null,
  browserDiagnosticUtterance:null, browserDiagnosticTimer:null,
};

const motion = new PhotoAvatarMotion({
  photo: $('avatar-photo'),
  canvas: $('avatar-canvas'),
  audio: $('generated-audio'),
  status: message => $('photo-motion-status').textContent=message
});
// Le regolazioni della fotografia rimangono sul Chromebook, non nel Worker.
const MOTION_DEFAULTS={mouth:1.20,brow:35};
const MOTION_STORAGE={mouth:'viva_motion_mouth_24',brow:'viva_motion_brow_24'};
function readMotionValue(key,fallback,min,max){
  try{
    const raw=localStorage.getItem(key);
    if(raw===null)return fallback;
    const value=Number(raw);
    return Number.isFinite(value)&&value>=min&&value<=max?value:fallback;
  }catch{return fallback;}
}
function saveMotionValue(key,value){
  try{localStorage.setItem(key,String(value));}catch{}
}
function applyMotionValues(mouth,brow,save=false){
  const m=Math.max(.4,Math.min(2.4,Number(mouth)));
  const b=Math.max(0,Math.min(150,Number(brow)));
  $('motion-intensity').value=String(m);
  $('motion-intensity-label').textContent=Math.round(m*100)+'%';
  $('brow-intensity').value=String(b);
  $('brow-intensity-label').textContent=Math.round(b)+'%';
  motion.setIntensity(m);
  motion.setBrowIntensity(b);
  if(save){
    saveMotionValue(MOTION_STORAGE.mouth,m);
    saveMotionValue(MOTION_STORAGE.brow,b);
  }
}
// VIVA AI 2.6 — stile e variazione delle risposte. Nessuna chiamata aggiuntiva
// finché Gemini non produce una risposta molto simile alle precedenti.
const CONVERSATION_STYLES={
  natural:'Tono caldo, spontaneo e misurato, come un dialogo naturale.',
  lively:'Tono vivace, curioso e spiritoso quando opportuno, senza battute forzate.',
  concise:'Tono diretto e sintetico: preferisci risposte brevi ma complete.'
};
function conversationStyle(){
  const value=$('conversation-style').value;
  return Object.hasOwn(CONVERSATION_STYLES,value)?value:'natural';
}
function conversationalPersonality(repeated=false){
  const preferences=$('personality').value.trim();
  const guidance=[
    'Rispondi in italiano alla domanda concreta dell’ultimo messaggio.',
    'Mantieni continuità con il dialogo e rispetta la personalità scelta.',
    'Evita frasi preconfezionate, saluti continui, ripetizioni e domande generiche a ogni turno.',
    'Varia la formulazione e fai domande soltanto se utili.',
    'Non inventare fatti, esperienze o ricordi.',
    CONVERSATION_STYLES[conversationStyle()]
  ];
  if(repeated)guidance.push('La tua prima risposta a questa domanda ripeteva una risposta già data: rispondi con contenuto nuovo e pertinente, senza riciclare la stessa formula.');
  const guide=guidance.join(' ');
  const maxUser=Math.max(100,900-guide.length-2);
  return (preferences.slice(0,maxUser)+'\n\n'+guide).slice(0,900);
}
function normalizedReply(text){
  return String(text||'').toLocaleLowerCase('it-IT').normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
}
function resemblesRecentAnswer(answer,messages){
  const current=normalizedReply(answer);
  if(current.length<42)return false;
  const priorUsers=messages.filter(m=>m.role==='user').slice(-2);
  // Se la persona ha ripetuto volutamente la stessa domanda, non forzare una variante.
  if(priorUsers.length===2 && normalizedReply(priorUsers[0].text)===normalizedReply(priorUsers[1].text))return false;
  return messages.filter(m=>m.role==='model').slice(-4).some(m=>{
    const prev=normalizedReply(m.text);
    if(prev.length<42)return false;
    if(current===prev)return true;
    const shorter=current.length<prev.length?current:prev;
    const longer=current.length<prev.length?prev:current;
    if(shorter.length/longer.length<.75)return false;
    return longer.startsWith(shorter.slice(0,Math.floor(shorter.length*.88)));
  });
}
function status(message, error=false) {
  $('status-message').textContent = message;
  $('status-message').classList.toggle('error', error);
}
function settingsStatus(message, error=false) {
  $('settings-result').textContent = message;
  $('settings-result').classList.toggle('error', error);
}
function nameValue() { return $('avatar-name').value.trim().slice(0,50) || 'Avatar'; }
function updateName() { $('chat-name').textContent = nameValue(); }
function setConnection(ok,label) {
  $('connection-label').textContent = label;
  $('connection-label').closest('.chip').classList.toggle('ready', ok);
}
function addMessage(role, content) {
  if (!content || !content.trim()) return;
  const intro = $('chat-scroll').querySelector('.intro-bubble');
  if (intro) intro.remove();
  const node = document.createElement('div');
  node.className = 'message ' + (role==='user' ? 'user' : 'assistant');
  if (role!=='user') {
    const sender = document.createElement('span');
    sender.className='sender'; sender.textContent=nameValue().toUpperCase(); node.append(sender);
  }
  node.append(document.createTextNode(content));
  $('chat-scroll').append(node);
  $('chat-scroll').scrollTop = $('chat-scroll').scrollHeight;
  return node;
}
function voiceSourceChange(next) {
  if (state.active || state.busy) return status('Termina la conversazione prima di cambiare la voce.',true);
  state.voiceSource = next;
  for (const [id,value] of [['voice-standard','standard'],['voice-custom','custom']]) {
    $(id).classList.toggle('active',next===value);
    $(id).setAttribute('aria-pressed',String(next===value));
  }
  $('voice-standard-panel').hidden=next!=='standard';
  $('voice-custom-panel').hidden=next!=='custom';
  $('voice-choice').disabled=next==='custom' || (state.voiceEngine==='gemini'&&!ttsCooldownUntil());
  $('ai-voice-choice').disabled=next==='custom' || state.voiceEngine==='browser';
  status(next==='standard'
    ? 'Voce standard selezionata: gratuita, tramite il browser.'
    : 'Carica una voce autorizzata. Per generare risposte con quella voce serve un motore Chatterbox attivo.');
}
function uploadVoice(event) {
  const file=event.target.files?.[0];
  if(!file) return;
  const permitted=/\.(wav|mp3)$/i.test(file.name) &&
    ['audio/wav','audio/x-wav','audio/wave','audio/mpeg','audio/mp3',''].includes(file.type);
  if(!permitted) return status('Per il campione vocale usa un WAV o un MP3.',true);
  if(file.size>8*1024*1024 || !file.size) return status('L’audio deve pesare tra 1 byte e 8 MB.',true);
  if(state.voicePreviewUrl) URL.revokeObjectURL(state.voicePreviewUrl);
  state.voiceFile=file; state.convertedVoiceFile=null;
  state.voicePreviewUrl=URL.createObjectURL(file);
  $('voice-preview').src=state.voicePreviewUrl;
  $('voice-preview').hidden=false;
  $('voice-sample-info').textContent=`Pronto: ${file.name} · ${(file.size/1048576).toFixed(2)} MB. Premi ▶ per ascoltare il campione.`;
  status('Campione caricato solo nel browser. Non è ancora stato inviato al server.');
}
function clearBrowserSpeechTimers(){
  for(const timer of [state.browserStartTimer,state.browserWatchdogTimer,state.browserRetryTimer]){
    if(timer!==null)clearTimeout(timer);
  }
  state.browserStartTimer=null;state.browserWatchdogTimer=null;state.browserRetryTimer=null;
}
function stopSpokenAudio() {
  state.speechJob++;
  clearBrowserSpeechTimers();
  motion.setBrowserSpeaking(false);
  motion.clearSpeechTimeline();
  if('speechSynthesis' in window && (state.browserUtterance||speechSynthesis.speaking||speechSynthesis.pending)) {
    try{speechSynthesis.cancel();}catch(err){console.warn('VIVA AI: arresto voce Chrome non riuscito',err);}
  }
  state.browserUtterance=null;
  const audio=$('generated-audio');
  audio.pause(); audio.removeAttribute('src'); audio.load(); audio.hidden=true;
  if(state.playingUrl) URL.revokeObjectURL(state.playingUrl);
  state.playingUrl=null;
}
async function normalizedWav(file) {
  // Converte WAV e MP3 localmente in PCM mono/24kHz, fino a 15 sec.
  // Nessun audio viene trasmesso durante la conversione.
  const AudioCtor=window.AudioContext||window.webkitAudioContext;
  const OfflineCtor=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  if(!AudioCtor||!OfflineCtor) throw Error('Il browser non supporta la conversione audio. Apri VIVA AI in Chrome.');
  const context=new AudioCtor();
  let decoded;
  try { decoded=await context.decodeAudioData(await file.arrayBuffer()); }
  finally { await context.close(); }
  if(decoded.duration<2) throw Error('Il campione vocale deve durare almeno 2 secondi.');
  const samples=Math.ceil(Math.min(decoded.duration,15)*24000);
  const offline=new OfflineCtor(1,samples,24000);
  const source=offline.createBufferSource(); source.buffer=decoded; source.connect(offline.destination); source.start(0);
  const rendered=await offline.startRendering();
  const pcm=rendered.getChannelData(0);
  const buffer=new ArrayBuffer(44+pcm.length*2);
  const view=new DataView(buffer);
  const write=(offset,string)=>{for(let i=0;i<string.length;i++) view.setUint8(offset+i,string.charCodeAt(i));};
  write(0,'RIFF');view.setUint32(4,36+pcm.length*2,true);write(8,'WAVE');write(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,24000,true);view.setUint32(28,48000,true);view.setUint16(32,2,true);
  view.setUint16(34,16,true);write(36,'data');view.setUint32(40,pcm.length*2,true);
  for(let i=0;i<pcm.length;i++) {const sample=Math.max(-1,Math.min(1,pcm[i]));view.setInt16(44+i*2,sample<0?sample*32768:sample*32767,true);}
  return new File([buffer],'campione-autorizzato.wav',{type:'audio/wav'});
}
async function apiVoice(form) {
  const response=await fetch(state.worker+'/api/voice',{
    method:'POST',headers:{'x-app-token':state.token},body:form,
  });
  if(!response.ok) {
    let description='';
    try { const data=await response.json(); description=data.error||''; } catch {}
    throw Error(description || `Generazione vocale non disponibile (HTTP ${response.status}).`);
  }
  const contentType=response.headers.get('content-type')||'';
  if(!/audio\/(wav|x-wav|wave)/i.test(contentType)) throw Error('Il servizio vocale non ha restituito un file WAV.');
  const sound=await response.blob();
  if(!sound.size) throw Error('Il servizio vocale ha restituito audio vuoto.');
  return sound;
}
function modeChange(next) {
  if (state.active || state.busy) return status('Termina la conversazione corrente prima di cambiare modalità.',true);
  state.mode = next;
  motion.setMode(next);
  for (const [el, type] of [['mode-basic','basic'],['mode-live','live']]) {
    $(el).classList.toggle('active', type===next);
    $(el).setAttribute('aria-pressed', String(type===next));
  }
  $('mode-info').textContent = next==='basic'
    ? 'Anteprima gratuita: labbra sincronizzate alla voce e battiti delle palpebre opzionali. Movimento 2D, non un video fotorealistico.'
    : 'D-ID genera il video parlante da una foto (Talk V2) e sincronizza labbra e voce. Per espressioni ancora più naturali servirà integrare V4 Instant. Sono necessari crediti D-ID.';
  $('start-button').innerHTML = next==='basic' ? 'Avvia conversazione <span>↗</span>' : 'Crea avatar e avvia video <span>↗</span>';
}
async function uploadPhoto(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!['image/jpeg','image/png'].includes(file.type)) return status('Carica soltanto file JPG o PNG.',true);
  if (file.size>7*1024*1024) return status('L’immagine deve pesare meno di 7 MB.',true);
  if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
  state.photo = file; state.photoUrl = URL.createObjectURL(file);
  $('avatar-photo').src=state.photoUrl;
  $('avatar-photo').hidden=false;
  $('avatar-placeholder').hidden=true;
  $('avatar-placeholder').style.display='none';
  $('agent-video').hidden=true;
  $('live-tag').hidden=true;
  $('avatar-state').textContent = file.name;
  status('Fotografia caricata. Scegli la modalità e avvia la conversazione.');
  if(state.mode==='basic') void motion.loadPhoto();
}
function settingValues() {
  state.worker = $('worker-url').value.trim().replace(/\/+$/,'');
  state.token = $('access-token').value.trim();
  localStorage.setItem('viva_worker',state.worker);
  if (state.token) sessionStorage.setItem('viva_token',state.token);
  else sessionStorage.removeItem('viva_token');
}
async function api(path, payload, file=false) {
  if (!state.worker || !/^https?:\/\//i.test(state.worker)) throw Error('Inserisci un URL valido del Worker Cloudflare nelle impostazioni.');
  if (!state.token) throw Error('Inserisci il codice di accesso del Worker nelle impostazioni.');
  const response = await fetch(state.worker + path, {
    method: 'POST',
    headers: {...(file ? {} : {'content-type':'application/json'}), 'x-app-token':state.token},
    body: file ? payload : JSON.stringify(payload)
  });
  let data;
  try { data=await response.json(); } catch { throw Error('Il Worker non ha restituito JSON. Controlla indirizzo e distribuzione.'); }
  if (!response.ok || !data.ok) throw Error(data.error || `Errore HTTP ${response.status}`);
  return data;
}
function isTemporaryGeminiError(error) {
  const message=String(error?.message||error||'');
  return /high demand|server.*overload|temporar(?:ily|y) overloaded|service unavailable|503|UNAVAILABLE/i.test(message);
}
async function chatWithRetry(payload) {
  // Solo per /api/chat: piccoli retry con attesa progressiva sugli errori temporanei.
  // In caso di chiave errata, modello non disponibile (404) o quota esaurita (429),
  // restituisce subito il messaggio originale senza fare nuove richieste.
  for(let attempt=0;attempt<3;attempt++) {
    try {
      return await api('/api/chat',payload);
    } catch(err) {
      if (!isTemporaryGeminiError(err) || attempt===2) {
        if(isTemporaryGeminiError(err)) throw Error('Gemini è temporaneamente sovraccarico (503). Riprova più tardi: la domanda è rimasta nel campo di scrittura.');
        throw err;
      }
      status('Gemini è molto richiesto. Riprovo automaticamente ('+(attempt+1)+'/2)...');
      await new Promise(resolve=>setTimeout(resolve,attempt===0?1200:2800));
    }
  }
}

async function checkWorker() {
  settingValues();
  settingsStatus('Verifica in corso...');
  try {
    const data=await api('/api/status', {});
    settingsStatus(`Collegamento attivo. Gemini: ${data.gemini ? 'pronto' : 'non configurato'}. D-ID: ${data.did ? 'attivo (con possibili costi)' : 'non configurato'}. Chatterbox: ${data.voice ? 'collegato' : 'non collegato'}.`);
    $('voice-clone-status').textContent=data.voice ? 'Motore vocale configurato: puoi usare la voce autorizzata nelle risposte in modalità Voce AI.' : 'Motore Chatterbox non ancora collegato. Puoi caricare e ascoltare l’audio, ma non generare nuove risposte con quella voce.';
    setConnection(true, 'Cloudflare collegato');
  } catch(error) { settingsStatus(error.message,true); setConnection(false,'Non collegato'); }
}
const CHROME_VOICE_KEY='viva_chrome_voice_v211';
function chromeVoiceId(voice){
  return [voice.voiceURI||'',voice.name||'',voice.lang||''].join('::');
}
function chromeVoiceSelection(){
  return $('chrome-voice-choice')?.value||'auto';
}
function chooseVoice(){
  const italian=state.voices.filter(v=>/^it[-_]/i.test(v.lang));
  const selected=chromeVoiceSelection();
  if(selected==='default')return null; // Lascia scegliere al motore ChromeOS.
  if(selected!=='auto'){
    const exact=italian.find(v=>chromeVoiceId(v)===selected);
    if(exact)return exact;
  }
  const local=italian.filter(v=>v.localService);
  const available=local.length?local:italian;
  const preference=$('voice-choice').value;
  const candidates=preference==='male'
    ?/(diego|cosimo|luca|marco|male|uomo|gianni|giorgio)/i
    :/(elsa|isabella|alice|female|donna|paola|lucia)/i;
  return available.find(v=>candidates.test(v.name))||available[0]||null;
}
function refreshChromeVoiceChoices(){
  const selector=$('chrome-voice-choice');
  if(!selector)return;
  let previous=selector.value||'auto';
  if(previous==='auto'){
    try{previous=localStorage.getItem(CHROME_VOICE_KEY)||'auto'}catch{}
  }
  const italian=state.voices.filter(v=>/^it[-_]/i.test(v.lang));
  italian.sort((a,b)=>Number(b.localService)-Number(a.localService)||a.name.localeCompare(b.name,'it'));
  const options=[
    {value:'auto',label:'Automatica · preferisci voci locali'},
    {value:'default',label:'Predefinita Chrome · voce già provata'}
  ];
  for(const voice of italian){
    const key=chromeVoiceId(voice);
    if(options.some(o=>o.value===key))continue;
    options.push({value:key,label:(voice.localService?'Locale · ':'Online · ')+voice.name});
  }
  selector.replaceChildren();
  for(const opt of options){
    const node=document.createElement('option');
    node.value=opt.value;
    node.textContent=opt.label;
    selector.append(node);
  }
  selector.value=options.some(o=>o.value===previous)?previous:'auto';
  $('chrome-voice-count').textContent=italian.length
    ? italian.length+' voci italiane disponibili, di cui '+italian.filter(v=>v.localService).length+' locali.'
    :'Chrome non ha ancora caricato voci italiane: prova a riaprire la pagina.';
}


function voiceEngineChange(next) {
  if(state.active || state.busy) return status('Termina la conversazione prima di cambiare il motore vocale.',true);
  state.voiceEngine=next==='browser'?'browser':'gemini';
  $('voice-choice').disabled=state.voiceSource==='custom'||(state.voiceEngine==='gemini'&&!ttsCooldownUntil());
  $('ai-voice-choice').disabled=state.voiceSource==='custom'||state.voiceEngine==='browser';
  status(state.voiceEngine==='gemini'?'Voce Gemini selezionata. Richiede un Worker aggiornato e quota gratuita disponibile.':'Voce Chrome selezionata. Puoi iniziare subito.');
}
// VIVA AI 2.7 — non ripetere richieste TTS con quota gratuita esaurita.
const TTS_COOLDOWN_KEY='viva_gemini_tts_cooldown_v27';
function parseTtsCooldownMs(message){
 const value=String(message||'');
 if(!/rate.limit.exceeded|quota.exceeded|resource.exhausted|requests.per.day|free.tier/i.test(value))return 0;
 const match=value.match(/(?:retry|try again)\s+in\s+((?:\s*\d+\s*[dhms]\s*)+)/i);
 if(!match)return 0;
 const unitMs={d:86400000,h:3600000,m:60000,s:1000};
 let total=0;
 for(const part of match[1].matchAll(/(\d+)\s*([dhms])/gi)){total+=Number(part[1])*unitMs[part[2].toLowerCase()];}
 return Number.isFinite(total)&&total>0?Math.min(total,72*3600000):0;
}
function ttsCooldownUntil(){
 try{
  const until=Number(localStorage.getItem(TTS_COOLDOWN_KEY));
  if(Number.isFinite(until)&&until>Date.now())return until;
  if(until)localStorage.removeItem(TTS_COOLDOWN_KEY);
 }catch{}
 return 0;
}
function rememberTtsCooldown(message){
 const ms=parseTtsCooldownMs(message);
 if(!ms)return 0;
 const until=Date.now()+ms+15000;
 try{localStorage.setItem(TTS_COOLDOWN_KEY,String(until));}catch{}
 return until;
}
function formatTtsWait(until){
 const minutes=Math.max(1,Math.ceil((until-Date.now())/60000));
 const hours=Math.floor(minutes/60),remaining=minutes%60;
 return hours?hours+' h '+remaining+' min':minutes+' min';
}
function showTtsCooldown(until=ttsCooldownUntil()){
 $('voice-choice').disabled=state.voiceSource==='custom'||(state.voiceEngine==='gemini'&&!until);
 const banner=$('tts-quota-status');
 if(!banner)return;
 banner.hidden=!until;
 banner.textContent=until
  ?'Quota voce Gemini esaurita: ancora circa '+formatTtsWait(until)+'. VIVA AI userà automaticamente Chrome; le risposte testuali Gemini continuano a funzionare.'
  :'';
}
function speakBrowser(text,{direct=false}={}){
  if(!('speechSynthesis' in window))throw Error('Sintesi vocale Chrome non disponibile.');
  const clean=String(text||'').replace(/\*\*/g,'').trim();
  if(!clean)return;
  const job=state.speechJob;
  state.lastSpokenText=clean;
  $('replay-voice').hidden=false;
  clearBrowserSpeechTimers();
  motion.setBrowserSpeaking(false);
  // stopSpokenAudio() ha già interrotto l'eventuale frase precedente.
  // Un secondo cancel() immediato può bloccare la coda di Chrome.
  function begin(attempt){
    if(job!==state.speechJob||state.mode!=='basic')return;
    let started=false,finished=false;
    const utterance=new SpeechSynthesisUtterance(clean);
    state.browserUtterance=utterance; // Evita che Chrome elimini l'oggetto durante la lettura.
    utterance.lang='it-IT';
    utterance.rate=.95;
    utterance.pitch=$('voice-choice').value==='male'?.87:1.05;
    // Aggiorna voci che Chrome potrebbe aver caricato in ritardo.
    refreshVoices();
    const voice=chooseVoice();if(voice)utterance.voice=voice;
    utterance.onstart=()=>{
      if(job!==state.speechJob||finished)return;
      started=true;
      if(state.browserWatchdogTimer!==null)clearTimeout(state.browserWatchdogTimer);
      state.browserWatchdogTimer=null;
      $('audio-state').textContent='◉ Sta parlando (Chrome)';
      motion.setBrowserSpeaking(true);
    };
    utterance.onend=()=>{
      if(job!==state.speechJob||finished)return;
      finished=true;
      clearBrowserSpeechTimers();
      state.browserUtterance=null;
      $('audio-state').textContent='● In ascolto';
      motion.setBrowserSpeaking(false);
    };
    utterance.onerror=(event)=>{
      if(job!==state.speechJob||finished)return;
      finished=true;
      if(state.browserWatchdogTimer!==null)clearTimeout(state.browserWatchdogTimer);
      state.browserWatchdogTimer=null;
      state.browserUtterance=null;
      motion.setBrowserSpeaking(false);
      // L'errore "interrupted"/"canceled" deriva spesso da una nuova risposta.
      if(event?.error==='interrupted'||event?.error==='canceled')return;
      if(!started&&attempt===0){
        retry();
      }else{
        $('audio-state').textContent='● Voce Chrome bloccata';
        status('La voce Chrome non è partita. Premi «Riascolta risposta» per riattivarla.',true);
      }
    };
    function retry(){
      if(job!==state.speechJob)return;
      try{speechSynthesis.cancel();}catch{}
      motion.setBrowserSpeaking(false);
      state.browserUtterance=null;
      $('audio-state').textContent='◉ Riavvio voce Chrome...';
      state.browserRetryTimer=setTimeout(()=>{
        state.browserRetryTimer=null;
        if(job!==state.speechJob)return;
        begin(1);
      },200);
    }
    try{
      if(speechSynthesis.paused)speechSynthesis.resume();
      speechSynthesis.speak(utterance);
    }catch(err){
      console.warn('VIVA AI: voce Chrome',err);
      if(attempt===0)retry();
      else{
        state.browserUtterance=null;
        $('audio-state').textContent='● Voce Chrome bloccata';
        status('Chrome non riesce a leggere la risposta. Premi «Riascolta risposta».',true);
      }
      return;
    }
    state.browserWatchdogTimer=setTimeout(()=>{
      state.browserWatchdogTimer=null;
      if(job!==state.speechJob||started||finished)return;
      finished=true; // Non confondere gli eventi della prima prova con la seconda.
      if(attempt===0)retry();
      else{
        state.browserUtterance=null;
        $('audio-state').textContent='● Voce Chrome bloccata';
        status('Chrome ha preparato la risposta ma non ha avviato la voce. Premi «Riascolta risposta» per riprovare.',true);
      }
    },2800);
  }
  // Dopo cancel() concedi al motore Chrome di svuotare la vecchia coda.
  if(direct)begin(0);
  else{
    $('audio-state').textContent='◉ Avvio voce Chrome...';
    state.browserStartTimer=setTimeout(()=>{state.browserStartTimer=null;begin(0);},160);
  }
}
// Prova autonoma: speak() viene eseguito direttamente nel clic,
// senza timer e senza alcuna chiamata a Gemini. Serve per capire se
// il dispositivo ChromeOS può emettere la propria voce locale.
// Diagnostica ChromeOS in due clic distinti per preservare la user activation.
function resetChromeVoice(){
  const display=$('chrome-voice-diagnostic');
  if(!('speechSynthesis' in window)){
    display.textContent='Sintesi vocale Chrome non disponibile in questo browser.';
    return;
  }
  // Solo reset, NESSUNA nuova frase in questo stesso clic.
  state.speechJob++;
  clearBrowserSpeechTimers();
  if(state.browserDiagnosticTimer!==null)clearTimeout(state.browserDiagnosticTimer);
  state.browserDiagnosticTimer=null;
  state.browserDiagnosticUtterance=null;
  state.browserUtterance=null;
  motion.setBrowserSpeaking(false);
  try{
    speechSynthesis.cancel();
    // ChromeOS può rimanere in pausa dopo una cancellazione.
    if(speechSynthesis.paused)speechSynthesis.resume();
    display.textContent='Reset inviato al motore Chrome. Attendi un secondo, poi premi «Prova voce predefinita».';
  }catch(err){
    display.textContent='Errore durante il reset Chrome: '+(err?.message||err);
    return;
  }
  state.browserDiagnosticTimer=setTimeout(()=>{
    state.browserDiagnosticTimer=null;
    display.textContent='Stato dopo il reset: speaking='+speechSynthesis.speaking+
      ', pending='+speechSynthesis.pending+', paused='+speechSynthesis.paused+
      '. Ora premi «Prova voce predefinita».';
  },850);
}
function testChromeVoice(){
  const display=$('chrome-voice-diagnostic');
  if(!('speechSynthesis' in window)||!('SpeechSynthesisUtterance' in window)){
    display.textContent='Il browser non espone la sintesi vocale Web Speech.';
    return;
  }
  if(state.browserDiagnosticTimer!==null)clearTimeout(state.browserDiagnosticTimer);
  state.browserDiagnosticTimer=null;
  refreshVoices();
  const all=state.voices;
  const italian=all.filter(v=>/^it[-_]/i.test(v.lang));
  const localItalian=italian.filter(v=>v.localService);
  const info='Voci: '+all.length+'; italiane: '+italian.length+
    '; locali italiane: '+localItalian.length+'.';
  if(speechSynthesis.speaking||speechSynthesis.pending){
    display.textContent='Il motore risulta ancora occupato (speaking='+speechSynthesis.speaking+
      ', pending='+speechSynthesis.pending+', paused='+speechSynthesis.paused+
      '). Premi «1. Sblocca voce Chrome», attendi un secondo e riprova.';
    return;
  }
  const selected=chromeVoiceSelection();
  const voice=chooseVoice();
  const label=selected==='default'?'predefinita Chrome':voice?.name||'automatica Chrome';
  const utterance=new SpeechSynthesisUtterance('Ciao! Questa è una prova della mia voce. Come ti sembra?');
  utterance.lang='it-IT';
  utterance.rate=.94;
  if(voice)utterance.voice=voice;
  state.browserDiagnosticUtterance=utterance;
  let started=false,done=false;
  display.textContent='Prova voce «'+label+'» in corso. '+info;
  utterance.onstart=()=>{
    started=true;
    display.textContent='Chrome segnala che «'+label+'» sta parlando. '+info+
      ' La frase è udibile?';
  };
  utterance.onend=()=>{
    done=true;
    if(state.browserDiagnosticTimer!==null)clearTimeout(state.browserDiagnosticTimer);
    state.browserDiagnosticTimer=null;
    state.browserDiagnosticUtterance=null;
    display.textContent='Prova terminata con «'+label+'». '+info+
      ' Dimmi se hai sentito la frase.';
  };
  utterance.onerror=event=>{
    done=true;
    if(state.browserDiagnosticTimer!==null)clearTimeout(state.browserDiagnosticTimer);
    state.browserDiagnosticTimer=null;
    state.browserDiagnosticUtterance=null;
    display.textContent='Errore della voce Chrome predefinita: '+
      (event?.error||'non specificato')+'. '+info;
  };
  try{
    if(speechSynthesis.paused)speechSynthesis.resume();
    // Deve avvenire nel clic, senza altri cancel/speak nello stesso gesto.
    speechSynthesis.speak(utterance);
  }catch(err){
    state.browserDiagnosticUtterance=null;
    display.textContent='Impossibile avviare la lettura: '+(err?.message||err)+'. '+info;
    return;
  }
  state.browserDiagnosticTimer=setTimeout(()=>{
    state.browserDiagnosticTimer=null;
    if(!started&&!done){
      display.textContent='Prova non avviata neanche con voce predefinita. '+info+
        ' Motore: speaking='+speechSynthesis.speaking+
        ', pending='+speechSynthesis.pending+', paused='+speechSynthesis.paused+
        '. Potrebbe essere bloccato il servizio vocale di ChromeOS.';
    }
  },5500);
}
async function playAudioBlob(blob,myJob) {
  if(myJob!==state.speechJob) return;
  // Analisi locale, senza microfono o chiamate a servizi aggiuntivi.
  // Se il WAV non è supportato, rimane la sincronizzazione live.
  const timeline=await analyzeSpeechWav(blob);
  if(myJob!==state.speechJob)return;
  motion.setSpeechTimeline(timeline);
  state.playingUrl=URL.createObjectURL(blob);
  const audio=$('generated-audio');
  audio.src=state.playingUrl;audio.hidden=false;
  audio.onended=()=>$('audio-state').textContent='● In ascolto';
  audio.onplay=()=>$('audio-state').textContent='◉ Sta parlando';
  try { await audio.play(); }
  catch {status('Audio generato. Premi ▶ nel riproduttore sotto la chat per ascoltarlo.');}
}
async function speak(text) {
  if(state.mode!=='basic') return;
  stopSpokenAudio();
  state.lastSpokenText=String(text||'').trim();
  $('replay-voice').hidden=!state.lastSpokenText;
  const myJob=state.speechJob;
  if(state.voiceSource==='custom') {
    if(!state.voiceFile || !$('voice-consent').checked) throw Error('Manca il campione vocale autorizzato.');
    $('audio-state').textContent='◉ Generazione vocale...';
    status('Chatterbox sta preparando la risposta nella voce autorizzata...');
    if(!state.convertedVoiceFile) state.convertedVoiceFile=await normalizedWav(state.voiceFile);
    if(myJob!==state.speechJob) return;
    const form=new FormData();
    form.set('voice_sample',state.convertedVoiceFile);
    form.set('text',text.slice(0,600));
    form.set('consent','true');
    const blob=await apiVoice(form);
    await playAudioBlob(blob,myJob);
    return;
  }
  if(state.voiceEngine==='gemini') {
    const waitingUntil=ttsCooldownUntil();
    if(waitingUntil){
      showTtsCooldown(waitingUntil);
      $('audio-state').textContent='◉ Voce Chrome (quota Gemini esaurita)';
      speakBrowser(text);
      return;
    }
    showTtsCooldown(0);
    $('audio-state').textContent='◉ Creo la voce...';
    try {
      const normalized=text.replace(/\*\*/g,'').trim().slice(0,1600);
      const result=await api('/api/tts',{text:normalized,voice:$('ai-voice-choice').value});
      if(myJob!==state.speechJob)return;
      if(!result.audio || result.mimeType!=='audio/wav') throw Error('Il servizio non ha prodotto un WAV valido.');
      const decoded=atob(result.audio);
      const array=new Uint8Array(decoded.length);
      for(let i=0;i<decoded.length;i++) array[i]=decoded.charCodeAt(i);
      showTtsCooldown(0);
      await playAudioBlob(new Blob([array],{type:'audio/wav'}),myJob);
      return;
    } catch(err) {
      if(myJob!==state.speechJob)return;
      const until=rememberTtsCooldown(err.message);
      if(until){
        showTtsCooldown(until);
        status('Limite gratuito della voce Gemini raggiunto. Uso Chrome fino al ripristino della quota.');
        $('audio-state').textContent='◉ Voce Chrome (limite Gemini)';
      }else{
        status(`Voce Gemini non disponibile: ${err.message}. Uso temporaneamente la voce Chrome.`,true);
        $('audio-state').textContent='● Voce Chrome alternativa';
      }
      speakBrowser(text);
      return;
    }
  }
  speakBrowser(text);
}
function refreshVoices(){
  if('speechSynthesis' in window){
    state.voices=speechSynthesis.getVoices();
    refreshChromeVoiceChoices();
  }
}
function setBusy(yes) {
  state.busy=yes;
  $('start-button').disabled=yes;
  $('send-button').disabled=yes;
  $('mic-button').disabled=yes;
}
async function start() {
  if (state.active) return status('La conversazione è già avviata.');
  if (!state.photo) return status('Prima di tutto carica una fotografia.',true);
  if (state.voiceSource==='custom' && state.mode==='live') return status('La voce personalizzata non è ancora compatibile con il video D-ID. Per ora scegli “Voce AI” con foto fissa.',true);
  if (state.voiceSource==='custom' && !state.voiceFile) return status('Carica prima un campione vocale WAV o MP3.',true);
  if (state.voiceSource==='custom' && !$('voice-consent').checked) return status('Per utilizzare la voce personalizzata, conferma l’autorizzazione esplicita.',true);
  if (!state.worker || !state.token) { openSettings(); return settingsStatus('Configura prima il Worker e il suo codice di accesso.',true); }
  updateName(); setBusy(true);
  if (state.mode==='basic') motion.armAudio(); // Chiamata diretta dal clic: autorizza Web Audio prima della risposta Gemini.
  try {
    if (state.mode==='basic') {
      const data=await api('/api/status',{});
      if (!data.gemini) throw Error('Nel Worker manca GEMINI_API_KEY.');
      if (state.voiceSource==='custom' && !data.voice) throw Error('La voce è caricata, ma Chatterbox non è configurato nel Worker. Scegli Voce standard per provare gratuitamente oppure collega VOICE_SERVICE_URL.');
      state.active=true;
      $('avatar-state').textContent='Avatar vocale attivo';
      $('audio-state').textContent='● In ascolto';
      status('Conversazione attiva. Scrivi oppure premi il microfono.');
    } else {
      status('Caricamento fotografia e preparazione del video realistico...');
      const form = new FormData();
      form.set('image',state.photo,'avatar.'+(state.photo.type==='image/png'?'png':'jpg'));
      form.set('name',nameValue());
      form.set('personality',$('personality').value.slice(0,900));
      form.set('voice',$('voice-choice').value);
      const data=await api('/api/avatar',form,true);
      status('Avatar creato. Apertura della connessione video...');
      // SDK ufficiale, caricato soltanto quando il video realistico viene attivato.
      const sdk=await import('https://esm.sh/@d-id/client-sdk@3.0.9');
      state.manager=await sdk.createAgentManager(data.agentId,{
        auth:{type:'key',clientKey:data.clientKey},
        callbacks:{
          onSrcObjectReady(stream) {
            const video=$('agent-video');
            video.srcObject=stream;
            video.muted=false;
            video.volume=1;
            video.play().catch(()=>status('Tocca il video per attivare l’audio: il browser lo ha bloccato.'));
            video.hidden=false;
            $('avatar-photo').hidden=true;
            $('live-tag').hidden=false;
          },
          onConnectionStateChange(value) { $('audio-state').textContent=String(value).slice(0,30); },
          onNewMessage(messages) {
            if (!Array.isArray(messages)) return;
            const last=messages[messages.length-1];
            const value=typeof last?.content==='string' ? last.content : '';
            const role=last?.role || last?.sender || '';
            if (value && /(assistant|agent)/i.test(role) && value!==state.lastAgentMessage) {
              state.lastAgentMessage=value; addMessage('assistant',value);
            }
          },
          onError(error) { status('D-ID: '+(error?.message||'Errore di connessione'),true); }
        }
      });
      await state.manager.connect();
      state.active=true;
      $('avatar-state').textContent='Avatar video attivo';
      status('Video connesso! Puoi scrivere o usare il microfono.');
    }
    $('stop-button').hidden=false;
    $('start-button').hidden=true;
  } catch(error) {
    status(error.message || 'Impossibile avviare la conversazione.',true);
    console.error(error);
    if (state.manager) { try{await state.manager.disconnect();}catch{} state.manager=null; }
  } finally { setBusy(false); }
}
async function send(text) {
  const message=(text||'').trim();
  if (!message || state.busy) return;
  if (!state.active) return status('Premi prima “Avvia conversazione”.',true);
  $('message-input').value='';
  const userBubble=addMessage('user',message);
  setBusy(true);
  try {
    if (state.mode==='live') {
      await state.manager.chat(message);
      status('Messaggio inviato. L’avatar sta preparando la risposta video.');
    } else {
      state.messages.push({role:'user',text:message});
      status('L’avatar sta pensando...');
      const basePayload={
        name:nameValue(),
        personality:conversationalPersonality(),
        messages:state.messages.slice(-20),
      };
      const data=await chatWithRetry(basePayload);
      let answer=String(data.answer||'').trim();
      if (!answer) throw Error('Gemini ha restituito una risposta vuota.');
      if(resemblesRecentAnswer(answer,state.messages)){
        // Una sola seconda richiesta, soltanto su ripetizioni molto evidenti.
        // Se il secondo tentativo non riesce, manteniamo la prima risposta.
        status('La risposta è troppo simile a una precedente. Provo a variarla...');
        try{
          const retry=await chatWithRetry({
            ...basePayload,
            personality:conversationalPersonality(true)
          });
          const alternative=String(retry.answer||'').trim();
          if(alternative&&!resemblesRecentAnswer(alternative,state.messages))answer=alternative;
        }catch(err){console.warn('VIVA AI: seconda formulazione non disponibile.',err);}
      }
      state.messages.push({role:'model',text:answer});
      addMessage('assistant',answer);
      status('Risposta pronta. Puoi fare una nuova domanda.');
      void speak(answer).catch(err=>{
        $('audio-state').textContent='● Audio non disponibile';
        status(`La risposta scritta è pronta, ma la voce non è stata generata: ${err.message}`,true);
      });
    }
  } catch(error) {
    // Non registrare domande fallite nella cronologia, per permettere il retry.
    if (state.mode==='basic') state.messages.pop();
    userBubble?.remove();
    if (!$('message-input').value.trim()) $('message-input').value=message;
    status(error.message || 'Errore durante la risposta. La domanda è rimasta nel campo di scrittura.',true);
  } finally { setBusy(false); }
}
function microphone() {
  const Recognition=window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return status('Riconoscimento vocale non disponibile. Prova Chrome aggiornato oppure scrivi.',true);
  if (!state.active) return status('Avvia prima la conversazione.',true);
  if (state.recognition) { state.recognition.stop(); return; }
  stopSpokenAudio();
  const rec=new Recognition(); state.recognition=rec;
  rec.lang='it-IT'; rec.continuous=false; rec.interimResults=false;
  $('mic-button').classList.add('listening');
  status('Microfono attivo: parla ora...');
  rec.onresult=(event)=>{ const transcript=event.results?.[0]?.[0]?.transcript; if(transcript) send(transcript); };
  rec.onerror=(event)=>status('Microfono: '+(event.error||'errore')+'. Verifica i permessi.',true);
  rec.onend=()=>{state.recognition=null;$('mic-button').classList.remove('listening');};
  try {rec.start();} catch(err) {rec.onend();status(err.message,true);}
}
async function stop() {
  state.recognition?.stop();
  stopSpokenAudio();
  if (state.manager) {try{await state.manager.disconnect();}catch{} state.manager=null;}
  const video=$('agent-video');video.pause();video.srcObject=null;video.hidden=true;
  $('avatar-photo').hidden=!state.photo;
  motion.updateDisplay();
  $('live-tag').hidden=true;
  state.active=false;
  $('start-button').hidden=false; $('stop-button').hidden=true;
  $('audio-state').textContent='● Terminato';
  status('Conversazione terminata. Puoi cambiare voce o modalità e ricominciare.');
}
function openSettings() {
  $('worker-url').value=state.worker; $('access-token').value=state.token;
  $('settings-overlay').hidden=false; $('worker-url').focus();
}
function closeSettings() { $('settings-overlay').hidden=true; }
$('settings-button').addEventListener('click',openSettings);
$('settings-close').addEventListener('click',closeSettings);
$('settings-overlay').addEventListener('click',(e)=>{if(e.target===$('settings-overlay'))closeSettings();});
$('test-worker').addEventListener('click',checkWorker);
$('save-settings').addEventListener('click',()=>{settingValues();settingsStatus('Impostazioni salvate. Puoi verificare il collegamento e chiudere.');});
$('photo-input').addEventListener('change',uploadPhoto);
$('voice-standard').addEventListener('click',()=>voiceSourceChange('standard'));
$('voice-custom').addEventListener('click',()=>voiceSourceChange('custom'));
$('voice-file').addEventListener('change',uploadVoice);
$('voice-engine').addEventListener('change',(e)=>voiceEngineChange(e.target.value));
$('photo-motion-enabled').addEventListener('change',e=>motion.setEnabled(e.target.checked));
$('motion-test').addEventListener('click',()=>motion.testMotion());
$('eyes-pick').addEventListener('click',()=>motion.pickEyes());
$('expression-enabled').addEventListener('change',e=>motion.setExpressionEnabled(e.target.checked));
$('expression-test').addEventListener('click',()=>motion.testExpression());
$('head-enabled').addEventListener('change',e=>motion.setHeadEnabled(e.target.checked));
$('motion-pick').addEventListener('click',()=>motion.pickMouth());
$('motion-intensity').addEventListener('input',e=>{
  applyMotionValues(Number(e.target.value),Number($('brow-intensity').value),true);
});
$('brow-intensity').addEventListener('input',e=>{
  applyMotionValues(Number($('motion-intensity').value),Number(e.target.value),true);
});
$('motion-reset').addEventListener('click',()=>{
  applyMotionValues(MOTION_DEFAULTS.mouth,MOTION_DEFAULTS.brow,true);
  $('photo-motion-status').textContent='Regolazioni ripristinate: bocca 120%, sopracciglia 35%.';
});
applyMotionValues(
  readMotionValue(MOTION_STORAGE.mouth,MOTION_DEFAULTS.mouth,.4,2.4),
  readMotionValue(MOTION_STORAGE.brow,MOTION_DEFAULTS.brow,0,150)
);
showTtsCooldown();
$('conversation-style').addEventListener('change',e=>{
  try{localStorage.setItem('viva_conversation_style_26',conversationStyle());}catch{}
  $('status-message').textContent='Stile aggiornato: sarà applicato dalla prossima risposta.';
});
try{
  const saved=localStorage.getItem('viva_conversation_style_26');
  if(saved&&Object.hasOwn(CONVERSATION_STYLES,saved))$('conversation-style').value=saved;
}catch{}
$('avatar-name').addEventListener('input',updateName);
$('mode-basic').addEventListener('click',()=>modeChange('basic'));
$('mode-live').addEventListener('click',()=>modeChange('live'));
$('start-button').addEventListener('click',start);
$('stop-button').addEventListener('click',stop);
$('chat-form').addEventListener('submit',(e)=>{e.preventDefault();send($('message-input').value);});
$('mic-button').addEventListener('click',microphone);
$('reset-chrome-voice').addEventListener('click',resetChromeVoice);
$('chrome-voice-choice').addEventListener('change',()=>{
  try{localStorage.setItem(CHROME_VOICE_KEY,chromeVoiceSelection())}catch{}
  const voice=chooseVoice();
  $('chrome-voice-diagnostic').textContent='Voce selezionata: '+
    (chromeVoiceSelection()==='default'?'predefinita Chrome':voice?.name||'automatica')+
    '. Premi «Prova voce selezionata» per ascoltarla.';
});
$('test-chrome-voice').addEventListener('click',testChromeVoice);
$('replay-voice').addEventListener('click',()=>{
  if(!state.lastSpokenText)return status('Non c’è ancora una risposta da riascoltare.');
  if(state.mode!=='basic')return status('Il riascolto Chrome è disponibile nella modalità fotografica.');
  const answer=state.lastSpokenText;
  stopSpokenAudio();
  try{speakBrowser(answer,{direct:true});}
  catch(err){status('Voce Chrome non disponibile: '+err.message,true);}
});
$('clear-chat').addEventListener('click',()=>{
  if (state.mode==='live'&&state.active) return status('Termina la videochiamata per azzerare la cronologia D-ID.',true);
  state.messages=[];state.lastAgentMessage='';state.lastSpokenText='';$('replay-voice').hidden=true;$('chat-scroll').innerHTML='';
  addMessage('assistant','Conversazione azzerata. Di cosa vuoi parlare?');
  status('Cronologia ripulita.');
});
document.querySelectorAll('[data-prompt]').forEach(b=>b.addEventListener('click',()=>send(b.dataset.prompt)));
window.addEventListener('beforeunload',()=>{void state.manager?.disconnect();if(state.photoUrl)URL.revokeObjectURL(state.photoUrl);if(state.voicePreviewUrl)URL.revokeObjectURL(state.voicePreviewUrl);stopSpokenAudio();});
window.addEventListener('keydown',(e)=>{if(e.key==='Escape')closeSettings();});
if ('speechSynthesis' in window) {refreshVoices();speechSynthesis.addEventListener?.('voiceschanged',refreshVoices);}
updateName();modeChange('basic');voiceSourceChange('standard');
if (state.worker && state.token) { setConnection(false,'Da verificare'); status('Worker configurato: premi Avvia oppure verifica la connessione.'); }
