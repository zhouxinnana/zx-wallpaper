import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Heart, Image as ImageIcon, Pause, Play, SkipForward, Trash2 } from "lucide-react";
import type { AppState, DesktopRuntime, WidgetLayout } from "../runtime/types";
import { tauriRuntime } from "../runtime/tauri-runtime";
import { pathName, samePath } from "../shared/paths";
import { invoke } from "@tauri-apps/api/core";

const COLLAPSE_DELAY_MS = 420;
const COLLAPSE_ANIM_MS = 150;
const EDGE_SNAP_PX = 28;
const DRAG_THRESHOLD_PX = 4;
const WIDGET_CARD_W = 248;
const WIDGET_STRIP_W = 36;

type Anchor = "left" | "right";

interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  offX: number;
  offY: number;
  moved: boolean;
  wasExpanded: boolean;
  lastX: number;
  lastY: number;
  raf: number;
}

function setWidgetGeometry(expanded: boolean, anchor: Anchor, docked: boolean, y: number | null) {
  return invoke("widget_set_expanded", { expanded, anchor, docked, y }).catch(() => {});
}

function setFreePosition(x: number, y: number) {
  return invoke("widget_set_free_position", { x, y }).catch(() => {});
}

/** 把拖拽落点写回后端持久化；失败不打断交互（下次启动回退默认位置）。 */
function persistLayout(api: DesktopRuntime, layout: WidgetLayout) {
  void api.setWidgetLayout(layout).catch(() => {});
}

/** 当前显示器左缘（全局坐标）；类型库未收录 availLeft，运行时安全读取。 */
function screenLeft(): number {
  const extended = window.screen as Screen & { availLeft?: number };
  return typeof extended.availLeft === "number" ? extended.availLeft : 0;
}

/** 光标距屏幕左右缘不足阈值时返回应吸附的一侧。 */
function edgeSide(clientScreenX: number): Anchor | null {
  const left = screenLeft();
  const right = left + window.screen.width;
  if (clientScreenX <= left + EDGE_SNAP_PX) return "left";
  if (clientScreenX >= right - EDGE_SNAP_PX) return "right";
  return null;
}

