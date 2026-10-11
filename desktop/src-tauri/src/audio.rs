use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Sample,
};
use rand::RngCore;
use rtrb::{Consumer, Producer, RingBuffer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    net::{SocketAddr, UdpSocket},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
const FRAME: usize = 240;
const LOCAL_CAPACITY: usize = 2048;
const LOCAL_HEADROOM: usize = 128;
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MonitorMode {
    #[default]
    Off = 0,
    Local = 1,
    Server = 2,
}
impl MonitorMode {
    fn from_control(value: u32) -> Self {
        match value & 3 {
            1 => Self::Local,
            2 => Self::Server,
            _ => Self::Off,
        }
    }
}
#[derive(Clone, Default, Deserialize)]
pub struct Preview {
    pub input: Option<String>,
    pub output: Option<String>,
}
#[derive(Clone, Copy, Default)]
struct OutputFrame {
    others: [f32; 2],
    own: [f32; 2],
}
#[derive(Clone, Copy)]
struct MonitorSample {
    value: f32,
    control: u32,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connect {
    pub id: String,
    pub key: String,
    pub ticket: String,
    pub address: String,
    pub input: Option<String>,
    pub output: Option<String>,
    pub jitter_ms: Option<u32>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub running: bool,
    pub connected: bool,
    pub preview: bool,
    pub monitor_mode: MonitorMode,
    pub local_monitor: bool,
    pub error: Option<String>,
    pub members: Vec<Value>,
    pub input_level: f32,
    pub input_post_level: f32,
    pub output_level: f32,
    pub mic_muted: bool,
    pub master: f32,
    pub input_gain: f32,
    pub limiter_hits: u64,
    pub sent: u64,
    pub received: u64,
    pub concealed: u64,
    pub output_underruns: u32,
    pub sample_rate: u32,
    pub jitter_ms: u32,
    pub ping_ms: Option<f64>,
    pub network_jitter_ms: Option<f64>,
    pub estimated_delay_ms: Option<f64>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            running: false,
            connected: false,
            preview: false,
            monitor_mode: MonitorMode::Off,
            local_monitor: false,
            error: None,
            members: vec![],
            input_level: 0.,
            input_post_level: 0.,
            output_level: 0.,
            mic_muted: true,
            master: 0.,
            input_gain: 1.,
            limiter_hits: 0,
            sent: 0,
            received: 0,
            concealed: 0,
            output_underruns: 0,
            sample_rate: 48000,
            jitter_ms: 20,
            ping_ms: None,
            network_jitter_ms: None,
            estimated_delay_ms: None,
        }
    }
}
#[derive(Default)]
struct Controls {
    mic_muted: AtomicBool,
    master: AtomicU32,
    gains: Mutex<HashMap<String, f32>>,
    pans: Mutex<HashMap<String, f32>>,
    muted_peers: Mutex<HashMap<String, bool>>,
    solo_peers: Mutex<HashMap<String, bool>>,
    input_gain: AtomicU32,
    input_peak: AtomicU32,
    input_post_peak: AtomicU32,
    monitor_control: AtomicU32,
    limiter_hits: AtomicU64,
    output_peak: AtomicU32,
    underruns: AtomicU32,
    stream_error: AtomicBool,
}
pub struct Engine {
    pub state: Arc<Mutex<Snapshot>>,
    controls: Arc<Controls>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Engine {
    pub fn connect(c: Connect) -> Result<Self, String> {
        if c.address != "91.226.80.181:22126"
            && !(cfg!(debug_assertions) && c.address == "127.0.0.1:22126")
        {
            return Err("Неизвестный аудиосервер".into());
        }
        if hex::decode(&c.id).map_or(true, |b| b.len() != 16)
            || hex::decode(&c.key).map_or(true, |b| b.len() != 32)
            || c.ticket.len() > 1000
        {
            return Err("Некорректный билет подключения".into());
        }
        let devices = Preview {
            input: c.input.clone(),
            output: c.output.clone(),
        };
        Self::start(Some(c), devices)
    }
    pub fn preview(devices: Preview) -> Result<Self, String> {
        Self::start(None, devices)
    }
    fn start(c: Option<Connect>, devices: Preview) -> Result<Self, String> {
        let state = Arc::new(Mutex::new(Snapshot {
            running: true,
            preview: c.is_none(),
            jitter_ms: c
                .as_ref()
                .and_then(|c| c.jitter_ms)
                .unwrap_or(20)
                .clamp(10, 80),
            ..Default::default()
        }));
        let controls = Arc::new(Controls::default());
        controls.mic_muted.store(true, Ordering::Relaxed);
        controls.input_gain.store(1f32.to_bits(), Ordering::Relaxed);
        let stop = Arc::new(AtomicBool::new(false));
        let (s, k, t) = (state.clone(), controls.clone(), stop.clone());
        let handle = thread::spawn(move || {
            if let Err(e) = run(c, devices, s.clone(), k, t) {
                s.lock().unwrap().error = Some(e);
            }
            let mut v = s.lock().unwrap();
            v.running = false;
            v.connected = false;
            v.preview = false;
            v.monitor_mode = MonitorMode::Off;
            v.local_monitor = false;
            v.members.clear();
            v.input_level = 0.;
            v.input_post_level = 0.;
            v.output_level = 0.;
            v.mic_muted = true;
            v.master = 0.;
            v.ping_ms = None;
            v.network_jitter_ms = None;
            v.estimated_delay_ms = None;
        });
        Ok(Self {
            state,
            controls,
            stop,
            thread: Some(handle),
        })
    }
    pub fn controls(
        &self,
        mute: Option<bool>,
        master: Option<f32>,
        gain: Option<(String, f32)>,
        pan: Option<(String, f32)>,
        peer_mute: Option<(String, bool)>,
        peer_solo: Option<(String, bool)>,
        input_gain: Option<f32>,
        monitor_mode: Option<MonitorMode>,
    ) -> Result<(), String> {
        // Reject the whole update before changing any sound control.
        if master.is_some_and(|v| !v.is_finite() || !(0.0..=1.0).contains(&v))
            || gain
                .as_ref()
                .is_some_and(|(_, v)| !v.is_finite() || !(0.0..=2.0).contains(v))
        {
            return Err("Громкость вне диапазона".into());
        }
        if pan
            .as_ref()
            .is_some_and(|(_, v)| !v.is_finite() || !(-1.0..=1.0).contains(v))
        {
            return Err("Панорама вне диапазона".into());
        }
        if input_gain.is_some_and(|v| !v.is_finite() || !(0.0..=4.0).contains(&v)) {
            return Err("Усиление вне диапазона".into());
        }
        let snapshot = self.state.lock().unwrap();
        if !snapshot.running {
            return Err("Аудиоустройства не запущены".into());
        }
        if snapshot.preview && (mute == Some(false) || monitor_mode == Some(MonitorMode::Server)) {
            return Err("Серверный возврат и отправка доступны после подключения к группе".into());
        }
        drop(snapshot);
        if let Some(mode) = monitor_mode {
            let _ = self.controls.monitor_control.fetch_update(
                Ordering::Relaxed,
                Ordering::Relaxed,
                |current| {
                    if MonitorMode::from_control(current) == mode {
                        None
                    } else {
                        Some((current.wrapping_add(4) & !3) | mode as u32)
                    }
                },
            );
        }
        if let Some(m) = mute {
            self.controls.mic_muted.store(m, Ordering::Relaxed)
        }
        if let Some(v) = master {
            self.controls.master.store(v.to_bits(), Ordering::Relaxed)
        }
        if let Some((id, v)) = gain {
            self.controls.gains.lock().unwrap().insert(id, v);
        }
        if let Some((id, v)) = pan {
            self.controls.pans.lock().unwrap().insert(id, v);
        }
        if let Some((id, v)) = peer_mute {
            self.controls.muted_peers.lock().unwrap().insert(id, v);
        }
        if let Some((id, v)) = peer_solo {
            self.controls.solo_peers.lock().unwrap().insert(id, v);
        }
        if let Some(v) = input_gain {
            self.controls
                .input_gain
                .store(v.to_bits(), Ordering::Relaxed);
        }
        Ok(())
    }
    pub fn close(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.thread.take() {
            let _ = h.join();
        }
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        self.close();
    }
}
pub fn devices() -> Result<Value, String> {
    let h = cpal::default_host();
    let list = |input: bool| -> Result<Vec<String>, String> {
        let iter = if input {
            h.input_devices()
        } else {
            h.output_devices()
        }
        .map_err(|e| e.to_string())?;
        Ok(iter.filter_map(|d| d.name().ok()).collect())
    };
    Ok(
        json!({"inputs":list(true)?,"outputs":list(false)?,"defaultInput":h.default_input_device().and_then(|d|d.name().ok()),"defaultOutput":h.default_output_device().and_then(|d|d.name().ok())}),
    )
}
fn device(name: Option<&str>, input: bool) -> Result<cpal::Device, String> {
    let h = cpal::default_host();
    if let Some(name) = name.filter(|v| !v.is_empty()) {
        let mut ds = if input {
            h.input_devices()
        } else {
            h.output_devices()
        }
        .map_err(|e| e.to_string())?;
        ds.find(|d| d.name().ok().as_deref() == Some(name))
            .ok_or("Аудиоустройство не найдено".into())
    } else {
        (if input {
            h.default_input_device()
        } else {
            h.default_output_device()
        })
        .ok_or("Аудиоустройство не найдено".into())
    }
}
fn config(
    d: &cpal::Device,
    input: bool,
) -> Result<(cpal::StreamConfig, cpal::SampleFormat), String> {
    let supported: Box<dyn Iterator<Item = cpal::SupportedStreamConfigRange>> = if input {
        Box::new(d.supported_input_configs().map_err(|e| e.to_string())?)
    } else {
        Box::new(d.supported_output_configs().map_err(|e| e.to_string())?)
    };
    let mut ranges: Vec<_> = supported
        .filter(|c| {
            c.channels() > 0
                && c.min_sample_rate().0 <= 48000
                && c.max_sample_rate().0 >= 48000
                && matches!(
                    c.sample_format(),
                    cpal::SampleFormat::F32 | cpal::SampleFormat::I16 | cpal::SampleFormat::U16
                )
        })
        .collect();
    ranges.sort_by_key(|c| {
        (
            if c.sample_format() == cpal::SampleFormat::F32 {
                0
            } else {
                1
            },
            c.channels(),
        )
    });
    let r = ranges
        .into_iter()
        .next()
        .ok_or("Устройство должно поддерживать 48 кГц. Выберите другой интерфейс.".to_string())?;
    let format = r.sample_format();
    let buffer = match r.buffer_size() {
        cpal::SupportedBufferSize::Range { min, max } if *min <= 128 && *max >= 128 => {
            cpal::BufferSize::Fixed(128)
        }
        _ => cpal::BufferSize::Default,
    };
    let mut c = r.with_sample_rate(cpal::SampleRate(48000)).config();
    c.buffer_size = buffer;
    Ok((c, format))
}
fn post_gain_sample(raw: f32, gain: f32) -> f32 {
    if raw.is_finite() && gain.is_finite() {
        raw.clamp(-1., 1.) * gain.clamp(0., 4.)
    } else {
        0.
    }
}
fn transmitted_sample(post: f32, muted: bool) -> i16 {
    if muted || !post.is_finite() {
        0
    } else {
        (post.clamp(-1., 1.) * 32767.) as i16
    }
}
fn capture_sample(
    raw: f32,
    gain: f32,
    control: u32,
    network: &mut Producer<f32>,
    local: &mut Producer<MonitorSample>,
) -> f32 {
    let post = post_gain_sample(raw, gain);
    let _ = network.push(post);
    if MonitorMode::from_control(control) == MonitorMode::Local {
        let _ = local.push(MonitorSample {
            value: post,
            control,
        });
    }
    post
}
fn trim_local(consumer: &mut Consumer<MonitorSample>, frames: usize, control: u32) {
    let keep = if MonitorMode::from_control(control) == MonitorMode::Local {
        frames.saturating_add(LOCAL_HEADROOM).min(LOCAL_CAPACITY)
    } else {
        0
    };
    // At most LOCAL_CAPACITY pops: callbacks never allocate or wait for another thread.
    let excess = consumer.slots().saturating_sub(keep);
    for _ in 0..excess {
        let _ = consumer.pop();
    }
}
fn take_local(consumer: &mut Consumer<MonitorSample>, control: u32) -> f32 {
    if MonitorMode::from_control(control) != MonitorMode::Local {
        return 0.;
    }
    // Samples carry the mode generation; old monitoring audio cannot replay after re-enabling.
    let available = consumer.slots();
    for _ in 0..available {
        let Ok(sample) = consumer.pop() else {
            break;
        };
        if sample.control == control {
            return sample.value;
        }
    }
    0.
}
fn final_mix(frame: OutputFrame, local: f32, mode: MonitorMode, master: f32) -> ([f32; 2], bool) {
    let local = if mode == MonitorMode::Local && local.is_finite() {
        local * std::f32::consts::FRAC_1_SQRT_2
    } else {
        0.
    };
    let master = if master.is_finite() {
        master.clamp(0., 1.)
    } else {
        0.
    };
    let mut result = [0.; 2];
    let mut limited = false;
    for (index, value) in result.iter_mut().enumerate() {
        let own = if mode == MonitorMode::Server {
            frame.own[index]
        } else {
            0.
        };
        let sum = (frame.others[index] + own + local) * master;
        if sum.is_finite() {
            limited |= sum.abs() > 0.95;
            *value = sum.clamp(-0.95, 0.95);
        }
    }
    (result, limited)
}
fn input<T: cpal::SizedSample>(
    d: &cpal::Device,
    c: &cpal::StreamConfig,
    mut p: Producer<f32>,
    mut local: Producer<MonitorSample>,
    ctl: Arc<Controls>,
) -> Result<cpal::Stream, String>
where
    f32: cpal::FromSample<T>,
{
    let channels = c.channels as usize;
    let err = ctl.clone();
    d.build_input_stream(
        c,
        move |samples: &[T], _| {
            let mut peak = 0f32;
            let mut post_peak = 0f32;
            let gain = f32::from_bits(ctl.input_gain.load(Ordering::Relaxed));
            let control = ctl.monitor_control.load(Ordering::Relaxed);
            for frame in samples.chunks_exact(channels) {
                let raw = frame.iter().map(|v| f32::from_sample(*v)).sum::<f32>() / channels as f32;
                let raw = if raw.is_finite() { raw } else { 0. };
                peak = peak.max(raw.abs());
                post_peak =
                    post_peak.max(capture_sample(raw, gain, control, &mut p, &mut local).abs());
            }
            ctl.input_peak.fetch_max(peak.to_bits(), Ordering::Relaxed);
            ctl.input_post_peak
                .fetch_max(post_peak.to_bits(), Ordering::Relaxed);
        },
        move |_| {
            err.stream_error.store(true, Ordering::Relaxed);
        },
        None,
    )
    .map_err(|e| e.to_string())
}
fn output<T: cpal::SizedSample + cpal::FromSample<f32>>(
    d: &cpal::Device,
    c: &cpal::StreamConfig,
    mut consumer: Consumer<OutputFrame>,
    mut local: Consumer<MonitorSample>,
    ctl: Arc<Controls>,
    preview: bool,
) -> Result<cpal::Stream, String> {
    let channels = c.channels as usize;
    let err = ctl.clone();
    d.build_output_stream(
        c,
        move |samples: &mut [T], _| {
            let mut missed = false;
            let mut peak = 0f32;
            let mut limiter_hits = 0;
            let control = ctl.monitor_control.load(Ordering::Relaxed);
            let mode = MonitorMode::from_control(control);
            let master = f32::from_bits(ctl.master.load(Ordering::Relaxed));
            trim_local(&mut local, samples.len() / channels, control);
            for frame in samples.chunks_exact_mut(channels) {
                let network = consumer.pop().unwrap_or_else(|_| {
                    missed |= !preview;
                    OutputFrame::default()
                });
                let (stereo, limited) =
                    final_mix(network, take_local(&mut local, control), mode, master);
                limiter_hits += u64::from(limited);
                peak = peak.max(stereo[0].abs()).max(stereo[1].abs());
                for (index, v) in frame.iter_mut().enumerate() {
                    *v = T::from_sample(if channels == 1 {
                        (stereo[0] + stereo[1]) * 0.5
                    } else if index < 2 {
                        stereo[index]
                    } else {
                        0.
                    });
                }
            }
            ctl.output_peak.fetch_max(peak.to_bits(), Ordering::Relaxed);
            ctl.limiter_hits.fetch_add(limiter_hits, Ordering::Relaxed);
            if missed {
                ctl.underruns.fetch_add(1, Ordering::Relaxed);
            }
        },
        move |_| {
            err.stream_error.store(true, Ordering::Relaxed);
        },
        None,
    )
    .map_err(|e| e.to_string())
}
fn update_controls_snapshot(snapshot: &mut Snapshot, ctl: &Controls) {
    snapshot.input_level = f32::from_bits(ctl.input_peak.swap(0, Ordering::Relaxed));
    snapshot.input_post_level = f32::from_bits(ctl.input_post_peak.swap(0, Ordering::Relaxed));
    snapshot.output_level = f32::from_bits(ctl.output_peak.swap(0, Ordering::Relaxed));
    snapshot.mic_muted = ctl.mic_muted.load(Ordering::Relaxed);
    snapshot.master = f32::from_bits(ctl.master.load(Ordering::Relaxed));
    snapshot.input_gain = f32::from_bits(ctl.input_gain.load(Ordering::Relaxed));
    snapshot.monitor_mode = MonitorMode::from_control(ctl.monitor_control.load(Ordering::Relaxed));
    snapshot.local_monitor = snapshot.monitor_mode == MonitorMode::Local;
    snapshot.limiter_hits = ctl.limiter_hits.load(Ordering::Relaxed);
    snapshot.output_underruns = ctl.underruns.load(Ordering::Relaxed);
}
// Monotonic local timing: echoed IDs carry no server clock or user data.
#[derive(Default)]
struct NetworkStats {
    serial: u64,
    pending: BTreeMap<u64, Instant>,
    samples: VecDeque<f64>,
    last_reply: Option<Instant>,
    previous_rtt: Option<f64>,
    variation: Option<f64>,
}
impl NetworkStats {
    fn probe(&mut self, now: Instant) -> [u8; 8] {
        self.pending
            .retain(|_, sent| now.duration_since(*sent) < Duration::from_secs(3));
        self.serial += 1;
        self.pending.insert(self.serial, now);
        self.serial.to_be_bytes()
    }
    fn reply(&mut self, body: &[u8], now: Instant) {
        let Ok(bytes) = <[u8; 8]>::try_from(body) else {
            return;
        };
        let Some(sent) = self.pending.remove(&u64::from_be_bytes(bytes)) else {
            return;
        };
        let elapsed = now.duration_since(sent);
        if elapsed >= Duration::from_secs(3) {
            return;
        }
        if self
            .last_reply
            .is_some_and(|last| now.duration_since(last) >= Duration::from_secs(3))
        {
            self.samples.clear();
            self.previous_rtt = None;
            self.variation = None;
        }
        let rtt = elapsed.as_secs_f64() * 1000.;
        if let Some(previous) = self.previous_rtt {
            let difference = (rtt - previous).abs();
            self.variation = Some(
                self.variation
                    .map_or(difference, |v| v + (difference - v) / 4.),
            );
        }
        self.previous_rtt = Some(rtt);
        self.last_reply = Some(now);
        self.samples.push_back(rtt);
        if self.samples.len() > 5 {
            self.samples.pop_front();
        }
    }
    fn values(&self, now: Instant, buffer_ms: u32) -> (Option<f64>, Option<f64>, Option<f64>) {
        if self
            .last_reply
            .is_none_or(|last| now.duration_since(last) >= Duration::from_secs(3))
        {
            return (None, None, None);
        }
        let mut sorted: Vec<_> = self.samples.iter().copied().collect();
        sorted.sort_by(f64::total_cmp);
        let mid = sorted.len() / 2;
        let ping = if sorted.len() % 2 == 0 {
            (sorted[mid - 1] + sorted[mid]) / 2.
        } else {
            sorted[mid]
        };
        // An estimate for a similar network route, not measured end-to-end audio latency.
        (
            Some(ping),
            self.variation,
            Some(ping + buffer_ms as f64 + 10.),
        )
    }
}
fn default_monitor_gain(peer_id: &str, self_id: &str) -> f32 {
    if peer_id == self_id {
        0.
    } else {
        0.7
    }
}

struct Cipher {
    cipher: Aes256Gcm,
    id: [u8; 16],
    prefix: [u8; 4],
    counter: u64,
    seen: HashSet<u64>,
    high: u64,
    remote_prefix: Option<[u8; 4]>,
}
impl Cipher {
    fn new(id: &str, key: &str) -> Self {
        let mut prefix = [0; 4];
        rand::thread_rng().fill_bytes(&mut prefix);
        prefix[0] = 0x43;
        Self {
            cipher: Aes256Gcm::new_from_slice(&hex::decode(key).unwrap()).unwrap(),
            id: hex::decode(id).unwrap().try_into().unwrap(),
            prefix,
            counter: 0,
            seen: HashSet::new(),
            high: 0,
            remote_prefix: None,
        }
    }
    fn encode(&mut self, kind: u8, body: &[u8], ticket: Option<&str>) -> Vec<u8> {
        self.counter += 1;
        let mut head = b"PSM1".to_vec();
        head.push(kind);
        head.extend(self.id);
        let mut nonce = [0; 12];
        nonce[..4].copy_from_slice(&self.prefix);
        nonce[4..].copy_from_slice(&self.counter.to_be_bytes());
        let cipher = self
            .cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: body,
                    aad: &head,
                },
            )
            .unwrap();
        head.extend(nonce);
        if let Some(t) = ticket {
            head.extend((t.len() as u16).to_be_bytes());
            head.extend(t.as_bytes());
        }
        head.extend(cipher);
        head
    }
    fn decode(&mut self, packet: &[u8]) -> Option<(u8, Vec<u8>)> {
        if packet.len() < 49 || &packet[..4] != b"PSM1" || packet[5..21] != self.id {
            return None;
        }
        let prefix: [u8; 4] = packet[21..25].try_into().ok()?;
        if prefix[0] != 0x53 || self.remote_prefix.is_some_and(|p| p != prefix) {
            return None;
        }
        let n = u64::from_be_bytes(packet[25..33].try_into().ok()?);
        if n.saturating_add(128) <= self.high || self.seen.contains(&n) {
            return None;
        }
        let body = self
            .cipher
            .decrypt(
                Nonce::from_slice(&packet[21..33]),
                Payload {
                    msg: &packet[33..],
                    aad: &packet[..21],
                },
            )
            .ok()?;
        self.remote_prefix = Some(prefix);
        self.high = self.high.max(n);
        self.seen.insert(n);
        self.seen.retain(|n| n.saturating_add(128) > self.high);
        Some((packet[4], body))
    }
}
struct Peer {
    frames: BTreeMap<u32, Vec<f32>>,
    next: Option<u32>,
    last: Vec<f32>,
    level: f32,
    misses: u32,
    received: u64,
    last_received: Option<Instant>,
}
impl Peer {
    fn new() -> Self {
        Self {
            frames: BTreeMap::new(),
            next: None,
            last: vec![0.; FRAME],
            level: 0.,
            misses: 0,
            received: 0,
            last_received: None,
        }
    }
    fn push(&mut self, sequence: u32, samples: Vec<f32>) {
        self.received += 1;
        self.last_received = Some(Instant::now());
        // Input metering follows received PCM, independently of playback deadlines/gain.
        self.level = self
            .level
            .max(samples.iter().map(|s| s.abs()).fold(0., f32::max));
        if self.next.is_some_and(|next| sequence < next) {
            return;
        }
        if self
            .next
            .is_some_and(|next| sequence.saturating_sub(next) > 64)
        {
            self.frames.clear();
            self.next = None;
            self.last.fill(0.);
            self.misses = 0;
        }
        if self.frames.len() >= 32 {
            self.frames.pop_first();
            self.next = None;
        }
        self.frames.insert(sequence, samples);
    }
    fn take(&mut self, buffer: usize) -> (Vec<f32>, bool) {
        if self.next.is_none() {
            if self.frames.len() < buffer {
                return (vec![0.; FRAME], false);
            }
            self.next = self.frames.keys().next().copied();
        }
        let n = self.next.unwrap();
        self.next = Some(n.wrapping_add(1));
        if let Some(f) = self.frames.remove(&n) {
            self.misses = 0;
            self.last = f.clone();
            (f, false)
        } else {
            for f in &mut self.last {
                *f *= 0.65;
            }
            self.misses += 1;
            let concealed = self.last.clone();
            if self.misses >= 8 {
                self.next = None;
                self.frames.clear();
                self.last.fill(0.);
                self.misses = 0;
            }
            (concealed, true)
        }
    }
}
fn run(
    c: Option<Connect>,
    devices: Preview,
    state: Arc<Mutex<Snapshot>>,
    ctl: Arc<Controls>,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    let preview = c.is_none();
    let input_dev = device(devices.input.as_deref(), true)?;
    let output_dev = device(devices.output.as_deref(), false)?;
    let (ic, iformat) = config(&input_dev, true)?;
    let (oc, oformat) = config(&output_dev, false)?;
    let (ip, mut input_consumer) = RingBuffer::<f32>::new(48000);
    let (mut output_producer, op) = RingBuffer::<OutputFrame>::new(48000);
    let (local_producer, local_consumer) = RingBuffer::<MonitorSample>::new(LOCAL_CAPACITY);
    let input_stream = match iformat {
        cpal::SampleFormat::F32 => input::<f32>(&input_dev, &ic, ip, local_producer, ctl.clone()),
        cpal::SampleFormat::I16 => input::<i16>(&input_dev, &ic, ip, local_producer, ctl.clone()),
        _ => input::<u16>(&input_dev, &ic, ip, local_producer, ctl.clone()),
    }?;
    let output_stream = match oformat {
        cpal::SampleFormat::F32 => {
            output::<f32>(&output_dev, &oc, op, local_consumer, ctl.clone(), preview)
        }
        cpal::SampleFormat::I16 => {
            output::<i16>(&output_dev, &oc, op, local_consumer, ctl.clone(), preview)
        }
        _ => output::<u16>(&output_dev, &oc, op, local_consumer, ctl.clone(), preview),
    }?;
    for _ in 0..960 {
        let _ = output_producer.push(OutputFrame::default());
    }
    input_stream.play().map_err(|e| e.to_string())?;
    output_stream.play().map_err(|e| e.to_string())?;
    let Some(c) = c else {
        while !stop.load(Ordering::Relaxed) {
            if ctl.stream_error.load(Ordering::Relaxed) {
                return Err(
                    "Аудиоустройство отключилось или недоступно. Выберите его заново.".into(),
                );
            }
            while input_consumer.pop().is_ok() {}
            update_controls_snapshot(&mut state.lock().unwrap(), &ctl);
            thread::sleep(Duration::from_millis(50));
        }
        drop(input_stream);
        drop(output_stream);
        return Ok(());
    };
    let address: SocketAddr = c.address.parse().map_err(|_| "Неверный адрес сервера")?;
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket.connect(address).map_err(|e| e.to_string())?;
    socket.set_nonblocking(true).map_err(|e| e.to_string())?;
    let mut cipher = Cipher::new(&c.id, &c.key);
    let mut sequence = 0u32;
    let mut peers: HashMap<String, Peer> = HashMap::new();
    let mut members: Vec<Value> = vec![];
    let mut connected = false;
    let mut received = 0u64;
    let mut sent = 0u64;
    let mut concealed = 0u64;
    let jitter = state.lock().unwrap().jitter_ms as usize / 5;
    let start = Instant::now();
    let mut last_join = start - Duration::from_secs(2);
    let mut last_keep = start;
    let mut last_rx = start;
    let mut last_snapshot = start;
    let mut last_ping = start - Duration::from_secs(1);
    let mut network = NetworkStats::default();
    let mut next_frame = start;
    let mut buf = [0u8; 1500];
    while !stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        if ctl.stream_error.load(Ordering::Relaxed) {
            return Err("Аудиоустройство отключилось или недоступно. Выберите его заново.".into());
        }
        if !connected && now.duration_since(last_join) >= Duration::from_secs(1) {
            socket
                .send(&cipher.encode(1, b"monitor-v1", Some(&c.ticket)))
                .map_err(|e| e.to_string())?;
            last_join = now;
        }
        if connected && now.duration_since(last_keep) >= Duration::from_secs(2) {
            let _ = socket.send(&cipher.encode(5, b"", None));
            last_keep = now;
        }
        if connected && now.duration_since(last_ping) >= Duration::from_secs(1) {
            let _ = socket.send(&cipher.encode(8, &network.probe(now), None));
            last_ping = now;
        }
        for _ in 0..64 {
            match socket.recv(&mut buf) {
                Ok(n) => {
                    if let Some((kind, body)) = cipher.decode(&buf[..n]) {
                        last_rx = now;
                        match kind {
                            3 if body.len() == 500 => {
                                received += 1;
                                let id = hex::encode(&body[..16]);
                                let seq = u32::from_be_bytes(body[16..20].try_into().unwrap());
                                let p = peers.entry(id).or_insert_with(Peer::new);
                                let samples: Vec<_> = body[20..]
                                    .chunks_exact(2)
                                    .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.)
                                    .collect();
                                p.push(seq, samples);
                            }
                            4 => {
                                let presence: Value = serde_json::from_slice(&body)
                                    .map_err(|_| "Некорректный ответ аудиосервера")?;
                                members =
                                    presence["members"].as_array().cloned().unwrap_or_default();
                                let ids: HashSet<_> =
                                    members.iter().filter_map(|m| m["id"].as_str()).collect();
                                peers.retain(|id, _| ids.contains(id.as_str()));
                                connected = true;
                            }
                            9 => network.reply(&body, now),
                            7 => return Err(String::from_utf8_lossy(&body).to_string()),
                            _ => {}
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => break,
            }
        }
        if now.duration_since(last_rx) > Duration::from_secs(12) {
            return Err("Нет ответа аудиосервера. Проверьте интернет и подключитесь снова.".into());
        }
        if connected && now.duration_since(last_rx) > Duration::from_secs(6) {
            connected = false;
            state.lock().unwrap().error =
                Some("Нет ответа от аудиосервера. Повторяем подключение…".into());
        }
        if now >= next_frame {
            let muted = ctl.mic_muted.load(Ordering::Relaxed);
            if connected && input_consumer.slots() >= FRAME {
                while input_consumer.slots() > FRAME * 8 {
                    let _ = input_consumer.pop();
                }
                let mut body = sequence.to_be_bytes().to_vec();
                for _ in 0..FRAME {
                    let v = input_consumer.pop().unwrap_or(0.);
                    body.extend(transmitted_sample(v, muted).to_le_bytes());
                }
                let _ = socket.send(&cipher.encode(2, &body, None));
                sent += 1;
                sequence = sequence.wrapping_add(1);
            } else if !connected {
                while input_consumer.pop().is_ok() {}
            }
            if output_producer.slots() >= 48000 - 960 {
                let gains = ctl.gains.lock().unwrap().clone();
                let mut mix = vec![OutputFrame::default(); FRAME];
                let pans = ctl.pans.lock().unwrap().clone();
                let muted = ctl.muted_peers.lock().unwrap().clone();
                let solos = ctl.solo_peers.lock().unwrap().clone();
                let monitor =
                    MonitorMode::from_control(ctl.monitor_control.load(Ordering::Relaxed));
                let any_solo = peers.keys().any(|id| {
                    (id != &c.id || monitor == MonitorMode::Server)
                        && *solos.get(id).unwrap_or(&false)
                });
                for (id, p) in &mut peers {
                    let (frame, missing) = p.take(jitter);
                    if missing {
                        concealed += 1;
                    }
                    let gain = *gains.get(id).unwrap_or(&default_monitor_gain(id, &c.id));
                    let active = !*muted.get(id).unwrap_or(&false)
                        && (!any_solo || *solos.get(id).unwrap_or(&false));
                    let (left, right) = pan_gains(*pans.get(id).unwrap_or(&0.));
                    for (dst, src) in mix.iter_mut().zip(frame) {
                        if active {
                            let channels = if id == &c.id {
                                &mut dst.own
                            } else {
                                &mut dst.others
                            };
                            channels[0] += src * gain * left;
                            channels[1] += src * gain * right;
                        }
                    }
                    p.level *= 0.9;
                }
                // Consume one output block per hardware block; bounded queue absorbs callback scheduling.
                if output_producer.slots() >= FRAME {
                    for frame in mix {
                        let _ = output_producer.push(frame);
                    }
                }
            }
            next_frame += Duration::from_millis(5);
            if now.duration_since(next_frame.min(now)) > Duration::from_millis(30) {
                next_frame = now + Duration::from_millis(5);
            }
        }
        if now.duration_since(last_snapshot) >= Duration::from_millis(100) {
            let mut snapshot = state.lock().unwrap();
            snapshot.connected = connected;
            let (ping, variation, delay) = if connected {
                network.values(now, snapshot.jitter_ms)
            } else {
                (None, None, None)
            };
            snapshot.ping_ms = ping;
            snapshot.network_jitter_ms = variation;
            snapshot.estimated_delay_ms = delay;
            if connected {
                snapshot.error = None;
            }
            snapshot.members = members
                .iter()
                .map(|m| {
                    let mut m = m.clone();
                    let id = m["id"].as_str().unwrap_or("").to_string();
                    let peer = peers.get(&id);
                    let age = peer
                        .and_then(|p| p.last_received)
                        .map(|last| now.saturating_duration_since(last).as_millis() as u64);
                    m["level"] = json!(peer.map_or(0., |p| if age.is_some_and(|age| age < 300) {
                        p.level
                    } else {
                        0.
                    }));
                    m["received"] = json!(peer.map_or(0, |p| p.received));
                    m["lastFrameAgeMs"] = json!(age);
                    m["gain"] = json!(*ctl
                        .gains
                        .lock()
                        .unwrap()
                        .get(&id)
                        .unwrap_or(&default_monitor_gain(&id, &c.id)));
                    m["pan"] = json!(*ctl.pans.lock().unwrap().get(&id).unwrap_or(&0.));
                    m["muted"] = json!(*ctl.muted_peers.lock().unwrap().get(&id).unwrap_or(&false));
                    m["solo"] = json!(*ctl.solo_peers.lock().unwrap().get(&id).unwrap_or(&false));
                    m["self"] = json!(id == c.id);
                    m
                })
                .collect();
            update_controls_snapshot(&mut snapshot, &ctl);
            snapshot.sent = sent;
            snapshot.received = received;
            snapshot.concealed = concealed;
            last_snapshot = now;
        }
        thread::sleep(Duration::from_millis(1));
    }
    let _ = socket.send(&cipher.encode(6, b"", None));
    drop(input_stream);
    drop(output_stream);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn test_engine(preview: bool) -> Engine {
        let controls = Arc::new(Controls::default());
        controls.mic_muted.store(true, Ordering::Relaxed);
        controls.input_gain.store(1f32.to_bits(), Ordering::Relaxed);
        Engine {
            state: Arc::new(Mutex::new(Snapshot {
                running: true,
                preview,
                ..Default::default()
            })),
            controls,
            stop: Arc::new(AtomicBool::new(false)),
            thread: None,
        }
    }
    #[test]
    fn audio_starts_silent_and_preview_rejects_send_or_server_return_atomically() {
        let e = test_engine(true);
        let mut snapshot = e.state.lock().unwrap().clone();
        update_controls_snapshot(&mut snapshot, &e.controls);
        assert!(snapshot.preview && snapshot.mic_muted);
        assert_eq!(snapshot.monitor_mode, MonitorMode::Off);
        assert!(!snapshot.local_monitor);
        assert_eq!(snapshot.master, 0.);
        for (mute, mode) in [
            (Some(false), Some(MonitorMode::Local)),
            (None, Some(MonitorMode::Server)),
        ] {
            assert!(e
                .controls(mute, Some(0.5), None, None, None, None, Some(2.), mode)
                .is_err());
            assert!(e.controls.mic_muted.load(Ordering::Relaxed));
            assert_eq!(e.controls.master.load(Ordering::Relaxed), 0);
            assert_eq!(e.controls.monitor_control.load(Ordering::Relaxed), 0);
            assert_eq!(
                f32::from_bits(e.controls.input_gain.load(Ordering::Relaxed)),
                1.
            );
        }
        assert!(e
            .controls(
                Some(false),
                Some(0.5),
                None,
                None,
                None,
                None,
                Some(f32::NAN),
                None
            )
            .is_err());
        assert!(e.controls.mic_muted.load(Ordering::Relaxed));
        assert_eq!(e.controls.master.load(Ordering::Relaxed), 0);
        e.controls(
            None,
            None,
            None,
            None,
            None,
            None,
            Some(2.),
            Some(MonitorMode::Local),
        )
        .unwrap();
        update_controls_snapshot(&mut snapshot, &e.controls);
        assert_eq!(snapshot.monitor_mode, MonitorMode::Local);
        assert!(snapshot.local_monitor && snapshot.mic_muted);
        assert_eq!(
            snapshot.master, 0.,
            "selecting monitoring does not turn on output"
        );
        assert_eq!(snapshot.input_gain, 2.);
    }
    #[test]
    fn local_input_is_post_gain_and_independent_of_network_backpressure_and_send_mute() {
        let (mut network, mut received) = RingBuffer::<f32>::new(1);
        let (mut local, mut monitor) = RingBuffer::<MonitorSample>::new(8);
        let control = 5; // First explicit local-monitor generation.
        assert_eq!(
            capture_sample(0.25, 2., control, &mut network, &mut local),
            0.5
        );
        assert_eq!(
            capture_sample(-0.2, 4., control, &mut network, &mut local),
            -0.8
        );
        // Network is full, but local monitoring still receives the newest input directly.
        assert_eq!(take_local(&mut monitor, control), 0.5);
        assert_eq!(take_local(&mut monitor, control), -0.8);
        let post = received.pop().unwrap();
        assert_eq!(transmitted_sample(post, true), 0);
        assert_eq!(transmitted_sample(post, false), 16383);
        let (output, _) = final_mix(OutputFrame::default(), post, MonitorMode::Local, 0.5);
        assert!(output[0] > 0.17 && output[0] < 0.18);
        assert_eq!(output[0], output[1]);
        assert_eq!(post_gain_sample(0.75, 0.), 0.);
        assert_eq!(post_gain_sample(f32::NAN, 2.), 0.);
        assert_eq!(transmitted_sample(4., false), i16::MAX);
    }
    #[test]
    fn queued_own_return_and_local_input_are_exclusive_at_the_output_callback() {
        let frame = OutputFrame {
            others: [0.1, 0.2],
            own: [0.4, 0.6],
        };
        let (off, _) = final_mix(frame, 1., MonitorMode::Off, 0.5);
        let (server, _) = final_mix(frame, 1., MonitorMode::Server, 0.5);
        let (local, _) = final_mix(frame, 1., MonitorMode::Local, 0.5);
        assert_eq!(off, [0.05, 0.1]);
        assert_eq!(server, [0.25, 0.4]);
        assert!((local[0] - (0.1 + std::f32::consts::FRAC_1_SQRT_2) * 0.5).abs() < 0.00001);
        assert!((local[1] - (0.2 + std::f32::consts::FRAC_1_SQRT_2) * 0.5).abs() < 0.00001);
        for mode in [MonitorMode::Off, MonitorMode::Local, MonitorMode::Server] {
            assert_eq!(final_mix(frame, 4., mode, 0.).0, [0., 0.]);
        }
        let (limited, hit) = final_mix(frame, 4., MonitorMode::Local, 1.);
        assert_eq!(limited, [0.95, 0.95]);
        assert!(hit);
        assert_eq!(final_mix(frame, f32::NAN, MonitorMode::Local, 0.5).0, off);
        assert_eq!(
            final_mix(frame, 1., MonitorMode::Local, f32::NAN).0,
            [0., 0.]
        );
    }
    #[test]
    fn local_ring_is_bounded_trims_clock_drift_and_discards_old_monitor_generations() {
        let (mut producer, mut consumer) = RingBuffer::<MonitorSample>::new(LOCAL_CAPACITY);
        for i in 0..LOCAL_CAPACITY {
            producer
                .push(MonitorSample {
                    value: i as f32,
                    control: 5,
                })
                .unwrap();
        }
        assert!(producer
            .push(MonitorSample {
                value: 9999.,
                control: 5
            })
            .is_err());
        trim_local(&mut consumer, 128, 5);
        assert_eq!(consumer.slots(), 256);
        assert_eq!(take_local(&mut consumer, 5), (LOCAL_CAPACITY - 256) as f32);
        assert_eq!(
            take_local(&mut consumer, 13),
            0.,
            "re-enabling never replays old local samples"
        );
        producer
            .push(MonitorSample {
                value: 0.25,
                control: 13,
            })
            .unwrap();
        assert_eq!(take_local(&mut consumer, 13), 0.25);
        assert_eq!(take_local(&mut consumer, 13), 0., "underflow is silence");
        producer
            .push(MonitorSample {
                value: 0.5,
                control: 13,
            })
            .unwrap();
        trim_local(&mut consumer, usize::MAX, 16);
        assert_eq!(consumer.slots(), 0);
        trim_local(&mut consumer, usize::MAX, 17); // Oversized hardware blocks cannot overflow.
    }
    #[test]
    fn post_gain_meter_is_independent_of_send_mute_and_serializes_monitor_contract() {
        let e = test_engine(true);
        e.controls
            .input_peak
            .store(0.3f32.to_bits(), Ordering::Relaxed);
        e.controls
            .input_post_peak
            .store(1.2f32.to_bits(), Ordering::Relaxed);
        let mut snapshot = e.state.lock().unwrap().clone();
        update_controls_snapshot(&mut snapshot, &e.controls);
        let value = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(value["inputLevel"], json!(0.3f32));
        assert_eq!(value["inputPostLevel"], json!(1.2f32));
        assert_eq!(value["monitorMode"], "off");
        assert_eq!(value["preview"], true);
        assert!(snapshot.mic_muted);
        update_controls_snapshot(&mut snapshot, &e.controls);
        assert_eq!(snapshot.input_post_level, 0.);
        assert!(serde_json::from_value::<MonitorMode>(json!("both")).is_err());
    }
    #[test]
    fn silent_received_pcm_is_distinct_from_no_server_packets() {
        let mut peer = Peer::new();
        assert_eq!(peer.received, 0);
        assert!(peer.last_received.is_none());
        peer.push(0, vec![0.; FRAME]);
        assert_eq!(peer.received, 1);
        assert_eq!(peer.level, 0.);
        assert!(peer.last_received.is_some());
        peer.push(1, vec![0.2; FRAME]);
        assert_eq!(peer.received, 2);
    }
    #[test]
    fn server_return_is_metered_but_self_monitoring_starts_silent() {
        assert_eq!(default_monitor_gain("self", "self"), 0.);
        assert_eq!(default_monitor_gain("other", "self"), 0.7);
    }
    #[test]
    fn network_metrics_match_probes_and_expire() {
        let start = Instant::now();
        let mut stats = NetworkStats::default();
        assert_eq!(stats.values(start, 20), (None, None, None));
        let first = stats.probe(start);
        stats.reply(&99u64.to_be_bytes(), start + Duration::from_millis(5));
        assert_eq!(stats.values(start, 20).0, None);
        stats.reply(&first, start + Duration::from_millis(30));
        assert_eq!(
            stats.values(start + Duration::from_millis(31), 20),
            (Some(30.), None, Some(60.))
        );
        stats.reply(&first, start + Duration::from_millis(100));
        assert_eq!(stats.samples.len(), 1);
        let next = stats.probe(start + Duration::from_secs(1));
        stats.reply(&next, start + Duration::from_millis(1040));
        assert_eq!(
            stats.values(start + Duration::from_millis(1041), 40),
            (Some(35.), Some(10.), Some(85.))
        );
        assert_eq!(
            stats.values(start + Duration::from_millis(4040), 20),
            (None, None, None)
        );
        let fresh = stats.probe(start + Duration::from_secs(5));
        stats.reply(&fresh, start + Duration::from_millis(5020));
        assert_eq!(
            stats.values(start + Duration::from_millis(5021), 20),
            (Some(20.), None, Some(50.))
        );
    }
    #[test]
    fn expired_probes_do_not_restore_stale_metrics_and_pending_is_bounded() {
        let start = Instant::now();
        let mut stats = NetworkStats::default();
        let old = stats.probe(start);
        stats.reply(&old, start + Duration::from_secs(3));
        assert_eq!(stats.values(start + Duration::from_secs(3), 20).0, None);
        for second in 4..100 {
            stats.probe(start + Duration::from_secs(second));
        }
        assert_eq!(stats.pending.len(), 3);
        stats.reply(&[0; 7], start + Duration::from_secs(100));
        assert_eq!(stats.samples.len(), 0);
    }
    #[test]
    fn crypto_rejects_tampering_and_replay() {
        let mut c = Cipher::new(&"11".repeat(16), &"22".repeat(32));
        c.prefix[0] = 0x53;
        let packet = c.encode(3, b"audio", None);
        let mut receiver = Cipher::new(&"11".repeat(16), &"22".repeat(32));
        assert_eq!(receiver.decode(&packet).unwrap().1, b"audio");
        assert!(receiver.decode(&packet).is_none());
        let mut bad = c.encode(3, b"audio", None);
        bad[40] ^= 1;
        assert!(receiver.decode(&bad).is_none());
    }
    #[test]
    fn received_meter_and_playback_recover_after_late_packets() {
        let mut p = Peer::new();
        p.push(0, vec![0.; FRAME]);
        p.take(1);
        for _ in 0..3 {
            p.take(1);
        }
        p.push(1, vec![0.25; FRAME]); // Late for playback, but real received input.
        assert_eq!(p.level, 0.25);
        assert!(!p.frames.contains_key(&1));
        for _ in 0..5 {
            p.take(1);
        }
        assert_eq!(p.next, None);
        p.push(2, vec![0.5; FRAME]);
        p.push(3, vec![0.75; FRAME]);
        assert_eq!(p.take(2), (vec![0.5; FRAME], false));
        p.push(1000, vec![0.9; FRAME]);
        assert_eq!(p.take(1), (vec![0.9; FRAME], false));
    }
    #[test]
    fn jitter_reorders_and_conceals() {
        let mut p = Peer::new();
        for n in [2, 0, 1] {
            p.frames.insert(n, vec![n as f32; FRAME]);
        }
        assert_eq!(p.take(3).0[0], 0.);
        assert_eq!(p.take(3).0[0], 1.);
        assert_eq!(p.take(3).0[0], 2.);
        assert!(p.take(3).1);
        assert_eq!(p.last[0], 1.3);
    }
}

// Equal-power stereo pan; transmitted audio remains mono.
fn pan_gains(pan: f32) -> (f32, f32) {
    let angle = (pan.clamp(-1., 1.) + 1.) * std::f32::consts::FRAC_PI_4;
    (angle.cos(), angle.sin())
}
#[cfg(test)]
mod stereo_tests {
    use super::*;
    #[test]
    fn pan_has_constant_power_and_correct_edges() {
        for pan in [-1., -0.5, 0., 0.5, 1.] {
            let (l, r) = pan_gains(pan);
            assert!((l * l + r * r - 1.).abs() < 0.00001);
        }
        let (l, r) = pan_gains(-1.);
        assert!((l - 1.).abs() < 0.00001 && r.abs() < 0.00001);
        let (l, r) = pan_gains(1.);
        assert!(l.abs() < 0.00001 && (r - 1.).abs() < 0.00001);
    }
}
