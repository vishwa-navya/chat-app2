import { useRef, useCallback, useState, useEffect } from 'react';
import * as faceapi from 'face-api.js';

interface UseFaceDetectionProps {
  isEnabled: boolean;
  onViolation: () => void;
  onToggle: () => void;
}

export function useFaceDetection({ isEnabled, onViolation, onToggle }: UseFaceDetectionProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [faceCount, setFaceCount] = useState(0);

  const videoRef            = useRef<HTMLVideoElement | null>(null);
  const streamRef           = useRef<MediaStream | null>(null);
  const detectionIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const modelsLoadedRef     = useRef(false);
  const violationCountRef   = useRef(0);
  const isProcessingRef     = useRef(false);
  const isMountedRef        = useRef(true);

  // ── Load models once ──────────────────────────────────────────────────────
  const loadModels = useCallback(async () => {
    if (modelsLoadedRef.current) return;
    try {
      setIsLoading(true);
      const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@latest/model';
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      modelsLoadedRef.current = true;
      console.log('✅ Face models loaded');
    } catch (error) {
      console.error('❌ Model load error:', error);
      throw error;
    } finally {
      if (isMountedRef.current) setIsLoading(false);
    }
  }, []);

  // ── Detection loop ────────────────────────────────────────────────────────
  const startDetection = useCallback(() => {
    // Clear any existing interval first
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = null;
    }

    detectionIntervalRef.current = setInterval(async () => {
      // Skip if video not ready or already processing
      if (
        !videoRef.current ||
        !modelsLoadedRef.current ||
        isProcessingRef.current ||
        videoRef.current.readyState < 2 // HAVE_CURRENT_DATA
      ) return;

      try {
        isProcessingRef.current = true;

        const detections = await faceapi.detectAllFaces(
          videoRef.current,
          new faceapi.TinyFaceDetectorOptions({
            inputSize:      160,  // smaller = faster (was 192)
            scoreThreshold: 0.45  // slightly lower = catches faces faster
          })
        );

        if (!isMountedRef.current) return;

        const count = detections.length;
        setFaceCount(count);

        if (count === 0 || count >= 2) {
          // Bad frame — increment violation counter
          violationCountRef.current += 1;
          console.log(`🚨 Violation ${violationCountRef.current}/2 — faces: ${count}`);

          // 2 consecutive bad frames at 300ms = ~600ms to redirect
          if (violationCountRef.current >= 2) {
            console.log('🚨 CONFIRMED — redirecting to Chat1 NOW');
            violationCountRef.current = 0;
            stopCamera();
            onViolation();
          }
        } else {
          // Exactly 1 face — all good, reset counter
          violationCountRef.current = 0;
        }

      } catch (error) {
        // Silent — skip bad frames without counting as violations
      } finally {
        isProcessingRef.current = false;
      }

    }, 300); // ← KEY CHANGE: was 1000ms, now 300ms = 3x faster detection

  }, [onViolation]);

  // ── Start camera + detection ───────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    try {
      setIsLoading(true);

      await loadModels();
      if (!isMountedRef.current) return;

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width:  { ideal: 320 }, // smaller = faster detection
          height: { ideal: 240 },
          frameRate: { ideal: 15 },
        }
      });

      if (!isMountedRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      streamRef.current = stream;

      // Create hidden video element
      if (!videoRef.current) {
        const video = document.createElement('video');
        video.autoplay    = true;
        video.muted       = true;
        video.playsInline = true;
        video.style.cssText = 'display:none;position:fixed;top:-9999px;';
        document.body.appendChild(video);
        videoRef.current = video;
      }

      videoRef.current.srcObject = stream;

      try {
        await videoRef.current.play();
      } catch (e) {
        console.warn('Video play interrupted:', e);
      }

      startDetection();
      console.log('📹 Face detection active (300ms interval)');

    } catch (error) {
      console.error('❌ Camera start error:', error);
      if (isMountedRef.current) {
        setIsLoading(false);
        onToggle();
      }
    } finally {
      if (isMountedRef.current) setIsLoading(false);
    }
  }, [loadModels, startDetection, onToggle]);

  // ── Stop camera + detection ───────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
      try {
        if (videoRef.current.parentNode) {
          videoRef.current.parentNode.removeChild(videoRef.current);
        }
      } catch {}
      videoRef.current = null;
    }
    violationCountRef.current = 0;
    isProcessingRef.current   = false;
    if (isMountedRef.current) {
      setFaceCount(0);
      setIsLoading(false);
    }
    console.log('📹 Face detection stopped');
  }, []);

  // ── Enable / disable ──────────────────────────────────────────────────────
  useEffect(() => {
    isMountedRef.current = true;

    if (isEnabled) {
      startCamera().catch(err => {
        console.error('startCamera failed:', err);
        if (isMountedRef.current) onToggle();
      });
    } else {
      stopCamera();
    }

    return () => {
      isMountedRef.current = false;
      stopCamera();
    };
  }, [isEnabled]);

  return { isLoading, faceCount };
}