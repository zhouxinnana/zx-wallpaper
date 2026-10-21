use tauri::{AppHandle, Manager, State};

use crate::state::{lock_config, mutate_without_rescan, AppState, RuntimeState, WidgetLayout};

const WIDGET_COLLAPSED_SIZE: (f64, f64) = (36.0, 132.0);
/// 展开卡片尺寸：高度须容纳 128 缩略图 + 文件名/状态两行 + 分隔线 + 2×3 操作区（约 326）。
const WIDGET_EXPANDED_SIZE: (f64, f64) = (248.0, 332.0);
/// 显示器信息（逻辑单位、全局坐标）。
#[derive(Clone, Copy)]
struct Frame {
    scale: f64,
    ox: f64,
    oy: f64,
    sw: f64,
    sh: f64,
}

const WIDGET_EDGE_MARGIN: f64 = 4.0;
const WIDGET_VERTICAL_MARGIN: f64 = 8.0;

fn frame_from(monitor: &tauri::Monitor) -> Frame {
    let scale = monitor.scale_factor();
    let origin = monitor.position();
    let size = monitor.size();
    Frame {
        scale,
        ox: origin.x as f64 / scale,
        oy: origin.y as f64 / scale,
        sw: size.width as f64 / scale,
        sh: size.height as f64 / scale,
    }
}

/// 浮窗当前所在显示器。
fn monitor_frame(window: &tauri::WebviewWindow) -> Option<Frame> {
    window
        .current_monitor()
        .ok()
        .flatten()
        .map(|monitor| frame_from(&monitor))
}

/// 主显示器：启动定位一律以主显示器为基准，避免窗口尚未落位时拿到错误的 current_monitor。
fn primary_frame(window: &tauri::WebviewWindow) -> Option<Frame> {
    window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())
        .map(|monitor| frame_from(&monitor))
}

/// 包含给定全局点的显示器；找不到时回退到首个可用显示器或主显示器。
fn frame_at_point(window: &tauri::WebviewWindow, x: f64, y: f64) -> Option<Frame> {
    let monitors = window.available_monitors().unwrap_or_default();
    let mut first = None;
    for monitor in &monitors {
        let frame = frame_from(monitor);
        if x >= frame.ox && x <= frame.ox + frame.sw && y >= frame.oy && y <= frame.oy + frame.sh {
            return Some(frame);
        }
        if first.is_none() {
            first = Some(frame);
        }
    }
    first.or_else(|| primary_frame(window))
}

/// 启动定位：按已保存的浮窗布局恢复（吸附边含纵向位置，或自由悬浮位置）；
/// 无有效布局时兜底贴主显示器右缘垂直居中。定位完成后才显示窗口，
/// 避免窗口先以系统默认位置出现再跳位。
pub(crate) fn position_floating_widget(app: &AppHandle) {
    let Some(window) = app.get_webview_window("floating-widget") else {
        return;
    };
    let layout = match app.try_state::<RuntimeState>() {
        Some(state) => lock_config(&state)
            .map(|config| config.widget_layout.clone())
            .unwrap_or_default(),
        None => WidgetLayout::default(),
    };
    // 启动早期显示器枚举偶尔为空（尤其是随系统开机启动），重试几次再落位。
    let mut frame = primary_frame(&window);
    let mut attempt = 0;
    while frame.is_none() && attempt < 5 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        frame = primary_frame(&window);
        attempt += 1;
    }
    let docked_side = layout
        .docked
        .as_deref()
        .filter(|side| matches!(*side, "left" | "right"));
    if let Some(fallback) = frame {
        if let Some(side) = docked_side {
            apply_geometry(&window, fallback, false, side, true, layout.y);
        } else if let (Some(x), Some(y)) = (layout.x, layout.y) {
            let frame = frame_at_point(&window, x, y).unwrap_or(fallback);
            apply_free_position(&window, frame, x, y);
        } else {
            let y = fallback.oy + ((fallback.sh - WIDGET_COLLAPSED_SIZE.1) / 2.0);
            apply_geometry(&window, fallback, false, "right", true, Some(y));
        }
    }
}

