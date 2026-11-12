class Capture extends AudioWorkletProcessor {
  constructor(){super();this.phase=0;this.chunk=new Int16Array(1920);this.offset=0;}
  process(inputs){
    const channel=inputs[0]?.[0];if(!channel)return true;
    // AudioContext normally runs at 24 kHz. Handle a different negotiated rate.
    for(const value of channel){this.phase+=24000;while(this.phase>=sampleRate){this.phase-=sampleRate;const v=Math.max(-1,Math.min(1,value));this.chunk[this.offset++]=Math.round(v*(v<0?32768:32767));if(this.offset===1920){this.port.postMessage(this.chunk.buffer,[this.chunk.buffer]);this.chunk=new Int16Array(1920);this.offset=0;}}}
    return true;
  }
}
registerProcessor('assistant-capture',Capture);
