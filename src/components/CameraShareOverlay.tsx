/**
 * CameraShareOverlay.tsx — DRAGGABLE v5
 *
 * - Fully draggable on both mouse (laptop) and touch (phone)
 * - Default position: right side, vertically centered (desktop) / bottom-center (mobile)
 * - User can drag it anywhere on screen
 * - Stays within screen bounds (won't go off-screen)
 * - Fullscreen, Minimize, Close buttons still work
 * - Position resets when going fullscreen → back to floating
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { Maximize2, Minimize2, X, Video, VideoOff, Loader2, WifiOff } from "lucide-react";
import type { CamStatus } from "../hooks/useWebRTCCamera";

interface CameraShareOverlayProps {
  localStream:  MediaStream | null;
  remoteStream: MediaStream | null;
  status:   CamStatus;
  errorMsg: string | null;
  nickname: "Vishwa" | "Ammu";
  isEnabled: boolean;
  onClose: () => void;
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ msg, onDone }: { msg: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 3500); return () => clearTimeout(t); }, [onDone]);
  return (
    <div style={{
      position: "fixed", top: 80, left: "50%", transform: "translateX(-50%)",
      zIndex: 9999, background: "linear-gradient(135deg,#10b981,#059669)",
      color: "#fff", padding: "8px 18px", borderRadius: 999, fontSize: 13,
      fontWeight: 600, boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
      display: "flex", alignItems: "center", gap: 8,
      animation: "toastIn .3s ease", whiteSpace: "nowrap", pointerEvents: "none",
    }}>
      <Video style={{ width: 14, height: 14 }} />
      {msg}
      <style>{`@keyframes toastIn{from{opacity:0;transform:translateX(-50%) translateY(-10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}`}</style>
    </div>
  );
}

// ─── Video element ────────────────────────────────────────────────────────────

function Vid({ stream, muted = false, style, label }: {
  stream: MediaStream | null; muted?: boolean;
  style?: React.CSSProperties; label?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (stream) { el.srcObject = stream; el.play().catch(() => {}); }
    else el.srcObject = null;
  }, [stream]);

  return (
    <div style={{ position: "relative", ...style }}>
      <video ref={ref} autoPlay playsInline muted={muted}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      {label && (
        <span style={{
          position: "absolute", bottom: 4, left: 6, fontSize: 10,
          color: "rgba(255,255,255,0.9)", background: "rgba(0,0,0,0.5)",
          borderRadius: 4, padding: "1px 6px", pointerEvents: "none", fontWeight: 600,
        }}>{label}</span>
      )}
    </div>
  );
}

// ─── No-remote placeholder ────────────────────────────────────────────────────

function NoRemote({ status, errorMsg, other }: { status: CamStatus; errorMsg: string | null; other: string }) {
  return (
    <div style={{
      position: "absolute", inset: 0, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 10, padding: 16, textAlign: "center",
    }}>
      {status === "connecting" ? (
        <>
          <Loader2 size={32} color="#22c55e" style={{ animation: "spin 1s linear infinite" }} />
          <span style={{ color: "rgba(255,255,255,0.55)", fontSize: 12 }}>Waiting for {other} to turn on camera…</span>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </>
      ) : status === "error" ? (
        <>
          <WifiOff size={28} color="#f87171" />
          <span style={{ color: "#fca5a5", fontSize: 11, lineHeight: 1.4 }}>{errorMsg}</span>
        </>
      ) : (
        <>
          <VideoOff size={28} color="rgba(255,255,255,0.2)" />
          <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 12 }}>{other} hasn't turned camera on yet</span>
        </>
      )}
    </div>
  );
}

// ─── Control button ───────────────────────────────────────────────────────────

function Btn({ children, onClick, title, danger = false }: {
  children: React.ReactNode; onClick: () => void; title?: string; danger?: boolean;
}) {
  return (
    <button onClick={onClick} title={title} style={{
      width: 24, height: 24, borderRadius: "50%", border: "none", cursor: "pointer",
      background: danger ? "rgba(239,68,68,0.85)" : "rgba(255,255,255,0.25)",
      color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0, transition: "background .15s",
    }}
    onMouseEnter={e => (e.currentTarget.style.background = danger ? "#dc2626" : "rgba(255,255,255,0.45)")}
    onMouseLeave={e => (e.currentTarget.style.background = danger ? "rgba(239,68,68,0.85)" : "rgba(255,255,255,0.25)")}
    >
      {children}
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CameraShareOverlay({
  localStream, remoteStream, status, errorMsg, nickname, isEnabled, onClose,
}: CameraShareOverlayProps) {

  const [fullscreen, setFullscreen] = useState(false);
  const [minimized,  setMinimized]  = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // ── Drag state ──────────────────────────────────────────────────────────────
  const boxRef       = useRef<HTMLDivElement>(null);
  const isDragging   = useRef(false);
  const dragStart    = useRef({ x: 0, y: 0 });   // pointer position at drag start
  const boxStart     = useRef({ x: 0, y: 0 });   // box position at drag start
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null); // null = use default CSS

  // ── Default position (computed once on first render) ────────────────────────
  const getDefaultPos = useCallback(() => {
    const isMobile = window.innerWidth < 768;
    const W = 240;
    const H = Math.round(W * 3 / 4); // 4:3 ratio = 180px
    if (isMobile) {
      // Bottom center, above input bar
      return {
        x: Math.round((window.innerWidth - W) / 2),
        y: window.innerHeight - H - 140,
      };
    } else {
      // Right side, vertically centered
      return {
        x: window.innerWidth - W - 20,
        y: Math.round((window.innerHeight - H) / 2),
      };
    }
  }, []);

  // Set default position on mount / when overlay becomes visible
  useEffect(() => {
    if (isEnabled && !fullscreen && !minimized) {
      setPos(p => p ?? getDefaultPos());
    }
  }, [isEnabled, fullscreen, minimized, getDefaultPos]);

  // Reset position when coming back from fullscreen
  useEffect(() => {
    if (!fullscreen) setPos(getDefaultPos());
  }, [fullscreen, getDefaultPos]);

  // ── Clamp box within viewport ───────────────────────────────────────────────
  const clamp = useCallback((x: number, y: number) => {
    const W = boxRef.current?.offsetWidth  ?? 240;
    const H = boxRef.current?.offsetHeight ?? 180;
    return {
      x: Math.max(0, Math.min(x, window.innerWidth  - W)),
      y: Math.max(0, Math.min(y, window.innerHeight - H)),
    };
  }, []);

  // ── Mouse drag ──────────────────────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // Don't drag when clicking buttons
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    isDragging.current = true;
    dragStart.current  = { x: e.clientX, y: e.clientY };
    boxStart.current   = pos ?? getDefaultPos();
  }, [pos, getDefaultPos]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setPos(clamp(boxStart.current.x + dx, boxStart.current.y + dy));
    };
    const onUp = () => { isDragging.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
  }, [clamp]);

  // ── Touch drag ─────────────────────────────────────────────────────────────
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const t = e.touches[0];
    isDragging.current = true;
    dragStart.current  = { x: t.clientX, y: t.clientY };
    boxStart.current   = pos ?? getDefaultPos();
  }, [pos, getDefaultPos]);

  useEffect(() => {
    const onMove = (e: TouchEvent) => {
      if (!isDragging.current) return;
      e.preventDefault(); // prevent page scroll while dragging
      const t = e.touches[0];
      const dx = t.clientX - dragStart.current.x;
      const dy = t.clientY - dragStart.current.y;
      setPos(clamp(boxStart.current.x + dx, boxStart.current.y + dy));
    };
    const onEnd = () => { isDragging.current = false; };
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend",  onEnd);
    return () => {
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend",  onEnd);
    };
  }, [clamp]);

  // ── Toast logic ─────────────────────────────────────────────────────────────
  const other = nickname === "Vishwa" ? "Ammu" : "Vishwa";
  const prevRemote  = useRef<MediaStream | null>(null);
  const prevEnabled = useRef(false);

  useEffect(() => {
    if (isEnabled && !prevEnabled.current) setToast(`${nickname} started camera sharing`);
    prevEnabled.current = isEnabled;
  }, [isEnabled, nickname]);

  useEffect(() => {
    if (remoteStream && !prevRemote.current)  setToast(`${other} started camera sharing`);
    if (!remoteStream && prevRemote.current)  setToast(`${other} stopped camera sharing`);
    prevRemote.current = remoteStream;
  }, [remoteStream, other]);

  const handleClose = () => {
    setToast(`${nickname} stopped camera sharing`);
    setTimeout(onClose, 300);
  };

  if (!isEnabled && !localStream && !remoteStream) return null;

  const dotColor =
    status === "connected" && remoteStream ? "#22c55e" :
    status === "connecting"               ? "#facc15" :
    status === "error"                    ? "#ef4444" : "#9ca3af";

  // ── Fullscreen ──────────────────────────────────────────────────────────────
  if (fullscreen) {
    return (
      <>
        {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
        <div style={{ position: "fixed", inset: 0, zIndex: 500, background: "#000", display: "flex", flexDirection: "column" }}>
          {/* Controls */}
          <div style={{
            position: "absolute", top: 0, left: 0, right: 0, zIndex: 2,
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "10px 12px",
            background: "linear-gradient(to bottom,rgba(0,0,0,0.65),transparent)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: dotColor, display: "inline-block" }} />
              <span style={{ color: "rgba(255,255,255,0.8)", fontSize: 12, fontWeight: 600 }}>
                {remoteStream ? "Live" : "Connecting…"}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn title="Exit fullscreen" onClick={() => setFullscreen(false)}><Minimize2 size={13} /></Btn>
              <Btn title="Stop sharing" onClick={handleClose} danger><X size={13} /></Btn>
            </div>
          </div>
          {/* Remote video */}
          <div style={{ flex: 1, position: "relative" }}>
            {remoteStream
              ? <Vid stream={remoteStream} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} label={other} />
              : <NoRemote status={status} errorMsg={errorMsg} other={other} />}
          </div>
          {/* PiP */}
          {localStream && (
            <div style={{
              position: "absolute", bottom: 20, right: 20,
              width: 120, height: 90, borderRadius: 10, overflow: "hidden",
              border: "2px solid rgba(255,255,255,0.35)", boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            }}>
              <Vid stream={localStream} muted style={{ width: 120, height: 90 }} label="You" />
            </div>
          )}
        </div>
      </>
    );
  }

  // ── Minimized pill ──────────────────────────────────────────────────────────
  if (minimized) {
    return (
      <>
        {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
        <div
          onClick={() => setMinimized(false)}
          title="Expand camera"
          style={{
            position: "fixed",
            bottom: pos ? undefined : 110,
            top:    pos ? pos.y : undefined,
            left:   pos ? pos.x : undefined,
            right:  pos ? undefined : 20,
            zIndex: 500,
            background: "linear-gradient(135deg,#10b981,#059669)",
            borderRadius: 999, padding: "8px 14px",
            display: "flex", alignItems: "center", gap: 8,
            cursor: "grab", boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            userSelect: "none",
          }}
        >
          <div style={{ width: 28, height: 28, borderRadius: "50%", overflow: "hidden", border: "2px solid rgba(255,255,255,0.5)" }}>
            {localStream ? <Vid stream={localStream} muted style={{ width: 28, height: 28 }} /> : <Video size={14} color="#fff" />}
          </div>
          <span style={{ color: "#fff", fontSize: 12, fontWeight: 600 }}>Camera</span>
          {remoteStream && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#fff", display: "inline-block", animation: "pulse 1s infinite" }} />}
          <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
        </div>
      </>
    );
  }

  // ── Floating draggable window ───────────────────────────────────────────────
  const W = window.innerWidth < 768 ? 240 : 280;

  return (
    <>
      {toast && <Toast msg={toast} onDone={() => setToast(null)} />}

      <div
        ref={boxRef}
        onMouseDown={onMouseDown}
        onTouchStart={onTouchStart}
        style={{
          position: "fixed",
          left: pos?.x ?? (window.innerWidth - W - 20),
          top:  pos?.y ?? Math.round((window.innerHeight - Math.round(W * 3/4)) / 2),
          width: W,
          zIndex: 500,
          cursor: isDragging.current ? "grabbing" : "grab",
          userSelect: "none",
          touchAction: "none",   // critical for mobile drag
        }}
      >
        <div style={{
          borderRadius: 16, overflow: "hidden",
          background: "#0f172a",
          boxShadow: "0 8px 40px rgba(0,0,0,0.45)",
          border: "1px solid rgba(255,255,255,0.15)",
          aspectRatio: "4/3",
          position: "relative",
        }}>
          {/* Top bar */}
          <div style={{
            position: "absolute", top: 0, left: 0, right: 0, zIndex: 3,
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "7px 8px",
            background: "linear-gradient(to bottom,rgba(0,0,0,0.65),transparent)",
          }}>
            {/* Status */}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{
                width: 8, height: 8, borderRadius: "50%", background: dotColor, display: "inline-block",
                boxShadow: status === "connected" && remoteStream ? "0 0 6px #22c55e" : "none",
                animation: status === "connecting" ? "pulse 1s infinite" : "none",
              }} />
              <span style={{ color: "rgba(255,255,255,0.8)", fontSize: 11, fontWeight: 600 }}>
                {status === "connected" && remoteStream ? "Live"
                  : status === "connecting" ? "Connecting…"
                  : status === "error"      ? "Error"
                  : "Camera On"}
              </span>
            </div>

            {/* Drag hint */}
            <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 10, flex: 1, textAlign: "center" }}>
              ⠿ drag
            </span>

            {/* Buttons */}
            <div style={{ display: "flex", gap: 4 }}>
              <Btn title="Fullscreen" onClick={() => { setFullscreen(true); setMinimized(false); }}>
                <Maximize2 size={12} />
              </Btn>
              <Btn title="Minimize" onClick={() => { setMinimized(true); setFullscreen(false); }}>
                <Minimize2 size={12} />
              </Btn>
              <Btn title="Stop camera sharing" onClick={handleClose} danger>
                <X size={12} />
              </Btn>
            </div>
          </div>

          {/* Remote stream (main view) */}
          {remoteStream
            ? <Vid stream={remoteStream} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} label={other} />
            : <NoRemote status={status} errorMsg={errorMsg} other={other} />}

          {/* PiP: your own camera */}
          {localStream && (
            <div style={{
              position: "absolute", bottom: 8, right: 8,
              width: 64, height: 48, borderRadius: 8, overflow: "hidden",
              border: "1.5px solid rgba(255,255,255,0.35)",
              boxShadow: "0 2px 8px rgba(0,0,0,0.4)", zIndex: 4,
            }}>
              <Vid stream={localStream} muted style={{ width: 64, height: 48 }} label="You" />
            </div>
          )}
        </div>
      </div>
    </>
  );
}