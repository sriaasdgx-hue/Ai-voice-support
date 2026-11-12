import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {AppError,checkAbort,cancelled} from './errors.js';

export class AsyncQueue {
  items=[]; waiters=[]; bytes=0; ended=false; error=null;
  push(item) {
    if(this.ended)return;
    const size=Buffer.byteLength(JSON.stringify(item));
    if(this.bytes+size>2*1024*1024) {this.end(new AppError(503,'SLOW_CONSUMER','The connection could not keep up. Please reconnect.'));return;}
    const waiter=this.waiters.shift(); if(waiter)waiter.resolve({value:item,done:false});else{this.items.push({item,size});this.bytes+=size;}
  }
  end(error=null) {if(this.ended)return;this.ended=true;this.error=error;if(error){this.items=[];this.bytes=0;}for(const w of this.waiters.splice(0))error?w.reject(error):w.resolve({done:true});}
  next() {if(this.items.length){const {item,size}=this.items.shift();this.bytes-=size;return Promise.resolve({value:item,done:false});}if(this.ended)return this.error?Promise.reject(this.error):Promise.resolve({done:true});return new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));}
  [Symbol.asyncIterator]() {return this;}
}
export async function sendSocket(ws,value,binary=false) {
  if(ws.readyState!==WebSocket.OPEN)throw new AppError(503,'DISCONNECTED','Connection closed.');
  if(ws.bufferedAmount>2*1024*1024)throw new AppError(503,'SLOW_CONNECTION','Connection is too slow. Reconnect and retry.');
  await new Promise((resolve,reject)=>ws.send(binary?value:JSON.stringify(value),{binary},e=>e?reject(e):resolve()));
}
export class DirectTransport {
  constructor(config){this.config=config;}
  get ready(){return true;}
  endpoint(service){const c=this.config;if(service==='llm')return[c.GEMMA_CHAT_URL,c.GEMMA_API_KEY];if(service==='tts')return[c.PARLER_SPEECH_URL,c.PARLER_API_KEY];throw new AppError(400,'BAD_SERVICE','Unknown model service.');}
  async *request(service,body,signal) {
    checkAbort(signal); const [url,key]=this.endpoint(service);
    const response=await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(key?{Authorization:`Bearer ${key}`}:{})},body:JSON.stringify(body),signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(this.config.MODEL_TIMEOUT_MS)])});
    try {yield {kind:'head',status:response.status,headers:Object.fromEntries(['content-type','x-tts-voice','x-sample-rate'].map(k=>[k,response.headers.get(k)]))};
    for await(const chunk of response.body){checkAbort(signal);for(let i=0;i<chunk.length;i+=32768)yield {kind:'chunk',data:Buffer.from(chunk.subarray(i,i+32768))};}}
    finally {await response.body?.cancel().catch(()=>{});}
  }
  async health(){
    const c=this.config;
    const checks=await Promise.all([['llm',c.GEMMA_CHAT_URL,'/health',c.GEMMA_API_KEY],['stt',c.BODHAN_WS_URL,'/ready',c.BODHAN_API_KEY],['tts',c.PARLER_SPEECH_URL,'/ready',c.PARLER_API_KEY]].map(async([name,base,path,key])=>{
      try{const url=new URL(base);url.protocol=url.protocol==='wss:'?'https:':url.protocol==='ws:'?'http:':url.protocol;url.pathname=path;url.search='';const r=await fetch(url,{headers:key?{Authorization:`Bearer ${key}`}:{},signal:AbortSignal.timeout(5000),redirect:'error'});const data=await r.json();return[name,r.ok&&(name==='llm'||data.ready===true)];}catch{return[name,false];}
    }));return Object.fromEntries(checks);
  }
  async stt(config,onEvent,signal) {
    checkAbort(signal);
    const ws=new WebSocket(this.config.BODHAN_WS_URL,{headers:this.config.BODHAN_API_KEY?{Authorization:`Bearer ${this.config.BODHAN_API_KEY}`}:{},maxPayload:1024*1024,handshakeTimeout:10000});
    let ready=false,ended=false;
    const abort=()=>{ended=true;ws.terminate();};signal?.addEventListener('abort',abort,{once:true});
    const connection=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{reject(new AppError(504,'STT_TIMEOUT','Speech recognition did not connect.'));abort();},12000);timer.unref();
      function fail(error){clearTimeout(timer);if(!ready)reject(error);else if(!ended)onEvent({type:'error',error:{message:'Speech recognition disconnected.'}});}
      ws.on('error',()=>fail(new AppError(503,'STT_UNAVAILABLE','Speech recognition is unavailable.')));
      ws.on('close',()=>{signal?.removeEventListener('abort',abort);fail(new AppError(503,'STT_CLOSED','Speech recognition closed.'));});
      ws.on('message',raw=>{
        try {
          const event=JSON.parse(raw.toString());
          if(event.type==='session.created')ws.send(JSON.stringify({type:'session.update',session:{sample_rate:24000,language:config.recognitionLanguage,endpointing_ms:1200}}));
          else if(event.type==='session.updated'){clearTimeout(timer);ready=true;resolve({send:pcm=>sendSocket(ws,pcm,true),commit:()=>sendSocket(ws,{type:'input_audio_buffer.commit'}),close:()=>{ended=true;ws.close();setTimeout(()=>{if(ws.readyState!==WebSocket.CLOSED)ws.terminate();},1000).unref();}});}
          else if(event.type==='error'&&!ready){fail(new AppError(503,'STT_BUSY','Speech recognizer is unavailable or in use. End any Voice Lab conversation.'));abort();}
          else if(ready&&!ended)onEvent(event);
        }catch{fail(new AppError(502,'STT_PROTOCOL','Speech recognition returned invalid data.'));abort();}
      });
    });
    if(signal?.aborted){connection.close();throw cancelled();}return connection;
  }
}

