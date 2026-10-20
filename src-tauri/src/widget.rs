use tauri::{AppHandle, Manager};

const WIDGET_COLLAPSED_SIZE: (f64, f64) = (36.0, 132.0);
const WIDGET_EXPANDED_SIZE: (f64, f64) = (248.0, 272.0);

/// (scale, 显示器原点 x/y 与宽/高，逻辑单位、全局坐标)
fn widget_monitor_frame(window: &tauri::WebviewWindow) -> Option<(f64, f64, f64, f64, f64)> {
    let monitor = window.current_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let origin = monitor.position();
    let size = monitor.size();
    Some((
        scale,
        origin.x as f64 / scale,
        origin.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    ))
}

/// 启动兜底：贴主显示器右缘垂直居中。
pub(crate) fn position_floating_widget(app: &AppHandle, expanded: bool) {
    let Some(window) = app.get_webview_window("floating-widget") else {
        return;
    };
    let (_, height) = if expanded { WIDGET_EXPANDED_SIZE } else { WIDGET_COLLAPSED_SIZE };
    let y_override = widget_monitor_frame(&window)
        .map(|(_scale, _ox, oy, _sw, sh)| oy + (sh - height) / 2.0);
    let _ = set_widget_geometry(&window, expanded, "right", true, y_override);
}

/// 应用浮窗几何。`anchor` 是感应条/小球在窗口内的贴靠侧；
/// docked 时窗口吸附到对应屏幕边缘，否则在原位朝空旷一侧展开；
/// `y_override` 为全局逻辑坐标（None 表示保持当前纵向位置）。
fn set_widget_geometry(
    window: &tauri::WebviewWindow,
    expanded: bool,
    anchor: &str,
    docked: bool,
    y_override: Option<f64>,
) -> Result<(), String> {
    let (new_w, new_h) = if expanded { WIDGET_EXPANDED_SIZE } else { WIDGET_COLLAPSED_SIZE };
    let old_w = if expanded { WIDGET_COLLAPSED_SIZE.0 } else { WIDGET_EXPANDED_SIZE.0 };
    let old = window.outer_position().map_err(|error| error.to_string())?;
    let _ = window.set_size(tauri::LogicalSize::new(new_w, new_h));
    let Some((scale, ox, oy, screen_w, screen_h)) = widget_monitor_frame(window) else {
        return Ok(());
    };
    let old_x = old.x as f64 / scale - ox;
    let old_y = old.y as f64 / scale - oy;
    let y = match y_override {
        Some(raw) => raw - oy,
        None => old_y,
    }
    .clamp(8.0, (screen_h - new_h - 8.0).max(8.0));
    let x = if anchor == "left" {
        if docked { 0.0 } else { old_x }
    } else if docked {
        screen_w - new_w
    } else {
        old_x + old_w - new_w
    };
    let _ = window.set_position(tauri::LogicalPosition::new(ox + x, oy + y));
    Ok(())
}

#[tauri::command]
pub fn widget_set_expanded(
    window: tauri::WebviewWindow,
    expanded: bool,
    anchor: String,
    docked: bool,
    y: Option<f64>,
) -> Result<(), String> {
    set_widget_geometry(&window, expanded, &anchor, docked, y)
}

/// 自由拖动模式：按全局逻辑坐标移动浮窗，保持当前形态与尺寸（小球/整卡均可），
/// 仅在当前显示器范围内做温和钳制。
#[tauri::command]
pub fn widget_set_free_position(window: tauri::WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    if let Some((scale, ox, oy, screen_w, screen_h)) = widget_monitor_frame(&window) {
        let size = window.outer_size().map_err(|error| error.to_string())?;
        let width = (size.width as f64 / scale).max(WIDGET_COLLAPSED_SIZE.0);
        let height = (size.height as f64 / scale).max(WIDGET_COLLAPSED_SIZE.1);
        let x = (x - ox).clamp(4.0, (screen_w - width - 4.0).max(4.0));
        let y = (y - oy).clamp(8.0, (screen_h - height - 8.0).max(8.0));
        let _ = window.set_position(tauri::LogicalPosition::new(ox + x, oy + y));
    } else {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
    Ok(())
}
