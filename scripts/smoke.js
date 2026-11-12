// Uses your running backend. Never logs access keys. Optional voice fixture: PCM16 mono WAV.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import WebSocket from 'ws';
const base=process.env.BACKEND_URL||'http://127.0.0.1:3000',token=process.env.SMOKE_ACCESS_TOKEN||process.env.TEST_API_KEY;
if(!token)throw Error('Set TEST_API_KEY or SMOKE_ACCESS_TOKEN.');
const report={at:new Date().toISOString(),transport:'HTTP + WebSocket',text:[],voice:null};
async function api(path,body){const r=await fetch(base+'/api/v1/assistant'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(180000)});if(!r.ok)throw Error('Backend request failed: '+r.status);return r;}
const caps=await (await api('/capabilities')).json();report.health=caps.status;console.log('Model status:',caps.status);
const settings={replyLanguage:'auto',recognitionLanguage:'ta-IN',deliveryMode:process.env.SMOKE_DELIVERY||'neutral'};
const {conversation}=await (await api('/conversations',settings)).json();report.conversationId=conversation.id;
for(const text of ['நீங்கள் எப்படி இருக்கிறீர்கள்?','ஹலோ']){
 const response=await api(`/conversations/${conversation.id}/messages`,{text,clientMessageId:randomUUID()});const data=await response.text();const events=data.split('\n').filter(s=>s.startsWith('data:')).map(s=>JSON.parse(s.slice(5)));
 const done=events.find(e=>e.type==='response.done');if(!done)throw Error('Text turn failed: '+JSON.stringify(events.filter(e=>e.error)));if(done.message.language!=='tamil'||!/[\u0b80-\u0bff]/u.test(done.message.content))throw Error('Expected Tamil reply');
 report.text.push({input:text,reply:done.message.content,metrics:done.metrics});console.log('Tamil text passed:',done.metrics);
}
const audioPath=process.argv[2];
if(audioPath){
 const wav=await readFile(audioPath);let format,pcm;for(let i=12;i+8<=wav.length;){const type=wav.toString('ascii',i,i+4),size=wav.readUInt32LE(i+4);if(type==='fmt ')format={encoding:wav.readUInt16LE(i+8),channels:wav.readUInt16LE(i+10),rate:wav.readUInt32LE(i+12),bits:wav.readUInt16LE(i+22)};if(type==='data')pcm=wav.subarray(i+8,i+8+size);i+=8+size+(size%2);}
 if(!pcm||format?.encoding!==1||format.channels!==1||format.bits!==16)throw Error('Voice fixture must be PCM16 mono WAV.');
 const samples=Math.floor(pcm.length/2*24000/format.rate),converted=Buffer.alloc(samples*2);
 for(let i=0;i<samples;i++){const p=i*format.rate/24000,j=Math.floor(p),fraction=p-j;const a=pcm.readInt16LE(Math.min(j*2,pcm.length-2)),b=pcm.readInt16LE(Math.min((j+1)*2,pcm.length-2));converted.writeInt16LE(Math.round(a+(b-a)*fraction),i*2);}
 const ticket=await (await api(`/conversations/${conversation.id}/voice-session`,{settings})).json();const url=new URL(ticket.path,base);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('ticket',ticket.ticket);
 const ws=new WebSocket(url),events=[],audio=[];let stopped=false;let resolveDone,rejectDone;const finished=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
 const timer=setTimeout(()=>rejectDone(Error('Voice smoke timed out')),180000);
 ws.on('error',rejectDone);ws.on('message',raw=>{const e=JSON.parse(raw);events.push(e);if(e.type==='response.audio.delta')audio.push(Buffer.from(e.audio,'base64'));if(e.error)rejectDone(Error(e.error.message));if(e.type==='response.done')resolveDone(e);});
 const feeding=(async()=>{await once(ws,'open');while(!events.some(e=>e.type==='session.started')){if(stopped)return;await new Promise(r=>setTimeout(r,20));}const input=Buffer.concat([Buffer.alloc(12000),converted,Buffer.alloc(48000*4)]);for(let i=0;i<input.length&&!stopped;i+=3840){if(ws.readyState!==WebSocket.OPEN)throw Error('Voice socket closed');ws.send(input.subarray(i,i+3840));await new Promise(r=>setTimeout(r,80));}})();feeding.catch(rejectDone);
 try{const done=await finished;if(done.message.language!=='tamil'||!audio.length)throw Error('Expected Tamil text and spoken audio');const raw=Buffer.concat(audio);const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+raw.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(22050,24);header.writeUInt32LE(44100,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(raw.length,40);await mkdir('test-results',{recursive:true});await writeFile('test-results/tamil-reply.wav',Buffer.concat([header,raw]));report.voice={transcript:events.find(e=>e.type==='transcript.done')?.text,reply:done.message.content,audioBytes:raw.length,metrics:done.metrics};console.log('Tamil voice passed:',done.metrics);}
 finally{stopped=true;clearTimeout(timer);if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'session.end'}));ws.close();await feeding.catch(()=>{});}
}
await mkdir('test-results',{recursive:true});await writeFile('test-results/smoke.json',JSON.stringify(report,null,2));console.log('Saved test-results/smoke.json');
