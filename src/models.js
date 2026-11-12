import {AppError,checkAbort} from './errors.js';
import {languages,languageKeys,chooseLanguage,isAcknowledgement,scriptMatches} from './languages.js';

export class TextSegments {
  constructor(voice=false){this.pending='';this.text='';this.hidden=false;this.voice=voice;this.emitted=false;}
  feed(chunk,final=false){
    this.pending+=chunk;const result=[];
    while(this.pending){
      if(this.pending.startsWith('<think>')){this.hidden=true;this.pending=this.pending.slice(7);continue;}
      if(this.pending.startsWith('</think>')){this.hidden=false;this.pending=this.pending.slice(8);continue;}
      if(!final&&['<think>','</think>'].some(tag=>tag.startsWith(this.pending)))break;
      const char=this.pending[0];this.pending=this.pending.slice(1);
      if(this.hidden||(this.voice&&'*#`'.includes(char)))continue;
      this.text+=char;
      const limit=this.emitted?220:110;
      if(/\s/u.test(char)&&((this.text.length>=35&&/[.!?।]["'’”]?\s+$/u.test(this.text))||this.text.length>=limit)){
        result.push(this.clean(this.text));this.text='';this.emitted=true;
      }
    }
    if(final){if(this.text.trim())result.push(this.clean(this.text));this.text='';this.pending='';}
    return result.filter(Boolean);
  }
  clean(text){return this.voice?text.replace(/\[(?:delivery|tone|emotion|intensity):[^\]]*\]/gi,'').replace(/<\/?(?:happy|sad|anger|fear|clear)>/gi,'').trim():text;}
}
export async function* decodeSSE(chunks){
  const decoder=new TextDecoder();let buffer='';
  for await(const bytes of chunks){
    buffer+=decoder.decode(bytes,{stream:true});if(buffer.length>256000)throw new AppError(502,'MODEL_PROTOCOL','The model returned an invalid stream.');
    let index;while((index=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,index).trimEnd();buffer=buffer.slice(index+1);if(line.startsWith('data:'))yield line.slice(5).trim();}
  }
  buffer+=decoder.decode();if(buffer.startsWith('data:'))yield buffer.slice(5).trim();
}
export class Models {
  constructor(config,transport){this.config=config;this.transport=transport;}
  async *bytes(service,body,signal){
    for await(const event of this.transport.request(service,body,signal)){
      checkAbort(signal);
      if(event.kind==='head'&&(event.status<200||event.status>=300))throw new AppError(502,'MODEL_UNAVAILABLE',`${service==='tts'?'Speech generation':'Gemma 4'} is unavailable. Check the model worker.`);
      if(event.kind==='chunk')yield event.data;
    }
  }
  async completion(messages,{signal,schema,maxTokens=100,temperature=0}={}){
    const parts=[];let length=0;
    for await(const bytes of this.bytes('llm',{model:this.config.GEMMA_MODEL,messages,temperature,max_tokens:maxTokens,stream:false,...(schema?{response_format:{type:'json_object',schema}}:{})},signal)){length+=bytes.length;if(length>1000000)throw new AppError(502,'MODEL_PROTOCOL','The model response was too large.');parts.push(bytes);}
    const payload=JSON.parse(Buffer.concat(parts).toString());const content=payload.choices?.[0]?.message?.content;
    if(typeof content!=='string'||!content.trim())throw new AppError(502,'EMPTY_REPLY','Gemma returned an empty reply.');return content.trim();
  }
  async language(text,selected,history,previous,detected,signal){
    if(selected!=='auto')return selected;
    if(previous&&languages[previous]&&isAcknowledgement(text))return previous;
    const schema={type:'object',properties:{language:{type:'string',enum:[...languageKeys,'unsupported']},explicit_request:{type:'boolean'}},required:['language','explicit_request'],additionalProperties:false};
    const content=await this.completion([
      {role:'system',content:'Select the reply language. Return language and explicit_request JSON only. Explicit_request is true only when the latest message asks to answer in a named language. Otherwise match the current spoken language; brief acknowledgements retain the previous conversation language. Recognize romanized Indic speech. Hindi-English mixed speech is hinglish. Do not confuse languages sharing a script: Marathi, Nepali, Sanskrit, Konkani, Maithili, Bodo and Dogri are not Hindi. Bengali, Assamese and Manipuri are distinct. Use unsupported for languages outside this list: '+JSON.stringify(Object.fromEntries(Object.entries(languages).map(([k,v])=>[k,v.name])))},
      {role:'user',content:JSON.stringify({latest_message:text,previous_user_messages:history.filter(m=>m.role==='user').slice(-3).map(m=>m.content),previous_reply_language:previous,detected_speech_language:detected})},
    ],{signal,schema,maxTokens:80});
    return chooseLanguage(JSON.parse(content),text,detected);
  }
  async delivery(text,mode,history,signal){
    const neutral={tone:'neutral',intensity:'subtle'};if(mode==='neutral')return neutral;
    try{
      const tones=['neutral','warm','reassuring','empathetic','excited','clear'];
      const schema={type:'object',properties:{tone:{type:'string',enum:tones},intensity:{type:'string',enum:['subtle','moderate']}},required:['tone','intensity'],additionalProperties:false};
      const raw=await this.completion([{role:'system',content:'Choose delivery for the next assistant reply. Return tone and intensity JSON. Neutral for facts, warm for greetings, reassuring for worries, empathetic for loss, excited for good news, clear for explanations. Use subtle unless the user explicitly asks for stronger emotion. Do not diagnose emotions or answer the message.'},{role:'user',content:JSON.stringify({latest_message:text,previous_user_messages:history.filter(m=>m.role==='user').slice(-2).map(m=>m.content)})}],{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),schema,maxTokens:64});
      const value=JSON.parse(raw);if(!tones.includes(value.tone)||!['subtle','moderate'].includes(value.intensity))return neutral;return value;
    }catch{checkAbort(signal);return neutral;}
  }
  async ensureScript(text,language,signal){
    if(scriptMatches(text,language))return text;
    const corrected=await this.completion([{role:'system',content:'Rewrite the supplied answer only, preserving its meaning. '+languages[language].instruction+' Return only the corrected answer.'},{role:'user',content:text}],{signal,maxTokens:384});
    if(!scriptMatches(corrected,language)||!/[\p{L}]/u.test(corrected))throw new AppError(502,'LANGUAGE_DRIFT','The reply could not be generated in the selected language. No wrong-language speech was played.');return corrected;
  }
  async *reply(text,history,language,voice,delivery,signal){
    const system='You are a warm, helpful general conversation assistant in the SRIAAS app. You have no web browsing, company knowledge lookup, medical records, ERP access or ability to perform actions. Do not claim otherwise. Answer directly and naturally, use conversation context, and ask at most one relevant follow-up question. Avoid repeated stock empathy. '+languages[language].instruction+(voice?' Use speech-friendly sentences without Markdown, emoji, stage directions, delivery labels or thinking aloud. Keep emotional expression subtle.':' Use readable paragraphs or lists when helpful. Never reveal hidden reasoning.')+(delivery?` Voice delivery: ${delivery.tone}, ${delivery.intensity}; never say these labels.`:'');
    let remaining=4500;const recent=[];
    for(const row of [...history].reverse()){
      if(!row.content||row.status==='pending'||row.status==='failed')continue;
      if(row.content.length>remaining)break;recent.unshift({role:row.role,content:row.content});remaining-=row.content.length;
    }
    while(recent[0]?.role==='assistant')recent.shift();
    // Merge interrupted user turns to respect Gemma's alternating-role template.
    const messages=[{role:'system',content:system}];
    for(const row of [...recent,{role:'user',content:text+'\n\nResponse language: '+languages[language].name+'. '+languages[language].instruction}]){
      if(messages.at(-1)?.role===row.role)messages.at(-1).content+='\n'+row.content;else messages.push({...row});
    }
    const body={model:this.config.GEMMA_MODEL,messages,max_tokens:this.config.MAX_OUTPUT_TOKENS,temperature:0.6,stream:true};
    const segments=new TextSegments(voice);let complete=false,received=false,finishReason;
    for await(const data of decodeSSE(this.bytes('llm',body,signal))){
      if(data==='[DONE]'){complete=true;break;}
      const event=JSON.parse(data);if(event.error)throw new AppError(502,'MODEL_ERROR','Gemma could not finish the reply.');
      for(const choice of event.choices||[]){
        if(choice.finish_reason){finishReason=choice.finish_reason;complete=true;}
        const content=choice.delta?.content;if(typeof content!=='string')continue;
        for(const part of segments.feed(content)){const corrected=await this.ensureScript(part,language,signal);received=true;yield {text:corrected};}
      }
    }
    if(!complete)throw new AppError(502,'INCOMPLETE_REPLY','The model connection ended before the reply completed.');
    for(const part of segments.feed('',true)){const corrected=await this.ensureScript(part,language,signal);received=true;yield {text:corrected};}
    if(!received)throw new AppError(502,'EMPTY_REPLY','Gemma returned an empty reply.');
    yield {finishReason:finishReason||'stop'};
  }
  async *speech(text,language,delivery,signal){
    const info=languages[language];let received=false,pending=Buffer.alloc(0);
    for await(const bytes of this.bytes('tts',{input:text,language:info.locale,voice:info.voice,delivery,sample_rate:22050,response_format:'pcm',stream:true},signal)){
      const pcm=Buffer.concat([pending,bytes]);const even=pcm.length-pcm.length%2;pending=pcm.subarray(even);
      if(even){received=true;yield pcm.subarray(0,even);}
    }
    if(!received||pending.length)throw new AppError(502,'INVALID_AUDIO','Speech generation returned incomplete audio.');
  }
}
