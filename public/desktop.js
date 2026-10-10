/* Native Psalmony host: inert in the PWA. Audio never passes through the webview. */
(()=>{
 const config=window.psalmonyDesktop;if(!config)return;
 const original=window.fetch.bind(window);
 window.fetch=async(input,options={})=>{
  const url=new URL(input instanceof Request?input.url:input,location.href),method=(options.method||(input instanceof Request?input.method:'GET')).toUpperCase();
  if(url.origin===location.origin&&(url.pathname.startsWith('/desktop/')||(url.pathname.startsWith('/api/')&&!['GET','HEAD'].includes(method)))){
   const headers=new Headers(input instanceof Request?input.headers:undefined);new Headers(options.headers).forEach((v,k)=>headers.set(k,v));headers.set('X-Psalmony-Desktop',config.token);options={...options,headers};
   if(['/api/bands/switch','/api/auth/logout','/api/auth/login','/api/auth/register','/api/invites/join'].includes(url.pathname))await original('/desktop/disconnect',{method:'POST',headers:{'X-Psalmony-Desktop':config.token}});
  }
  return original(input,options);
 };
 const request=async(path,body)=>{const r=await fetch(path,{...(body!==undefined?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});const v=await r.json();if(!r.ok)throw Error(v.error||'Не удалось выполнить действие');return v;};
 document.addEventListener('click',e=>{const a=e.target.closest('a[href]');if(!a)return;const u=new URL(a.href,location.href);if(u.origin!==location.origin&&['https:','http:'].includes(u.protocol)){e.preventDefault();request('/desktop/open',{url:u.href}).catch(()=>{});}});
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let state={running:false,connected:false,members:[]},polling=false;
 const listeners=new Set();const dock=document.createElement('div');dock.className='desktop-audio-dock';dock.hidden=true;
 dock.innerHTML='<span class="audio-live-dot"></span><span data-dock-status></span><button class="btn secondary" data-dock-mixer>Микшер</button><button class="btn secondary" data-dock-mute>Микрофон</button><button class="btn secondary" data-dock-stop>Отключиться</button>';
 document.body.append(dock);
 function paintDock(){dock.hidden=!state.running;if(!state.running)return;dock.querySelector('[data-dock-status]').textContent=state.connected?`Репетиция · ${state.members.length} / 8`:'Подключаем звук…';dock.querySelector('[data-dock-mute]').textContent=state.micMuted?'Включить микрофон':'Выключить микрофон';dock.classList.toggle('mic-live',!state.micMuted);}
 async function tick(){if(polling)return;polling=true;try{state=await request('/desktop/audio');paintDock();for(const fn of listeners)fn(state);}catch{}finally{polling=false;}}
 async function poll(){await tick();setTimeout(poll,state.running||listeners.size?100:1000);}poll();
 dock.querySelector('[data-dock-stop]').onclick=()=>request('/desktop/disconnect',{}).then(tick);
 dock.querySelector('[data-dock-mute]').onclick=()=>request('/desktop/controls',{muted:!state.micMuted}).then(tick);
 dock.querySelector('[data-dock-mixer]').onclick=()=>{let d=document.querySelector('#desktop-audio-dialog');if(!d){d=document.createElement('dialog');d.id='desktop-audio-dialog';d.innerHTML='<div class="modal-head"><h2>Онлайн-репетиция</h2><button class="btn secondary" data-audio-close>Закрыть</button></div><div data-native-audio></div>';document.body.append(d);d.querySelector('[data-audio-close]').onclick=()=>d.close();mount(d.querySelector('[data-native-audio]'));}d.showModal();};
 async function mount(root, context={}) {
  root.closest('dialog')?.classList.add('audio-room-dialog');
  const glyph=(name)=>`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{mic:'<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',headphones:'<path d="M3 14v-3a9 9 0 0 1 18 0v3"/><rect x="3" y="12" width="4" height="9" rx="2"/><rect x="17" y="12" width="4" height="9" rx="2"/>',wave:'<path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4"/>',settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--surface)"/><circle cx="15" cy="17" r="3" fill="var(--surface)"/>'}[name]}</svg>`;
  root.innerHTML=`<div class="audio-room">
   <header class="room-heading"><div><span class="room-kicker">PSALMONY SESSIONS</span><h2>${esc(context.set?.title||'Комната группы')}</h2><p>Ваша музыка. В одном пространстве.</p></div><span class="room-status" data-room-badge>Не подключены</span></header>
   <div class="room-workspace"><section class="room-stage room-mixer"><div class="room-stage-heading"><span>Микшер <b data-room-count>0 / 8</b></span><span>Ваш персональный микс</span></div>
    <div class="mixer-bank"><article class="mixer-channel mixer-input"><span class="channel-number">IN</span><b>Микрофон</b><small>С устройства</small><div class="channel-control"><div class="channel-scale"><span>0</span><span>−30</span><span>−60</span></div><div class="channel-vu" role="meter" aria-label="Уровень микрофона" aria-valuemin="-60" aria-valuemax="0" aria-valuenow="-60" data-mic-vu><i></i></div></div><output data-mic-db>−∞ dBFS</output><button class="channel-mute" data-native-mute disabled aria-pressed="true"><span data-mic-label>Включить</span></button></article>
    <div class="mixer-peers" data-native-members></div><div class="mixer-empty" data-room-waiting><span>＋</span><h3>Каналы группы</h3><p>Участники появятся здесь после подключения</p></div>
    <article class="mixer-channel mixer-master"><span class="channel-number">OUT</span><b>Мой микс</b><small>В наушники</small><div class="channel-control"><div class="channel-scale"><span>0</span><span>−6</span><span>−∞</span></div><div class="channel-fader"><input aria-label="Общая громкость группы" aria-orientation="vertical" type="range" min="0" max="100" value="0" data-native-master></div><div class="channel-vu" role="meter" aria-label="Уровень выхода в наушники" aria-valuemin="-60" aria-valuemax="0" aria-valuenow="-60" data-output-vu><i></i></div></div><output data-master-value>−∞ dB</output><button class="channel-mute" data-master-mute aria-pressed="true" disabled>Mute</button></article></div>
    <dl class="mixer-network" aria-label="Качество соединения"><div data-network-metric="ping"><dt>Ping</dt><dd><span>—</span></dd></div><div data-network-metric="delay"><dt>Delay ≈</dt><dd><span>—</span></dd></div><div data-network-metric="jitter"><dt>Jitter</dt><dd><span>—</span></dd></div><div class="mixer-server">Москва</div></dl></section>
   <aside class="room-program"><span class="room-kicker">СЕГОДНЯ ИГРАЕМ</span><h3>Программа</h3><div class="room-track-list">${(context.tracks||[]).map((track,i)=>`<div class="room-track"><span>${String(i+1).padStart(2,'0')}</span><div><b>${esc(track.title)}</b><small>${esc(track.detail||'')}</small></div></div>`).join('')||'<p class="muted">Откройте комнату из сет-листа, чтобы видеть программу.</p>'}</div>${context.onLead?'<button class="btn secondary" data-room-lead>Вести программу →</button>':''}${context.onFollow?'<button class="btn text" data-room-follow>Следовать за ведущим</button>':''}</aside></div>
   <div class="room-controls mixer-actions"><p role="status" class="room-feedback" data-native-status>Проверяем аудиоустройства…</p><button class="btn primary room-join" data-native-connect disabled>Подключить звук</button><button class="btn room-leave" data-native-disconnect hidden>Завершить</button></div>
   <details class="room-settings"><summary>${glyph('settings')}<span>Настройки звука</span><small data-device-summary>Микрофон и наушники</small></summary><div class="room-settings-body"><div class="form-grid"><label class="field"><span>Микрофон или инструмент</span><select data-native-input><option value="">Системный вход</option></select></label><label class="field"><span>Наушники или колонки</span><select data-native-output><option value="">Системный выход</option></select></label></div><div class="room-input-meter"><span>Входной сигнал</span><meter aria-label="Уровень входного сигнала" min="0" max="1" value="0" data-native-input-meter></meter></div><p>Используйте проводные наушники. При первом подключении микрофон и громкость выключены — включите их, когда будете готовы.</p><label class="field room-buffer"><span>Буфер приёма</span><select data-native-jitter><option value="10">10 мс · меньше задержка</option><option value="20" selected>20 мс · стандартный</option><option value="40">40 мс · нестабильная сеть</option><option value="80">80 мс · большой запас</option></select></label><small>Сменить устройство можно после завершения подключения. Пилот: 48 кГц, моно.</small><p class="room-network-help"><b>Слева и справа — разные сигналы</b><br>«Микрофон» показывает вход с устройства до кнопки Mute. Канал «Вы · с сервера» и остальные участники показывают только полученные с сервера пакеты. Фейдеры справа меняют ваш личный микс. Прослушивание себя изначально выключено; поднимайте свой фейдер в наушниках.<br><br><b>Как читать показатели</b><br>Ping — путь до московского аудиосервера и обратно по UDP, медиана последних пяти ответов. Проверяется раз в секунду, даже при выключенном микрофоне.<br>Jitter сети — сглаженные колебания Ping; это не размер буфера приёма.<br>Delay — оценка: Ping + выбранный буфер + 10 мс пакетизации. Задержка аудиоустройств не измеряется, а путь до других музыкантов может отличаться.<br>Если ответа нет 3 секунды, цифры скрываются.</p></div></details>
  </div>`;
  const $=selector=>root.querySelector(selector);
  let devicesReady=false, busy=false, signature=null, failure='';
  const unmutedGains=new Map();let masterBeforeMute=.35;
  const db=gain=>gain>0?(20*Math.log10(gain)).toFixed(1)+' dB':'−∞ dB';
  const vu=(el,level)=>{const decibels=level>0?Math.max(-60,Math.min(0,20*Math.log10(level))):-60;el.style.setProperty('--level',((decibels+60)/60*100)+'%');el.setAttribute('aria-valuenow',decibels.toFixed(1));};
  const feedback=()=>{if(failure)return failure;if(busy)return 'Подключаемся к комнате…';if(state.error)return state.error;if(state.running)return state.connected?(state.master===0?'Вы в комнате. Поднимите громкость, чтобы слышать группу.':state.micMuted?'Вы слышите группу. Микрофон пока выключен.':'Микрофон включён. Вас слышит группа.'):'Ждём ответ сервера…';return devicesReady?'Готово к подключению. Микрофон включается отдельно.':'Проверяем аудиоустройства…';};
  const action=async fn=>{failure='';try{await fn();await tick();}catch(e){failure=e.message;}finally{paint(state);}};
  const paint=s=>{
   if(!root.isConnected){listeners.delete(paint);return;}
   $('[data-native-connect]').hidden=s.running;$('[data-native-connect]').disabled=busy||!devicesReady;
   $('[data-native-disconnect]').hidden=!s.running;
   for(const kind of ['input','output','jitter'])$(`[data-native-${kind}]`).disabled=s.running||busy;
   const muted=s.micMuted!==false;
   $('[data-native-mute]').disabled=!s.connected;
   $('[data-native-mute]').classList.toggle('on',!muted);
   $('[data-native-mute]').setAttribute('aria-pressed',String(muted));
   $('[data-mic-label]').textContent=muted?'Включить':'Mute';
   $('[data-native-mute]').setAttribute('aria-label',muted?'Включить микрофон':'Выключить микрофон');
   vu($('[data-mic-vu]'),s.inputLevel||0);vu($('[data-output-vu]'),s.outputLevel||0);$('[data-mic-db]').textContent=db(s.inputLevel||0)+'FS';
   $('[data-master-mute]').disabled=!s.running;$('[data-master-mute]').setAttribute('aria-pressed',String(!s.master));
   if(s.master>0)masterBeforeMute=s.master;
   $('[data-native-input-meter]').value=s.inputLevel||0;
   $('[data-native-master]').disabled=!s.running;
   if(document.activeElement!==$('[data-native-master]')){$('[data-native-master]').value=Math.round((s.master||0)*100);$('[data-master-value]').textContent=db(s.master||0);}
   $('[data-native-status]').textContent=feedback();$('[data-native-status]').classList.toggle('error',!!(failure||s.error));
   $('[data-room-badge]').textContent=s.connected?'На связи':s.running||busy?'Подключение…':'Не подключены';
   $('[data-room-badge]').classList.toggle('connected',s.connected);
   $('[data-room-count]').textContent=`${s.connected?s.members.length:0} / 8`;
   for(const [name,value,green,yellow] of [['ping',s.pingMs,30,60],['delay',s.estimatedDelayMs,50,80],['jitter',s.networkJitterMs,5,15]]){
    const el=$(`[data-network-metric="${name}"]`),known=s.connected&&Number.isFinite(value);
    const quality=!known?'unknown':value<=green?'good':value<=yellow?'fair':'poor';
    el.dataset.quality=quality;
    el.querySelector('span').textContent=known?value.toFixed(name==='jitter'?1:0)+' мс':'—';
    el.setAttribute('aria-label',`${{ping:'Ping',delay:'Оценка задержки',jitter:'Колебания Ping'}[name]}: ${known?value.toFixed(1)+' мс, '+{good:'низкий',fair:'повышенный',poor:'высокий'}[quality]:s.connected?'ожидаем ответ сервера':'доступно после подключения'}`);
   }
   const peers=[...s.members].sort((a,b)=>Number(b.self)-Number(a.self)),next=JSON.stringify(peers.map(m=>[m.id,m.name,m.self]));
   if(signature!==next){signature=next;$('[data-native-members]').innerHTML=peers.map((m,i)=>`<article class="mixer-channel" data-peer="${esc(m.id)}"><span class="channel-number">${String(i+1).padStart(2,'0')}</span><b title="${esc(m.name)}">${m.self?'Вы':esc(m.name)}</b><small>${m.self?'С сервера':'Вход с сервера'}</small><div class="channel-control"><div class="channel-fader"><input aria-label="Громкость ${esc(m.name)}" aria-orientation="vertical" type="range" min="0" max="100" value="${Math.round(m.gain*100)}" data-native-gain="${esc(m.id)}"></div><div class="channel-vu" role="meter" aria-label="Входной сигнал ${esc(m.name)}" aria-valuemin="-60" aria-valuemax="0" aria-valuenow="-60"><i></i></div></div><output>${db(m.gain)}</output><button class="channel-mute" data-peer-mute="${esc(m.id)}" aria-label="Отключить в моём миксе: ${esc(m.name)}" aria-pressed="false">Mute</button></article>`).join('');}
   for(const m of peers){const card=$(`[data-peer="${m.id}"]`);if(!card)continue;vu(card.querySelector('.channel-vu'),m.level||0);if(m.gain>0)unmutedGains.set(m.id,m.gain);const gain=card.querySelector('input');if(document.activeElement!==gain){gain.value=Math.round(m.gain*100);card.querySelector('output').textContent=db(m.gain);}card.querySelector('button').setAttribute('aria-pressed',String(m.gain===0));card.querySelector('button').setAttribute('aria-label',`${m.gain===0?'Включить':'Отключить'} в моём миксе: ${m.name}`);}
   $('[data-room-waiting]').hidden=peers.length>0;
   $('[data-room-waiting] h3').textContent=s.connected?'Ждём музыкантов':'Каналы группы';
  };
  $('[data-native-connect]').onclick=()=>action(async()=>{busy=true;paint(state);try{const prefs={input:$('[data-native-input]').value,output:$('[data-native-output]').value,jitter:$('[data-native-jitter]').value};localStorage.setItem('psalmony-desktop-devices',JSON.stringify(prefs));const ticket=await request('/api/audio/ticket',{});await request('/desktop/connect',{...ticket,input:prefs.input,output:prefs.output,jitterMs:Number(prefs.jitter)});}finally{busy=false;}});
  $('[data-native-disconnect]').onclick=()=>action(()=>request('/desktop/disconnect',{}));
  $('[data-native-mute]').onclick=()=>action(()=>request('/desktop/controls',{muted:!state.micMuted}));
  $('[data-native-master]').oninput=e=>{$('[data-master-value]').textContent=db(Number(e.target.value)/100);};
  $('[data-native-master]').onchange=e=>action(()=>request('/desktop/controls',{master:Number(e.target.value)/100}));
  $('[data-native-members]').onchange=e=>{if(e.target.matches('[data-native-gain]'))action(()=>request('/desktop/controls',{id:e.target.dataset.nativeGain,gain:Number(e.target.value)/100}));};
  $('[data-master-mute]').onclick=()=>action(()=>request('/desktop/controls',{master:state.master>0?0:masterBeforeMute}));
  $('[data-native-members]').oninput=e=>{if(e.target.matches('[data-native-gain]'))e.target.closest('article').querySelector('output').textContent=db(Number(e.target.value)/100);};
  $('[data-native-members]').onclick=e=>{const button=e.target.closest('[data-peer-mute]');if(!button)return;const id=button.dataset.peerMute,m=state.members.find(m=>m.id===id);if(m)action(()=>request('/desktop/controls',{id,gain:m.gain>0?0:unmutedGains.get(id)||.7}));};
  if(context.onLead)$('[data-room-lead]').onclick=()=>action(context.onLead);
  if(context.onFollow)$('[data-room-follow]').onclick=()=>action(context.onFollow);
  listeners.add(paint);paint(state);
  try{const d=await request('/desktop/devices');if(!root.isConnected)return;let saved={};try{saved=JSON.parse(localStorage.getItem('psalmony-desktop-devices')||'{}');}catch{}
   for(const [kind,list]of [['input',d.inputs],['output',d.outputs]]){const select=$(`[data-native-${kind}]`);select.innerHTML='<option value="">Системное устройство</option>'+list.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('');if(list.includes(saved[kind]))select.value=saved[kind];}
   if(['10','20','40','80'].includes(String(saved.jitter)))$('[data-native-jitter]').value=saved.jitter;
   devicesReady=d.inputs.length>0&&d.outputs.length>0;if(!devicesReady)failure='Подключите микрофон и устройство вывода, затем откройте комнату снова.';
  }catch(e){failure=e.message;}paint(state);
 }
 window.PsalmonyAudio={mount,disconnect:()=>request('/desktop/disconnect',{})};
})();
