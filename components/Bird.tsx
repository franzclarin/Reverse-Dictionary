"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type BirdState = "flying" | "alert" | "startled" | "dancing" | "sleeping";

interface Floater {
  id: number;
  content: string;
  color: string;
  x: number;
  y: number;
  duration: number;
}

const playChirp = () => {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1);
    osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.2);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
    setTimeout(() => ctx.close(), 600);
  } catch (_) {}
};

const BIRD_KEYFRAMES = `
  @keyframes bird-jump {
    0%   { transform: translateY(0) rotate(0deg); }
    28%  { transform: translateY(-22px) rotate(-8deg); }
    55%  { transform: translateY(-10px) rotate(6deg); }
    78%  { transform: translateY(-3px) rotate(-2deg); }
    100% { transform: translateY(0) rotate(0deg); }
  }
  @keyframes bird-dance {
    0%   { transform: translateX(0) translateY(0) rotate(0deg); }
    12%  { transform: translateX(-11px) translateY(-11px) rotate(-6deg); }
    24%  { transform: translateX(0) translateY(0) rotate(0deg); }
    36%  { transform: translateX(11px) translateY(-11px) rotate(6deg); }
    48%  { transform: translateX(0) translateY(0) rotate(0deg); }
    60%  { transform: translateX(-11px) translateY(-11px) rotate(-6deg); }
    72%  { transform: translateX(0) translateY(0) rotate(0deg); }
    90%  { transform: rotate(360deg) scale(1.08); }
    100% { transform: rotate(360deg) scale(1); }
  }
  @keyframes wing-flap {
    0%   { transform: rotate(0deg); }
    25%  { transform: rotate(-32deg) translateY(-3px); }
    75%  { transform: rotate(22deg) translateY(3px); }
    100% { transform: rotate(0deg); }
  }
  @keyframes breathe {
    0%, 100% { transform: scaleY(1); }
    50%       { transform: scaleY(1.05); }
  }
  @keyframes floater-up {
    0%   { opacity: 1; transform: translateX(-50%) translateY(0); }
    100% { opacity: 0; transform: translateX(-50%) translateY(-40px); }
  }
  @keyframes tooltip-fade {
    0%   { opacity: 0; transform: translateX(-50%) translateY(3px); }
    14%  { opacity: 1; transform: translateX(-50%) translateY(0); }
    78%  { opacity: 1; }
    100% { opacity: 0; }
  }
  @keyframes zzz-loop {
    0%   { opacity: 0; transform: translateY(0) scale(0.75); }
    18%  { opacity: 1; }
    72%  { opacity: 1; }
    100% { opacity: 0; transform: translateY(-18px) scale(1.05); }
  }
  .bird-wing-flap {
    animation: wing-flap 0.13s ease-in-out infinite;
    transform-origin: 20px 25px;
  }
  .bird-wing-flap-slow {
    animation: wing-flap 0.22s ease-in-out infinite;
    transform-origin: 20px 25px;
  }
  .bird-body-breathe {
    animation: breathe 3.4s ease-in-out infinite;
    transform-origin: 20px 32px;
  }
`;

const getRandomPos = () => {
  const vw = typeof window !== "undefined" ? window.innerWidth : 800;
  const vh = typeof window !== "undefined" ? window.innerHeight : 600;
  return {
    bottom: 40 + Math.random() * Math.min(vh * 0.55, 340),
    right: 20 + Math.random() * Math.min(vw * 0.72, 520),
  };
};

