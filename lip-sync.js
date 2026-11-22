/* VIVA AI 2.5 — analisi locale della voce WAV per animazione labbra.
 * Nessun servizio esterno. La timeline è allineata ad audio.currentTime
 * anche dopo pausa, seek o perdita di fotogrammi. Non identifica fonemi.
 */
const WINDOW_MS=20;
const MAX_BYTES=24*1024*1024;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
function fourcc(view,pos){
 return String.fromCharCode(view.getUint8(pos),view.getUint8(pos+1),view.getUint8(pos+2),view.getUint8(pos+3));
}
function percentile(sorted,fraction){
 if(!sorted.length)return 0;
 return sorted[Math.max(0,Math.min(sorted.length-1,Math.floor((sorted.length-1)*fraction)))];
}
function sampleAt(view,pos,encoding,bits){
 if(encoding===3){
  if(bits===32)return view.getFloat32(pos,true);
  if(bits===64)return view.getFloat64(pos,true);
 }
 if(encoding!==1)return 0;
 if(bits===8)return (view.getUint8(pos)-128)/128;
 if(bits===16)return view.getInt16(pos,true)/32768;
 if(bits===24){
  let n=view.getUint8(pos)|(view.getUint8(pos+1)<<8)|(view.getUint8(pos+2)<<16);
  if(n&0x800000)n-=0x1000000;
  return n/8388608;
 }
 if(bits===32)return view.getInt32(pos,true)/2147483648;
 return 0;
}
export function buildWavSpeechTimeline(bytes){
 const buffer=bytes instanceof ArrayBuffer?bytes:bytes?.buffer;
 if(!(buffer instanceof ArrayBuffer)||buffer.byteLength<44||buffer.byteLength>MAX_BYTES)return null;
 const view=new DataView(buffer);
 if(fourcc(view,0)!=='RIFF'||fourcc(view,8)!=='WAVE')return null;
 let format=null,dataPos=-1,dataSize=0;
 let pos=12;
 while(pos+8<=view.byteLength){
  const kind=fourcc(view,pos),size=view.getUint32(pos+4,true);
  const start=pos+8;
  if(start+size>view.byteLength)break;
  if(kind==='fmt '&&size>=16){
   format={
    encoding:view.getUint16(start,true),
    channels:view.getUint16(start+2,true),
    rate:view.getUint32(start+4,true),
    align:view.getUint16(start+12,true),
    bits:view.getUint16(start+14,true)
   };
  }else if(kind==='data'){
   dataPos=start;dataSize=size;
  }
  pos=start+size+(size%2);
 }
 if(!format||dataPos<0)return null;
 const {encoding,channels,rate,align,bits}=format;
 if(![1,3].includes(encoding)||channels<1||channels>8||rate<8000||rate>192000||align<1)return null;
 if(!([8,16,24,32].includes(bits)&&encoding===1) && !([32,64].includes(bits)&&encoding===3))return null;
 const sampleBytes=bits/8;
 if(align<sampleBytes*channels)return null;
 const sampleFrames=Math.floor(dataSize/align);
 if(sampleFrames<rate*.15)return null;
 const windowFrames=Math.max(1,Math.round(rate*WINDOW_MS/1000));
 const windows=Math.ceil(sampleFrames/windowFrames);
 const rmsValues=new Float32Array(windows),roughValues=new Float32Array(windows);
 const stride=Math.max(1,Math.floor(rate/12000));
 for(let frame=0;frame<windows;frame++){
  const start=frame*windowFrames,end=Math.min(sampleFrames,start+windowFrames);
  let energy=0,derivative=0,count=0,prev=0,hasPrev=false;
  for(let i=start;i<end;i+=stride){
   const base=dataPos+i*align;
   let sample=0;
   for(let ch=0;ch<channels;ch++)sample+=sampleAt(view,base+ch*sampleBytes,encoding,bits);
   sample=clamp(sample/channels,-1,1);
   energy+=sample*sample;
   if(hasPrev){const diff=sample-prev;derivative+=diff*diff;}
   prev=sample;hasPrev=true;count++;
  }
  rmsValues[frame]=Math.sqrt(energy/Math.max(1,count));
  roughValues[frame]=Math.sqrt(derivative/Math.max(1,count-1));
 }
 // Percentili per adattarsi a voci di diversa intensità.
 const distribution=Array.from(rmsValues).filter(x=>Number.isFinite(x)&&x>.001).sort((x,y)=>x-y);
 if(distribution.length<3)return null;
 const upper=percentile(distribution,.88);
 const floor=Math.max(.005,Math.min(.022,percentile(distribution,.12)*.45));
 const range=Math.max(.012,upper-floor);
 const levels=new Float32Array(windows),shapes=new Float32Array(windows);
 for(let i=0;i<windows;i++){
  const rms=rmsValues[i];
  let level=Math.pow(clamp((rms-floor)/range,0,1),.84);
  if(rms<floor*1.2||level<.052)level=0;
  const rough=clamp(roughValues[i]/Math.max(.01,rms),0,1.45);
  levels[i]=level;
  // Indizio timbrico approssimativo, non classificazione fonetica.
  shapes[i]=clamp(.41+rough*.17+level*.05,.3,.76);
 }
 return {
  step:windowFrames/rate,
  duration:sampleFrames/rate,
  levels,
  shapes,
  source:'wav-local'
 };
}
export async function analyzeSpeechWav(blob){
 if(!blob||typeof blob.arrayBuffer!=='function'||blob.size>MAX_BYTES)return null;
 try{return buildWavSpeechTimeline(await blob.arrayBuffer());}
 catch(err){console.warn('VIVA AI: analisi WAV non disponibile, uso sincronizzazione audio diretta.',err);return null;}
}
