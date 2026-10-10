export const KEYS = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
const NOTES = {C:0,'B#':0,'C#':1,Db:1,D:2,'D#':3,Eb:3,E:4,Fb:4,'E#':5,F:5,'F#':6,Gb:6,G:7,'G#':8,Ab:8,A:9,'A#':10,Bb:10,B:11,Cb:11};
const mod = n => (n % 12 + 12) % 12;
export function transpose(chord, steps = 0) {
  return chord.replace(/^([A-G][b#]?)([^/]*)(?:\/([A-G][b#]?))?$/, (_,root,tail,bass) => KEYS[mod(NOTES[root]+steps)] + tail + (bass ? '/' + KEYS[mod(NOTES[bass]+steps)] : ''));
}
export function nashville(chord, key = 'C') {
  const scale = ['1','♭2','2','♭3','3','4','♯4','5','♭6','6','♭7','7'];
  const base = NOTES[key.replace(/m$/, '')] ?? 0;
  return chord.replace(/^([A-G][b#]?)([^/]*)(?:\/([A-G][b#]?))?$/, (_,root,tail,bass) => scale[mod(NOTES[root]-base)] + tail + (bass ? '/' + scale[mod(NOTES[bass]-base)] : ''));
}
export function parseChordPro(text) {
  const result = {title:'', artist:'', key:'C', bpm:90, lyrics:''};
  result.lyrics = text.split(/\r?\n/).filter(line => {
    const m = line.match(/^\{(title|t|artist|subtitle|st|key|tempo):\s*(.*?)\}$/i);
    if (!m) return true;
    const k = {t:'title',subtitle:'artist',st:'artist',tempo:'bpm'}[m[1].toLowerCase()] || m[1].toLowerCase();
    result[k] = k === 'bpm' ? Number(m[2]) || 90 : m[2]; return false;
  }).join('\n').trim();
  return result;
}
export function detectPitch(buffer, sampleRate) {
  let energy = 0; for (const v of buffer) energy += v*v;
  if (Math.sqrt(energy/buffer.length) < .008) return null;
  let best = -1, lag = 0;
  const min = Math.floor(sampleRate/1200), max = Math.min(Math.floor(sampleRate/55), buffer.length/2);
  for(let t=min;t<max;t++) { let ab=0,aa=0,bb=0; for(let i=0;i<buffer.length-max;i++) { const a=buffer[i], b=buffer[i+t]; ab+=a*b; aa+=a*a; bb+=b*b; } const c=ab/Math.sqrt(aa*bb||1); if(c>best){best=c;lag=t;} if(best>.96 && c<best-.015) break; }
  if(best<.85 || !lag) return null;
  const hz=sampleRate/lag, midi=69+12*Math.log2(hz/440), rounded=Math.round(midi);
  return {hz, note:KEYS[mod(rounded)], octave:Math.floor(rounded/12)-1, cents:Math.round((midi-rounded)*100)};
}
export function duration(seconds) { seconds = Math.max(0, Math.round(seconds||0)); return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`; }
export function setDuration(set, songs) { return (set.items||[]).reduce((n,i)=>n+(i.type==='song' ? songs.find(s=>s.id===i.songId)?.duration||0 : i.duration||0),0); }
