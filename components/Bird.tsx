"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type BirdState =
  | "idle"
  | "alert"
  | "startled"
  | "dancing"
  | "sleeping"
  | "flying-out"
  | "flying-in";

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
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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
  } catch (_) {
    // Web Audio not supported — silent fail
  }
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
  @keyframes bird-fly-out {
    0%   { transform: translateX(0) translateY(0); opacity: 1; }
    100% { transform: translateX(280px) translateY(-40px); opacity: 0; }
  }
  @keyframes bird-fly-in {
    0%   { transform: translateX(-130vw) translateY(-20px); opacity: 0; }
    80%  { transform: translateX(6px) translateY(0); opacity: 1; }
    90%  { transform: translateX(-4px) translateY(0); }
    100% { transform: translateX(0) translateY(0); opacity: 1; }
  }
  @keyframes bird-perk {
    0%   { transform: translateY(0) scale(1); }
    100% { transform: translateY(-5px) scale(1.06); }
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
  .bird-body-breathe {
    animation: breathe 3.4s ease-in-out infinite;
    transform-origin: 20px 32px;
  }
`;

export function Bird() {
  const birdRef = useRef<HTMLDivElement>(null);

  /* ---------- state ---------- */
  const stateRef = useRef<BirdState>("idle");
  const [birdState, _setBirdState] = useState<BirdState>("idle");

  const [pupilOffset, setPupilOffset] = useState({ x: 0, y: 0 });
  const [isBlinking, setIsBlinking] = useState(false);
  const [headTilt, setHeadTilt] = useState(0);
  const [isWingFlapping, setIsWingFlapping] = useState(false);
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [showZzz, setShowZzz] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);

  /* ---------- refs ---------- */
  const floaterIdRef = useRef(0);
  const isHoveringRef = useRef(false);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const hoverSleepTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const idleBehaviorTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const blinkTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const clickTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const clickCountRef = useRef(0);

  /* ---------- helpers ---------- */
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

  /* ---------- blink scheduler ---------- */
  const scheduleBlink = useCallback(() => {
    clearTimeout(blinkTimerRef.current);
    blinkTimerRef.current = setTimeout(
      () => {
        if (stateRef.current !== "sleeping") {
          setIsBlinking(true);
          setTimeout(() => {
            setIsBlinking(false);
            scheduleBlink();
          }, 180);
        } else {
          scheduleBlink();
        }
      },
      3000 + Math.random() * 1200
    );
  }, []);

  /* ---------- idle behaviour scheduler ---------- */
  const scheduleIdleBehavior = useCallback(() => {
    clearTimeout(idleBehaviorTimerRef.current);
    idleBehaviorTimerRef.current = setTimeout(
      () => {
        const s = stateRef.current;
        if (s === "idle" || s === "alert") {
          const pick = Math.floor(Math.random() * 4);
          if (pick === 0) {
            // Ruffle — quick head jitter
            setHeadTilt(9);
            setTimeout(() => setHeadTilt(-9), 80);
            setTimeout(() => setHeadTilt(5), 160);
            setTimeout(() => setHeadTilt(0), 240);
          } else if (pick === 1) {
            // Look left then right
            setHeadTilt(-14);
            setTimeout(() => setHeadTilt(14), 550);
            setTimeout(() => setHeadTilt(0), 1100);
          } else if (pick === 2) {
            // Preen — head dips
            setHeadTilt(22);
            setTimeout(() => setHeadTilt(0), 750);
          } else {
            // Chirp with floating note
            playChirp();
            addFloater("♪", "var(--accent-gold)", 14, -14, 1400);
          }
        }
        scheduleIdleBehavior();
      },
      15000 + Math.random() * 5000
    );
  }, [addFloater]);

  /* ---------- 60 s inactivity fly-away ---------- */
  const resetInactivityTimer = useCallback(() => {
    clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = setTimeout(() => {
      const s = stateRef.current;
      if (s === "idle" || s === "sleeping" || s === "alert") {
        setShowZzz(false);
        setState("flying-out");
        setIsWingFlapping(true);
        // After fly-out anim (1 s), wait 10 s then fly back
        setTimeout(() => {
          setTimeout(() => {
            setState("flying-in");
            setTimeout(() => {
              setIsWingFlapping(false);
              setState("idle");
              resetInactivityTimer();
            }, 950);
          }, 10000);
        }, 1000);
      }
    }, 60000);
  }, [setState]);

  /* ---------- mount ---------- */
  useEffect(() => {
    scheduleBlink();
    scheduleIdleBehavior();
    resetInactivityTimer();
    return () => {
      clearTimeout(blinkTimerRef.current);
      clearTimeout(idleBehaviorTimerRef.current);
      clearTimeout(inactivityTimerRef.current);
      clearTimeout(hoverSleepTimerRef.current);
      clearTimeout(clickTimerRef.current);
    };
  }, [scheduleBlink, scheduleIdleBehavior, resetInactivityTimer]);

  /* ---------- global mouse tracking (pupil + sleep reset) ---------- */
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      // Pupil tracking — always
      const rect = birdRef.current?.getBoundingClientRect();
      if (rect) {
        const dx = e.clientX - (rect.left + rect.width / 2);
        const dy = e.clientY - (rect.top + rect.height / 2);
        const angle = Math.atan2(dy, dx);
        const dist = Math.min(3, Math.hypot(dx, dy) / 50);
        setPupilOffset({
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist,
        });
      }

      // While hovering: reset the 3 s sleep timer on every move
      if (isHoveringRef.current) {
        clearTimeout(hoverSleepTimerRef.current);

        // Wake up if sleeping
        if (stateRef.current === "sleeping") {
          setShowZzz(false);
          setState("alert");
        }

        // Restart sleep countdown
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

  /* ---------- hover ---------- */
  const handleMouseEnter = useCallback(() => {
    isHoveringRef.current = true;
    const s = stateRef.current;
    if (
      s === "flying-out" ||
      s === "flying-in" ||
      s === "startled" ||
      s === "dancing"
    )
      return;

    setState("alert");
    resetInactivityTimer();

    // First-ever hover tooltip
    if (!sessionStorage.getItem("bird-seen")) {
      sessionStorage.setItem("bird-seen", "1");
      setShowTooltip(true);
      setTimeout(() => setShowTooltip(false), 2400);
    }

    // Start 3 s sleep timer
    clearTimeout(hoverSleepTimerRef.current);
    hoverSleepTimerRef.current = setTimeout(() => {
      if (isHoveringRef.current && stateRef.current === "alert") {
        setState("sleeping");
        setShowZzz(true);
      }
    }, 3000);
  }, [setState, resetInactivityTimer]);

  const handleMouseLeave = useCallback(() => {
    isHoveringRef.current = false;
    clearTimeout(hoverSleepTimerRef.current);

    const s = stateRef.current;
    if (s === "sleeping") {
      setShowZzz(false);
      setState("idle");
    } else if (s === "alert") {
      setState("idle");
    }

    setPupilOffset({ x: 0, y: 0 });
  }, [setState]);

  /* ---------- click interactions ---------- */
  const doClick = useCallback(() => {
    const s = stateRef.current;
    if (s === "dancing" || s === "flying-out" || s === "flying-in") return;
    resetInactivityTimer();
    setState("startled");
    setIsWingFlapping(true);
    playChirp();
    addFloater("♥", "#e05252", 0, -12, 1200);
    setTimeout(() => {
      setIsWingFlapping(false);
      setState(isHoveringRef.current ? "alert" : "idle");
    }, 560);
  }, [setState, resetInactivityTimer, addFloater]);

  const doDoubleClick = useCallback(() => {
    const s = stateRef.current;
    if (s === "flying-out" || s === "flying-in") return;
    resetInactivityTimer();
    setState("dancing");
    setIsWingFlapping(true);
    playChirp();

    addFloater("!!", "var(--accent-gold)", 0, -26, 1800);

    // Confetti burst — staggered ◈ in a fan
    const xPositions = [-28, -18, -8, 2, 12, 22, -22, -12, 2, 16];
    xPositions.forEach((x, i) => {
      setTimeout(() => {
        addFloater("◈", "var(--accent-gold)", x, -6 - Math.abs(x) * 0.3, 1600);
      }, i * 55);
    });

    setTimeout(() => {
      setIsWingFlapping(false);
      setState(isHoveringRef.current ? "alert" : "idle");
    }, 2200);
  }, [setState, resetInactivityTimer, addFloater]);

  // Distinguish single vs double click
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

  /* ---------- derived animation / transform ---------- */
  const containerAnimation = (() => {
    if (birdState === "startled") return "bird-jump 0.56s cubic-bezier(.36,.07,.19,.97) both";
    if (birdState === "dancing") return "bird-dance 2s ease both";
    if (birdState === "flying-out") return "bird-fly-out 1s ease forwards";
    if (birdState === "flying-in") return "bird-fly-in 0.95s ease forwards";
    return undefined;
  })();

  const containerTransform =
    birdState === "alert" ? "translateY(-5px) scale(1.06)" : undefined;

  const isFlying = birdState === "flying-out" || birdState === "flying-in";

  /* ---------- render ---------- */
  return (
    <>
      <style>{BIRD_KEYFRAMES}</style>

      <div
        ref={birdRef}
        style={{
          position: "fixed",
          bottom: "48px",
          right: "32px",
          zIndex: 100,
          cursor: isFlying ? "default" : "pointer",
          userSelect: "none",
          pointerEvents: isFlying ? "none" : "auto",
          transition:
            birdState === "alert" ? "transform 0.2s ease" : "transform 0.3s ease",
          transform: containerTransform,
          animation: containerAnimation,
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      >
        {/* First-hover tooltip */}
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

        {/* Zzz */}
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

        {/* Floaters: hearts, notes, !!, confetti */}
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

        {/* Bird + Branch wrapper */}
        <div style={{ position: "relative" }}>
          {/* SVG */}
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
            {/* Wing — behind body */}
            <ellipse
              cx="13"
              cy="26"
              rx="7.5"
              ry="4.5"
              fill="var(--border)"
              className={isWingFlapping ? "bird-wing-flap" : undefined}
            />

            {/* Body */}
            <ellipse
              cx="20"
              cy="26"
              rx="11"
              ry="9"
              fill="var(--surface-2)"
              className="bird-body-breathe"
            />

            {/* Tail */}
            <polygon points="10,30 6,37 15,32" fill="var(--surface-2)" />

            {/* Head group — head tilt applied here */}
            <g
              style={{
                transform: `rotate(${headTilt}deg)`,
                transformOrigin: "20px 18px",
                transition: "transform 0.42s ease",
              }}
            >
              <circle cx="21" cy="14" r="7.5" fill="var(--surface-2)" />

              {/* Beak */}
              <polygon
                points="28,12.5 35,15 28,17.5"
                fill="var(--accent-gold)"
              />

              {/* Eye white */}
              <circle cx="24" cy="12" r="2.4" fill="var(--text-primary)" />

              {/* Blink eyelid */}
              {isBlinking && (
                <ellipse
                  cx="24"
                  cy="12"
                  rx="2.4"
                  ry="2.4"
                  fill="var(--surface-2)"
                />
              )}

              {/* Half-closed eye when sleeping */}
              {birdState === "sleeping" && !isBlinking && (
                <rect
                  x="21.6"
                  y="9.6"
                  width="4.8"
                  height="2.6"
                  rx="1.2"
                  fill="var(--surface-2)"
                />
              )}

              {/* Pupil + shine */}
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

            {/* Feet */}
            <line
              x1="16"
              y1="34"
              x2="13"
              y2="38"
              stroke="var(--accent-gold)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <line
              x1="16"
              y1="35"
              x2="11"
              y2="36.5"
              stroke="var(--accent-gold)"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
            <line
              x1="23"
              y1="34"
              x2="26"
              y2="38"
              stroke="var(--accent-gold)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <line
              x1="23"
              y1="35"
              x2="28"
              y2="36.5"
              stroke="var(--accent-gold)"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>

          {/* Branch */}
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
            <path
              d="M0,6 Q40,2 80,6"
              stroke="#3a2e1e"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
            />
            <path
              d="M0,6 Q40,2 80,6"
              stroke="#4a3a28"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </div>
    </>
  );
}
