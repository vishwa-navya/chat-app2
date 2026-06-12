/**
 * useWebRTCCamera.ts — FINAL v7
 *
 * FIXES:
 * 1. Camera too zoomed → use zoom:1, wider FOV constraints
 * 2. Reconnect black screen → full PC rebuild on every camera-ready/camera-off
 * 3. Black screen delay → video plays immediately on ontrack, no waiting
 * 4. Stale connection → aggressive retry with fresh PC every 3s until connected
 * 5. One user waits hours → retry loop keeps sending camera-ready until peer responds
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";

export type CamStatus = "idle" | "connecting" | "connected" | "error";

export interface UseWebRTCCameraOptions {
  nickname: "Vishwa" | "Ammu";
  isEnabled: boolean;
}

export interface UseWebRTCCameraReturn {
  localStream:  MediaStream | null;
  remoteStream: MediaStream | null;
  status:       CamStatus;
  errorMsg:     string | null;
  audioEnabled: boolean;
  toggleAudio:  () => void;
  stop:         () => void;
}

const SIGNALING_SERVER = "https://camera-sharing-server.onrender.com";
const ROOM = "vishwa-ammu-room-v4";

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "turn:openrelay.metered.ca:80",                username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443",               username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  ],
};

export function useWebRTCCamera({
  nickname,
  isEnabled,
}: UseWebRTCCameraOptions): UseWebRTCCameraReturn {

  const [localStream,  setLocalStream]  = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [status,       setStatus]       = useState<CamStatus>("idle");
  const [errorMsg,     setErrorMsg]     = useState<string | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(false);

  const socketRef      = useRef<Socket | null>(null);
  const pcRef          = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const iceCandidateQ  = useRef<RTCIceCandidateInit[]>([]);
  const cancelledRef   = useRef(false);
  const retryRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const isConnectedRef = useRef(false);

  // ── Mic toggle ────────────────────────────────────────────────────────────
  const toggleAudio = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setAudioEnabled(track.enabled);
  }, []);

  // ── Stop retry ────────────────────────────────────────────────────────────
  const stopRetry = useCallback(() => {
    if (retryRef.current) {
      clearInterval(retryRef.current);
      retryRef.current = null;
    }
  }, []);

  // ── Destroy PC cleanly ────────────────────────────────────────────────────
  const destroyPC = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.ontrack             = null;
      pcRef.current.onicecandidate      = null;
      pcRef.current.onnegotiationneeded = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.oniceconnectionstatechange = null;
      try { pcRef.current.close(); } catch {}
      pcRef.current = null;
    }
    iceCandidateQ.current = [];
    isConnectedRef.current = false;
  }, []);

  // ── Full cleanup ──────────────────────────────────────────────────────────
  const cleanup = useCallback((notify = true) => {
    stopRetry();
    destroyPC();
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    streamRef.current = null;
    if (socketRef.current) {
      if (notify) socketRef.current.emit("camera-off", { room: ROOM, from: nickname });
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    cancelledRef.current = false;
    setLocalStream(null);
    setRemoteStream(null);
    setStatus("idle");
    setErrorMsg(null);
    setAudioEnabled(false);
  }, [nickname, stopRetry, destroyPC]);

  // ── Drain ICE queue ───────────────────────────────────────────────────────
  const drainICE = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;
    for (const c of iceCandidateQ.current) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
    iceCandidateQ.current = [];
  }, []);

  // ── Build fresh PC ────────────────────────────────────────────────────────
  const buildPC = useCallback((stream: MediaStream): RTCPeerConnection => {
    destroyPC();

    const pc = new RTCPeerConnection(ICE_CONFIG);
    pcRef.current = pc;

    // Add all local tracks (video + audio)
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    // FIX 3: ontrack — set remote stream immediately, no delay
    pc.ontrack = ({ streams, track }) => {
      if (cancelledRef.current) return;
      const s = streams[0] ?? new MediaStream([track]);
      console.log("[Camera] Remote track received:", track.kind, "streams:", streams.length);
      // Set remote stream immediately — this fixes black screen delay
      setRemoteStream(s);
      setStatus("connected");
      isConnectedRef.current = true;
      stopRetry();
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && socketRef.current) {
        socketRef.current.emit("ice", { room: ROOM, from: nickname, candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      console.log("[Camera] ICE state:", s);
      if (s === "failed") {
        console.log("[Camera] ICE failed, restarting");
        pc.restartIce();
      }
      if (s === "disconnected") {
        // Don't immediately destroy — ICE can recover from brief disconnects
        setTimeout(() => {
          if (pc.iceConnectionState === "disconnected" && !cancelledRef.current) {
            console.log("[Camera] ICE still disconnected after 3s, marking connecting");
            setRemoteStream(null);
            setStatus("connecting");
            isConnectedRef.current = false;
          }
        }, 3000);
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log("[Camera] PC state:", s);
      if (s === "failed") {
        // Full reconnect
        destroyPC();
        setRemoteStream(null);
        setStatus("connecting");
        isConnectedRef.current = false;
        // Re-announce camera to trigger fresh offer/answer
        if (socketRef.current?.connected) {
          socketRef.current.emit("camera-ready", { room: ROOM, from: nickname });
        }
      }
    };

    return pc;
  }, [nickname, destroyPC, stopRetry]);

  // ── Send offer (Vishwa) ───────────────────────────────────────────────────
  const sendOffer = useCallback(async (stream: MediaStream) => {
    if (cancelledRef.current) return;
    console.log("[Camera] Creating offer...");
    const pc = buildPC(stream);
    try {
      const offer = await pc.createOffer({
        offerToReceiveVideo: true,
        offerToReceiveAudio: true,
      });
      await pc.setLocalDescription(offer);
      socketRef.current?.emit("offer", { room: ROOM, from: nickname, sdp: pc.localDescription });
      console.log("[Camera] Offer sent");
    } catch (err) {
      console.error("[Camera] createOffer failed:", err);
    }
  }, [nickname, buildPC]);

  // ── Main effect ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isEnabled) { cleanup(); return; }

    cancelledRef.current = false;
    isConnectedRef.current = false;
    setStatus("connecting");
    setErrorMsg(null);

    const run = async () => {

      // FIX 1: Camera constraints — wider FOV, no zoom
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            // Use environment/user facing camera
            facingMode: "user",
            // Wide angle: lower resolution = wider FOV on most phones
            width:     { ideal: 640,  max: 1280 },
            height:    { ideal: 480,  max: 720  },
            frameRate: { ideal: 30,   max: 30   },
            // FIX 1: Explicitly request no zoom
            // These are non-standard but supported on some browsers
            advanced: [
              { zoom: 1 } as any,
              { focusMode: "continuous" } as any,
            ],
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl:  true,
          },
        });
      } catch (err: any) {
        // Retry without advanced constraints if they fail
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: "user",
              width:  { ideal: 640, max: 1280 },
              height: { ideal: 480, max: 720  },
            },
            audio: true,
          });
        } catch (err2: any) {
          if (cancelledRef.current) return;
          // Last fallback: video only
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: "user" },
              audio: false,
            });
          } catch (err3: any) {
            if (!cancelledRef.current) {
              setStatus("error");
              const msg =
                err3.name === "NotAllowedError"  ? "Camera permission denied." :
                err3.name === "NotFoundError"    ? "No camera found." :
                err3.name === "NotReadableError" ? "Camera in use by another app." :
                                                   "Could not access camera.";
              setErrorMsg(msg);
            }
            return;
          }
        }
      }

      if (cancelledRef.current) { stream.getTracks().forEach(t => t.stop()); return; }

      // Audio starts muted
      stream.getAudioTracks().forEach(t => { t.enabled = false; });
      setAudioEnabled(false);

      localStreamRef.current = stream;
      streamRef.current      = stream;
      setLocalStream(stream);

      // Connect socket
      const socket = io(SIGNALING_SERVER, {
        transports: ["websocket", "polling"],
        reconnectionAttempts: 20,
        reconnectionDelay: 1000,
      });
      socketRef.current = socket;

      socket.on("connect", () => {
        console.log("[Camera Socket] Connected:", socket.id);
        socket.emit("join", { room: ROOM, user: nickname });
      });

      // FIX 2: On join, start retry loop immediately
      socket.on("joined", ({ count }: { count: number }) => {
        console.log("[Camera Socket] Joined room, users:", count);

        // Announce camera immediately
        socket.emit("camera-ready", { room: ROOM, from: nickname });

        // FIX 2: Retry every 3s until we get connected
        // This handles the case where one user waits hours for the other
        stopRetry();
        retryRef.current = setInterval(() => {
          if (cancelledRef.current || isConnectedRef.current) {
            stopRetry();
            return;
          }
          if (socket.connected) {
            console.log("[Camera] Retrying camera-ready...");
            socket.emit("camera-ready", { room: ROOM, from: nickname });
          }
        }, 3000);
      });

      // FIX 2: When partner's camera-ready arrives, ALWAYS destroy old PC and start fresh
      socket.on("camera-ready", async ({ from }: { from: string }) => {
        if (from === nickname || cancelledRef.current) return;
        console.log("[Camera Socket] Partner camera ready:", from);

        // Vishwa always sends offer
        if (nickname === "Vishwa") {
          // Destroy any stale PC first — this is the key reconnect fix
          destroyPC();
          isConnectedRef.current = false;
          setRemoteStream(null);
          setStatus("connecting");
          await sendOffer(stream);
        }
        // Ammu waits for offer
      });

      // FIX 2: Server tells Vishwa to send offer (Ammu joined while Vishwa waiting)
      socket.on("request-offer", async ({ to }: { to: string }) => {
        if (nickname !== "Vishwa" || cancelledRef.current) return;
        console.log("[Camera Socket] Request offer for:", to);
        destroyPC();
        isConnectedRef.current = false;
        setRemoteStream(null);
        await sendOffer(stream);
      });

      // Receive offer (Ammu)
      socket.on("offer", async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
        if (from === nickname || cancelledRef.current) return;
        console.log("[Camera Socket] Offer received from:", from);

        // FIX 2: Always build fresh PC for each offer
        const pc = buildPC(stream);
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          await drainICE();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("answer", { room: ROOM, from: nickname, sdp: pc.localDescription });
          console.log("[Camera] Answer sent");
        } catch (err) {
          console.error("[Camera] Answer error:", err);
        }
      });

      // Receive answer (Vishwa)
      socket.on("answer", async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
        if (from === nickname || cancelledRef.current) return;
        const pc = pcRef.current;
        if (!pc) return;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          await drainICE();
          console.log("[Camera] Remote description set (answer)");
        } catch (err) {
          console.error("[Camera] setRemoteDescription(answer) error:", err);
        }
      });

      // ICE candidates
      socket.on("ice", async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
        if (from === nickname || !candidate) return;
        const pc = pcRef.current;
        if (!pc) return;
        if (!pc.remoteDescription) {
          iceCandidateQ.current.push(candidate);
          return;
        }
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
      });

      // FIX 2: Partner camera off — destroy PC, show connecting, wait for them to come back
      socket.on("camera-off", ({ from }: { from: string }) => {
        if (from === nickname) return;
        console.log("[Camera Socket] Partner camera off:", from);

        // Destroy stale PC immediately
        destroyPC();
        setRemoteStream(null);
        setStatus("connecting");
        isConnectedRef.current = false;

        // Re-announce our camera so when partner comes back, they know we're here
        if (socket.connected && !cancelledRef.current) {
          socket.emit("camera-ready", { room: ROOM, from: nickname });
        }
      });

      socket.on("connect_error", () => {
        if (!cancelledRef.current) {
          setStatus("error");
          setErrorMsg("Cannot reach signaling server. Check internet.");
        }
      });

      socket.on("reconnect", () => {
        console.log("[Camera Socket] Reconnected — rejoining room");
        socket.emit("join", { room: ROOM, user: nickname });
      });
    };

    run();

    const onUnload = () => {
      socketRef.current?.emit("camera-off", { room: ROOM, from: nickname });
      localStreamRef.current?.getTracks().forEach(t => t.stop());
    };
    window.addEventListener("beforeunload", onUnload);

    return () => {
      cancelledRef.current = true;
      window.removeEventListener("beforeunload", onUnload);
      cleanup();
    };
  }, [isEnabled, nickname]);

  const stop = useCallback(() => cleanup(true), [cleanup]);

  return { localStream, remoteStream, status, errorMsg, audioEnabled, toggleAudio, stop };
}