/**
 * useWebRTCCamera.ts — FINAL v4
 *
 * Bugs fixed from v3:
 *  1. announceCamera() was called before it was defined (hoisting issue with arrow fn inside useEffect)
 *  2. socket.on("connect") registered TWICE — caused double announce + race condition
 *  3. Server didn't emit "joined" or "request-offer" — now it does (update server.js too)
 *  4. Retry logic was stopping too early (gotResponseRef set on camera-ready, not on actual video)
 *
 * Flow:
 *  Vishwa turns ON  → joins room → server emits "joined" → Vishwa emits "camera-ready"
 *  Ammu turns ON    → joins room → server emits "joined" → Ammu emits "camera-ready"
 *                   → server ALSO emits "request-offer" to Vishwa
 *  Vishwa receives "camera-ready" from Ammu  → sends WebRTC offer
 *  Vishwa receives "request-offer"           → sends WebRTC offer (covers late-join case)
 *  Ammu receives offer → sends answer → ICE exchange → VIDEO APPEARS
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
  status:   CamStatus;
  errorMsg: string | null;
  stop: () => void;
}

const SIGNALING_SERVER = "https://camera-sharing-server.onrender.com";
const ROOM = "vishwa-ammu-room-v4";

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
  const [status,   setStatus]   = useState<CamStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const socketRef      = useRef<Socket | null>(null);
  const pcRef          = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const iceCandidateQ  = useRef<RTCIceCandidateInit[]>([]);
  const cancelledRef   = useRef(false);
  const retryRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef      = useRef<MediaStream | null>(null); // stable ref to stream for callbacks

  // ── Helpers ───────────────────────────────────────────────────────────────

  const stopRetry = () => {
    if (retryRef.current) { clearInterval(retryRef.current); retryRef.current = null; }
  };

  const destroyPC = () => {
    if (pcRef.current) {
      pcRef.current.ontrack             = null;
      pcRef.current.onicecandidate      = null;
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
      localStreamRef.current.getTracks().forEach((t) => t.stop());
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
  }, [nickname]);

  const drainICE = async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;
    for (const c of iceCandidateQ.current) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
    iceCandidateQ.current = [];
  };

  // Build fresh PC — call this right before creating offer OR right before setting remote offer
  const buildPC = (stream: MediaStream): RTCPeerConnection => {
    destroyPC();
    const pc = new RTCPeerConnection(ICE_CONFIG);
    pcRef.current = pc;

    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    pc.ontrack = ({ streams }) => {
      if (streams[0] && !cancelledRef.current) {
        console.log("[WebRTC] ✅ Remote stream received!");
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
      console.log("[WebRTC] connection state:", s);
      if (s === "failed") {
        pc.restartIce();
      }
      if (s === "disconnected") {
        setRemoteStream(null);
        setStatus("connecting");
      }
    };

    return pc;
  };

  // Vishwa creates and sends offer
  const sendOffer = async () => {
    const stream = streamRef.current;
    if (!stream || cancelledRef.current) return;
    console.log("[WebRTC] Creating offer...");
    const pc = buildPC(stream);
    try {
      const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false });
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

      // STEP 1: Get camera
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: false,
        });
      } catch (err: any) {
        if (cancelledRef.current) return;
        const msg =
          err.name === "NotAllowedError"   ? "Camera permission denied. Please allow camera access and try again." :
          err.name === "NotFoundError"     ? "No camera found on this device." :
          err.name === "NotReadableError"  ? "Camera is in use by another app. Close it and retry." :
                                            "Could not access camera.";
        setStatus("error"); setErrorMsg(msg); return;
      }

      if (cancelledRef.current) { stream.getTracks().forEach(t => t.stop()); return; }

      // Store stream in both ref and state
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

      // STEP 3: On connect, join the room
      socket.on("connect", () => {
        console.log("[Socket] ✅ Connected, joining room...");
        socket.emit("join", { room: ROOM, user: nickname });
      });

      // STEP 4: Server confirms join → NOW announce our camera
      // This is the ONLY place we start the announce + retry loop
      socket.on("joined", ({ count }: { count: number }) => {
        console.log(`[Socket] Room joined. Users in room: ${count}`);
        
        // Announce camera immediately
        socket.emit("camera-ready", { room: ROOM, from: nickname });
        console.log("[Socket] 📣 camera-ready sent");

        // Retry every 3s until we actually get remote video
        stopRetry();
        retryRef.current = setInterval(() => {
          if (cancelledRef.current) { stopRetry(); return; }
          // Check if we already have remote stream (stop retrying)
          if (pcRef.current?.connectionState === "connected") { stopRetry(); return; }
          if (socket.connected) {
            console.log("[Socket] 🔁 Retrying camera-ready...");
            socket.emit("camera-ready", { room: ROOM, from: nickname });
          }
        }, 3000);
      });

      // STEP 5: Other person's camera is ready
      // → Vishwa sends offer; Ammu just waits for the offer
      socket.on("camera-ready", async ({ from }: { from: string }) => {
        if (from === nickname || cancelledRef.current) return;
        console.log(`[Socket] 📷 ${from} camera ready`);

        if (nickname === "Vishwa") {
          await sendOffer();
        }
        // Ammu: do nothing here — offer will arrive via "offer" event
      });

      // STEP 6: Server tells Vishwa to send offer (Ammu joined while Vishwa already in room)
      socket.on("request-offer", async ({ to }: { to: string }) => {
        if (nickname !== "Vishwa" || cancelledRef.current) return;
        console.log("[Socket] 📨 request-offer received, sending offer to:", to);
        await sendOffer();
      });

      // STEP 7: Ammu receives offer → creates answer
      socket.on("offer", async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
        if (from === nickname || cancelledRef.current) return;
        console.log("[Socket] 📨 Offer received from:", from);

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

      // STEP 8: Vishwa receives answer
      socket.on("answer", async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
        if (from === nickname || cancelledRef.current) return;
        console.log("[Socket] 📨 Answer received from:", from);
        const pc = pcRef.current;
        if (!pc) { console.warn("[WebRTC] No PC to set answer on!"); return; }
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          await drainICE();
        } catch (err) {
          console.error("[WebRTC] setRemoteDescription(answer) error:", err);
        }
      });

      // STEP 9: ICE candidates
      socket.on("ice", async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
        if (from === nickname || !candidate) return;
        const pc = pcRef.current;
        if (!pc) return;
        if (!pc.remoteDescription) {
          iceCandidateQ.current.push(candidate); return;
        }
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
      });

      // STEP 10: Partner turned camera off
      socket.on("camera-off", ({ from }: { from: string }) => {
        if (from === nickname) return;
        console.log(`[Socket] ❌ ${from} turned camera off`);
        destroyPC();
        setRemoteStream(null);
        setStatus("connecting");
        // Re-announce so when they come back, they can reconnect to us
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

  return { localStream, remoteStream, status, errorMsg, stop };
}