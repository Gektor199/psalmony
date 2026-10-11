import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8');
const voidTags = new Set(['input','img','br','hr','meta','link','source']);

// A small DOM boundary, not a second implementation of mixer logic. Selectors
// resolve actual rendered markup, and events execute the shipped desktop.js.
class Element {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = tag.toLowerCase(); this.attrs = {...attrs}; this.children = []; this.parentElement = null; this.events = new Map();
    this.value = attrs.value || ''; this.min = attrs.min || ''; this.max = attrs.max || ''; this.disabled = 'disabled' in attrs; this.hidden = 'hidden' in attrs;
    this.style = {values: new Map(), setProperty(name, value) {this.values.set(name, value);}};
    this.classList = {
      add: (...names) => this.setAttribute('class', [...new Set([...(this.attrs.class || '').split(/\s+/), ...names])].join(' ')),
      remove: (...names) => this.setAttribute('class', (this.attrs.class || '').split(/\s+/).filter(name => !names.includes(name)).join(' ')),
      toggle: (name, force) => {const has = (this.attrs.class || '').split(/\s+/).includes(name), add = force === undefined ? !has : force; this.classList[add ? 'add' : 'remove'](name); return add;},
      contains: name => (this.attrs.class || '').split(/\s+/).includes(name),
    };
  }
  get className() {return this.attrs.class || '';}
  set className(value) {this.attrs.class = value;}
  get id() {return this.attrs.id || '';}
  set id(value) {this.attrs.id = value;}
  get dataset() {return Object.fromEntries(Object.entries(this.attrs).filter(([key]) => key.startsWith('data-')).map(([key,value]) => [key.slice(5).replace(/-([a-z])/g, (_,c) => c.toUpperCase()),value]));}
  get isConnected() {return this.tagName === 'body' || !!this.parentElement?.isConnected;}
  setAttribute(name, value) {this.attrs[name] = String(value);}
  getAttribute(name) {return this.attrs[name] ?? null;}
  hasAttribute(name) {return name in this.attrs;}
  append(child) {child.parentElement = this; this.children.push(child);}
  appendChild(child) {this.append(child); return child;}
  remove() {if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null;}
  set innerHTML(html) {
    for (const child of this.children) child.parentElement = null;
    this.children = []; this.html = String(html);
    const stack = [this];
    for (const match of String(html).matchAll(/<\s*(\/?)\s*([a-zA-Z][\w:-]*)([^>]*)>/g)) {
      const [,closing,tag,tail] = match;
      if (closing) {while (stack.length > 1) if (stack.pop().tagName === tag.toLowerCase()) break; continue;}
      const attrs = Object.fromEntries([...tail.matchAll(/([^\s=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)].map(m => [m[1],m[2] ?? m[3] ?? m[4] ?? '']));
      const child = new Element(tag, attrs); stack.at(-1).append(child);
      if (!voidTags.has(child.tagName) && !tail.endsWith('/')) stack.push(child);
    }
    for (const select of this.querySelectorAll('select')) select.value = (select.children.find(child => child.hasAttribute('selected')) || select.children[0])?.value || '';
  }
  get innerHTML() {return this.html || '';}
  matches(selector) {
    return selector.split(',').some(part => {
      const s = part.trim(), attrs = [...s.matchAll(/\[([^=\]]+)(?:=["']?([^\]"']*)["']?)?\]/g)];
      if (attrs.some(([,key,value]) => !this.hasAttribute(key) || value !== undefined && this.getAttribute(key) !== value)) return false;
      const rest = s.replace(/\[[^\]]+\]/g, '');
      if (rest.startsWith('.')) return this.classList.contains(rest.slice(1));
      if (rest.startsWith('#')) return this.id === rest.slice(1);
      return !rest || rest === '*' || this.tagName === rest;
    });
  }
  querySelectorAll(selector) {return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);}
  querySelector(selector) {return this.querySelectorAll(selector)[0] || null;}
  closest(selector) {return this.matches(selector) ? this : this.parentElement?.closest(selector) || null;}
  addEventListener(type, handler) {this.events.set(type, [...(this.events.get(type) || []), handler]);}
  focus() {this.ownerDocument && (this.ownerDocument.activeElement = this);}
  setPointerCapture() {}
  releasePointerCapture() {}
  async fire(type, extra = {}) {
    const event = {type,target:this,bubbles:true,preventDefault(){},stopPropagation(){this.bubbles=false;},...extra};
    for (let current = this; current; current = event.bubbles ? current.parentElement : null) {
      await current['on' + type]?.(event);
      for (const handler of current.events.get(type) || []) await handler(event);
    }
  }
  dispatchEvent(event) {void this.fire(event.type, event); return true;}
}

