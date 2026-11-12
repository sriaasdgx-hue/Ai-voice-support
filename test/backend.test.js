import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {loadConfig} from '../src/config.js';
import {authenticator} from '../src/auth.js';
import {createBackend} from '../src/app.js';
import {MemoryStore,PostgresStore} from '../src/store.js';
import {chooseLanguage,scriptMatches,languages} from '../src/languages.js';
import {Models,TextSegments,decodeSSE} from '../src/models.js';
import {AsyncQueue} from '../src/transport.js';
import {startWorker} from '../src/worker.js';

const key='test-only-key-'+ 'a'.repeat(32),workerKey='worker-only-key-'+ 'b'.repeat(32);
const settings={replyLanguage:'tamil',recognitionLanguage:'ta-IN',deliveryMode:'neutral'};
const config=(extra={})=>loadConfig({NODE_ENV:'test',AUTH_MODE:'test-key',TEST_API_KEY:key,STORAGE:'memory',PORT:0,...extra});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<300;i++){if(await fn())return;await pause(10);}assert.fail('Timed out');}
class FakeTransport{
  ready=true; calls=[]; listeners=[]; cancelled=0;
  async health(){return {llm:true,stt:true,tts:true};}
  async *request(service,body,signal){
    this.calls.push({service,body});yield {kind:'head',status:200};
    if(service==='tts'){yield {kind:'chunk',data:Buffer.alloc(4400)};return;}
    if(body.messages.at(-1).content.includes('WAIT_FOR_CANCEL')){await new Promise(r=>{if(signal.aborted)r();else signal.addEventListener('abort',r,{once:true});});this.cancelled++;signal.throwIfAborted();}
    if(!body.stream){yield {kind:'chunk',data:Buffer.from(JSON.stringify({choices:[{message:{content:JSON.stringify({language:'tamil',explicit_request:false})}}]}))};return;}
    for(const data of [{choices:[{delta:{content:'நான் நலமாக இருக்கிறேன். நீங்கள் எப்படி இருக்கிறீர்கள்?'}}]},{choices:[{delta:{},finish_reason:'stop'}]}])yield {kind:'chunk',data:Buffer.from('data: '+JSON.stringify(data)+'\n\n')};
    yield {kind:'chunk',data:Buffer.from('data: [DONE]\n\n')};
  }
  async stt(_settings,onEvent,signal){const entry={onEvent,closed:false};this.listeners.push(entry);const close=()=>{entry.closed=true;};signal.addEventListener('abort',close,{once:true});return {send:async()=>{},commit:async()=>{},close};}
}
async function fixture(t,{worker=false,auth=false}={}){
  const transport=new FakeTransport(),c=config(worker?{MODEL_TRANSPORT:'worker',MODEL_WORKER_TOKEN:workerKey}:{});
  const app=await createBackend(c,{...(worker?{}:{transport}),...(auth?{authenticate:async header=>{if(!header)throw Error();return {id:header};}}:{})});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base='http://127.0.0.1:'+app.server.address().port;
  let connector;if(worker){connector=startWorker({...c,BACKEND_URL:base},{transport,log:()=>{}});await until(()=>app.transport.ready);}
  t.after(async()=>{connector?.stop();await app.close();});
  const request=async(path,method='GET',body,token=key)=>fetch(base+'/api/v1/assistant'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const r=await request('/conversations','POST',settings);assert.equal(r.status,201);const {conversation}=await r.json();
  return {app,transport,base,request,conversation};
}
async function voice(f){const r=await f.request(`/conversations/${f.conversation.id}/voice-session`,'POST',{});const ticket=await r.json();const ws=new WebSocket(f.base.replace('http','ws')+ticket.path+'?ticket='+ticket.ticket);const events=[];ws.on('message',data=>events.push(JSON.parse(data)));await once(ws,'open');await until(()=>events.some(e=>e.type==='session.started'));return {ws,events,ticket};}

test('configuration rejects unprotected or ephemeral production setup',()=>{
 assert.throws(()=>config({TEST_API_KEY:'short'}));assert.throws(()=>config({NODE_ENV:'production'}));assert.throws(()=>config({MODEL_TRANSPORT:'worker',MODEL_WORKER_TOKEN:key}));
 assert.throws(()=>loadConfig({BACKEND_URL:'http://example.com',MODEL_WORKER_TOKEN:workerKey},{worker:true}));
});
test('Supabase verifies token remotely and never trusts a submitted user ID',async()=>{
 const auth=authenticator({AUTH_MODE:'supabase',SUPABASE_URL:'https://test.example',SUPABASE_ANON_KEY:'anon'},async(url,options)=>{assert.equal(url,'https://test.example/auth/v1/user');assert.equal(options.headers.Authorization,'Bearer jwt');return Response.json({id:'verified-user'});});
 assert.equal((await auth('Bearer jwt')).id,'verified-user');await assert.rejects(auth('jwt'));
});
test('Tamil script overrides incorrect classification; acknowledgements and unsupported languages are guarded',async()=>{
 assert.equal(chooseLanguage({language:'hindi',explicit_request:false},'நீங்கள் எப்படி இருக்கிறீர்கள்','bn'),'tamil');
 assert.equal(chooseLanguage({language:'english',explicit_request:true},'ஆங்கிலத்தில் பதில் சொல்லுங்கள்','ta'),'english');
 assert.throws(()=>chooseLanguage({language:'hindi',explicit_request:false},'का हाल बा','bho'));
 const m=new Models(config(),new FakeTransport());assert.equal(await m.language('হ্যাঁ','auto',[],'tamil','bn',new AbortController().signal),'tamil');
 assert.equal(scriptMatches('I am doing well.','tamil'),false);assert.equal(scriptMatches('நான் நலமாக இருக்கிறேன்.','tamil'),true);
 assert.equal(Object.keys(languages).length,23);assert.equal(languages.bhojpuri,undefined);
});
test('stream parser preserves split Unicode and excludes hidden reasoning across chunk boundaries',async()=>{
 const s=new TextSegments();let output='';for(const c of ['<thi','nk>secret</thi','nk>நான் நலமாக இருக்கிறேன்.'])output+=s.feed(c).join('');output+=s.feed('',true).join('');assert.equal(output,'நான் நலமாக இருக்கிறேன்.');
 const bytes=Buffer.from('data: தமிழ்\n\ndata: [DONE]\n\n');async function* chunks(){for(const b of bytes)yield Buffer.from([b]);}const events=[];for await(const e of decodeSSE(chunks()))events.push(e);assert.deepEqual(events,['தமிழ்','[DONE]']);
});
test('model rejects wrong-language corrections instead of speaking English',async()=>{
 const m=new Models(config(),{});m.completion=async()=> 'Still English';await assert.rejects(m.ensureScript('Hello','tamil',new AbortController().signal),e=>e.code==='LANGUAGE_DRIFT');
});
test('relay queue fails bounded slow consumers',async()=>{const q=new AsyncQueue();q.push({data:'x'.repeat(2100000)});await assert.rejects(q.next(),e=>e.code==='SLOW_CONSUMER');});

for(const kind of ['memory','postgres'])test(`${kind} history isolates users, persists idempotent turns and deletes ownership-safely`,{skip:kind==='postgres'&&!process.env.TEST_DATABASE_URL},async t=>{
 const store=kind==='memory'?new MemoryStore():new PostgresStore({DATABASE_URL:process.env.TEST_DATABASE_URL});await store.init();t.after(()=>store.close());
 const owner=randomUUID(),c=await store.create(owner,settings),id=randomUUID();await assert.rejects(store.get(c.id,'different'),e=>e.status===404);
 const turn=await store.begin(c.id,owner,id,'வணக்கம்','text');await store.finish(c.id,owner,turn.assistant.id,'வணக்கம்!','completed','tamil');
 assert.equal((await store.begin(c.id,owner,id,'வணக்கம்','text')).duplicate,true);await assert.rejects(store.begin(c.id,owner,id,'changed','text'),e=>e.status===409);
 await store.setSettings(c.id,owner,{...settings,replyLanguage:'english'});assert.equal((await store.get(c.id,owner)).settings.replyLanguage,'english');
 assert.equal((await store.messages(c.id,owner)).length,2);assert.equal((await store.get(c.id,owner)).last_language,'tamil');
 if(kind==='postgres'){const second=new PostgresStore({DATABASE_URL:process.env.TEST_DATABASE_URL});await second.init();assert.equal((await second.messages(c.id,owner))[1].content,'வணக்கம்!');await second.close();}
 await assert.rejects(store.delete(c.id,'different'));await store.deleteAll(owner);assert.equal((await store.list(owner)).length,0);
});
test('HTTP authentication, origin, input validation, owner isolation and safe static files',async t=>{
 const f=await fixture(t);assert.equal((await fetch(f.base+'/healthz')).status,200);assert.equal((await fetch(f.base+'/.env')).status,404);
 assert.equal((await f.request('/conversations','GET',null,'bad')).status,401);
 assert.equal((await fetch(f.base+'/healthz',{headers:{Origin:'https://evil.example'}})).status,403);
 assert.equal((await f.request('/conversations','POST',{owner_id:'spoof'})).status,400);
 assert.equal((await f.request('/conversations/not-a-uuid/messages')).status,400);
 const other=await f.app.store.create('different',settings);assert.equal((await f.request(`/conversations/${other.id}/messages`)).status,404);
 assert.equal((await f.request(`/conversations/${other.id}`,'DELETE')).status,404);
});
for(const worker of [false,true])test(`${worker?'worker relay':'direct'} text streams Tamil, saves history and replays duplicate without model call`,async t=>{
 const f=await fixture(t,{worker});const path=`/conversations/${f.conversation.id}/messages`,body={text:'நீங்கள் எப்படி இருக்கிறீர்கள்?',clientMessageId:randomUUID()};
 const r=await f.request(path,'POST',body);assert.equal(r.status,200);const events=(await r.text()).split('\n').filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5)));
 assert(events.some(e=>e.type==='response.text.delta'&&e.delta.includes('நான்')));assert.equal(events.at(-1).type,'response.done');assert.equal(events.at(-1).message.language,'tamil');
 const calls=f.transport.calls.length;const repeat=await f.request(path,'POST',{...body,stream:false});assert.equal((await repeat.json()).message.status,'completed');assert.equal(f.transport.calls.length,calls);
 assert.equal((await f.request(path,'POST',{...body,text:'different',stream:false})).status,409);
 assert.equal((await (await f.request(path)).json()).messages.length,2);
});
test('worker offline returns a useful error without creating an incomplete message',async t=>{
 const f=await fixture(t);f.app.transport.ready=false;const r=await f.request(`/conversations/${f.conversation.id}/messages`,'POST',{text:'hello',clientMessageId:randomUUID()});assert.equal(r.status,503);assert.equal((await r.json()).error.code,'WORKER_OFFLINE');assert.equal((await f.app.store.messages(f.conversation.id,'render-test-user')).length,0);
});
for(const worker of [false,true])test(`${worker?'worker relay':'direct'} voice uses single-use tickets, streams audio and releases STT on disconnect`,async t=>{
 const f=await fixture(t,{worker}),v=await voice(f);t.after(()=>v.ws.terminate());
 const reused=new WebSocket(f.base.replace('http','ws')+v.ticket.path+'?ticket='+v.ticket.ticket);const rejected=await once(reused,'error');assert.match(rejected[0].message,/401/);
 const busy=await f.request(`/conversations/${f.conversation.id}/messages`,'POST',{text:'hello',clientMessageId:randomUUID()});assert.equal(busy.status,409);
 f.transport.listeners.at(-1).onEvent({type:'conversation.item.input_audio_transcription.completed',transcript:'நீங்கள் எப்படி இருக்கிறீர்கள்?',language:'ta'});
 await until(()=>v.events.some(e=>e.type==='response.done'));assert(v.events.some(e=>e.type==='response.audio.delta'&&e.sampleRate===22050));
 v.ws.close();await until(()=>f.transport.listeners.at(-1).closed&&!f.app.assistant.voiceActive);
 assert.equal((await f.app.store.messages(f.conversation.id,'render-test-user')).length,2);
});
test('voice interruption cancels model request and saves partial turn; malformed PCM ends session',async t=>{
 const f=await fixture(t,{worker:true}),v=await voice(f);t.after(()=>v.ws.terminate());
 f.transport.listeners.at(-1).onEvent({type:'conversation.item.input_audio_transcription.completed',transcript:'WAIT_FOR_CANCEL',language:'ta'});
 await until(()=>f.transport.calls.some(c=>c.body.stream));v.ws.send(JSON.stringify({type:'response.cancel'}));
 await until(()=>v.events.some(e=>e.type==='response.cancelled'));await until(()=>f.transport.cancelled===1);
 const rows=await f.app.store.messages(f.conversation.id,'render-test-user');assert.equal(rows.at(-1).status,'interrupted');
 v.ws.send(Buffer.alloc(3));await until(()=>v.events.some(e=>e.type==='session.error'));await until(()=>!f.app.assistant.voiceActive);
});
test('HTTP cancellation aborts generation and releases capacity',async t=>{
 const f=await fixture(t);const controller=new AbortController();const r=await fetch(f.base+`/api/v1/assistant/conversations/${f.conversation.id}/messages`,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({text:'WAIT_FOR_CANCEL',clientMessageId:randomUUID()}),signal:controller.signal});
 await until(()=>f.transport.calls.some(c=>c.body.stream));controller.abort();await r.text().catch(()=>{});await until(()=>f.transport.cancelled===1&&f.app.assistant.textActive===0);
 assert.equal((await f.app.store.messages(f.conversation.id,'render-test-user')).at(-1).status,'interrupted');
});

test('worker disconnect terminates an active turn and frees capacity',async t=>{
 const f=await fixture(t,{worker:true});const r=await f.request(`/conversations/${f.conversation.id}/messages`,'POST',{text:'WAIT_FOR_CANCEL',clientMessageId:randomUUID()});
 await until(()=>f.transport.calls.some(c=>c.body.stream));f.app.transport.ws.terminate();const events=await r.text();assert.match(events,/WORKER_OFFLINE/);await until(()=>f.app.assistant.textActive===0);assert.equal((await f.app.store.messages(f.conversation.id,'render-test-user')).at(-1).status,'failed');
});
test('shutdown cancels active voice, persists interruption and closes resources',async t=>{
 const f=await fixture(t,{worker:true}),v=await voice(f);t.after(()=>v.ws.terminate());
 f.transport.listeners.at(-1).onEvent({type:'conversation.item.input_audio_transcription.completed',transcript:'WAIT_FOR_CANCEL',language:'ta'});await until(()=>f.transport.calls.some(c=>c.body.stream));
 const closing=f.app.close();await closing;assert.equal(f.app.assistant.voiceActive,false);assert.equal((await f.app.store.messages(f.conversation.id,'render-test-user')).at(-1).status,'interrupted');
});
