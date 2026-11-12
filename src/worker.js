import WebSocket from 'ws';
import {pathToFileURL} from 'node:url';
import {loadConfig} from './config.js';
import {DirectTransport,sendSocket} from './transport.js';
import {locales} from './languages.js';

export function startWorker(config,{log=console.log,transport=new DirectTransport(config)}={}){
  let stopped=false,socket,retryTimer,attempt=0;
  const jobs=new Map();
  function connect(){
    if(stopped)return;
    const url=new URL('/internal/model-worker',config.BACKEND_URL);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    socket=new WebSocket(url,{headers:{Authorization:`Bearer ${config.MODEL_WORKER_TOKEN}`},handshakeTimeout:15000,maxPayload:1024*1024,perMessageDeflate:false});
    const ws=socket;let alive=true;
    const heartbeat=setInterval(()=>{if(ws.readyState!==WebSocket.OPEN)return;if(!alive){ws.terminate();return;}alive=false;ws.ping();},20000);heartbeat.unref();
    ws.on('pong',()=>{alive=true;});
    const report=async()=>{const services=await transport.health();if(ws.readyState===WebSocket.OPEN)await sendSocket(ws,{type:'health',services}).catch(()=>{});};
    const health=setInterval(()=>void report(),15000);health.unref();
    ws.on('open',()=>{attempt=0;log('Model worker connected. Only Gemma 4, Bodhan and Parler are routed.');void report();});
    ws.on('error',()=>{});
    ws.on('close',()=>{
      clearInterval(heartbeat);clearInterval(health);for(const job of jobs.values()){job.controller.abort();job.stt?.close();}jobs.clear();
      if(!stopped){log('Model worker disconnected; reconnecting.');retryTimer=setTimeout(connect,Math.min(30000,1000*2**Math.min(attempt++,5)));}
    });
    ws.on('message',async(raw,binary)=>{
      let m;try{if(binary)throw Error();m=JSON.parse(raw.toString());}catch{ws.close(1003);return;}
      if(typeof m.id!=='string'||m.id.length>80)return;
      if(m.type==='cancel'){const j=jobs.get(m.id);j?.controller.abort();j?.stt?.close();return;}
      if(m.type==='stt.audio'||m.type==='stt.commit'){
        const j=jobs.get(m.id);if(!j?.stt)return;
        try{if(m.type==='stt.commit')await j.stt.commit();else{if(typeof m.data!=='string'||m.data.length>65536)throw Error();const pcm=Buffer.from(m.data,'base64');j.audioBytes+=pcm.length;if(pcm.length%2||j.audioBytes>48000*config.VOICE_SESSION_SECONDS)throw Error();await j.stt.send(pcm);}}catch{j.controller.abort();j.stt.close();await sendSocket(ws,{id:m.id,kind:'error'}).catch(()=>{});}return;
      }
      if(!['http','stt.open'].includes(m.type)||jobs.has(m.id)||jobs.size>=8){await sendSocket(ws,{id:m.id,kind:'error'}).catch(()=>{});return;}
      const job={type:m.type,controller:new AbortController(),audioBytes:0};jobs.set(m.id,job);
      try{
        if(m.type==='http'){
          if(!['llm','tts'].includes(m.service)||!m.body||JSON.stringify(m.body).length>100000)throw Error();
          if(m.service==='llm'&&m.body.model!==config.GEMMA_MODEL)throw Error();
          for await(const event of transport.request(m.service,m.body,job.controller.signal))await sendSocket(ws,{...event,id:m.id,...(event.kind==='chunk'?{data:event.data.toString('base64')}:{})});
        }else{
          if(!m.config||!['auto',...locales].includes(m.config.recognitionLanguage))throw Error();
          if([...jobs.values()].some(j=>j!==job&&j.type==='stt.open'))throw Error();
          job.stt=await transport.stt(m.config,event=>{void sendSocket(ws,{id:m.id,kind:'event',event}).catch(()=>{job.controller.abort();job.stt?.close();});},job.controller.signal);
          await sendSocket(ws,{id:m.id,kind:'ready'});
          await new Promise(resolve=>{if(job.controller.signal.aborted)resolve();else job.controller.signal.addEventListener('abort',resolve,{once:true});});
          job.stt.close();
        }
        await sendSocket(ws,{id:m.id,kind:'end'});
      }catch{if(!job.controller.signal.aborted)await sendSocket(ws,{id:m.id,kind:'error'}).catch(()=>{});}
      finally{job.controller.abort();job.stt?.close();jobs.delete(m.id);}
    });
  }
  connect();return {stop:()=>{stopped=true;clearTimeout(retryTimer);for(const j of jobs.values()){j.controller.abort();j.stt?.close();}socket?.close();setTimeout(()=>socket?.terminate(),1000).unref();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const worker=startWorker(loadConfig(process.env,{worker:true}));for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>worker.stop());}
  catch(e){console.error(e.message);process.exitCode=1;}
}