export function Bird() {
  const birdRef = useRef<HTMLDivElement>(null);

  const stateRef = useRef<BirdState>("flying");
  const [birdState, _setBirdState] = useState<BirdState>("flying");

  const [pos, setPos] = useState({ bottom: 48, right: 32 });
  const [flightDuration, setFlightDuration] = useState(1200);

  const [pupilOffset, setPupilOffset] = useState({ x: 0, y: 0 });
  const [isBlinking, setIsBlinking] = useState(false);
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [showZzz, setShowZzz] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);

  const floaterIdRef = useRef(0);
  const isHoveringRef = useRef(false);
  const pendingFlightRef = useRef(false);
  const flightTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const hoverSleepTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const blinkTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const clickTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const clickCountRef = useRef(0);

  const setState = useCallback((s: BirdState) => {
    stateRef.current = s;
    _setBirdState(s);
  }, []);

  const addFloater = useCallback(
    (content: string, color: string, x = 0, y = -14, duration = 1300) => {
      const id = floaterIdRef.current++;
      setFloaters((prev) => [...prev, { id, content, color, x, y, duration }]);
      setTimeout(
        () => setFloaters((prev) => prev.filter((f) => f.id !== id)),
        duration + 50
      );
    },
    []
  );

  /* ---------- blink ---------- */
  const scheduleBlink = useCallback(() => {
    clearTimeout(blinkTimerRef.current);
    blinkTimerRef.current = setTimeout(() => {
      if (stateRef.current !== "sleeping") {
        setIsBlinking(true);
        setTimeout(() => {
          setIsBlinking(false);
          scheduleBlink();
        }, 180);
      } else {
        scheduleBlink();
      }
    }, 3000 + Math.random() * 1200);
  }, []);

  /* ---------- continuous flight loop ---------- */
  const scheduleNextFlight = useCallback(() => {
    clearTimeout(flightTimerRef.current);

    const duration = 800 + Math.random() * 1200; // 0.8–2 s per leg
    const pause = 100 + Math.random() * 400;     // 0.1–0.5 s gap

    flightTimerRef.current = setTimeout(() => {
      const s = stateRef.current;
      if (isHoveringRef.current || s === "startled" || s === "dancing") {
        // Pause flight — will resume from handleMouseLeave or after interaction
        pendingFlightRef.current = true;
        return;
      }
      setFlightDuration(duration);
      setPos(getRandomPos());
      setState("flying");
      scheduleNextFlight();
    }, duration + pause);
  }, [setState]);

  const resumeFlight = useCallback(() => {
    pendingFlightRef.current = false;
    const duration = 800 + Math.random() * 1200;
    const pause = 100 + Math.random() * 300;
    clearTimeout(flightTimerRef.current);
    flightTimerRef.current = setTimeout(() => {
      setFlightDuration(duration);
      setPos(getRandomPos());
      setState("flying");
      scheduleNextFlight();
    }, pause);
  }, [setState, scheduleNextFlight]);

  /* ---------- mount ---------- */
  useEffect(() => {
    scheduleBlink();
    // Kick off first flight after a short delay
    flightTimerRef.current = setTimeout(() => {
      scheduleNextFlight();
    }, 600);
    return () => {
      clearTimeout(blinkTimerRef.current);
      clearTimeout(flightTimerRef.current);
      clearTimeout(hoverSleepTimerRef.current);
      clearTimeout(clickTimerRef.current);
    };
  }, [scheduleBlink, scheduleNextFlight]);

  /* ---------- pupil tracking ---------- */
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const rect = birdRef.current?.getBoundingClientRect();
      if (rect) {
        const dx = e.clientX - (rect.left + rect.width / 2);
        const dy = e.clientY - (rect.top + rect.height / 2);
        const angle = Math.atan2(dy, dx);
        const dist = Math.min(3, Math.hypot(dx, dy) / 50);
        setPupilOffset({ x: Math.cos(angle) * dist, y: Math.sin(angle) * dist });
      }

      if (isHoveringRef.current) {
        clearTimeout(hoverSleepTimerRef.current);
        if (stateRef.current === "sleeping") {
          setShowZzz(false);
          setState("alert");
        }
        hoverSleepTimerRef.current = setTimeout(() => {
          if (isHoveringRef.current && stateRef.current === "alert") {
            setState("sleeping");
            setShowZzz(true);
          }
        }, 3000);
      }
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, [setState]);

  /* ---------- hover — pause/resume flight ---------- */
  const handleMouseEnter = useCallback(() => {
    isHoveringRef.current = true;
    clearTimeout(flightTimerRef.current);
    const s = stateRef.current;
    if (s !== "startled" && s !== "dancing") setState("alert");

    if (!sessionStorage.getItem("bird-seen")) {
      sessionStorage.setItem("bird-seen", "1");
      setShowTooltip(true);
      setTimeout(() => setShowTooltip(false), 2400);
    }

    clearTimeout(hoverSleepTimerRef.current);
    hoverSleepTimerRef.current = setTimeout(() => {
      if (isHoveringRef.current && stateRef.current === "alert") {
        setState("sleeping");
        setShowZzz(true);
      }
    }, 3000);
  }, [setState]);

  const handleMouseLeave = useCallback(() => {
    isHoveringRef.current = false;
    clearTimeout(hoverSleepTimerRef.current);
    setShowZzz(false);
    setPupilOffset({ x: 0, y: 0 });
    // Resume flying
    resumeFlight();
  }, [resumeFlight]);

  /* ---------- clicks ---------- */
  const doClick = useCallback(() => {
    if (stateRef.current === "dancing") return;
    setState("startled");
    playChirp();
    addFloater("♥", "#e05252", 0, -12, 1200);
    setTimeout(() => {
      setState(isHoveringRef.current ? "alert" : "flying");
      if (!isHoveringRef.current) resumeFlight();
    }, 560);
  }, [setState, addFloater, resumeFlight]);

  const doDoubleClick = useCallback(() => {
    setState("dancing");
    playChirp();
    addFloater("!!", "var(--accent-gold)", 0, -26, 1800);
    const xPositions = [-28, -18, -8, 2, 12, 22, -22, -12, 2, 16];
    xPositions.forEach((x, i) => {
      setTimeout(() => {
        addFloater("◈", "var(--accent-gold)", x, -6 - Math.abs(x) * 0.3, 1600);
      }, i * 55);
    });
    setTimeout(() => {
      setState(isHoveringRef.current ? "alert" : "flying");
      if (!isHoveringRef.current) resumeFlight();
    }, 2200);
  }, [setState, addFloater, resumeFlight]);

  const handleClick = useCallback(() => {
    clickCountRef.current += 1;
    clearTimeout(clickTimerRef.current);
    if (clickCountRef.current >= 2) {
      clickCountRef.current = 0;
      doDoubleClick();
    } else {
      clickTimerRef.current = setTimeout(() => {
        if (clickCountRef.current === 1) doClick();
        clickCountRef.current = 0;
      }, 260);
    }
  }, [doClick, doDoubleClick]);

  const isPerched = birdState === "alert" || birdState === "sleeping";
  const containerAnimation = (() => {
    if (birdState === "startled") return "bird-jump 0.56s cubic-bezier(.36,.07,.19,.97) both";
    if (birdState === "dancing") return "bird-dance 2s ease both";
    return undefined;
  })();

  return (
    <>
      <style>{BIRD_KEYFRAMES}</style>

      <div
        ref={birdRef}
        style={{
          position: "fixed",
          bottom: `${pos.bottom}px`,
          right: `${pos.right}px`,
          zIndex: 100,
          cursor: "pointer",
          userSelect: "none",
          transition: isPerched || birdState === "startled" || birdState === "dancing"
            ? "transform 0.2s ease"
            : `bottom ${flightDuration}ms cubic-bezier(0.45, 0.05, 0.55, 0.95), right ${flightDuration}ms cubic-bezier(0.45, 0.05, 0.55, 0.95)`,
          transform: isPerched ? "translateY(-5px) scale(1.06)" : undefined,
          animation: containerAnimation,
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      >
        {showTooltip && (
          <div
            style={{
              position: "absolute",
              top: "-34px",
              left: "50%",
              fontFamily: "'DM Mono', monospace",
              fontSize: "11px",
              color: "var(--text-secondary)",
              whiteSpace: "nowrap",
              animation: "tooltip-fade 2.4s ease forwards",
              pointerEvents: "none",
            }}
          >
            click me ♪
          </div>
        )}

        {showZzz && (
          <div
            style={{
              position: "absolute",
              top: "-20px",
              left: "66%",
              fontFamily: "'DM Mono', monospace",
              fontSize: "11px",
              color: "var(--text-secondary)",
              animation: "zzz-loop 1.9s ease-in-out infinite",
              pointerEvents: "none",
            }}
          >
            z z z
          </div>
        )}

        {floaters.map((f) => (
          <div
            key={f.id}
            style={{
              position: "absolute",
              top: `${f.y}px`,
              left: `calc(50% + ${f.x}px)`,
              color: f.color,
              fontSize: "13px",
              fontFamily: "'DM Mono', monospace",
              lineHeight: 1,
              animation: `floater-up ${f.duration}ms ease forwards`,
              pointerEvents: "none",
              zIndex: 10,
            }}
          >
            {f.content}
          </div>
        ))}

        <div style={{ position: "relative" }}>
          <svg
            viewBox="0 0 40 40"
            width="54"
            height="54"
            style={{
              filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.55))",
              overflow: "visible",
              display: "block",
            }}
          >
            <ellipse
              cx="13"
              cy="26"
              rx="7.5"
              ry="4.5"
              fill="var(--border)"
              className={isPerched ? "bird-wing-flap-slow" : "bird-wing-flap"}
            />

            <ellipse
              cx="20"
              cy="26"
              rx="11"
              ry="9"
              fill="var(--surface-2)"
              className="bird-body-breathe"
            />

            <polygon points="10,30 6,37 15,32" fill="var(--surface-2)" />

            <g
              style={{
                transformOrigin: "20px 18px",
                transition: "transform 0.3s ease",
              }}
            >
              <circle cx="21" cy="14" r="7.5" fill="var(--surface-2)" />

              <polygon points="28,12.5 35,15 28,17.5" fill="var(--accent-gold)" />

              <circle cx="24" cy="12" r="2.4" fill="var(--text-primary)" />

              {isBlinking && (
                <ellipse cx="24" cy="12" rx="2.4" ry="2.4" fill="var(--surface-2)" />
              )}

              {birdState === "sleeping" && !isBlinking && (
                <rect x="21.6" y="9.6" width="4.8" height="2.6" rx="1.2" fill="var(--surface-2)" />
              )}

              {birdState !== "sleeping" && !isBlinking && (
                <>
                  <circle
                    cx={24 + pupilOffset.x}
                    cy={12 + pupilOffset.y}
                    r="1.15"
                    fill="#080808"
                  />
                  <circle
                    cx={23.4 + pupilOffset.x}
                    cy={11.4 + pupilOffset.y}
                    r="0.42"
                    fill="rgba(240,235,224,0.82)"
                  />
                </>
              )}
            </g>

            <line x1="16" y1="34" x2="13" y2="38" stroke="var(--accent-gold)" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="16" y1="35" x2="11" y2="36.5" stroke="var(--accent-gold)" strokeWidth="1.2" strokeLinecap="round" />
            <line x1="23" y1="34" x2="26" y2="38" stroke="var(--accent-gold)" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="23" y1="35" x2="28" y2="36.5" stroke="var(--accent-gold)" strokeWidth="1.2" strokeLinecap="round" />
          </svg>

          {/* Branch — only shown when perched */}
          {isPerched && (
            <svg
              viewBox="0 0 80 12"
              width="82"
              height="12"
              style={{
                position: "absolute",
                bottom: "-6px",
                left: "50%",
                transform: "translateX(-50%)",
                pointerEvents: "none",
                overflow: "visible",
              }}
            >
              <path d="M0,6 Q40,2 80,6" stroke="#3a2e1e" strokeWidth="4" fill="none" strokeLinecap="round" />
              <path d="M0,6 Q40,2 80,6" stroke="#4a3a28" strokeWidth="2" fill="none" strokeLinecap="round" />
            </svg>
          )}
        </div>
      </div>
    </>
  );
}
