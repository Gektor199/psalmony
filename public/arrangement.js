const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

export function validateArrangement(value) {
  if (!value || !Array.isArray(value.blocks) || !Array.isArray(value.order) || !value.blocks.length || value.blocks.length > 64 || !value.order.length || value.order.length > 256) return false;
  const ids = new Set();
  for (const b of value.blocks) {
    if (!b || !validId(b.id) || ids.has(b.id) || typeof b.title !== 'string' || !b.title.trim() || b.title.length > 100 || /[\r\n{}]/.test(b.title) || typeof b.lyrics !== 'string' || b.lyrics.length > 200000) return false;
    ids.add(b.id);
  }
  if (value.order.some(id => !ids.has(id))) return false;
  return arrangementText(value).length <= 200000;
}

export function arrangementText(value) {
  const blocks = new Map(value.blocks.map(b => [b.id, b]));
  return value.order.map(id => {
    const b = blocks.get(id);
    return b ? `{comment:${b.title}}\n${b.lyrics}` : '';
  }).join('\n\n');
}

// Migration is opt-in: opening the builder never changes the saved song.
export function arrangementFromLyrics(lyrics) {
  const blocks = [], order = [];
  let title = 'Вступление', lines = [];
  function flush() {
    const content = lines.join('\n').trim();
    if (!content && !lines.length) return;
    let b = blocks.find(b => b.title === title && b.lyrics === content);
    if (!b) { b = { id: `part-${blocks.length + 1}`, title, lyrics: content }; blocks.push(b); }
    order.push(b.id); lines = [];
  }
  for (const line of lyrics.split(/\r?\n/)) {
    const m = line.match(/^\{(?:comment|c):\s*(.*?)\}$/i);
    if (m) { flush(); title = m[1].trim() || 'Раздел'; }
    else if (/^\{(?:start_of_chorus|soc)\}$/i.test(line)) { flush(); title = 'Припев'; }
    else if (!/^\{(?:end_of_chorus|eoc)\}$/i.test(line)) lines.push(line);
  }
  flush();
  if (!blocks.length) { blocks.push({id:'part-1',title:'Куплет',lyrics:''}); order.push('part-1'); }
  return {blocks,order};
}

export function songParts(song) {
  const a = song.arrangement || arrangementFromLyrics(song.lyrics || '');
  return a.order.map(id => a.blocks.find(b => b.id === id)).filter(Boolean);
}

export function validPosition(snapshot, position) {
  if (!position || !Number.isInteger(position.index) || !Number.isInteger(position.part) || position.index < 0 || position.index >= snapshot.items.length || position.part < 0) return false;
  const item = snapshot.items[position.index];
  const song = snapshot.songs.find(s => s.id === item.songId);
  return position.part < (song ? songParts(song).length : 1);
}