const initialState = () => ({running:false,preview:false,connected:false,monitorMode:'off',localMonitor:false,micMuted:true,master:0,inputGain:1,inputLevel:0,inputPostLevel:0,outputLevel:0,members:[],jitterMs:20,sent:0,received:0,concealed:0,outputUnderruns:0,limiterHits:0});
const peer = (id, self = false, overrides = {}) => ({id,name:self?'You':'Player',self,gain:self?0:.7,pan:0,muted:false,solo:false,level:0,received:12,lastFrameAgeMs:4,...overrides});

async function harness({state = initialState(), devices = {inputs:['Input'],outputs:['Output']}, desktop = true} = {}) {
  const calls = [], timers = [], body = new Element('body'), document = {body,activeElement:null,createElement:tag=>new Element(tag),querySelector:q=>body.querySelector(q),addEventListener(){}};
  const values = new Map(); let current = structuredClone(state);
  const respond = value => ({ok:true,status:200,json:async()=>structuredClone(value)});
  const fetch = async (input, options = {}) => {
    const path = new URL(typeof input === 'string' ? input : input.url, 'http://127.0.0.1:3291').pathname;
    const value = options.body ? JSON.parse(options.body) : undefined; calls.push({path,method:options.method || 'GET',body:value,headers:new Headers(options.headers)});
    if (path === '/desktop/audio') return respond(current);
    if (path === '/desktop/devices') return respond(devices);
    if (path === '/api/audio/ticket') return respond({id:'self',ticket:'qa',key:'qa',address:'qa'});
    if (path === '/desktop/preview') current = {...initialState(),running:true,preview:true,inputLevel:.1,inputPostLevel:.1};
    if (path === '/desktop/connect') current = {...initialState(),running:true,connected:true,members:[peer('self',true),peer('other')]};
    if (path === '/desktop/disconnect') current = initialState();
    if (path === '/desktop/controls') {
      for (const key of ['master','inputGain','monitorMode']) if (value[key] !== undefined) current[key] = value[key];
      if (value.muted !== undefined) current.micMuted = value.muted;
      const target = current.members.find(member => member.id === value.id);
      if (target) for (const [from,to] of [['gain','gain'],['peerMuted','muted'],['pan','pan'],['solo','solo']]) if (value[from] !== undefined) target[to] = value[from];
    }
    return respond({ok:true});
  };
  const window = {fetch,...(desktop ? {psalmonyDesktop:{token:'qa-token'}} : {})};
  const context = vm.createContext({window,document,URL,Request,Headers,AbortSignal,Event,location:{href:'http://127.0.0.1:3291/',origin:'http://127.0.0.1:3291'},localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},console});
  context.fetch = (...args) => window.fetch(...args);
  vm.runInContext(source, context, {filename:'public/desktop.js'});
  await new Promise(resolve => setImmediate(resolve));
  const root = new Element(); body.append(root);
  if (desktop) await window.PsalmonyAudio.mount(root);
  const controlCalls = () => calls.filter(call => call.path === '/desktop/controls');
  const poll = async replacement => {if (replacement) current=structuredClone(replacement);const timer=timers.shift();assert.ok(timer,'poll timer available');await timer();};
  return {window,root,body,calls,controlCalls,poll,state:()=>structuredClone(current),find:q=>{const element=root.querySelector(q);assert.ok(element,`Expected rendered control ${q}`);return element;},clear:()=>{calls.length=0;}};
}

test('ordinary PWA never starts the native mixer or makes native requests', async () => {
  const h = await harness({desktop:false});
  assert.equal(h.window.PsalmonyAudio, undefined); assert.equal(h.calls.length, 0);
});

test('opening the native mixer discovers devices but never opens audio, sends microphone, or raises output', async () => {
  const h = await harness();
  assert.ok(h.calls.some(call => call.path === '/desktop/devices'));
  assert.ok(h.calls.every(call => call.method === 'GET'));
  assert.equal(h.find('[data-input-gain]').classList.contains('studio-fader'), true);
  assert.equal(h.find('[data-input-gain]').disabled, true);
  assert.equal(h.find('[data-master]').disabled, true);
  assert.equal(h.find('[data-mic]').disabled, true);
});

