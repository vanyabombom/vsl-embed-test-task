"use client";

import { useRef, useEffect, useState, useCallback, memo } from "react";
import Hls from "hls.js";

interface VslPlayerProps {
  src: string;
  videoId: string;
  analyticsUrl?: string;
  poster?: string;
}

const RESUME_KEY_PREFIX = "vsl_resume_";

export const VslPlayer = memo(function VslPlayer({
  src,
  videoId,
  analyticsUrl,
  poster,
}: VslPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const maxPercentRef = useRef(0);
  const sentRef = useRef(false);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [showPlayButton, setShowPlayButton] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Track whether user has engaged (clicked to go fullscreen at least once)
  const userEngagedRef = useRef(false);

  // Send watch analytics
  const sendAnalytics = useCallback(() => {
    if (sentRef.current || !analyticsUrl || maxPercentRef.current === 0) return;
    sentRef.current = true;
    const video = videoRef.current;
    const payload = {
      video_id: videoId,
      percent_watched: Math.round(maxPercentRef.current),
      duration: video ? Math.round(video.duration) : 0,
    };
    // Use sendBeacon for reliability on page close
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        `${analyticsUrl}/api/view`,
        new Blob([JSON.stringify(payload)], { type: "application/json" })
      );
    } else {
      fetch(`${analyticsUrl}/api/view`, {
        method: "POST",
        body: JSON.stringify(payload),
        keepalive: true,
        headers: { "Content-Type": "application/json" },
      }).catch(() => {});
    }
  }, [analyticsUrl, videoId]);

  // Initialize HLS or native playback
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (src.includes(".m3u8") && Hls.isSupported()) {
      const hls = new Hls({ startLevel: -1 });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      // Safari has native HLS support, or it's a direct mp4
      video.src = src;
    }

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [src]);

  // Attempt autoplay (muted) + restore resume position
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const tryAutoplay = () => {
      // Restore resume position
      try {
        const saved = localStorage.getItem(RESUME_KEY_PREFIX + videoId);
        if (saved) {
          const pos = parseFloat(saved);
          if (pos > 0 && pos < video.duration - 2) {
            video.currentTime = pos;
          }
        }
      } catch {}

      video.muted = true;
      video.play().then(() => {
        setPlaying(true);
        setMuted(true);
      }).catch(() => {
        // Autoplay blocked — show play button
        setShowPlayButton(true);
      });
    };

    if (video.readyState >= 1) {
      tryAutoplay();
    } else {
      video.addEventListener("loadedmetadata", tryAutoplay, { once: true });
    }
  }, [videoId]);

  // Track max percent watched + save resume position
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => {
      if (!video.duration) return;
      const pct = (video.currentTime / video.duration) * 100;
      if (pct > maxPercentRef.current) {
        maxPercentRef.current = pct;
      }
      // Save resume position every ~5 seconds
      try {
        localStorage.setItem(
          RESUME_KEY_PREFIX + videoId,
          String(video.currentTime)
        );
      } catch {}
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [videoId]);

  // Tab visibility — pause when hidden
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onVisChange = () => {
      if (document.hidden) {
        video.pause();
        setPlaying(false);
      } else if (!showPlayButton) {
        video.play().then(() => setPlaying(true)).catch(() => {});
      }
    };

    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, [showPlayButton]);

  // Send analytics on page close
  useEffect(() => {
    const onUnload = () => sendAnalytics();
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [sendAnalytics]);

  // Also send on video end
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

  // Lock body scroll when in pseudo-fullscreen
  useEffect(() => {
    if (isFullscreen) {
      const scrollY = window.scrollY;
      document.body.style.position = "fixed";
      document.body.style.top = `-${scrollY}px`;
      document.body.style.width = "100%";
      document.body.style.overflow = "hidden";
      return () => {
        const y = document.body.style.top;
        document.body.style.position = "";
        document.body.style.top = "";
        document.body.style.width = "";
        document.body.style.overflow = "";
        window.scrollTo(0, parseInt(y || "0") * -1);
      };
    }
  }, [isFullscreen]);

  // Prevent right-click
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const prevent = (e: Event) => e.preventDefault();
    el.addEventListener("contextmenu", prevent);
    return () => el.removeEventListener("contextmenu", prevent);
  }, []);

  // Enter pseudo-fullscreen — CSS-based, keeps custom UI visible.
  // No native iOS player, no Apple scrubbing controls.
  const enterFullscreen = useCallback(() => {
    setIsFullscreen(true);
  }, []);

  // Exit pseudo-fullscreen
  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false);
  }, []);

  // Click on video area: unmute + fullscreen + play, or pause + exit fullscreen
  const handleVideoClick = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused || showPlayButton || !userEngagedRef.current) {
      // First engagement: restart from beginning so user doesn't miss anything
      if (!userEngagedRef.current) {
        video.currentTime = 0;
      }
      userEngagedRef.current = true;
      video.muted = false;
      setMuted(false);
      video.play().then(() => {
        setPlaying(true);
        setShowPlayButton(false);
        enterFullscreen();
      }).catch(() => {});
    } else {
      // Pause + exit fullscreen
      video.pause();
      setPlaying(false);
      exitFullscreen();
    }
  }, [showPlayButton, enterFullscreen, exitFullscreen]);

  const handleUnmute = () => {
    const video = videoRef.current;
    if (!video) return;
    // First engagement: restart from beginning
    if (!userEngagedRef.current) {
      video.currentTime = 0;
    }
    userEngagedRef.current = true;
    video.muted = false;
    setMuted(false);
    enterFullscreen();
  };

  const handleManualPlay = () => {
    const video = videoRef.current;
    if (!video) return;
    // First engagement: restart from beginning
    if (!userEngagedRef.current) {
      video.currentTime = 0;
    }
    userEngagedRef.current = true;
    video.muted = false;
    setMuted(false);
    video.play().then(() => {
      setPlaying(true);
      setShowPlayButton(false);
      enterFullscreen();
    }).catch(() => {});
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      userEngagedRef.current = true;
      video.play().then(() => {
        setPlaying(true);
        enterFullscreen();
      }).catch(() => {});
    } else {
      video.pause();
      setPlaying(false);
      exitFullscreen();
    }
  };

  return (
    <div
      ref={containerRef}
      onClick={handleVideoClick}
      style={
        isFullscreen
          ? {
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              width: "100vw",
              height: "100dvh",
              background: "#000",
              zIndex: 999999,
              cursor: "pointer",
              overflow: "hidden",
            }
          : {
              position: "relative",
              width: "100%",
              paddingTop: "177.78%",
              background: "#000",
              borderRadius: 8,
              overflow: "hidden",
              cursor: "pointer",
            }
      }
    >
      <video
        ref={videoRef}
        playsInline
        webkit-playsinline="true"
        x5-playsinline="true"
        preload="metadata"
        poster={poster}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          objectFit: isFullscreen ? "contain" : "cover",
        }}
        // Prevent seeking via keyboard
        onKeyDown={(e) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
            e.preventDefault();
          }
        }}
      />

      {/* Autoplay blocked — big play button */}
      {showPlayButton && (
        <button
          onClick={(e) => { e.stopPropagation(); handleManualPlay(); }}
          aria-label="Play video"
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: 72,
            height: 72,
            borderRadius: "50%",
            background: "rgba(0,0,0,0.6)",
            border: "2px solid rgba(255,255,255,0.8)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10,
          }}
        >
          <svg width="28" height="32" viewBox="0 0 28 32" fill="none">
            <path d="M4 2L26 16L4 30V2Z" fill="white" />
          </svg>
        </button>
      )}

      {/* Unmute banner */}
      {muted && playing && (
        <button
          onClick={(e) => { e.stopPropagation(); handleUnmute(); }}
          style={{
            position: "absolute",
            top: 16,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(0,0,0,0.7)",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.3)",
            borderRadius: 8,
            padding: "10px 20px",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 8,
            zIndex: 10,
            backdropFilter: "blur(4px)",
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
            <path d="M11 5L6 9H2v6h4l5 4V5z" />
            <line x1="23" y1="9" x2="17" y2="15" />
            <line x1="17" y1="9" x2="23" y2="15" />
          </svg>
          Tap to unmute
        </button>
      )}

      {/* Bottom controls — play/pause only, no seek bar */}
      {playing && !showPlayButton && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            padding: "16px",
            background: "linear-gradient(transparent, rgba(0,0,0,0.5))",
            display: "flex",
            alignItems: "center",
            gap: 12,
            zIndex: 10,
          }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); togglePlay(); }}
            aria-label={playing ? "Pause" : "Play"}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 4,
            }}
          >
            {playing ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          {/* Fake progress bar — shows progress but no interaction */}
          <ProgressBar videoRef={videoRef} />
        </div>
      )}
    </div>
  );
});

// Non-interactive progress bar
function ProgressBar({ videoRef }: { videoRef: React.RefObject<HTMLVideoElement | null> }) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const update = () => {
      if (video.duration) {
        setProgress((video.currentTime / video.duration) * 100);
      }
    };

    video.addEventListener("timeupdate", update);
    return () => video.removeEventListener("timeupdate", update);
  }, [videoRef]);

  return (
    <div
      style={{
        flex: 1,
        height: 4,
        background: "rgba(255,255,255,0.3)",
        borderRadius: 2,
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${progress}%`,
          background: "#fff",
          borderRadius: 2,
          transition: "width 0.3s linear",
        }}
      />
    </div>
  );
}
