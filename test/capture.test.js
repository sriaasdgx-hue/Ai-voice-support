import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('microphone worklet produces clipped mono PCM16 at 24 kHz with 80 ms frames',async()=>{
 for(const rate of [24000,48000]){
  const frames=[];let Capture;
  const context={sampleRate:rate,AudioWorkletProcessor:class {port={postMessage:buffer=>frames.push(buffer)};},registerProcessor:(_name,processor)=>{Capture=processor;},Int16Array,Math};
  vm.runInNewContext(await readFile(new URL('../public/capture.js',import.meta.url),'utf8'),context);
  const capture=new Capture();for(let i=0;i<rate/100;i++)capture.process([[new Float32Array(100).fill(i%2?-2:2)]]);
  assert.equal(frames.length,12);assert.equal(frames[0].byteLength,3840);assert.equal(new Int16Array(frames[0])[0],32767);assert(new Int16Array(frames[0]).includes(-32768));assert.equal(capture.offset,960);
 }
});
