import { PhotoAvatarMotion } from './photo-avatar.js';
/* VIVA AI: interfaccia pubblica, nessuna API key privata nel browser. */
const $ = (id) => document.getElementById(id);
const state = {
  mode: 'basic', photo: null, photoUrl: null, manager: null,
  worker: localStorage.getItem('viva_worker') || '',
  token: sessionStorage.getItem('viva_token') || '',
  messages: [], active: false, busy: false, recognition: null,
  voices: [], lastAgentMessage: '', voiceSource:'standard', voiceFile:null, voicePreviewUrl:null,
  convertedVoiceFile:null, playingUrl:null, speechJob:0, voiceEngine:'gemini',
};

const motion = new PhotoAvatarMotion({
  photo: $('avatar-photo'),
  canvas: $('avatar-canvas'),
  audio: $('generated-audio'),
  status: message => $('photo-motion-status').textContent=message
});
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
  $('voice-choice').disabled=next==='custom' || state.voiceEngine==='gemini';
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
function stopSpokenAudio() {
  state.speechJob++;
  motion.setBrowserSpeaking(false);
  if('speechSynthesis' in window) speechSynthesis.cancel();
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
    ? 'Anteprima gratuita: la foto anima le labbra in 2D seguendo il volume della voce AI. Non è ancora una videochiamata fotorealistica.'
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
function chooseVoice() {
  const italian = state.voices.filter(v=>/^it[-_]/i.test(v.lang));
  const preference = $('voice-choice').value;
  const candidates = preference==='male' ? /(diego|cosimo|luca|marco|male|uomo|gianni|giorgio)/i : /(elsa|isabella|alice|female|donna|paola|lucia)/i;
  return italian.find(v=>candidates.test(v.name)) || italian[0] || null;
}

function voiceEngineChange(next) {
  if(state.active || state.busy) return status('Termina la conversazione prima di cambiare il motore vocale.',true);
  state.voiceEngine=next==='browser'?'browser':'gemini';
  $('voice-choice').disabled=state.voiceSource==='custom'||state.voiceEngine==='gemini';
  $('ai-voice-choice').disabled=state.voiceSource==='custom'||state.voiceEngine==='browser';
  status(state.voiceEngine==='gemini'?'Voce Gemini selezionata. Richiede un Worker aggiornato e quota gratuita disponibile.':'Voce Chrome selezionata. Puoi iniziare subito.');
}
function speakBrowser(text) {
  if(!('speechSynthesis' in window)) throw Error('Sintesi vocale non disponibile in questo browser.');
  const utterance=new SpeechSynthesisUtterance(text);
  utterance.lang='it-IT';utterance.rate=.95;utterance.pitch=$('voice-choice').value==='male'?.87:1.05;
  const voice=chooseVoice();if(voice) utterance.voice=voice;
  utterance.onstart=()=>{$('audio-state').textContent='◉ Sta parlando';motion.setBrowserSpeaking(true);};
  utterance.onend=()=>{$('audio-state').textContent='● In ascolto';motion.setBrowserSpeaking(false);};
  utterance.onerror=()=>{$('audio-state').textContent='● Audio non disponibile';motion.setBrowserSpeaking(false);};
  speechSynthesis.speak(utterance);
}
async function playAudioBlob(blob,myJob) {
  if(myJob!==state.speechJob) return;
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
    $('audio-state').textContent='◉ Creo la voce...';
    try {
      const normalized=text.replace(/\*\*/g,'').trim().slice(0,1600);
      const result=await api('/api/tts',{text:normalized,voice:$('ai-voice-choice').value});
      if(myJob!==state.speechJob)return;
      if(!result.audio || result.mimeType!=='audio/wav') throw Error('Il servizio non ha prodotto un WAV valido.');
      const decoded=atob(result.audio);
      const array=new Uint8Array(decoded.length);
      for(let i=0;i<decoded.length;i++) array[i]=decoded.charCodeAt(i);
      await playAudioBlob(new Blob([array],{type:'audio/wav'}),myJob);
      return;
    } catch(err) {
      if(myJob!==state.speechJob)return;
      status(`Voce Gemini non disponibile: ${err.message}. Uso temporaneamente la voce Chrome.`,true);
      $('audio-state').textContent='● Voce Chrome alternativa';
      speakBrowser(text);
      return;
    }
  }
  speakBrowser(text);
}
function refreshVoices() { if ('speechSynthesis' in window) state.voices=speechSynthesis.getVoices(); }
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
      const data=await chatWithRetry({
        name:nameValue(),personality:$('personality').value,
        messages:state.messages.slice(-20),
      });
      const answer=data.answer;
      if (!answer) throw Error('Gemini ha restituito una risposta vuota.');
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
$('motion-pick').addEventListener('click',()=>motion.pickMouth());
$('avatar-name').addEventListener('input',updateName);
$('mode-basic').addEventListener('click',()=>modeChange('basic'));
$('mode-live').addEventListener('click',()=>modeChange('live'));
$('start-button').addEventListener('click',start);
$('stop-button').addEventListener('click',stop);
$('chat-form').addEventListener('submit',(e)=>{e.preventDefault();send($('message-input').value);});
$('mic-button').addEventListener('click',microphone);
$('clear-chat').addEventListener('click',()=>{
  if (state.mode==='live'&&state.active) return status('Termina la videochiamata per azzerare la cronologia D-ID.',true);
  state.messages=[];state.lastAgentMessage='';$('chat-scroll').innerHTML='';
  addMessage('assistant','Conversazione azzerata. Di cosa vuoi parlare?');
  status('Cronologia ripulita.');
});
document.querySelectorAll('[data-prompt]').forEach(b=>b.addEventListener('click',()=>send(b.dataset.prompt)));
window.addEventListener('beforeunload',()=>{void state.manager?.disconnect();if(state.photoUrl)URL.revokeObjectURL(state.photoUrl);if(state.voicePreviewUrl)URL.revokeObjectURL(state.voicePreviewUrl);stopSpokenAudio();});
window.addEventListener('keydown',(e)=>{if(e.key==='Escape')closeSettings();});
if ('speechSynthesis' in window) {refreshVoices();speechSynthesis.addEventListener?.('voiceschanged',refreshVoices);}
updateName();modeChange('basic');voiceSourceChange('standard');
if (state.worker && state.token) { setConnection(false,'Da verificare'); status('Worker configurato: premi Avvia oppure verifica la connessione.'); }
