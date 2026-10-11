use crate::audio::{self, Connect, Engine, MonitorMode, Preview, Snapshot};
use include_dir::{include_dir, Dir};
use rand::RngCore;
use serde_json::{json, Value};
use std::{
    io::Read,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tiny_http::{Header, Request, Response, Server, StatusCode};
static ASSETS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../public");
const BACKEND: &str = "https://psalmony.91.226.80.181.sslip.io";
const HOST: &str = "127.0.0.1:3188";
const MAX: usize = 31 * 1024 * 1024;
struct State {
    token: String,
    engine: Arc<Mutex<Option<Engine>>>,
    client: reqwest::blocking::Client,
    bootstrap: Arc<Mutex<Option<String>>>,
    active: AtomicUsize,
    stop: AtomicBool,
    offline: AtomicBool,
}
pub struct Gateway {
    pub url: String,
    state: Arc<State>,
    thread: Option<JoinHandle<()>>,
}
impl Gateway {
    pub fn start() -> Result<Self, String> {
        let server = Server::http(HOST).map_err(|e| e.to_string())?;
        let mut token = [0; 32];
        rand::thread_rng().fill_bytes(&mut token);
        let state = Arc::new(State {
            token: hex::encode(token),
            engine: Arc::new(Mutex::new(None)),
            client: reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(12))
                .connect_timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| e.to_string())?,
            bootstrap: Arc::new(Mutex::new(None)),
            active: AtomicUsize::new(0),
            stop: AtomicBool::new(false),
            offline: AtomicBool::new(false),
        });
        let shared = state.clone();
        let handle = thread::spawn(move || {
            while !shared.stop.load(Ordering::Relaxed) {
                if let Ok(Some(req)) = server.recv_timeout(Duration::from_millis(200)) {
                    if shared.active.fetch_add(1, Ordering::Relaxed) >= 32 {
                        shared.active.fetch_sub(1, Ordering::Relaxed);
                        let _ = req.respond(Response::from_string("Busy").with_status_code(503));
                        continue;
                    }
                    let s = shared.clone();
                    thread::spawn(move || {
                        handle(req, &s);
                        s.active.fetch_sub(1, Ordering::Relaxed);
                    });
                }
            }
        });
        Ok(Self {
            url: format!("http://{HOST}/app"),
            state,
            thread: Some(handle),
        })
    }
    pub fn audio_state(&self) -> Arc<Mutex<Option<Engine>>> {
        self.state.engine.clone()
    }
    pub fn bootstrap_handle(&self) -> Arc<Mutex<Option<String>>> {
        self.state.bootstrap.clone()
    }
    pub fn shutdown(&mut self) {
        self.state.stop.store(true, Ordering::Relaxed);
        self.state.engine.lock().unwrap().take();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
impl Drop for Gateway {
    fn drop(&mut self) {
        self.shutdown();
    }
}
fn header(req: &Request, name: &'static str) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str().to_string())
}
fn reply(req: Request, status: u16, body: Vec<u8>, mime: &str, extra: Vec<Header>) {
    let mut response = Response::from_data(body).with_status_code(StatusCode(status));
    for (k, v) in [
        ("Content-Type", mime),
        ("X-Content-Type-Options", "nosniff"),
        ("Cache-Control", "no-store"),
        ("Referrer-Policy", "same-origin"),
        ("X-Frame-Options", "DENY"),
    ] {
        response.add_header(Header::from_bytes(k, v).unwrap());
    }
    for h in extra {
        response.add_header(h);
    }
    let _ = req.respond(response);
}
fn error(req: Request, status: u16, e: &str) {
    reply(
        req,
        status,
        serde_json::to_vec(&json!({"error":e})).unwrap(),
        "application/json",
        vec![],
    )
}
fn read(req: &mut Request) -> Result<Vec<u8>, String> {
    let mut bytes = vec![];
    req.as_reader()
        .take((MAX + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX {
        return Err("Запрос слишком большой".into());
    }
    Ok(bytes)
}
fn handle(mut req: Request, state: &State) {
    if header(&req, "Host").as_deref() != Some(HOST) {
        return error(req, 403, "Недопустимый адрес клиента");
    }
    if header(&req, "Sec-Fetch-Site").as_deref() == Some("cross-site") {
        return error(req, 403, "Запрос с другого сайта отклонён");
    }
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("/");
    let method = req.method().as_str().to_string();
    if let Some(origin) = header(&req, "Origin") {
        if origin != format!("http://{HOST}") {
            return error(req, 403, "Недопустимый источник запроса");
        }
    }
    if path.starts_with("/desktop/") || !matches!(method.as_str(), "GET" | "HEAD") {
        if header(&req, "X-Psalmony-Desktop").as_deref() != Some(state.token.as_str()) {
            return error(req, 403, "Нет ключа локального клиента");
        }
    }
    if path.starts_with("/desktop/") {
        let result = (|| -> Result<Value, String> {
            match (path, method.as_str()) {
                ("/desktop/network", "GET") => {
                    Ok(json!({"offline":state.offline.load(Ordering::Relaxed)}))
                }
                ("/desktop/network", "POST") => {
                    let v: Value = serde_json::from_slice(&read(&mut req)?)
                        .map_err(|_| "Некорректная настройка")?;
                    let offline = v["offline"].as_bool().ok_or("Укажите режим сети")?;
                    if offline {
                        state.engine.lock().unwrap().take();
                    }
                    state.offline.store(offline, Ordering::Relaxed);
                    Ok(json!({"offline" :offline}))
                }
                ("/desktop/devices", "GET") => audio::devices(),
                ("/desktop/audio", "GET") => Ok(serde_json::to_value(
                    state
                        .engine
                        .lock()
                        .unwrap()
                        .as_ref()
                        .map(|e| e.state.lock().unwrap().clone())
                        .unwrap_or_else(Snapshot::default),
                )
                .unwrap()),
                ("/desktop/preview", "POST") => {
                    let data = read(&mut req)?;
                    let devices: Preview = serde_json::from_slice(&data)
                        .map_err(|_| "Некорректные настройки аудиоустройств")?;
                    let mut engine = state.engine.lock().unwrap();
                    engine.take();
                    *engine = Some(Engine::preview(devices)?);
                    Ok(json!({"ok":true}))
                }
                ("/desktop/connect", "POST") => {
                    let data = read(&mut req)?;
                    let c: Connect = serde_json::from_slice(&data)
                        .map_err(|_| "Некорректные настройки подключения")?;
                    let mut engine = state.engine.lock().unwrap();
                    engine.take();
                    *engine = Some(Engine::connect(c)?);
                    Ok(json!({"ok":true}))
                }
                ("/desktop/disconnect", "POST") => {
                    state.engine.lock().unwrap().take();
                    Ok(json!({"ok":true}))
                }
                ("/desktop/controls", "POST") => {
                    let data = read(&mut req)?;
                    let v: Value = serde_json::from_slice(&data)
                        .map_err(|_| "Некорректные настройки микшера")?;
                    let monitor: Option<MonitorMode> = v
                        .get("monitorMode")
                        .map(|value| {
                            serde_json::from_value(value.clone())
                                .map_err(|_| "Выберите режим прослушивания: off, local или server")
                        })
                        .transpose()?;
                    let engine = state.engine.lock().unwrap();
                    let e = engine.as_ref().ok_or("Аудиоустройства ещё не запущены")?;
                    let gain = v["id"]
                        .as_str()
                        .zip(v["gain"].as_f64())
                        .map(|(id, v)| (id.to_string(), v as f32));
                    e.controls(
                        v["muted"].as_bool(),
                        v["master"].as_f64().map(|v| v as f32),
                        gain,
                        v["id"]
                            .as_str()
                            .zip(v["pan"].as_f64())
                            .map(|(id, n)| (id.to_string(), n as f32)),
                        v["id"]
                            .as_str()
                            .zip(v["peerMuted"].as_bool())
                            .map(|(id, n)| (id.to_string(), n)),
                        v["id"]
                            .as_str()
                            .zip(v["solo"].as_bool())
                            .map(|(id, n)| (id.to_string(), n)),
                        v["inputGain"].as_f64().map(|v| v as f32),
                        monitor,
                    )?;
                    Ok(json!({"ok":true}))
                }
                ("/desktop/open", "POST") => {
                    let v: Value = serde_json::from_slice(&read(&mut req)?)
                        .map_err(|_| "Некорректная ссылка")?;
                    let url = v["url"].as_str().ok_or("Некорректная ссылка")?;
                    let parsed = reqwest::Url::parse(url).map_err(|_| "Некорректная ссылка")?;
                    if !matches!(parsed.scheme(), "https" | "http")
                        || !parsed.username().is_empty()
                        || parsed.password().is_some()
                    {
                        return Err("Эта ссылка не поддерживается".into());
                    }
                    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())?;
                    Ok(json!({"ok":true}))
                }
                _ => Err("Метод не найден".into()),
            }
        })();
        return match result {
            Ok(v) => reply(
                req,
                200,
                serde_json::to_vec(&v).unwrap(),
                "application/json",
                vec![],
            ),
            Err(e) => error(req, 400, &e),
        };
    }
    if path.starts_with("/api/") {
        if state.offline.load(Ordering::Relaxed) {
            return error(
                req,
                503,
                "Клиент работает в офлайн-режиме. Используйте скачанные материалы.",
            );
        }
        let body = match read(&mut req) {
            Ok(b) => b,
            Err(e) => return error(req, 413, &e),
        };
        let upstream_method = match reqwest::Method::from_bytes(method.as_bytes()) {
            Ok(m) => m,
            Err(_) => return error(req, 405, "Недопустимый метод"),
        };
        let mut request = state
            .client
            .request(upstream_method, format!("{BACKEND}{url}"))
            .body(body);
        for name in [
            "Content-Type",
            "X-File-Name",
            "X-Revision",
            "X-User-Id",
            "X-Band-Id",
            "Range",
            "If-Range",
        ] {
            if let Some(value) = header(&req, name) {
                request = request.header(name, value);
            }
        }
        if let Some(cookie) = header(&req, "Cookie") {
            let only = cookie
                .split(';')
                .map(str::trim)
                .find(|c| c.starts_with("psalmony=") && c[9..].len() <= 128);
            if let Some(cookie) = only {
                request = request.header("Cookie", cookie);
            }
        }
        return match request.send() {
            Ok(mut res) => {
                let status = res.status().as_u16();
                let mime = res
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("application/octet-stream")
                    .to_string();
                let mut headers = vec![];
                for name in ["content-range", "accept-ranges", "content-disposition"] {
                    if let Some(v) = res.headers().get(name) {
                        if let Ok(h) = Header::from_bytes(name, v.as_bytes()) {
                            headers.push(h)
                        }
                    }
                }
                for v in res.headers().get_all("set-cookie") {
                    if let Ok(v) = v.to_str() {
                        if v.starts_with("psalmony=") {
                            let v = v
                                .replace("; Secure", "")
                                .replace("SameSite=Lax", "SameSite=Strict");
                            if let Ok(h) = Header::from_bytes("Set-Cookie", v) {
                                headers.push(h)
                            }
                        }
                    }
                }
                let mut bytes = vec![];
                match res.by_ref().take((MAX + 1) as u64).read_to_end(&mut bytes) {
                    Ok(_) if bytes.len() <= MAX => reply(req, status, bytes, &mime, headers),
                    _ => error(req, 502, "Ответ сервера слишком большой"),
                }
            }
            Err(_) => error(
                req,
                503,
                "Нет связи с сервером. Офлайн-материалы доступны на этом компьютере.",
            ),
        };
    }
    if !matches!(method.as_str(), "GET" | "HEAD") {
        return error(req, 405, "Метод не поддерживается");
    }
    let name = if matches!(path, "/" | "/app" | "/app/") {
        "index.html"
    } else if path == "/help" {
        "site/help.html"
    } else if path == "/privacy" {
        "site/privacy.html"
    } else if path == "/terms" {
        "site/terms.html"
    } else {
        path.trim_start_matches('/')
    };
    let Some(asset) = ASSETS.get_file(name) else {
        return error(req, 404, "Файл не найден");
    };
    let mut bytes = asset.contents().to_vec();
    let mime = match name.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "webmanifest" => "application/manifest+json",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    };
    if name == "index.html" {
        let config =
            json!({"token":state.token,"version":env!("CARGO_PKG_VERSION"),"backend":BACKEND});
        let script = format!(
            "<script nonce=\"{}\">window.psalmonyDesktop={};</script></head>",
            state.token, config
        );
        bytes = String::from_utf8(bytes)
            .unwrap()
            .replace("</head>", &script)
            .into_bytes();
    }
    let csp=format!("default-src 'self'; script-src 'self' 'nonce-{}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",state.token);
    let mut extra = vec![Header::from_bytes("Content-Security-Policy", csp).unwrap()];
    if name == "index.html" && header(&req, "Cookie").is_none() {
        if let Some(token) = state.bootstrap.lock().unwrap().take() {
            extra.push(
                Header::from_bytes(
                    "Set-Cookie",
                    format!("psalmony={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000"),
                )
                .unwrap(),
            );
        }
    }
    if name == "sw.js" {
        extra.push(Header::from_bytes("Service-Worker-Allowed", "/").unwrap());
    }
    if method == "HEAD" {
        bytes.clear();
    }
    reply(req, 200, bytes, mime, extra);
}
