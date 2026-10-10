#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod audio;
mod gateway;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
fn main() {
    let mut gateway = gateway::Gateway::start().expect(
        "Psalmony: не удалось запустить локальный клиент. Возможно, приложение уже открыто.",
    );
    let url = gateway.url.clone();
    let audio = gateway.audio_state();
    let bootstrap = gateway.bootstrap_handle();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .on_window_event(move |_window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                audio.lock().unwrap().take();
            }
        })
        .setup(move |app| {
            let path = app.path().app_data_dir()?.join("restore-session");
            if let Ok(token) = std::fs::read_to_string(&path) {
                let token = token.trim();
                if token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()) {
                    *bootstrap.lock().unwrap() = Some(token.to_string());
                    let _ = std::fs::remove_file(path);
                }
            }
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Psalmony")
                .inner_size(1280., 840.)
                .min_inner_size(800., 600.)
                .on_navigation(|url| {
                    url.scheme() == "http"
                        && url.host_str() == Some("127.0.0.1")
                        && url.port() == Some(3188)
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Psalmony launch failed")
        .run(move |_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                gateway.shutdown();
            }
        });
}
