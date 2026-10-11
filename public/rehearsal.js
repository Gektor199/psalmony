// Native audio room; browser offers desktop clients and program controls.
export async function openRehearsal({api,dialog,esc,user,members,set,tracks,onLead,onFollow}) {
 dialog('Комната группы','<div id="rehearsal-root"><p class="muted">Открываем комнату…</p></div>',true);
 const root=document.querySelector('#rehearsal-root');
 if(window.PsalmonyAudio){await window.PsalmonyAudio.mount(root,{set,tracks,onLead:user.role!=='viewer'?onLead:null,onFollow});return;}
 root.closest('dialog')?.classList.add('audio-room-dialog');
 root.innerHTML=`<div class="audio-room"><header class="room-heading"><div><h2>${esc(set.title)}</h2></div></header><div class="room-workspace"><section class="room-stage"><div class="room-stage-heading"><span>Аудио</span><span>До 8 подключений</span></div><div class="room-waiting"><h3>Для аудио нужно приложение</h3><p>В браузере доступны программа и совместный просмотр.</p><div class="room-downloads"><a class="btn white" href="https://psalmony.91.226.80.181.sslip.io/downloads/Psalmony-0.6.1-mac-universal.dmg">Скачать для Mac</a><a class="btn glass" href="https://psalmony.91.226.80.181.sslip.io/downloads/Psalmony-0.6.1-windows-x64.exe">Для Windows</a></div><p class="room-release-note">Тестовая версия · без нотариализации Apple и подписи Windows</p></div></section><aside class="room-program"><h3>Программа</h3><div class="room-track-list">${(tracks||[]).map((t,i)=>`<div class="room-track"><span>${String(i+1).padStart(2,'0')}</span><div><b>${esc(t.title)}</b><small>${esc(t.detail)}</small></div></div>`).join('')}</div>${user.role!=='viewer'?'<button class="btn secondary" id="browser-lead">Вести программу →</button>':''}<button class="btn text" id="browser-follow">Следовать за ведущим</button></aside></div><p class="room-feedback" role="status" id="browser-status"></p></div>`;
 const runBrowser=async fn=>{try{await fn();}catch(e){const status=root.querySelector('#browser-status');if(status)status.textContent=e.message;}};
 root.querySelector('#browser-follow').onclick=()=>runBrowser(onFollow);
 const browserLead=root.querySelector('#browser-lead');if(browserLead)browserLead.onclick=()=>runBrowser(onLead);
}
