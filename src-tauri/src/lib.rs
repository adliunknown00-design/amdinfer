use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

const APP_PORT: u16 = 3030;

struct Service(Mutex<Option<Child>>);

#[tauri::command]
fn choose_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog().file().blocking_pick_folder().map(|p| p.to_string())
}

#[tauri::command]
fn service_url(app: tauri::AppHandle, state: State<'_, Service>) -> Result<String, String> {
    if is_ready() {
        return Ok(format!("http://127.0.0.1:{APP_PORT}"));
    }
    ensure_started(&app, &state)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if is_ready() { return Ok(format!("http://127.0.0.1:{APP_PORT}")); }
        thread::sleep(Duration::from_millis(100));
    }
    Err("The local inference service did not start. Check AmdInfer's log output.".into())
}

fn is_ready() -> bool {
    TcpStream::connect(("127.0.0.1", APP_PORT)).is_ok()
}

fn ensure_started(app: &tauri::AppHandle, state: &State<'_, Service>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() { return Ok(()); }
    let exe = service_executable(app)?;
    let exe_dir = exe.parent().ok_or("Invalid service executable path")?.to_path_buf();
    let model_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("models");
    std::fs::create_dir_all(&model_dir).map_err(|e| e.to_string())?;
    let child = Command::new(exe)
        .current_dir(exe_dir)
        .env("PORT", APP_PORT.to_string())
        .env("MODEL_DIR", model_dir)
        .env("SETTINGS_DIR", app.path().app_config_dir().map_err(|e| e.to_string())?)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start the local service: {e}"))?;
    *guard = Some(child);
    Ok(())
}

fn service_executable(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let candidates: [PathBuf; 2] = if cfg!(windows) {
        [resource_dir.join("service").join("amdinfer-service.exe"), resource_dir.join("amdinfer-service.exe")]
    } else {
        [resource_dir.join("service").join("amdinfer-service"), resource_dir.join("amdinfer-service")]
    };
    candidates.iter().find(|p: &&PathBuf| p.is_file()).cloned().ok_or_else(|| {
        "The packaged inference service is missing. Reinstall AmdInfer or run `npm start` from the source folder.".into()
    })
}

fn stop_service(state: &State<'_, Service>) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Service(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![service_url, choose_folder])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_title("AmdInfer — Local AMD AI").map_err(|e| e.to_string())?;
            let handle = app.handle().clone();
            thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(80));
                let state: State<Service> = handle.state();
                if let Err(e) = ensure_started(&handle, &state) { eprintln!("{e}"); return; }
                let deadline = Instant::now() + Duration::from_secs(15);
                while Instant::now() < deadline {
                    if is_ready() { break; }
                    thread::sleep(Duration::from_millis(120));
                }
                if !is_ready() {
                    eprintln!("Local inference service failed to start on port {APP_PORT}");
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state: State<Service> = window.state();
                stop_service(&state);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running AmdInfer");
}
