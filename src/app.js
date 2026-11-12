import express from 'express';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';
import {z} from 'zod';
import {authenticator,sameSecret} from './auth.js';
import {AppError,publicError} from './errors.js';
import {languages,languageKeys,locales} from './languages.js';
import {Models} from './models.js';
import {Assistant} from './assistant.js';
import {DirectTransport,WorkerTransport} from './transport.js';
import {MemoryStore,PostgresStore} from './store.js';
import {voiceSession} from './voice.js';

const settingsSchema=z.object({replyLanguage:z.enum(['auto',...languageKeys]).default('auto'),recognitionLanguage:z.enum(['auto',...locales]).default('auto'),deliveryMode:z.enum(['auto','neutral']).default('auto')}).strict();
const messageSchema=z.object({text:z.string().trim().min(1).max(2000),clientMessageId:z.uuid(),settings:settingsSchema.optional(),stream:z.boolean().default(true)}).strict();
const uuid=z.uuid();
function validate(schema,value){const r=schema.safeParse(value);if(!r.success)throw new AppError(400,'INVALID_INPUT','Invalid request. Check the language, message length and identifiers.');return r.data;}

export async function createBackend(config,overrides={}){
  const store=overrides.store||(config.STORAGE==='memory'?new MemoryStore():new PostgresStore(config));await store.init();
  const transport=overrides.transport||(config.MODEL_TRANSPORT==='worker'?new WorkerTransport(config):new DirectTransport(config));
  const models=overrides.models||new Models(config,transport),assistant=new Assistant(store,models);
  const authenticate=overrides.authenticate||authenticator(config);
  const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
  const server=createServer(app);server.headersTimeout=15000;server.requestTimeout=30000;
  const tickets=new Map(),limits=new Map(),controllers=new Set(),sockets=new Set(),tasks=new Set();let shuttingDown=false;
  const housekeeping=setInterval(()=>{const now=Date.now();for(const[k,t]of tickets)if(t.expires<now)tickets.delete(k);for(const[k,t]of limits)if(t.until<now)limits.delete(k);},30000);housekeeping.unref();
  function limited(key,max=120){const now=Date.now();let bucket=limits.get(key);if(!bucket||bucket.until<now){if(limits.size>20000)throw new AppError(429,'RATE_LIMIT','Too many requests. Retry shortly.');bucket={count:0,until:now+60000};limits.set(key,bucket);}if(++bucket.count>max)throw new AppError(429,'RATE_LIMIT','Too many requests. Retry shortly.');}
  function originAllowed(req){const origin=req.headers.origin;if(!origin)return true;return config.origins.includes(origin)||origin===`${config.NODE_ENV==='production'?'https':'http'}://${req.headers.host}`;}
  app.use((req,res,next)=>{
    res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','Permissions-Policy':'microphone=(self)','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
    if(!originAllowed(req))return res.status(403).json({error:{code:'ORIGIN_DENIED',message:'Origin not permitted.'}});
    if(req.headers.origin){res.set('Access-Control-Allow-Origin',req.headers.origin);res.vary('Origin');res.set('Access-Control-Allow-Headers','Authorization, Content-Type');res.set('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');}
    if(req.method==='OPTIONS')return res.sendStatus(204);next();
  });
  app.use(express.json({limit:'32kb'}));
  app.get('/healthz',(_req,res)=>res.status(shuttingDown?503:200).json({ok:!shuttingDown,service:'sriaas-ai-backend'}));
  app.get('/client-config',(_req,res)=>res.json({authMode:config.AUTH_MODE,scope:'general_conversation'}));
  const api=express.Router();
  api.use(async(req,res,next)=>{limited('ip:'+req.ip,180);req.user=await authenticate(req.headers.authorization);limited('user:'+req.user.id,120);if(shuttingDown)throw new AppError(503,'RESTARTING','The server is restarting. Reconnect shortly.');next();});
  api.get('/capabilities',async(_req,res)=>res.json({models:{llm:'Gemma 4 E4B',stt:'Bodhan Indic-Transcribe-Core',tts:'AI4Bharat Indic Parler'},languages,limits:{voiceSeconds:config.VOICE_SESSION_SECONDS,concurrentSessions:1,maxMessageCharacters:2000},audio:{inputRate:24000,outputRate:22050,encoding:'pcm_s16le',channels:1},status:await transport.health(),storage:config.STORAGE}));
  api.post('/conversations',async(req,res)=>res.status(201).json({conversation:await store.create(req.user.id,validate(settingsSchema,req.body||{}))}));
  api.get('/conversations',async(req,res)=>res.json({conversations:await store.list(req.user.id)}));
  api.param('id',(req,_res,next,id)=>{validate(uuid,id);next();});
  api.get('/conversations/:id/messages',async(req,res)=>{
    const before=req.query.before===undefined?Number.MAX_SAFE_INTEGER:validate(z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),req.query.before);
    const messages=await store.messages(req.params.id,req.user.id,before);res.json({conversation:await store.get(req.params.id,req.user.id),messages,nextBefore:messages.length===100?messages[0].seq:null});
  });
  api.delete('/conversations/:id',async(req,res)=>{await store.get(req.params.id,req.user.id);if(assistant.locks.has(req.params.id))throw new AppError(409,'CONVERSATION_BUSY','End the active session before deleting it.');await store.delete(req.params.id,req.user.id);res.sendStatus(204);});
  api.delete('/history',async(req,res)=>{if(assistant.locks.size)throw new AppError(409,'ASSISTANT_BUSY','End active sessions before clearing history.');await store.deleteAll(req.user.id);res.sendStatus(204);});
  api.post('/conversations/:id/messages',async(req,res)=>{
    const body=validate(messageSchema,req.body),c=await store.get(req.params.id,req.user.id);
    if(!transport.ready)throw new AppError(503,'WORKER_OFFLINE','Start the Spark model worker before chatting.');
    const release=assistant.acquire(c.id,'text'),controller=new AbortController();controllers.add(controller);res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    let seq=0;
    const emit=async event=>{
      if(!body.stream)return;
      if(res.destroyed)throw new AppError(499,'DISCONNECTED','Client disconnected.');
      if(!res.write(`data: ${JSON.stringify({...event,seq:++seq})}\n\n`))await new Promise((resolve,reject)=>{
        const cleanup=()=>{clearTimeout(timer);res.off('drain',done);res.off('close',closed);};const done=()=>{cleanup();resolve();};const closed=()=>{cleanup();reject(new Error('closed'));};
        const timer=setTimeout(()=>{cleanup();controller.abort();reject(new Error('slow connection'));},10000);res.once('drain',done);res.once('close',closed);
      });
    };
    if(body.stream){res.status(200).set({'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();}
    const keepalive=body.stream?setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n');},15000):null;
    try{
      const task=assistant.turn({id:c.id,owner:req.user.id,text:body.text,clientId:body.clientMessageId,options:body.settings||c.settings,signal:controller.signal,emit});
      tasks.add(task);let message;try{message=await task;}finally{tasks.delete(task);}
      if(!body.stream)res.json({message});else res.end();
    }catch(error){if(body.stream){await emit({type:'error',error:publicError(error)}).catch(()=>{});res.end();}else throw error;}
    finally{clearInterval(keepalive);controllers.delete(controller);release();}
  });
  api.post('/conversations/:id/voice-session',async(req,res)=>{
    const c=await store.get(req.params.id,req.user.id);const settings=validate(settingsSchema,req.body?.settings||c.settings);
    if(!transport.ready)throw new AppError(503,'WORKER_OFFLINE','Start the Spark model worker before speaking.');
    if(tickets.size>=1000)throw new AppError(429,'RATE_LIMIT','Too many pending sessions.');
    const ticket=randomBytes(32).toString('base64url');tickets.set(ticket,{owner:req.user.id,conversationId:c.id,settings,expires:Date.now()+30000});
    res.json({ticket,path:'/api/v1/assistant/voice',expiresInSeconds:30});
  });
  app.use('/api/v1/assistant',api);
  app.use(express.static(fileURLToPath(new URL('../public',import.meta.url)),{dotfiles:'deny'}));
  app.use((_req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'Route not found.'}}));
  app.use((error,_req,res,_next)=>{
    const safe=error instanceof AppError?error:new AppError(error.type==='entity.too.large'?413:error instanceof SyntaxError?400:500,'REQUEST_FAILED',error.type==='entity.too.large'?'Request is too large.':error instanceof SyntaxError?'Invalid JSON.':'The request could not be completed.');
    if(!res.headersSent)res.status(safe.status===499?400:safe.status).json({error:publicError(safe)});else res.end();
    if(safe.status>=500)console.error('Request failed',{code:safe.code});
  });
  const voiceWss=new WebSocketServer({noServer:true,maxPayload:48000,perMessageDeflate:false}),workerWss=new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false});
  function heartbeat(ws){sockets.add(ws);let alive=true;const timer=setInterval(()=>{if(!alive){ws.terminate();return;}alive=false;ws.ping();},20000);timer.unref();ws.on('pong',()=>{alive=true;});ws.on('error',()=>{});ws.on('close',()=>{clearInterval(timer);sockets.delete(ws);});}
  server.on('upgrade',(req,socket,head)=>{
    socket.on('error',()=>{});
    try{
      if(shuttingDown)throw Error();limited('ws:'+socket.remoteAddress,60);
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/internal/model-worker'){
        if(config.MODEL_TRANSPORT!=='worker'||!sameSecret(req.headers.authorization,`Bearer ${config.MODEL_WORKER_TOKEN}`)||transport.ready)throw Error();
        workerWss.handleUpgrade(req,socket,head,ws=>{heartbeat(ws);transport.attach(ws);});return;
      }
      if(url.pathname!=='/api/v1/assistant/voice'||!originAllowed(req))throw Error();
      const token=url.searchParams.get('ticket'),ticket=tickets.get(token);tickets.delete(token);
      if(!ticket||ticket.expires<Date.now())throw Error();
      const release=assistant.acquire(ticket.conversationId,'voice');
      try{voiceWss.handleUpgrade(req,socket,head,ws=>{heartbeat(ws);const task=voiceSession(ws,ticket,{assistant,transport,config,release}).catch(()=>{release();ws.close(1011);});tasks.add(task);void task.finally(()=>tasks.delete(task));});}catch(e){release();throw e;}
    }catch{socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');}
  });
  async function close(){
    shuttingDown=true;clearInterval(housekeeping);for(const c of controllers)c.abort();for(const ws of sockets)ws.close(1012,'Server restarting');transport.close?.();
    const timer=setTimeout(()=>{for(const ws of sockets)ws.terminate();server.closeAllConnections();},1500);timer.unref();
    await new Promise(resolve=>server.close(resolve));clearTimeout(timer);await Promise.allSettled([...tasks]);await store.close();
  }
  return {app,server,store,transport,assistant,close};
}
