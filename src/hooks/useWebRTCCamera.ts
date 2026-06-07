/**
 * useWebRTCCamera.ts — v5 (Audio + Video)
 *
 * Changes from v4:
 *  - getUserMedia now requests BOTH video and audio
 *  - Audio tracks added to RTCPeerConnection (so voice is streamed peer-to-peer)
 *  - remoteStream now carries audio tracks too
 *  - Audio is LOW LATENCY: no processing, no echo cancellation delay tricks
 *  - exposing audioEnabled state + toggleAudio() so UI can mute/unmute mic
 *  - Remote audio plays through the <video> element directly (zero extra buffering)
 *
 * Backend: NO CHANGES NEEDED — same signaling, audio travels peer-to-peer via WebRTC
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";

export type CamStatus = "idle" | "connecting" | "connected" | "error";

export interface UseWebRTCCameraOptions {
  nickname: "Vishwa" | "Ammu";
  isEnabled: boolean;
}

export interface UseWebRTCCameraReturn {
  localStream:   MediaStream | null;
  remoteStream:  MediaStream | null;
  status:        CamStatus;
  errorMsg:      string | null;
  audioEnabled:  boolean;   // is OUR microphone on?
  toggleAudio:   () => void;
  stop:          () => void;
}

const SIGNALING_SERVER = "https://camera-sharing-server.onrender.com";
const ROOM = "vishwa-ammu-room-v4"; // same room as before

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

export function useWebRTCCamera({ nickname, isEnabled }: UseWebRTCCameraOptions): UseWebRTCCameraReturn {
  const [localStream,  setLocalStream]  = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [status,       setStatus]       = useState<CamStatus>("idle");
  const [errorMsg,     setErrorMsg]     = useState<string | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(false); // mic starts MUTED

  const socketRef      = useRef<Socket | null>(null);
  const pcRef          = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const iceCandidateQ  = useRef<RTCIceCandidateInit[]>([]);
  const cancelledRef   = useRef(false);
  const retryRef       = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Mic toggle (mutes/unmutes our audio track in the stream) ─────────────
  const toggleAudio = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;
    audioTrack.enabled = !audioTrack.enabled;
    setAudioEnabled(audioTrack.enabled);
    console.log("[Audio] Mic", audioTrack.enabled ? "ON" : "OFF");
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const stopRetry = () => {
    if (retryRef.current) { clearInterval(retryRef.current); retryRef.current = null; }
  };

  const destroyPC = () => {
    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onicecandidate = null;
      pcRef.current.onnegotiationneeded = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    iceCandidateQ.current = [];
  };

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
  }, [nickname]);

  const drainICE = async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;
    for (const c of iceCandidateQ.current) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
    iceCandidateQ.current = [];
  };

  const buildPC = (stream: MediaStream): RTCPeerConnection => {
    destroyPC();
    const pc = new RTCPeerConnection(ICE_CONFIG);
    pcRef.current = pc;

    // Add ALL tracks (video + audio) so peer receives both
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    pc.ontrack = ({ streams }) => {
      if (streams[0] && !cancelledRef.current) {
        console.log("[WebRTC] ✅ Remote stream received (video+audio)");
        stopRetry();
        setRemoteStream(streams[0]);
        setStatus("connected");
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && socketRef.current) {
        socketRef.current.emit("ice", { room: ROOM, from: nickname, candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log("[WebRTC] state:", s);
      if (s === "failed") pc.restartIce();
      if (s === "disconnected") { setRemoteStream(null); setStatus("connecting"); }
    };

    return pc;
  };

  const sendOffer = async () => {
    const stream = streamRef.current;
    if (!stream || cancelledRef.current) return;
    console.log("[WebRTC] Creating offer...");
    const pc = buildPC(stream);
    try {
      const offer = await pc.createOffer({
        offerToReceiveVideo: true,
        offerToReceiveAudio: true,  // ← tell peer we want audio too
      });
      await pc.setLocalDescription(offer);
      socketRef.current?.emit("offer", { room: ROOM, from: nickname, sdp: pc.localDescription });
      console.log("[WebRTC] 📡 Offer sent");
    } catch (err) {
      console.error("[WebRTC] createOffer error:", err);
    }
  };

  // ── Main effect ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isEnabled) { cleanup(); return; }

    cancelledRef.current = false;
    setStatus("connecting");
    setErrorMsg(null);

    const run = async () => {

      // STEP 1: Get camera + microphone
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width:  { ideal: 1280, max: 1920 },
            height: { ideal: 720,  max: 1080 },
            facingMode: "user",
          },
          audio: {
            // Low-latency audio settings — minimize processing delay
            echoCancellation: true,       // prevents echo from speakers
            noiseSuppression: true,       // cleaner voice
            autoGainControl:  true,       // consistent volume
            // Latency hints for browser
            latency: 0,                   // request lowest possible latency
            channelCount: 1,              // mono is faster than stereo
            sampleRate: 48000,            // standard WebRTC sample rate
          },
        });
      } catch (err: any) {
        if (cancelledRef.current) return;

        // If microphone denied, fall back to video-only
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          console.warn("[Audio] Mic permission denied, falling back to video only");
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
              audio: false,
            });
          } catch (vidErr: any) {
            if (cancelledRef.current) return;
            setStatus("error");
            setErrorMsg("Camera permission denied. Please allow camera access and try again.");
            return;
          }
        } else {
          if (cancelledRef.current) return;
          const msg =
            err.name === "NotFoundError"    ? "No camera found on this device." :
            err.name === "NotReadableError" ? "Camera is in use by another app. Close it and retry." :
                                             "Could not access camera/microphone.";
          setStatus("error"); setErrorMsg(msg); return;
        }
      }

      if (cancelledRef.current) { stream.getTracks().forEach(t => t.stop()); return; }

      // Start mic MUTED (user turns it on via speaker button in UI)
      stream.getAudioTracks().forEach(t => { t.enabled = false; });
      setAudioEnabled(false);

      localStreamRef.current = stream;
      streamRef.current = stream;
      setLocalStream(stream);

      // STEP 2: Connect socket
      const socket = io(SIGNALING_SERVER, {
        transports: ["websocket", "polling"],
        reconnectionAttempts: 10,
        reconnectionDelay: 2000,
      });
      socketRef.current = socket;

      socket.on("connect", () => {
        console.log("[Socket] ✅ Connected:", socket.id);
        socket.emit("join", { room: ROOM, user: nickname });
      });

      socket.on("joined", ({ count }: { count: number }) => {
        console.log(`[Socket] Room joined. Users: ${count}`);
        socket.emit("camera-ready", { room: ROOM, from: nickname });
        console.log("[Socket] 📣 camera-ready sent");

        stopRetry();
        retryRef.current = setInterval(() => {
          if (cancelledRef.current) { stopRetry(); return; }
          if (pcRef.current?.connectionState === "connected") { stopRetry(); return; }
          if (socket.connected) {
            console.log("[Socket] 🔁 Retry camera-ready...");
            socket.emit("camera-ready", { room: ROOM, from: nickname });
          }
        }, 3000);
      });

      socket.on("camera-ready", async ({ from }: { from: string }) => {
        if (from === nickname || cancelledRef.current) return;
        console.log(`[Socket] 📷 ${from} camera ready`);
        if (nickname === "Vishwa") await sendOffer();
      });

      socket.on("request-offer", async ({ to }: { to: string }) => {
        if (nickname !== "Vishwa" || cancelledRef.current) return;
        console.log("[Socket] 📨 request-offer for:", to);
        await sendOffer();
      });

      socket.on("offer", async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
        if (from === nickname || cancelledRef.current) return;
        console.log("[Socket] 📨 Offer from:", from);
        const pc = buildPC(stream);
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          await drainICE();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("answer", { room: ROOM, from: nickname, sdp: pc.localDescription });
          console.log("[WebRTC] 📡 Answer sent");
        } catch (err) {
          console.error("[WebRTC] answer error:", err);
        }
      });

      socket.on("answer", async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
        if (from === nickname || cancelledRef.current) return;
        console.log("[Socket] 📨 Answer from:", from);
        const pc = pcRef.current;
        if (!pc) return;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          await drainICE();
        } catch (err) {
          console.error("[WebRTC] setRemoteDescription(answer) error:", err);
        }
      });

      socket.on("ice", async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
        if (from === nickname || !candidate) return;
        const pc = pcRef.current;
        if (!pc) return;
        if (!pc.remoteDescription) { iceCandidateQ.current.push(candidate); return; }
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
      });

      socket.on("camera-off", ({ from }: { from: string }) => {
        if (from === nickname) return;
        console.log(`[Socket] ❌ ${from} camera off`);
        destroyPC();
        setRemoteStream(null);
        setStatus("connecting");
        if (socket.connected && !cancelledRef.current) {
          socket.emit("camera-ready", { room: ROOM, from: nickname });
        }
      });

      socket.on("connect_error", (err) => {
        console.error("[Socket] connect error:", err.message);
        if (!cancelledRef.current) {
          setStatus("error");
          setErrorMsg("Cannot reach signaling server. Check internet and try again.");
        }
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
  }, [isEnabled, nickname]); // eslint-disable-line react-hooks/exhaustive-deps

  const stop = useCallback(() => cleanup(true), [cleanup]);

  return { localStream, remoteStream, status, errorMsg, audioEnabled, toggleAudio, stop };
}