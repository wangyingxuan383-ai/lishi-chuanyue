//! Remembers the desktop window's size, position and maximised state between
//! runs (UX_APP_BASICS #58), in `window-state.json` in the app data folder.
//! The window is put in place during setup, before it first paints. A saved position that no longer lies
//! on any screen (a monitor was unplugged) is dropped and the window centres.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{App, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

const FILE: &str = "window-state.json";

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// A rectangle in physical pixels: x, y, width, height.
pub type Rect = (i32, i32, u32, u32);

pub fn load(path: &Path) -> Option<Saved> {
    let text = std::fs::read_to_string(path).ok()?;
    let saved: Saved = serde_json::from_str(&text).ok()?;
    (saved.width >= 200 && saved.height >= 200).then_some(saved)
}

pub fn store(path: &Path, saved: &Saved) {
    if let Ok(text) = serde_json::to_string(saved) {
        let temp = path.with_extension("json.tmp");
        if std::fs::write(&temp, text).is_ok() {
            let _ = std::fs::rename(&temp, path);
        }
    }
}

/// True when enough of the window's title bar is on one of the screens to grab it.
pub fn visible_on(saved: &Saved, screens: &[Rect]) -> bool {
    let (left, top, right) = (
        i64::from(saved.x),
        i64::from(saved.y),
        i64::from(saved.x) + i64::from(saved.width),
    );
    screens.iter().any(|&(x, y, w, h)| {
        let (sx, sy) = (i64::from(x), i64::from(y));
        let (sr, sb) = (sx + i64::from(w), sy + i64::from(h));
        let overlap = right.min(sr) - left.max(sx);
        top >= sy - 8 && top < sb - 40 && overlap >= 120
    })
}

struct Tracker {
    path: PathBuf,
    /// The last size and place while neither maximised nor minimised.
    normal: Mutex<Option<Saved>>,
}

impl Tracker {
    fn remember(&self, window: &WebviewWindow) {
        let maximized = window.is_maximized().unwrap_or(false);
        if maximized || window.is_minimized().unwrap_or(false) {
            return;
        }
        if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
            if size.width == 0 || size.height == 0 {
                return;
            }
            let mut normal = self.normal.lock().unwrap_or_else(|e| e.into_inner());
            *normal = Some(Saved {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
                maximized: false,
            });
        }
    }

    fn save(&self, window: &WebviewWindow) {
        let maximized = window.is_maximized().unwrap_or(false);
        let normal = *self.normal.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut saved) = normal {
            saved.maximized = maximized;
            store(&self.path, &saved);
        }
    }
}

/// Restores the main window's last size, place and maximised state, and
/// tracks it from now on. Runs in `setup`, before the event loop shows the
/// window, so the window opens in its remembered place.
pub fn restore(app: &App) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let path = app.path().app_data_dir()?.join(FILE);
    let screens: Vec<Rect> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let area = m.work_area();
            (
                area.position.x,
                area.position.y,
                area.size.width,
                area.size.height,
            )
        })
        .collect();
    let tracker = Tracker {
        path: path.clone(),
        normal: Mutex::new(None),
    };
    if let Some(saved) = load(&path) {
        let _ = window.set_size(PhysicalSize::new(saved.width, saved.height));
        if visible_on(&saved, &screens) {
            let _ = window.set_position(PhysicalPosition::new(saved.x, saved.y));
        } else {
            let _ = window.center();
        }
        tracker.remember(&window);
        if saved.maximized {
            let _ = window.maximize();
        }
    } else {
        tracker.remember(&window);
    }
    let tracked = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => tracker.remember(&tracked),
        WindowEvent::CloseRequested { .. } => tracker.save(&tracked),
        _ => {}
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(x: i32, y: i32) -> Saved {
        Saved {
            x,
            y,
            width: 1100,
            height: 800,
            maximized: false,
        }
    }

    #[test]
    fn round_trips_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        let state = Saved {
            maximized: true,
            ..saved(10, 20)
        };
        store(&path, &state);
        assert_eq!(load(&path), Some(state));
    }

    #[test]
    fn ignores_a_broken_or_tiny_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(load(&path), None);
        std::fs::write(
            &path,
            r#"{"x":0,"y":0,"width":10,"height":10,"maximized":false}"#,
        )
        .unwrap();
        assert_eq!(load(&path), None);
        assert_eq!(load(&dir.path().join("missing.json")), None);
    }

    #[test]
    fn a_window_off_every_screen_is_not_restored_there() {
        let screens = [(0, 0, 1920, 1040), (1920, 0, 1280, 984)];
        assert!(visible_on(&saved(100, 100), &screens));
        assert!(visible_on(&saved(2000, 50), &screens));
        assert!(visible_on(&saved(-900, 0), &screens));
        assert!(!visible_on(&saved(-1200, 0), &screens));
        assert!(!visible_on(&saved(100, 1030), &screens));
        assert!(!visible_on(&saved(4000, 100), &screens));
        assert!(!visible_on(&saved(100, 100), &[]));
    }
}
