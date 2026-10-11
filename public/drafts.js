// Local copies are scoped to an authenticated account and its group. A session
// expiry locks the offline entry point without deleting recoverable drafts.
export const ACTIVE_KEY='psalmony-active-library';
export const draftKey=(userId,bandId)=>`psalmony-library:${encodeURIComponent(userId)}:${encodeURIComponent(bandId)}`;
export function createDraftStore(storage){
 const memory=new Map();let active=null,locked=false;
 const read=key=>{if(memory.has(key))return structuredClone(memory.get(key));try{return JSON.parse(storage.getItem(key));}catch{return null;}};
 const valid=value=>value?.state&&value.user?.id&&value.user?.bandId&&!value.user.guest;
 return {
  save(value){if(!valid(value))return false;const key=draftKey(value.user.id,value.user.bandId);const snapshot=structuredClone(value);memory.set(key,snapshot);active={userId:value.user.id,bandId:value.user.bandId};locked=false;try{storage.setItem(key,JSON.stringify(snapshot));storage.setItem(ACTIVE_KEY,JSON.stringify(active));return true;}catch{return false;}},
  get(userId,bandId){const value=read(draftKey(userId,bandId));return valid(value)&&value.user.id===userId&&value.user.bandId===bandId?value:null;},
  offline(){if(locked)return null;let pointer=active;try{pointer||=JSON.parse(storage.getItem(ACTIVE_KEY));}catch{}return pointer?this.get(pointer.userId,pointer.bandId):null;},
  lock(){active=null;locked=true;try{storage.removeItem(ACTIVE_KEY);}catch{}},
  forget(userId,bandId){const key=draftKey(userId,bandId);memory.delete(key);try{storage.removeItem(key);}catch{}},
  migrate(){let legacy;try{legacy=JSON.parse(storage.getItem('psalmony-cache'));}catch{}if(!valid(legacy))return;const existing=this.get(legacy.user.id,legacy.user.bandId);if(existing){try{storage.removeItem('psalmony-cache');}catch{}return;}if(this.save(legacy)){try{storage.removeItem('psalmony-cache');}catch{}}}
 };
}
export function restoreLibrary(fresh,cached){
 if(!fresh.state||!cached?.pending||cached.user?.id!==fresh.user.id||cached.user?.bandId!==fresh.user.bandId)return {...fresh,pending:false,conflict:false};
 return {...cached,user:fresh.user,members:fresh.members,pending:true,conflict:!!cached.conflict||fresh.revision!==cached.revision||fresh.user.role==='viewer'};
}
export function saveFailure(error,localSaved){
 const suffix=localSaved?'Черновик сохранён на этом устройстве.':'Локальное сохранение не удалось. Не закрывайте страницу; экспортируйте копию.';
 if(error.status===401)return `Сессия завершилась. Войдите тем же аккаунтом, чтобы восстановить правки. ${suffix}`;
 if(error.status===409)return `Конфликт изменений: автоматическая перезапись отключена. Откройте настройки синхронизации. ${suffix}`;
 if(error.status)return `${error.message} ${suffix}`;
 return `Нет связи с сервером. ${suffix}`;
}