const settle = () => new Promise(resolve => setImmediate(resolve));
const actOn = async (element, type = 'click', value) => {assert.equal(element.disabled, false, 'Action must be available');if(value !== undefined)element.value=value;await element.fire(type);await settle();};
const connected = overrides => ({...initialState(),running:true,connected:true,members:[peer('self',true),peer('other')],...overrides});
const writes = h => h.calls.filter(call => call.method === 'POST');

test('explicit input preview opens only the local engine and leaves microphone/output silent', async () => {
  const h=await harness();h.clear();await actOn(h.find('[data-preview]'));
  assert.deepEqual(writes(h).map(call=>call.path),['/desktop/preview']);
  assert.equal(h.state().preview,true);assert.equal(h.state().micMuted,true);assert.equal(h.state().master,0);
  assert.equal(h.find('[data-input-gain]').disabled,false);assert.equal(h.find('[data-master]').disabled,false);
  assert.equal(h.find('[data-mic]').disabled,true);assert.equal(h.find('[data-connect]').hidden,false);
  assert.equal(h.find('[data-device-input]').disabled,true);
});

test('local listen can start without a server ticket, raises only deliberate output, and toggles off', async () => {
  const h=await harness();h.clear();await actOn(h.find('[data-local-listen]'));
  assert.deepEqual(writes(h).map(call=>call.path),['/desktop/preview','/desktop/controls']);
  assert.deepEqual(h.controlCalls()[0].body,{monitorMode:'local',master:.25});
  assert.equal(h.state().micMuted,true);assert.equal(h.find('[data-local-listen]').getAttribute('aria-pressed'),'true');
  assert.match(h.find('[data-monitor-status]').textContent,/Подключение к группе не требуется/);
  h.clear();await actOn(h.find('[data-local-listen]'));
  assert.deepEqual(h.controlCalls().map(call=>call.body),[{monitorMode:'off'}]);
});

test('local and server listen switch explicitly, preserve chosen master, and never enable microphone', async () => {
  const h=await harness({state:connected({master:.6})});h.clear();await actOn(h.find('[data-local-listen]'));
  assert.deepEqual(h.controlCalls()[0].body,{monitorMode:'local'});
  assert.equal(writes(h).length,1);
  h.clear();await actOn(h.find('[data-server-listen]'));
  assert.deepEqual(h.controlCalls()[0].body,{monitorMode:'server',id:'self',gain:.7,peerMuted:false});
  assert.equal(h.state().master,.6);assert.equal(h.state().micMuted,true);
  assert.equal(h.find('[data-local-listen]').getAttribute('aria-pressed'),'false');
  assert.match(h.find('[data-monitor-status]').textContent,/отправка выключена/);
});

test('input fader sends its selected gain through 0 to 4 rather than the value repainted during busy state', async () => {
  const h=await harness({state:{...initialState(),running:true,preview:true}});h.clear();
  await actOn(h.find('[data-input-gain]'),'change','1000');
  assert.deepEqual(h.controlCalls().map(call=>call.body),[{inputGain:4}]);
  h.clear();await actOn(h.find('[data-input-gain]'),'change','0');
  assert.deepEqual(h.controlCalls().map(call=>call.body),[{inputGain:0}]);
  assert.equal(h.state().micMuted,true);assert.equal(h.state().master,0);assert.equal(h.state().monitorMode,'off');
});

test('input meter follows post-fader level while raw input remains independently visible', async () => {
  const h=await harness({state:{...initialState(),running:true,preview:true,inputGain:0,inputLevel:.1,inputPostLevel:0}});
  assert.equal(h.find('[data-input-raw]').textContent,'-20.0 dBFS');
  assert.equal(h.find('[data-input-db]').textContent,'−∞');
  assert.equal(h.find('[data-input-meter]').getAttribute('aria-valuenow'),'-60.0');
  await h.poll({...h.state(),inputGain:2,inputPostLevel:.2});
  assert.equal(h.find('[data-input-raw]').textContent,'-20.0 dBFS');
  assert.equal(h.find('[data-input-db]').textContent,'-14.0');
});

