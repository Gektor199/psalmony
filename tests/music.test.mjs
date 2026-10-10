import {test} from 'node:test';
import assert from 'node:assert/strict';
import {transpose,nashville,parseChordPro,detectPitch,setDuration,duration} from '../public/music.js';
test('transpose preserves chord quality and independently shifts slash bass',()=>{
 assert.equal(transpose('Cmaj7/E',2),'Dmaj7/F#');
 assert.equal(transpose('Bb7',-2),'Ab7');
 assert.equal(transpose('F#m7b5',1),'Gm7b5');
 assert.equal(transpose('N.C.',3),'N.C.');
 assert.equal(transpose('Am',12),'Am');
});
test('every pitch returns after transposing up and down an octave',()=>{for(const note of ['C','D','E','F','G','A','B'])assert.equal(transpose(note,24),note);});
test('Nashville numbers use the tonic and slash bass',()=>{
 assert.equal(nashville('G/B','C'),'5/7');assert.equal(nashville('Bm7','D'),'6m7');assert.equal(nashville('Eb','C'),'♭3');
});
test('ChordPro imports metadata and retains song structure',()=>{
 const s=parseChordPro('{title: Song}\r\n{artist: Band}\r\n{key: D}\r\n{tempo: 123}\r\n{comment:Verse}\r\n[D]Hello [A]world');
 assert.deepEqual(s,{title:'Song',artist:'Band',key:'D',bpm:123,lyrics:'{comment:Verse}\n[D]Hello [A]world'});
});
test('tuner detects a generated A440 and rejects silence',()=>{
 const b=Float32Array.from({length:4096},(_,i)=>Math.sin(i*2*Math.PI*440/48000)*.2);const p=detectPitch(b,48000);assert.equal(p.note,'A');assert.equal(p.octave,4);assert.ok(Math.abs(p.cents)<5);assert.equal(detectPitch(new Float32Array(4096),48000),null);
});
test('set duration includes repeated songs and breaks, not notes',()=>{
 assert.equal(setDuration({items:[{type:'song',songId:'a'},{type:'break',duration:60},{type:'note'},{type:'song',songId:'a'}]},[{id:'a',duration:180}]),420);
 assert.equal(duration(420),'7:00');assert.equal(duration(0),'0:00');
});
