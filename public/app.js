const $=id=>document.getElementById(id);
let token='',conversation=null,capabilities=null,busy=false,connecting=false,activeResponseId=null,voice=null,voiceReady=false,muted=false,mic=null,captureContext=null,outputContext=null,outputTime=0,requestController=null;
const bubbles=new Map(),audioSources=new Set(),cancelledResponses=new Set();
function notice(message=''){$('notice').textContent=message;$('notice').hidden=!message;}
function controls(){const signed=!!token;for(const id of ['new','refresh','history','delete','recognition','language','delivery'])$(id).disabled=!signed||busy||connecting||!!voice;$('text').disabled=!signed||connecting||!!voice;$('send').disabled=!signed||busy||connecting||!!voice;$('talk').disabled=!signed||busy||connecting||!!voice;$('end').disabled=!voice;$('mute').disabled=!voiceReady;$('stop').disabled=!busy&&!voiceReady;}
async function api(path,method='GET',body){const r=await fetch('/api/v1/assistant'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(r.status===204)return null;const data=await r.json();if(!r.ok)throw Error(data.error?.message||'Request failed.');return data;}
function settings(){return {replyLanguage:$('language').value,recognitionLanguage:$('recognition').value,deliveryMode:$('delivery').value};}
function languageNote(){const l=capabilities?.languages[$('language').value];$('language-note').textContent=l?.experimental?'Experimental language: check fluency and pronunciation.':l?.genericVoice?'This language uses a generic Parler speaker. Check pronunciation.':'Choose a fixed input and reply language for more reliable matching.';}
function bubble(id,role,text=''){if(bubbles.has(id))return bubbles.get(id);$('messages').querySelector('.empty')?.remove();const e=document.createElement('div');e.className='bubble '+role;const label=document.createElement('small');label.textContent=role==='user'?'YOU':'SRIAAS ASSISTANT';const content=document.createElement('span');content.textContent=text;e.append(label,content);$('messages').append(e);bubbles.set(id,content);scroll();return content;}
function scroll(){$('messages').scrollTop=$('messages').scrollHeight;}
function clearAudio(){for(const source of audioSources){try{source.stop();}catch{}}audioSources.clear();outputTime=outputContext?.currentTime||0;}
function play(event){if(cancelledResponses.has(event.responseId))return;const raw=atob(event.audio),pcm=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)pcm[i]=raw.charCodeAt(i);const view=new DataView(pcm.buffer);const data=outputContext.createBuffer(1,pcm.length/2,event.sampleRate);for(let i=0;i<data.length;i++)data.getChannelData(0)[i]=view.getInt16(i*2,true)/32768;const source=outputContext.createBufferSource();source.buffer=data;source.connect(outputContext.destination);source.onended=()=>audioSources.delete(source);outputTime=Math.max(outputContext.currentTime+.035,outputTime);source.start(outputTime);outputTime+=data.duration;audioSources.add(source);if(outputTime-outputContext.currentTime>30){clearAudio();stopReply();notice('Playback fell behind; the reply was stopped.');}}
function handle(event){
  if(event.type==='response.started'){activeResponseId=event.responseId;bubble(event.userMessage.id,'user',event.userMessage.content);bubble(event.responseId,'assistant');$('voice-state').textContent='Thinking…';}
  else if(event.type==='response.text.delta'){if(!cancelledResponses.has(event.responseId))bubble(event.responseId,'assistant').textContent+=event.delta;scroll();}
  else if(event.type==='response.audio.delta'){if(outputContext){play(event);$('voice-state').textContent='Speaking…';}}
  else if(event.type==='response.done'){
    bubble(event.responseId,'assistant').textContent=event.message.content;const m=event.metrics;$('metrics').textContent=`First text: ${(m.firstTextMs/1000).toFixed(2)}s${m.firstAudioMs===null?'':` · First audio: ${(m.firstAudioMs/1000).toFixed(2)}s`} · Generation: ${(m.totalMs/1000).toFixed(2)}s`;
    if(event.message.status==='truncated')notice('The reply reached its length limit. Ask the assistant to continue.');void refreshHistory().catch(e=>notice(e.message));if(voiceReady)$('voice-state').textContent='Listening';
  }else if(event.type==='response.replayed'){bubble(event.message.id,'assistant',event.message.content);}
  else if(event.type==='playback.clear'){if(activeResponseId)cancelledResponses.add(activeResponseId);clearAudio();if(voiceReady)$('voice-state').textContent='Listening';}
  else if(event.type==='response.cancelled'){cancelledResponses.add(event.responseId);clearAudio();}
  else if(event.type==='transcript.delta'){$('transcript').textContent=event.delta;}
  else if(event.type==='transcript.done'){$('transcript').textContent=event.text;}
  else if(event.type==='session.started'){voiceReady=true;$('voice-state').textContent='Listening';controls();}
  else if(event.type==='session.ended'){void endVoice();}
  else if(event.error){notice(event.error.message);if(event.type==='session.error')void endVoice();}
}
async function refreshHistory(){const data=await api('/conversations');$('history').replaceChildren(...data.conversations.map(c=>{const o=document.createElement('option');o.value=c.id;o.textContent=c.title;return o;}));if(conversation)$('history').value=conversation.id;}
async function createConversation(){const data=await api('/conversations','POST',settings());conversation=data.conversation;bubbles.clear();$('messages').replaceChildren();$('transcript').textContent='';await refreshHistory();}
async function refreshModels(){capabilities=await api('/capabilities');const status=capabilities.status;const all=status.llm&&status.stt&&status.tts;$('connection').textContent=all?'Models ready':status.worker===false?'Spark worker offline':'Models loading / unavailable';if(!all)notice('Keep the local models and Spark connector running. Use Check models to refresh.');else notice();}
$('connect').onclick=async()=>{try{token=$('token').value.trim();await refreshModels();for(const[id,recognition]of[['language',false],['recognition',true]]){const select=$(id);select.replaceChildren(new Option(recognition?'Auto detect':'Match my language','auto'));for(const[key,l]of Object.entries(capabilities.languages)){if(recognition&&key==='hinglish')continue;select.add(new Option(`${l.name} · ${l.native}${l.experimental?' · Experimental':''}`,recognition?l.locale:key));}}$('token').value='';$('login').hidden=true;await refreshHistory();if($('history').options.length){$('history').value=$('history').options[0].value;await loadConversation();}else await createConversation();}catch(e){token='';$('login').hidden=false;notice(e.message);}finally{controls();}};
async function loadConversation(){const data=await api(`/conversations/${$('history').value}/messages`);conversation=data.conversation;bubbles.clear();$('messages').replaceChildren();for(const m of data.messages)bubble(m.id,m.role,m.content+(m.status==='interrupted'?'\n[Interrupted]':''));$('language').value=conversation.settings.replyLanguage;$('recognition').value=conversation.settings.recognitionLanguage;$('delivery').value=conversation.settings.deliveryMode;languageNote();}
$('history').onchange=()=>loadConversation().catch(e=>notice(e.message));$('new').onclick=()=>createConversation().catch(e=>notice(e.message));$('refresh').onclick=()=>refreshModels().catch(e=>notice(e.message));$('language').onchange=languageNote;
$('delete').onclick=async()=>{if(!conversation||!confirm('Delete this conversation and its messages?'))return;try{await api(`/conversations/${conversation.id}`,'DELETE');await createConversation();}catch(e){notice(e.message);}};
$('composer').onsubmit=async event=>{
  event.preventDefault();const text=$('text').value.trim();if(!text||busy||connecting||voice)return;
  busy=true;controls();notice();requestController=new AbortController();let accepted=false;
  try{
    const r=await fetch(`/api/v1/assistant/conversations/${conversation.id}/messages`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({text,clientMessageId:crypto.randomUUID(),settings:settings(),stream:true}),signal:requestController.signal});
    if(!r.ok){const d=await r.json();throw Error(d.error?.message||'Chat failed.');}accepted=true;$('text').value='';
    const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(true){const{value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.startsWith('data:'))handle(JSON.parse(line.slice(5)));}}
  }catch(e){if(e.name!=='AbortError')notice(e.message);if(!accepted)$('text').value=text;}finally{requestController=null;busy=false;controls();}
};
function stopReply(){if(activeResponseId)cancelledResponses.add(activeResponseId);requestController?.abort();if(voice?.readyState===WebSocket.OPEN)voice.send(JSON.stringify({type:'response.cancel'}));clearAudio();}
$('stop').onclick=stopReply;
$('talk').onclick=async()=>{
  if(voice||busy||connecting)return;connecting=true;controls();notice();$('voice-state').textContent='Connecting…';
  try{
    outputContext=new AudioContext();await outputContext.resume();
    mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});
    captureContext=new AudioContext({sampleRate:24000});await captureContext.audioWorklet.addModule('/capture.js');await captureContext.resume();
    const source=captureContext.createMediaStreamSource(mic),recorder=new AudioWorkletNode(captureContext,'assistant-capture'),silence=captureContext.createGain();silence.gain.value=0;source.connect(recorder).connect(silence).connect(captureContext.destination);
    const ticket=await api(`/conversations/${conversation.id}/voice-session`,'POST',{settings:settings()});const url=new URL(ticket.path,location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.searchParams.set('ticket',ticket.ticket);
    voice=new WebSocket(url);voice.onmessage=event=>handle(JSON.parse(event.data));voice.onclose=()=>void endVoice();voice.onerror=()=>{notice('Voice connection failed. Check model availability and try again.');void endVoice();};
    recorder.port.onmessage=({data})=>{if(voiceReady&&voice?.readyState===WebSocket.OPEN){if(voice.bufferedAmount>192000){notice('The connection is too slow for voice.');void endVoice();return;}voice.send(data);}};
    connecting=false;controls();
  }catch(e){notice(e.message);await endVoice();}
};
async function endVoice(){const ws=voice;voice=null;voiceReady=false;muted=false;if(ws){ws.onclose=null;if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'session.end'}));ws.close();}for(const t of mic?.getTracks()||[])t.stop();mic=null;clearAudio();await captureContext?.close().catch(()=>{});await outputContext?.close().catch(()=>{});captureContext=null;outputContext=null;connecting=false;$('voice-state').textContent='Voice is off';$('mute').textContent='Mute';controls();}
$('end').onclick=()=>void endVoice();$('mute').onclick=()=>{muted=!muted;for(const t of mic?.getAudioTracks()||[])t.enabled=!muted;$('mute').textContent=muted?'Unmute':'Mute';};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&voice)void endVoice();});window.addEventListener('pagehide',()=>{requestController?.abort();void endVoice();});
fetch('/client-config').then(r=>r.json()).then(c=>{$('token-label').textContent=c.authMode==='test-key'?'Render test API key':'Supabase access token';$('auth-help').textContent=c.authMode==='test-key'?'Paste TEST_API_KEY from your Render environment. This private test mode uses one shared test history. The key stays in page memory.':'Paste a signed-in user’s Supabase access token. Each user has separate conversation history. The token stays in page memory.';}).catch(()=>notice('Backend is unavailable.'));
controls();
