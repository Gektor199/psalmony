export function seed() {
  const songs = [
    ['s1','Навстречу свету','Psalmony Sessions','D',96,238,'Поп','sky'],
    ['s2','Тихий океан','Psalmony Sessions','Am',72,264,'Акустика','ocean'],
    ['s3','Выше облаков','Psalmony Sessions','G',112,212,'Поп','peach'],
    ['s4','Пока горят огни','Psalmony Sessions','Em',124,226,'Рок','violet'],
    ['s5','Здесь и сейчас','Psalmony Sessions','C',88,245,'Акустика','green'],
    ['s6','Новый день','Psalmony Sessions','F',104,203,'Поп','gold']
  ].map(([id,title,artist,key,bpm,duration,tag,color],i)=>({id,title,artist,key,bpm,duration,meter:'4/4',tags:[tag],color,favorite:i<2,capo:0,notes:'Учебная композиция Psalmony. Текст создан для демонстрации приложения.',links:[],files:[],annotations:[],lyrics:'{comment:Куплет 1}\n[D]Утро рисует [A]свет на стене,\n[Bm]Новый мотив про[G]снулся во мне.\n[D]Сделаем музыку [A]чуть-чуть теплей,\n[G]Соберём вместе [A]наших друзей.\n\n{comment:Припев}\n[G]Навстречу свету, [D]навстречу ветру,\n[A]Каждая нота — [Bm]наш новый шаг.\n[G]Пусть эта песня [D]летит по свету,\n[Em]Всё начинается [A]просто [D]так.\n\n{comment:Куплет 2}\n[D]Тихо настроим [A]струны опять,\n[Bm]Будем друг друга [G]слышать, играть.\n[D]Время оставим [A]за дверью на час,\n[G]Музыка здесь и [A]сейчас.\n\n{comment:Припев}\n[G]Навстречу свету, [D]навстречу ветру,\n[A]Каждая нота — [Bm]наш новый шаг.\n[G]Пусть эта песня [D]летит по свету,\n[Em]Всё начинается [A]просто [D]так.',updatedAt:new Date().toISOString()}));
  const shift={D:0,Am:-2,G:5,Em:5,C:-2,F:3};
  // Keep demo charts musically consistent with their declared key (minor charts use relative major).
  const names=['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
  for(const s of songs) s.lyrics=s.lyrics.replace(/\[([A-G])([^\]]*)\]/g,(_,r,t)=>`[${names[(names.indexOf(r)+shift[s.key]+12)%12]}${t}]`);
  return {bandName:'Моя группа',songs,setlists:[{id:'set1',title:'Акустический вечер',date:'2026-10-10T19:00',location:'Студия · Большой зал',kind:'Выступление',description:'Тёплый вечер, любимая музыка и только живой звук.',color:'sky',assignments:{},items:[{id:'i1',type:'song',songId:'s1'},{id:'i2',type:'song',songId:'s2'},{id:'i3',type:'song',songId:'s3'},{id:'i4',type:'break',title:'Пауза',duration:300,notes:'Проверить настройку гитар'},{id:'i5',type:'song',songId:'s5'}]},{id:'set2',title:'Репетиция нового сета',date:'2026-10-08T18:30',location:'Репетиционная комната',kind:'Репетиция',description:'Разобрать переходы и вступления.',color:'peach',assignments:{},items:[{id:'i6',type:'song',songId:'s4'},{id:'i7',type:'song',songId:'s6'}]}],activity:[{id:'a1',text:'Добро пожаловать! В библиотеке — 6 учебных композиций. Их можно редактировать или удалить.',at:new Date().toISOString()}]};
}