test('moving self-return fader enables server monitoring without secretly raising output or sending microphone', async () => {
  const h=await harness({state:connected({monitorMode:'local'})});h.clear();
  await actOn(h.find('[data-peer="self"]').querySelector('[data-gain]'),'change','1000');
  assert.deepEqual(h.controlCalls()[0].body,{id:'self',gain:2,monitorMode:'server'});
  assert.equal(h.state().master,0);assert.equal(h.state().micMuted,true);
  assert.equal(h.find('[data-server-listen]').getAttribute('aria-pressed'),'true');
  assert.match(h.find('[data-monitor-status]').textContent,/общий выход на −∞/);
  assert.match(h.find('[data-monitor-status]').textContent,/отправка выключена/);
});

test('explicit server listen clears self mute and restores self level/output but requires separate send action', async () => {
  const h=await harness({state:connected({members:[peer('self',true,{muted:true}),peer('other')]})});h.clear();
  await actOn(h.find('[data-server-listen]'));
  assert.deepEqual(h.controlCalls()[0].body,{monitorMode:'server',id:'self',gain:.7,peerMuted:false,master:.25});
  assert.equal(h.state().micMuted,true);assert.equal(h.state().members[0].muted,false);
  assert.match(h.find('[data-monitor-status]').textContent,/отправка выключена/);
});

test('existing visible Mute and Solo are explained instead of reporting packet arrival as audible sound', async () => {
  const h=await harness({state:connected({monitorMode:'server',master:.4,micMuted:false,members:[peer('self',true,{gain:.7,muted:true}),peer('other',false,{solo:true})]})});
  const message=h.find('[data-monitor-status]').textContent;
  assert.match(message,/Mute своего возврата включён/);assert.match(message,/Solo другого канала исключает/);
  assert.match(message,/Пакеты своего возврата поступают/);
  assert.doesNotMatch(message,/Свой возврат поступает на общий выход/);
});

test('server return distinguishes no packets, stale packets, and live packets containing silence', async () => {
  const state=connected({monitorMode:'server',master:.5,micMuted:false,members:[peer('self',true,{gain:.7,received:0,lastFrameAgeMs:null})]});
  const h=await harness({state});assert.match(h.find('[data-monitor-status]').textContent,/ещё не приходят/);
  await h.poll({...state,members:[peer('self',true,{gain:.7,received:10,lastFrameAgeMs:2100})]});
  assert.match(h.find('[data-monitor-status]').textContent,/перестали приходить/);
  await h.poll({...state,members:[peer('self',true,{gain:.7,received:12,lastFrameAgeMs:4,level:0})]});
  assert.match(h.find('[data-monitor-status]').textContent,/сейчас возвращается тишина/);
});

test('loss of server connection disables sending and all peer controls but preserves local monitoring control', async () => {
  const h=await harness({state:connected()});await h.poll({...h.state(),connected:false});
  for(const selector of ['[data-mic]','[data-server-listen]'])assert.equal(h.find(selector).disabled,true,selector);
  for(const element of h.find('[data-channels]').querySelectorAll('[data-gain],[data-pan],[data-mute],[data-solo]'))assert.equal(element.disabled,true);
  assert.equal(h.find('[data-local-listen]').disabled,false);
});

test('stopping a local preview requests engine disconnect without any server dependency', async () => {
  const h=await harness({state:{...initialState(),running:true,preview:true,monitorMode:'local',master:.25}});h.clear();
  await actOn(h.find('[data-disconnect]'));
  assert.deepEqual(writes(h).map(call=>call.path),['/desktop/disconnect']);
  assert.equal(h.state().running,false);assert.equal(h.find('[data-input-gain]').disabled,true);assert.equal(h.find('[data-master]').disabled,true);
  assert.equal(h.find('[data-device-input]').disabled,false);
});

test('joining the group from preview resets to safe startup and does not auto enable send or output', async () => {
  const h=await harness({state:{...initialState(),running:true,preview:true,monitorMode:'local',master:.25}});h.clear();
  await actOn(h.find('[data-connect]'));
  assert.deepEqual(writes(h).map(call=>call.path),['/api/audio/ticket','/desktop/connect']);
  assert.equal(h.controlCalls().length,0);assert.equal(h.state().micMuted,true);assert.equal(h.state().master,0);
  assert.equal(h.find('[data-mic]').disabled,false);
});

test('missing input/output devices keep every startup action disabled', async () => {
  const h=await harness({devices:{inputs:[],outputs:[]}});
  for(const selector of ['[data-preview]','[data-connect]','[data-local-listen]'])assert.equal(h.find(selector).disabled,true,selector);
  assert.equal(writes(h).length,0);
});