export class WorkerTransport {
  constructor(config){this.config=config;this.ws=null;this.pending=new Map();this.lastHealth=null;}
  get ready(){return this.ws?.readyState===WebSocket.OPEN;}
  attach(ws){
    if(this.ready){ws.close(1013,'A worker is already connected');return false;}
    this.ws=ws;this.lastHealth=null;
    ws.on('message',(raw,binary)=>{
      if(binary){ws.close(1003);return;}
      try {
        const event=JSON.parse(raw.toString());
        if(event.type==='health'){this.lastHealth={...event.services,at:Date.now()};return;}
        const q=this.pending.get(event.id);if(!q)return;
        if(event.kind==='error')q.end(new AppError(502,'MODEL_ERROR','The model worker could not finish this request.'));
        else if(event.kind==='end')q.end();else q.push(event);
      }catch{ws.close(1003,'Invalid worker event');}
    });
    ws.on('close',()=>{if(this.ws!==ws)return;this.ws=null;this.lastHealth=null;for(const q of this.pending.values())q.end(new AppError(503,'WORKER_OFFLINE','The model worker disconnected. Keep the Spark connector running.'));this.pending.clear();});
    return true;
  }
  async health(){const h=this.lastHealth;return {worker:this.ready,llm:!!(h&&Date.now()-h.at<45000&&h.llm),stt:!!(h&&Date.now()-h.at<45000&&h.stt),tts:!!(h&&Date.now()-h.at<45000&&h.tts)};}
  async *channel(message,signal,timeout=this.config.MODEL_TIMEOUT_MS){
    checkAbort(signal);if(!this.ready)throw new AppError(503,'WORKER_OFFLINE','Connect the Spark model worker before chatting.');
    if(this.pending.size>=8)throw new AppError(429,'MODEL_BUSY','The model worker is busy.');
    const id=randomUUID(),q=new AsyncQueue();this.pending.set(id,q);
    const abort=()=>q.end(cancelled());signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>q.end(new AppError(504,'MODEL_TIMEOUT','The model took too long. Please retry.')),timeout);timer.unref();
    try{await sendSocket(this.ws,{...message,id});for await(const event of q)yield event;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.pending.delete(id);if(this.ready)await sendSocket(this.ws,{type:'cancel',id}).catch(()=>{});}
  }
  async *request(service,body,signal){for await(const event of this.channel({type:'http',service,body},signal)){if(event.kind==='chunk')event.data=Buffer.from(event.data,'base64');yield event;}}
  async stt(config,onEvent,signal){
    const controller=new AbortController();const combined=AbortSignal.any([signal||new AbortController().signal,controller.signal]);
    let id;let opened=false;let resolveReady,rejectReady;
    const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    const connectTimeout=setTimeout(()=>{rejectReady(new AppError(504,'STT_TIMEOUT','Speech recognition did not connect.'));controller.abort();},15000);connectTimeout.unref();
    const pump=(async()=>{try{for await(const event of this.channel({type:'stt.open',config},combined,(this.config.VOICE_SESSION_SECONDS+15)*1000)){
      if(event.kind==='ready'){id=event.id;opened=true;clearTimeout(connectTimeout);resolveReady();}else if(event.kind==='event')onEvent(event.event);
    }}catch(e){if(!opened)rejectReady(e);else if(!combined.aborted)onEvent({type:'error',error:{message:'Speech recognition disconnected.'}});}finally{clearTimeout(connectTimeout);if(!opened)rejectReady(new AppError(503,'STT_CLOSED','Speech recognition closed.'));}})();
    await ready;
    return {send:pcm=>sendSocket(this.ws,{type:'stt.audio',id,data:pcm.toString('base64')}),commit:()=>sendSocket(this.ws,{type:'stt.commit',id}),close:()=>{controller.abort();return pump;}};
  }
  close(){this.ws?.close(1012,'Server restarting');}
}
