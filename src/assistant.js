import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {AppError,checkAbort,publicError} from './errors.js';

export class Assistant {
  constructor(store,models){this.store=store;this.models=models;this.locks=new Map();this.voiceActive=false;this.textActive=0;}
  acquire(id,type){
    if(this.locks.has(id)||this.voiceActive||this.textActive>=1)throw new AppError(409,'ASSISTANT_BUSY','The assistant is already in use. End the active session or wait for its reply.');
    this.locks.set(id,type);if(type==='voice')this.voiceActive=true;else this.textActive++;
    let released=false;return()=>{if(released)return;released=true;this.locks.delete(id);if(type==='voice')this.voiceActive=false;else this.textActive--;};
  }
  async turn({id,owner,text,clientId=randomUUID(),mode='text',options,detected,signal,emit}){
    const started=performance.now();const c=await this.store.get(id,owner);
    const history=await this.store.messages(id,owner);
    const turn=await this.store.begin(id,owner,clientId,text,mode);
    if(turn.duplicate){await emit({type:'response.replayed',message:turn.assistant});return turn.assistant;}
    let output='',language=null,status='failed';let firstText=null,firstAudio=null,finishReason='stop';
    const responseId=turn.assistant.id;
    try {
      await this.store.setSettings(id,owner,options);
      await emit({type:'response.started',responseId,userMessage:turn.user});
      language=await this.models.language(text,options.replyLanguage,history,c.last_language,detected,signal);
      const delivery=mode==='voice'?await this.models.delivery(text,options.deliveryMode,history,signal):null;
      await emit({type:'response.language',responseId,language,detectedLanguage:detected||null,delivery});
      for await(const part of this.models.reply(text,history,language,mode==='voice',delivery,signal)){
        checkAbort(signal);if(part.finishReason){finishReason=part.finishReason;continue;}
        const delta=(mode==='voice'&&output?' ':'')+part.text;output+=delta;
        if(firstText===null)firstText=performance.now()-started;
        await emit({type:'response.text.delta',responseId,delta});
        if(mode==='voice')for await(const audio of this.models.speech(part.text,language,delivery,signal)){
          if(firstAudio===null)firstAudio=performance.now()-started;
          await emit({type:'response.audio.delta',responseId,sampleRate:22050,audio:audio.toString('base64')});
        }
      }
      checkAbort(signal);status=finishReason==='length'?'truncated':'completed';
      const message=await this.store.finish(id,owner,responseId,output,status,language);
      await emit({type:'response.done',responseId,message,finishReason,metrics:{firstTextMs:Math.round(firstText||0),firstAudioMs:firstAudio===null?null:Math.round(firstAudio),totalMs:Math.round(performance.now()-started),scope:'From finalized input; excludes speech-end detection, network transit and client playback.'}});
      return message;
    }catch(error){
      status=signal.aborted?'interrupted':'failed';
      await this.store.finish(id,owner,responseId,output,status,language);
      await emit({type:status==='interrupted'?'response.cancelled':'response.error',responseId,error:publicError(error)}).catch(()=>{});
      throw error;
    }
  }
}