/// 应用浮窗几何。`anchor` 是感应条/小球在窗口内的贴靠侧；
/// docked 时窗口吸附到对应屏幕边缘，否则在原位朝空旷一侧展开；
/// `y_override` 为全局逻辑坐标（None 表示保持当前纵向位置）。
fn apply_geometry(
    window: &tauri::WebviewWindow,
    frame: Frame,
    expanded: bool,
    anchor: &str,
    docked: bool,
    y_override: Option<f64>,
) {
    let (new_w, new_h) = if expanded { WIDGET_EXPANDED_SIZE } else { WIDGET_COLLAPSED_SIZE };
    let old_w = if expanded { WIDGET_COLLAPSED_SIZE.0 } else { WIDGET_EXPANDED_SIZE.0 };
    let old = window.outer_position().ok();
    let _ = window.set_size(tauri::LogicalSize::new(new_w, new_h));
    let old_x = old.map(|position| position.x as f64 / frame.scale - frame.ox).unwrap_or(0.0);
    let old_y = old.map(|position| position.y as f64 / frame.scale - frame.oy).unwrap_or(0.0);
    let y = match y_override {
        Some(raw) => raw - frame.oy,
        None => old_y,
    }
    .clamp(
        WIDGET_VERTICAL_MARGIN,
        (frame.sh - new_h - WIDGET_VERTICAL_MARGIN).max(WIDGET_VERTICAL_MARGIN),
    );
    let x = if anchor == "left" {
        if docked { 0.0 } else { old_x }
    } else if docked {
        frame.sw - new_w
    } else {
        old_x + old_w - new_w
    };
    let _ = window.set_position(tauri::LogicalPosition::new(frame.ox + x, frame.oy + y));
}

#[tauri::command]
pub fn widget_set_expanded(
    window: tauri::WebviewWindow,
    expanded: bool,
    anchor: String,
    docked: bool,
    y: Option<f64>,
) -> Result<(), String> {
    let frame = monitor_frame(&window)
        .or_else(|| primary_frame(&window))
        .ok_or_else(|| "无法确定浮窗所在显示器".to_string())?;
    apply_geometry(&window, frame, expanded, &anchor, docked, y);
    Ok(())
}

/// 自由拖动模式：按全局逻辑坐标移动浮窗，保持当前形态与尺寸（小球/整卡均可），
/// 仅在目标显示器范围内做温和钳制。
#[tauri::command]
pub fn widget_set_free_position(window: tauri::WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    let frame = frame_at_point(&window, x, y)
        .or_else(|| monitor_frame(&window))
        .ok_or_else(|| "无法确定浮窗所在显示器".to_string())?;
    apply_free_position(&window, frame, x, y);
    Ok(())
}

fn apply_free_position(window: &tauri::WebviewWindow, frame: Frame, x: f64, y: f64) {
    let size = window.outer_size().unwrap_or_default();
    let width = (size.width as f64 / frame.scale).max(WIDGET_COLLAPSED_SIZE.0);
    let height = (size.height as f64 / frame.scale).max(WIDGET_COLLAPSED_SIZE.1);
    let x = (x - frame.ox).clamp(
        WIDGET_EDGE_MARGIN,
        (frame.sw - width - WIDGET_EDGE_MARGIN).max(WIDGET_EDGE_MARGIN),
    );
    let y = (y - frame.oy).clamp(
        WIDGET_VERTICAL_MARGIN,
        (frame.sh - height - WIDGET_VERTICAL_MARGIN).max(WIDGET_VERTICAL_MARGIN),
    );
    let _ = window.set_position(tauri::LogicalPosition::new(frame.ox + x, frame.oy + y));
}

/// 读取已持久化的浮窗布局（吸附边 / 自由位置）。
#[tauri::command]
pub fn get_widget_layout(state: State<'_, RuntimeState>) -> Result<WidgetLayout, String> {
    let config = lock_config(&state)?;
    Ok(config.widget_layout.clone())
}

/// 拖拽落点后持久化浮窗布局；不触发库重扫。
#[tauri::command]
pub fn set_widget_layout(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    layout: WidgetLayout,
) -> Result<AppState, String> {
    mutate_without_rescan(&app, &state, |config| {
        config.widget_layout = layout;
        Ok(())
    })
}