export default function FloatingWidget({ runtime }: { runtime?: DesktopRuntime }) {
  const [api] = useState(() => runtime ?? tauriRuntime);
  const [state, setState] = useState<AppState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [anchor, setAnchor] = useState<Anchor>("right");
  const [docked, setDocked] = useState<Anchor | null>("right");
  const [snapSide, setSnapSide] = useState<Anchor | null>(null);
  const [dragging, setDragging] = useState(false);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expandedRef = useRef(false);
  const anchorRef = useRef<Anchor>("right");
  const dockedRef = useRef<Anchor | null>("right");
  const dragRef = useRef<DragSession | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const shrinkTimerRef = useRef<number | null>(null);

  const applyExpanded = (value: boolean) => {
    expandedRef.current = value;
    setExpanded(value);
  };
  const applyAnchor = (value: Anchor) => {
    anchorRef.current = value;
    setAnchor(value);
  };
  const applyDocked = (value: Anchor | null) => {
    dockedRef.current = value;
    setDocked(value);
  };

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};

    void api.getState().then(
      (next) => {
        if (active) setState(next);
      },
      () => {
        if (active) setError("无法读取壁纸状态");
      },
    );
    void api.onStateChanged((next) => {
      if (active) setState(next);
    }).then((stop) => {
      if (!active) {
        stop();
        return;
      }
      unsubscribe = stop;
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const currentPath = state?.currentPath ?? null;
  const paused = state?.paused ?? false;
  const isFavorite = Boolean(currentPath) && state!.favoritePaths.some((path) => samePath(path, currentPath!));
  const previousPath = state?.wallpaperHistory.find((path) => !samePath(path, currentPath ?? "")) ?? null;

  useEffect(() => {
    let active = true;
    setThumbnail(null);
    if (!currentPath) return () => { active = false; };
    void api.getImageAsset(currentPath, "grid").then((asset) => {
      if (active && asset) setThumbnail(asset.src);
    });
    return () => { active = false; };
  }, [currentPath]);

  // 启动时从后端同步布局状态；几何定位由 Rust 侧启动时完成，这里只恢复渲染状态。
  useEffect(() => {
    let active = true;
    void api.getWidgetLayout().then(
      (layout) => {
        if (!active) return;
        if (layout.docked === "left" || layout.docked === "right") {
          applyDocked(layout.docked);
          applyAnchor(layout.docked);
        } else if (typeof layout.x === "number" && typeof layout.y === "number") {
          applyDocked(null);
        }
      },
      () => {
        /* 恢复失败：保持默认右缘吸附状态 */
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const cancelTimers = useCallback(() => {
    if (collapseTimerRef.current !== null) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    if (shrinkTimerRef.current !== null) {
      window.clearTimeout(shrinkTimerRef.current);
      shrinkTimerRef.current = null;
    }
  }, []);

  const expand = useCallback(() => {
    if (dragRef.current) return;
    cancelTimers();
    const dockedNow = dockedRef.current;
    const nextAnchor: Anchor = dockedNow
      ?? (window.screenX + 18 > screenLeft() + window.screen.width / 2 ? "right" : "left");
    applyAnchor(nextAnchor);
    applyExpanded(true);
    void setWidgetGeometry(true, nextAnchor, dockedNow !== null, null);
  }, [cancelTimers]);

  const collapse = useCallback(() => {
    applyExpanded(false);
    setConfirming(false);
    if (shrinkTimerRef.current !== null) window.clearTimeout(shrinkTimerRef.current);
    // 先让卡片播完退出动画，再收缩窗口，避免内容被裁切。
    shrinkTimerRef.current = window.setTimeout(() => {
      shrinkTimerRef.current = null;
      void setWidgetGeometry(false, anchorRef.current, dockedRef.current !== null, null);
    }, COLLAPSE_ANIM_MS);
  }, []);

  const scheduleCollapse = useCallback(() => {
    if (dragRef.current) return;
    if (collapseTimerRef.current !== null) window.clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = window.setTimeout(() => {
      collapseTimerRef.current = null;
      collapse();
    }, COLLAPSE_DELAY_MS);
  }, [collapse]);

  useEffect(() => () => {
    cancelTimers();
    if (dragRef.current?.raf) window.cancelAnimationFrame(dragRef.current.raf);
    dragRef.current = null;
  }, [cancelTimers]);

  const startGrab = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const wasExpanded = expandedRef.current;
    cancelTimers();
    if (!wasExpanded) {
      // 收起态抓取：确保窗口确为小球尺寸（可能抢抓在缩窗动画完成前）。
      void setWidgetGeometry(false, anchorRef.current, dockedRef.current !== null, null);
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      offX: event.screenX - window.screenX,
      offY: event.screenY - window.screenY,
      moved: false,
      wasExpanded,
      lastX: window.screenX,
      lastY: window.screenY,
      raf: 0,
    };
    setDragging(true);
  }, [cancelTimers]);

  const moveGrab = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const session = dragRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    if (!session.moved) {
      if (Math.hypot(event.screenX - session.startX, event.screenY - session.startY) < DRAG_THRESHOLD_PX) return;
      session.moved = true;
      if (dockedRef.current !== null) applyDocked(null);
    }
    session.lastX = event.screenX - session.offX;
    session.lastY = event.screenY - session.offY;
    setSnapSide(edgeSide(event.screenX));
    if (session.raf === 0) {
      session.raf = window.requestAnimationFrame(() => {
        session.raf = 0;
        void setFreePosition(session.lastX, session.lastY);
      });
    }
  }, []);

  const endGrab = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const session = dragRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    setSnapSide(null);
    if (session.raf !== 0) {
      window.cancelAnimationFrame(session.raf);
      session.raf = 0;
    }
    if (!session.moved) {
      // 原地点击：收起态则展开；卡片本就展开则原地不动。
      if (!session.wasExpanded) expand();
      return;
    }
    const side = edgeSide(event.screenX);
    if (side) {
      applyDocked(side);
      applyAnchor(side);
      applyExpanded(false);
      void setWidgetGeometry(false, side, true, session.lastY);
      persistLayout(api, { docked: side, x: null, y: session.lastY });
      return;
    }
    const nextAnchor: Anchor = window.screenX + WIDGET_CARD_W / 2 > screenLeft() + window.screen.width / 2 ? "right" : "left";
    applyAnchor(nextAnchor);
    if (session.wasExpanded) {
      // 整卡拖动落点：持久化折叠球的等效位置（卡片贴靠侧的小球坐标）。
      persistLayout(api, {
        docked: null,
        x: session.lastX + (nextAnchor === "right" ? WIDGET_CARD_W - WIDGET_STRIP_W : 0),
        y: session.lastY,
      });
    } else {
      persistLayout(api, { docked: null, x: session.lastX, y: session.lastY });
    }
  }, [api, expand]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    try {
      setError(null);
      await action();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : String(cause));
    }
  }, []);

  const goPrevious = () => {
    if (!previousPath) return;
    void run(() => api.selectWallpaper(previousPath));
  };
  const goNext = () => void run(() => api.nextWallpaper());
  const toggleFavorite = () => {
    if (!currentPath) return;
    void run(() => api.toggleFavorite(currentPath));
  };
  const togglePaused = () => void run(() => api.togglePaused());
  const skipCurrent = () => {
    if (!currentPath) return;
    void run(() => api.skipCurrentWallpaper());
  };
  const confirmDelete = () => {
    setConfirming(false);
    void run(() => invoke("delete_current_wallpaper"));
  };

  const displayName = currentPath ? pathName(currentPath) : "尚未选择壁纸";
  const metaText = error ?? (state?.paused ? "自动切换已暂停" : "自动切换中");
  const rootClass = [
    "widget-root",
    expanded ? "is-expanded" : "",
    dragging ? "is-dragging" : "",
    snapSide ? "is-snap" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={rootClass}
      data-anchor={anchor}
      data-docked={docked ?? "none"}
      onMouseEnter={expanded ? cancelTimers : undefined}
      onMouseLeave={expanded ? scheduleCollapse : undefined}
    >
      <button
        className="widget-strip"
        type="button"
        aria-label="壁纸速控浮窗：按住拖动，移到屏幕边缘吸附，悬停展开"
        onMouseEnter={expand}
        onFocus={expand}
        onPointerDown={startGrab}
        onPointerMove={moveGrab}
        onPointerUp={endGrab}
      >
        {thumbnail
          ? <img src={thumbnail} alt="" decoding="async" />
          : <ImageIcon size={16} aria-hidden="true" />}
        <ChevronLeft size={14} aria-hidden="true" />
      </button>
      <section
        className={`widget-card${expanded ? " is-open" : ""}`}
        aria-label="壁纸速控浮窗"
        onPointerDown={startGrab}
        onPointerMove={moveGrab}
        onPointerUp={endGrab}
      >
        <div className="widget-thumb-wrap" onPointerDown={startGrab}>
          {thumbnail
            ? <img src={thumbnail} alt="当前壁纸预览" decoding="async" />
            : <div className="widget-empty">{currentPath ? "壁纸预览加载中" : "暂无壁纸"}</div>}
          <span className="widget-live-badge">当前壁纸 · LIVE</span>
        </div>
        <div className="widget-info">
          <span className="widget-name">{displayName}</span>
          <span className="widget-meta">{metaText}</span>
        </div>
        <div className="widget-divider" />
        {confirming ? (
          <div className="widget-confirm" onPointerDown={(event) => event.stopPropagation()}>
            <span className="widget-confirm-text">删除后移入回收站，并自动切换到下一张。</span>
            <button className="action-button is-small is-danger" type="button" onClick={confirmDelete}>删除</button>
            <button className="action-button is-small" type="button" onClick={() => setConfirming(false)}>取消</button>
          </div>
        ) : (
          <div className="widget-actions" onPointerDown={(event) => event.stopPropagation()}>
            <button
              className="widget-action"
              type="button"
              title="上一张"
              aria-label="回到上一张壁纸"
              disabled={!previousPath}
              onClick={goPrevious}
            >
              <span className="widget-btn"><ChevronLeft size={16} /></span>
            </button>
            <button
              className="widget-action"
              type="button"
              title={paused ? "恢复自动切换" : "暂停自动切换"}
              aria-label={paused ? "恢复切换" : "暂停切换"}
              onClick={togglePaused}
            >
              <span className="widget-btn">{paused ? <Play size={15} /> : <Pause size={15} />}</span>
            </button>
            <button className="widget-action" type="button" title="下一张" aria-label="切换下一张壁纸" onClick={goNext}>
              <span className="widget-btn"><ChevronRight size={16} /></span>
            </button>
            <button
              className="widget-action"
              type="button"
              title="跳过当前壁纸"
              aria-label="跳过当前壁纸"
              disabled={!currentPath}
              onClick={skipCurrent}
            >
              <span className="widget-btn"><SkipForward size={15} /></span>
            </button>
            <button
              className={isFavorite ? "widget-action is-fav" : "widget-action"}
              type="button"
              title={isFavorite ? "取消喜欢" : "喜欢"}
              aria-label={`${isFavorite ? "取消喜欢" : "喜欢"} ${displayName}`}
              disabled={!currentPath}
              onClick={toggleFavorite}
            >
              <span className="widget-btn"><Heart size={15} fill={isFavorite ? "currentColor" : "none"} /></span>
            </button>
            <button
              className="widget-action is-danger"
              type="button"
              title="删除当前壁纸"
              aria-label={`删除 ${displayName}`}
              disabled={!currentPath}
              onClick={() => setConfirming(true)}
            >
              <span className="widget-btn"><Trash2 size={15} /></span>
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
