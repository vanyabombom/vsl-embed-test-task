"use client";

import {
  useRef,
  useEffect,
  useState,
  useCallback,
  memo,
  type RefObject,
} from "react";
import { 
  Play, 
  Pause, 
  RotateCcw, 
  Volume2, 
  VolumeX, 
  Settings, 
  Maximize, 
  SlidersHorizontal, 
  FastForward, 
  ChevronRight,
  Minimize,
  ChevronLeft,
  Check
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface VslPlayerProps {
  src: string;
  videoId: string;
  analyticsUrl?: string;
  poster?: string;
}

type TapPhase = "preview" | "playing" | "paused";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const RESUME_KEY_PREFIX = "vsl_resume_";
const LS_THROTTLE_MS = 5_000;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function canPlayNativeHls(): boolean {
  if (typeof document === "undefined") return false;
  const v = document.createElement("video");
  return (
    v.canPlayType("application/vnd.apple.mpegurl") !== "" ||
    v.canPlayType("application/x-mpegURL") !== ""
  );
}

function isRestrictedIOSWebView(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";

  const isIOS = /iPhone|iPad|iPod/.test(ua);
  if (!isIOS) return false;

  const hasSafari = /Safari\//.test(ua);
  if (hasSafari) return false;

  const knownWorking = /Instagram|FBAN|FB_IAB|FBAV|Line\/|Twitter|Snapchat/i.test(ua);
  if (knownWorking) return false;

  return true;
}

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* blocked in some in-app browsers */
  }
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const VslPlayer = memo(function VslPlayer({
  src,
  videoId,
  analyticsUrl,
  poster,
}: VslPlayerProps) {
  /* ---- refs ---- */
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef</* Hls instance */ unknown>(null);

  /** Prevents race conditions: tracks the current pending play() Promise. */
  const playPromiseRef = useRef<Promise<void> | null>(null);
  /** Tracks the INTENDED play state. Overrides pending promises if state changes quickly. */
  const intendedPlayStateRef = useRef<"playing" | "paused">("paused");

  /** Max watch percentage achieved during this page session. */
  const maxPercentRef = useRef(0);

  /** Whether analytics have already been sent (fire-once guard). */
  const sentRef = useRef(false);

  /** Whether the component is still mounted (async guard). */
  const mountedRef = useRef(true);

  /** Timestamp of last localStorage write (throttle guard). */
  const lastLsSaveRef = useRef(0);

  /** Tap state machine. */
  const tapPhaseRef = useRef<TapPhase>("preview");

  /* ---- state (only things that affect render) ---- */
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showPlayButton, setShowPlayButton] = useState(false);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [nativeHijacked, setNativeHijacked] = useState(false);

  // --- UI State ---
  const [showControls, setShowControls] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsView, setSettingsView] = useState<"main" | "speed" | "quality">("main");
  const [playbackRate, setPlaybackRate] = useState(1);
  const [qualities, setQualities] = useState<{ index: number; name: string }[]>([]);
  const [currentQualityIndex, setCurrentQualityIndex] = useState<number>(-1);
  const [mockQuality, setMockQuality] = useState<string>("Auto");
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleInteract = useCallback(() => {
    setShowControls(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setShowControls(false);
      setShowSettings(false);
      setSettingsView("main");
    }, 3000);
  }, []);

  const handleSetSpeed = useCallback((rate: number) => {
    const video = videoRef.current;
    if (video) {
      video.playbackRate = rate;
      setPlaybackRate(rate);
    }
    setSettingsView("main");
    setShowSettings(false);
  }, []);

  const handleSetQuality = useCallback((index: number) => {
    const hls = hlsRef.current as any;
    if (hls) {
      hls.currentLevel = index;
      setCurrentQualityIndex(index);
    }
    setSettingsView("main");
    setShowSettings(false);
  }, []);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  /* ================================================================ */
  /*  safePlay — single entry point for ALL .play() calls             */
  /* ================================================================ */

  const safePlay = useCallback((): Promise<boolean> => {
    const video = videoRef.current;
    if (!video || !mountedRef.current) return Promise.resolve(false);

    intendedPlayStateRef.current = "playing";
    const promise = video.play();
    playPromiseRef.current = promise;

    return promise
      .then(() => {
        if (!mountedRef.current) return false;
        if (playPromiseRef.current === promise) {
          playPromiseRef.current = null;
        }
        if (intendedPlayStateRef.current === "playing") {
          setPlaying(true);
          return true;
        }
        return false;
      })
      .catch((err: DOMException) => {
        if (!mountedRef.current) return false;
        if (playPromiseRef.current === promise) {
          playPromiseRef.current = null;
        }
        if (err.name !== "AbortError") {
          setShowPlayButton(true);
        }
        return false;
      });
  }, []);

  /* ================================================================ */
  /*  safePause — waits for pending play() before pausing             */
  /* ================================================================ */

  const safePause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    intendedPlayStateRef.current = "paused";
    const pending = playPromiseRef.current;

    if (pending) {
      pending
        .then(() => {
          if (mountedRef.current && intendedPlayStateRef.current === "paused") {
            video.pause();
            setPlaying(false);
          }
        })
        .catch(() => { /* handled in safePlay */ });
    } else {
      video.pause();
      setPlaying(false);
    }
  }, []);

  /* ================================================================ */
  /*  EFFECT: Detect restricted iOS WebView                           */
  /* ================================================================ */

  useEffect(() => {
    if (isRestrictedIOSWebView()) {
      setNativeHijacked(true);
    }
  }, []);

  /* ================================================================ */
  /*  engage — first-tap logic (deduplicated)                         */
  /* ================================================================ */

  const engage = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (tapPhaseRef.current === "preview") {
      video.currentTime = 0;
    }

    video.muted = false;
    setMuted(false);

    // We optimistically set phase, but safePlay might fail.
    // If it fails with NotAllowedError, we show play button, which handles manual play.
    tapPhaseRef.current = "playing";

    safePlay().then((ok) => {
      if (ok && mountedRef.current && tapPhaseRef.current === "playing") {
        setIsFullscreen(true);
      } else if (!ok && mountedRef.current) {
        // If play failed, revert phase so user can try again
        tapPhaseRef.current = "preview";
        setIsFullscreen(false);
      }
    });
  }, [safePlay]);

  /* ================================================================ */
  /*  sendAnalytics — fire-once via sendBeacon                        */
  /* ================================================================ */

  const sendAnalytics = useCallback(() => {
    if (sentRef.current || !analyticsUrl || maxPercentRef.current === 0) return;
    sentRef.current = true;

    const video = videoRef.current;
    const payload = JSON.stringify({
      video_id: videoId,
      percent_watched: Math.round(maxPercentRef.current),
      duration: video && Number.isFinite(video.duration) ? Math.round(video.duration) : 0,
    });

    const blob = new Blob([payload], { type: "text/plain" });
    const url = `${analyticsUrl}/api/view`;

    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      const sent = navigator.sendBeacon(url, blob);
      if (sent) return;
    }

    fetch(url, {
      method: "POST",
      body: payload,
      keepalive: true,
      headers: { "Content-Type": "text/plain" },
    }).catch(() => { /* best-effort */ });
  }, [analyticsUrl, videoId]);

  /* ================================================================ */
  /*  EFFECT: Initialize HLS or native playback                       */
  /* ================================================================ */

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isRestrictedIOSWebView()) return;

    video.setAttribute("webkit-playsinline", "true");
    video.setAttribute("x5-playsinline", "true");

    let destroyed = false;
    const isHlsSource = src.includes(".m3u8");

    if (isHlsSource) {
      import("hls.js")
        .then(({ default: Hls }) => {
          if (destroyed || !mountedRef.current) return;
          if (Hls.isSupported()) {
            const hls = new Hls({ startLevel: -1 });
            hlsRef.current = hls;

            hls.on(Hls.Events.MANIFEST_PARSED, (_: any, data: any) => {
              if (!mountedRef.current) return;
              const levels = data.levels
                .map((l: any, idx: number) => {
                  const shortEdge = Math.min(l.width || 0, l.height || 0) || Math.max(l.width || 0, l.height || 0);
                  return { index: idx, shortEdge, height: l.height || 0 };
                })
                .sort((a: any, b: any) => b.height - a.height)
                .map((l: any) => ({ index: l.index, name: l.shortEdge ? `${l.shortEdge}p` : `Level ${l.index}` }));
              setQualities(levels);
            });

            hls.on(Hls.Events.LEVEL_SWITCHED, (_: any, data: any) => {
              if (!mountedRef.current) return;
              if (hls.autoLevelEnabled) {
                setCurrentQualityIndex(-1);
              } else {
                setCurrentQualityIndex(data.level);
              }
            });

            hls.loadSource(src);
            hls.attachMedia(video);
          } else if (canPlayNativeHls()) {
            video.src = src;
          }
        })
        .catch(() => {
          if (!destroyed && mountedRef.current && canPlayNativeHls()) {
            video.src = src;
          }
        });
    } else {
      video.src = src;
    }

    return () => {
      destroyed = true;
      const hls = hlsRef.current as { destroy(): void } | null;
      if (hls) {
        hls.destroy();
        hlsRef.current = null;
      }
    };
  }, [src]);

  /* ================================================================ */
  /*  EFFECT: Muted autoplay + resume position + fallback timeout     */
  /* ================================================================ */

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isRestrictedIOSWebView()) return;

    let autoplayFired = false;

    const tryAutoplay = () => {
      if (!mountedRef.current || autoplayFired) return;
      autoplayFired = true;

      const saved = lsGet(RESUME_KEY_PREFIX + videoId);
      if (saved) {
        const pos = parseFloat(saved);
        if (
          pos > 0 &&
          Number.isFinite(video.duration) &&
          video.duration > 0 &&
          pos < video.duration - 2
        ) {
          video.currentTime = pos;
        }
      }

      video.muted = true;
      setMuted(true);
      safePlay();
    };

    if (video.readyState >= 1) {
      tryAutoplay();
    } else {
      video.addEventListener("loadedmetadata", tryAutoplay, { once: true });
      video.addEventListener("canplay", tryAutoplay, { once: true });
    }

    const fallbackTimer = setTimeout(() => {
      if (!mountedRef.current) return;
      if (!autoplayFired || (intendedPlayStateRef.current === "playing" && video.paused)) {
        setShowPlayButton(true);
      }
    }, 4000);

    const onError = () => {
      if (!mountedRef.current) return;
      setShowPlayButton(true);
    };
    video.addEventListener("error", onError);

    return () => {
      clearTimeout(fallbackTimer);
      video.removeEventListener("loadedmetadata", tryAutoplay);
      video.removeEventListener("canplay", tryAutoplay);
      video.removeEventListener("error", onError);
    };
  }, [videoId, safePlay]);

  /* ================================================================ */
  /*  EFFECT: Track max percent + throttled localStorage resume       */
  /* ================================================================ */

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => {
      if (!video.duration || !Number.isFinite(video.duration)) return;

      const pct = (video.currentTime / video.duration) * 100;
      if (pct > maxPercentRef.current) {
        maxPercentRef.current = pct;
      }

      const now = Date.now();
      if (now - lastLsSaveRef.current >= LS_THROTTLE_MS) {
        lastLsSaveRef.current = now;
        lsSet(RESUME_KEY_PREFIX + videoId, String(video.currentTime));
      }
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [videoId]);

  /* ================================================================ */
  /*  EFFECT: Tab visibility — pause when hidden, resume on return    */
  /* ================================================================ */

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onVisChange = () => {
      if (document.hidden) {
        safePause();
      } else {
        if (tapPhaseRef.current === "playing") {
          safePlay();
        } else if (tapPhaseRef.current === "preview") {
          video.muted = true;
          safePlay();
        }
      }
    };

    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, [safePlay, safePause]);

  /* ================================================================ */
  /*  EFFECT: Send analytics on page close                            */
  /* ================================================================ */

  useEffect(() => {
    const onUnload = () => sendAnalytics();
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [sendAnalytics]);

  /* ================================================================ */
  /*  EFFECT: Send analytics on video end                             */
  /* ================================================================ */

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onEnded = () => {
      maxPercentRef.current = 100;
      sendAnalytics();
    };
    video.addEventListener("ended", onEnded);
    return () => video.removeEventListener("ended", onEnded);
  }, [sendAnalytics]);

  /* ================================================================ */
  /*  EFFECT: Lock body scroll in pseudo-fullscreen                   */
  /* ================================================================ */

  useEffect(() => {
    if (!isFullscreen) return;

    const scrollY = window.scrollY;
    const { body } = document;

    // Cache original styles before overwriting
    const origPosition = body.style.position;
    const origTop = body.style.top;
    const origWidth = body.style.width;
    const origOverflow = body.style.overflow;

    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";
    body.style.overflow = "hidden";

    return () => {
      // Restore exact original values
      body.style.position = origPosition;
      body.style.top = origTop;
      body.style.width = origWidth;
      body.style.overflow = origOverflow;
      window.scrollTo(0, scrollY);
    };
  }, [isFullscreen]);

  /* ================================================================ */
  /*  EFFECT: Block touchmove in pseudo-fullscreen (WebView fix)      */
  /* ================================================================ */

  useEffect(() => {
    if (!isFullscreen) return;

    const container = containerRef.current;
    if (!container) return;

    const blockTouch = (e: TouchEvent) => {
      e.preventDefault();
    };

    container.addEventListener("touchmove", blockTouch, { passive: false });
    document.addEventListener("touchmove", blockTouch, { passive: false });

    return () => {
      container.removeEventListener("touchmove", blockTouch);
      document.removeEventListener("touchmove", blockTouch);
    };
  }, [isFullscreen]);

  /* ================================================================ */
  /*  EFFECT: Prevent right-click / context menu                      */
  /* ================================================================ */

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const prevent = (e: Event) => e.preventDefault();
    el.addEventListener("contextmenu", prevent);
    return () => el.removeEventListener("contextmenu", prevent);
  }, []);

  /* ================================================================ */
  /*  EFFECT: Mounted guard                                           */
  /* ================================================================ */

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* ================================================================ */
  /*  Click handler — tap state machine                               */
  /* ================================================================ */

  const handleVideoClick = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    const phase = tapPhaseRef.current;

    switch (phase) {
      case "preview": {
        engage();
        setShowPlayButton(false);
        break;
      }
      case "playing": {
        tapPhaseRef.current = "paused";
        safePause();
        setIsFullscreen(false);
        break;
      }
      case "paused": {
        tapPhaseRef.current = "playing";
        safePlay().then((ok) => {
          if (ok && mountedRef.current && tapPhaseRef.current === "playing") {
            setIsFullscreen(true);
          } else if (!ok && mountedRef.current) {
            tapPhaseRef.current = "paused";
          }
        });
        break;
      }
    }
  }, [engage, safePlay, safePause]);

  /* ================================================================ */
  /*  handleManualPlay — for autoplay-blocked fallback button         */
  /* ================================================================ */

  const handleManualPlay = useCallback(() => {
    setShowPlayButton(false);
    engage();
  }, [engage]);

  /* ================================================================ */
  /*  handleUnmute — for the "Tap to unmute" banner                   */
  /* ================================================================ */

  const handleUnmute = useCallback(() => {
    engage();
  }, [engage]);

  /* ================================================================ */
  /*  togglePlay — for the bottom play/pause button                   */
  /* ================================================================ */

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused || intendedPlayStateRef.current === "paused") {
      tapPhaseRef.current = "playing";
      setIsFullscreen(true);
      safePlay();
    } else {
      tapPhaseRef.current = "paused";
      safePause();
      setIsFullscreen(false);
    }
  }, [safePlay, safePause]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.muted = !video.muted;
      setMuted(video.muted);
    }
  }, []);

  const handleRewind15 = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.currentTime = Math.max(0, video.currentTime - 15);
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  if (nativeHijacked) {
    return (
      <div className="vsl-container">
        {poster && (
          <img
            src={poster}
            alt=""
            className="vsl-video"
            style={{ objectFit: "cover" }}
          />
        )}
        <div className="vsl-tiktok-overlay">
          <div className="vsl-tiktok-card">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5">
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            <p className="vsl-tiktok-title">Open in browser to watch</p>
            <p className="vsl-tiktok-hint">
              Tap <strong>⋯</strong> in the top right corner,<br />
              then select <strong>&ldquo;Open in browser&rdquo;</strong>
            </p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      ref={containerRef}
      onClick={handleVideoClick}
      onMouseMove={handleInteract}
      onTouchStart={handleInteract}
      onMouseLeave={() => setShowControls(false)}
      className={isFullscreen ? "vsl-container vsl-fullscreen" : "vsl-container"}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        preload="metadata"
        poster={poster}
        className="vsl-video"
        style={{ objectFit: isFullscreen ? "contain" : "cover" }}
        onKeyDown={(e) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End", " "].includes(e.key)) {
            e.preventDefault();
          }
        }}
        onMouseDown={(e) => e.preventDefault()}
      />

      {muted && playing && !isFullscreen && (
        <div 
          className="vsl-unmute-overlay control-btn" 
          onClick={(e) => {
            e.stopPropagation();
            handleUnmute();
          }}
        >
          <Volume2 size={48} color="white" strokeWidth={1.5} />
          <div className="vsl-unmute-text">
            <strong>Your Video Is Playing</strong>
            <span>Click To Unmute</span>
          </div>
        </div>
      )}

      <div className={`vsl-controls-container ${showControls || showSettings ? 'visible' : ''}`}>
          <ProgressBar videoRef={videoRef} />

          <div className="vsl-controls-row">
            <div className="vsl-pill">
              <button className="vsl-btn control-btn" onClick={(e) => { e.stopPropagation(); togglePlay(); }}>
                {playing ? <Pause size={18} color="white" fill="white" /> : <Play size={18} color="white" fill="white" />}
              </button>
              <button className="vsl-btn control-btn" style={{ position: "relative" }} onClick={(e) => { e.stopPropagation(); handleRewind15(); }}>
                <RotateCcw size={20} color="white" strokeWidth={2.5} />
                <span style={{ position: "absolute", fontSize: "8px", fontWeight: "bold", color: "white", top: "50%", left: "50%", transform: "translate(-50%, -50%)", marginTop: "1px" }}>15</span>
              </button>
              <button className="vsl-btn control-btn" onClick={(e) => { e.stopPropagation(); toggleMute(); }}>
                {muted ? <VolumeX size={18} color="white" /> : <Volume2 size={18} color="white" />}
              </button>
            </div>

            <div className="vsl-controls-right">
              <div className="vsl-settings-wrapper">
                {showSettings && (
                  <div className="vsl-settings-menu">
                    {settingsView === "main" && (
                      <div style={{ padding: "8px 0" }}>
                        <div className="vsl-settings-item control-btn" onClick={(e) => { e.stopPropagation(); setSettingsView("quality"); }}>
                          <div className="vsl-settings-item-left">
                            <SlidersHorizontal size={16} color="white" />
                            <span>Quality</span>
                          </div>
                          <div className="vsl-settings-item-right">
                            <span>{qualities.length > 0 ? (currentQualityIndex === -1 ? "Auto" : qualities.find(q => q.index === currentQualityIndex)?.name || "Auto") : mockQuality}</span>
                            <ChevronRight size={16} color="white" />
                          </div>
                        </div>
                        <div className="vsl-settings-item control-btn" onClick={(e) => { e.stopPropagation(); setSettingsView("speed"); }}>
                          <div className="vsl-settings-item-left">
                            <FastForward size={16} color="white" fill="white" />
                            <span>Speed</span>
                          </div>
                          <div className="vsl-settings-item-right">
                            <span>{playbackRate === 1 ? "Normal" : `${playbackRate}x`}</span>
                            <ChevronRight size={16} color="white" />
                          </div>
                        </div>
                      </div>
                    )}

                    {settingsView === "speed" && (
                      <>
                        <div className="vsl-settings-header control-btn" onClick={(e) => { e.stopPropagation(); }}>
                          <button className="vsl-settings-back control-btn" onClick={(e) => { e.stopPropagation(); setSettingsView("main"); }}>
                            <ChevronLeft size={18} color="white" />
                          </button>
                          <span className="vsl-settings-title">Speed</span>
                        </div>
                        <div className="vsl-settings-options">
                          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                            <div 
                              key={rate} 
                              className={`vsl-settings-option control-btn ${playbackRate === rate ? 'active' : ''}`}
                              onClick={(e) => { e.stopPropagation(); handleSetSpeed(rate); }}
                            >
                              <span>{rate === 1 ? "Normal" : `${rate}x`}</span>
                              {playbackRate === rate && <Check size={16} color="white" />}
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {settingsView === "quality" && (
                      <>
                        <div className="vsl-settings-header control-btn" onClick={(e) => { e.stopPropagation(); }}>
                          <button className="vsl-settings-back control-btn" onClick={(e) => { e.stopPropagation(); setSettingsView("main"); }}>
                            <ChevronLeft size={18} color="white" />
                          </button>
                          <span className="vsl-settings-title">Quality</span>
                        </div>
                        <div className="vsl-settings-options">
                          <div 
                            className={`vsl-settings-option control-btn ${qualities.length > 0 ? (currentQualityIndex === -1 ? 'active' : '') : (mockQuality === 'Auto' ? 'active' : '')}`}
                            onClick={(e) => { 
                              e.stopPropagation(); 
                              if (qualities.length > 0) handleSetQuality(-1); 
                              else { setMockQuality('Auto'); setSettingsView("main"); setShowSettings(false); }
                            }}
                          >
                            <span>Auto</span>
                            {(qualities.length > 0 ? currentQualityIndex === -1 : mockQuality === 'Auto') && <Check size={16} color="white" />}
                          </div>
                          {qualities.length > 0 ? qualities.map((q) => (
                            <div 
                              key={q.index} 
                              className={`vsl-settings-option control-btn ${currentQualityIndex === q.index ? 'active' : ''}`}
                              onClick={(e) => { e.stopPropagation(); handleSetQuality(q.index); }}
                            >
                              <span>{q.name}</span>
                              {currentQualityIndex === q.index && <Check size={16} color="white" />}
                            </div>
                          )) : (
                            ['1080p', '720p', '360p', '270p'].map((q) => (
                              <div 
                                key={q} 
                                className={`vsl-settings-option control-btn ${mockQuality === q ? 'active' : ''}`}
                                onClick={(e) => { 
                                  e.stopPropagation(); 
                                  setMockQuality(q);
                                  setSettingsView("main"); 
                                  setShowSettings(false); 
                                }}
                              >
                                <span>{q}</span>
                                {mockQuality === q && <Check size={16} color="white" />}
                              </div>
                            ))
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
                <div className="vsl-pill">
                  <button className={`vsl-btn control-btn ${showSettings ? 'active' : ''}`} onClick={(e) => { 
                    e.stopPropagation(); 
                    if (!showSettings) setSettingsView("main");
                    setShowSettings(!showSettings); 
                  }}>
                    <Settings size={18} color="white" />
                  </button>
                  <button className="vsl-btn control-btn" onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}>
                    {isFullscreen ? <Minimize size={18} color="white" /> : <Maximize size={18} color="white" />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
    </div>
  );
});

function ProgressBar({
  videoRef,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const update = () => {
      if (video.duration && Number.isFinite(video.duration)) {
        setProgress((video.currentTime / video.duration) * 100);
      }
    };

    video.addEventListener("timeupdate", update);
    return () => video.removeEventListener("timeupdate", update);
  }, [videoRef]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    video.currentTime = pos * video.duration;
  }, [videoRef]);

  return (
    <div 
      className="vsl-progress-wrapper control-btn" 
      onClick={handleSeek}
    >
      <div className="vsl-progress-track">
        <div
          className="vsl-progress-fill"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

