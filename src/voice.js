import {randomUUID} from 'node:crypto';
import {sendSocket} from './transport.js';
import {publicError} from './errors.js';

export async function voiceSession(ws,ticket,{assistant,transport,config,release}){
  const sessionAbort=new AbortController();let stt,closed=false,current=null,turns=Promise.resolve(),queued=0,bytes=0,seq=0;
  let resolveFinished;const finished=new Promise(resolve=>{resolveFinished=resolve;});
  const start=Date.now();
  const send=event=>sendSocket(ws,{...event,seq:++seq});
  const timeout=setTimeout(()=>void end('Session time limit reached.'),config.VOICE_SESSION_SECONDS*1000);timeout.unref();
  async function end(reason='Session ended.'){
    if(closed)return;closed=true;clearTimeout(timeout);sessionAbort.abort();current?.abort();
    await Promise.resolve(stt?.close()).catch(()=>{});
    await turns.catch(()=>{});
    await send({type:'session.ended',reason}).catch(()=>{});ws.close(1000);release();resolveFinished();
  }
  ws.on('close',()=>void end());ws.on('error',()=>void end());
  ws.on('message',async(raw,binary)=>{
    if(closed)return;
    try{
      if(binary){
        if(!stt)throw Error('not ready');bytes+=raw.length;
        if(raw.length>48000||raw.length%2||bytes>48000*config.VOICE_SESSION_SECONDS||bytes>48000*((Date.now()-start)/1000+5))throw Error('invalid audio');
        await stt.send(raw);
      }else{
        if(raw.length>4000)throw Error();const event=JSON.parse(raw.toString());
        if(event.type==='session.end')await end();
        else if(event.type==='response.cancel'){current?.abort();await send({type:'playback.clear'});}
        else if(event.type==='ping')await send({type:'pong'});
        else throw Error('unknown control');
      }
    }catch{await send({type:'session.error',error:{code:'INVALID_AUDIO',message:'Send mono PCM16 at 24 kHz after session.started.'}}).catch(()=>{});await end();}
  });
  try{
    stt=await transport.stt(ticket.settings,event=>{
      if(closed||typeof event.type!=='string')return;
      if(event.type==='input_audio_buffer.speech_started'){
        current?.abort();void send({type:'playback.clear'}).catch(()=>end());
      }else if(event.type.endsWith('transcription.delta')){
        void send({type:'transcript.delta',delta:event.delta}).catch(()=>end());
      }else if(event.type.endsWith('transcription.completed')&&event.transcript?.trim()){
        const text=event.transcript.trim();
        if(text.length>2000||queued>=4){void send({type:'session.error',error:{code:'INPUT_TOO_LONG',message:'Please use shorter turns.'}}).catch(()=>{}).finally(()=>end());return;}
        void send({type:'transcript.done',text,detectedLanguage:event.language}).catch(()=>end());
        current?.abort();const controller=new AbortController();current=controller;queued++;
        turns=turns.catch(()=>{}).then(async()=>{
          try{await assistant.turn({id:ticket.conversationId,owner:ticket.owner,text,clientId:randomUUID(),mode:'voice',options:ticket.settings,detected:event.language,signal:AbortSignal.any([sessionAbort.signal,controller.signal]),emit:send});}
          catch{/* turn sends its own sanitized error and saves interruption state */}
          finally{queued--;if(current===controller)current=null;}
        });
      }else if(event.type==='error'){
        void send({type:'session.error',error:{code:'STT_ERROR',message:'Speech recognition failed or disconnected.'}}).catch(()=>{}).finally(()=>end());
      }
    },sessionAbort.signal);
    if(closed){await stt.close();return;}
    await send({type:'session.started',sessionId:randomUUID(),conversationId:ticket.conversationId,input:{encoding:'pcm_s16le',sampleRate:24000,channels:1},output:{encoding:'pcm_s16le',sampleRate:22050,channels:1},settings:ticket.settings,maxSeconds:config.VOICE_SESSION_SECONDS});
  }catch(error){await send({type:'session.error',error:publicError(error)}).catch(()=>{});await end();}
  return finished;
}
