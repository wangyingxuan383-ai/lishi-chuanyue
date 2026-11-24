import { useEffect, useRef, useState } from "react";
import { motionLevel } from "../app/motion";
import "./bootSplash.css";

let launchPlayed = false;

const PARTING_DURATION_MS = 740;

/**
 * Unified single-stage classical dual-scroll parting & cinnabar-seal launch ritual (R36 R3-A):
 * - `ready === false`: `holding` — two Xuan-paper / pine-smoke scroll curtains meet seamlessly
 *   at the center seam flanked by Song brocade silk trims (`.boot-silk-trim`) and Zitan-rosewood
 *   scroll rods with gilded bronze finials (`.boot-scroll-rod`), while the homologous cinnabar
 *   seal and brushed-gold astrolabe arc breathe gently.
 * - `ready === true`: `parting` (740ms) — 0–180ms seal executes a poised stone-stamp micro-pause
 *   (`1.05 -> 0.97 -> 1.0`) & dual golden-ink halos bloom; 180–740ms left/right scroll curtains,
 *   silk trims & gilded rods unroll off-screen (`-104%` / `104%`) along a heavy-scroll inertia
 *   curve while the central seal & arc stay at `opacity: 1` through 340ms (46%) before dispersing.
 * - Tapping/clicking skips in 0ms (`skipRequestedRef` remembers early taps during `holding`).
 * - `motionLevel() === "off"`: silent pure-ground cover while `!ready`; instant `null` once `ready`.
 */
export function BootSplash({ ready = true }: { ready?: boolean }) {
  const [dismissed, setDismissed] = useState(() => launchPlayed);
  const skipRequestedRef = useRef(false);
  const off = motionLevel() === "off";

  useEffect(() => {
    if (dismissed) return;
    if (ready && (off || skipRequestedRef.current)) {
      launchPlayed = true;
      setDismissed(true);
      return;
    }
    if (!ready) return;

    const timer = window.setTimeout(() => {
      launchPlayed = true;
      setDismissed(true);
    }, PARTING_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [ready, off, dismissed]);

  if (dismissed || launchPlayed) return null;

  // When motion is off or the user already tapped during `holding`, unmount in 0ms once ready.
  if (ready && (off || skipRequestedRef.current)) {
    return null;
  }

  // Motion off while database is still booting: render zero-animation pure-ground silent cover.
  if (off) {
    return (
      <div
        className="boot-splash boot-splash-silent"
        data-stage="holding"
        data-boot-stage="holding"
        aria-hidden="true"
      />
    );
  }

  const stage = ready ? "parting" : "holding";

  const handleInteract = () => {
    if (!ready) {
      skipRequestedRef.current = true;
      return;
    }
    launchPlayed = true;
    setDismissed(true);
  };

  return (
    <div
      className="boot-splash"
      data-stage={stage}
      data-boot-stage={stage}
      aria-hidden="true"
      onPointerDown={handleInteract}
      onClick={handleInteract}
    >
      <div className="boot-splash-half left">
        <span className="boot-silk-trim" />
        <span className="boot-scroll-rod" />
      </div>
      <div className="boot-splash-half right">
        <span className="boot-scroll-rod" />
        <span className="boot-silk-trim" />
      </div>

      <div className="boot-splash-center">
        <span className="boot-splash-halo outer" />
        <span className="boot-splash-halo inner" />

        <svg className="boot-splash-arc" viewBox="0 0 148 148" fill="none" focusable="false">
          <defs>
            <linearGradient id="bootArcGold" x1="112" y1="30" x2="32" y2="112" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="var(--boot-arc-hi)" />
              <stop offset="48%" stopColor="var(--boot-arc-mid)" />
              <stop offset="100%" stopColor="var(--boot-arc-lo)" />
            </linearGradient>
          </defs>
          <circle
            cx="74"
            cy="74"
            r="61"
            stroke="currentColor"
            strokeOpacity="0.24"
            strokeWidth="1"
            strokeDasharray="10 5 3 5"
          />
          <path
            d="M74 9v4M74 135v4M9 74h4M135 74h4"
            stroke="currentColor"
            strokeOpacity="0.34"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          <g transform="rotate(-24 74 74)">
            <path
              d="M 21.4 65.7 A 54.5 47.4 0 1 1 26.3 96.9 A 51.0 44.0 0 1 0 21.4 65.7 Z"
              fill="url(#bootArcGold)"
            />
            <path
              d="M 76.6 29.8 A 51.0 44.0 0 0 1 125.0 75.5 A 51.0 44.0 0 0 1 69.2 117.8"
              stroke="var(--boot-arc-hi)"
              strokeWidth="0.9"
              strokeLinecap="round"
              strokeOpacity="0.65"
            />
          </g>
          <path
            d="M119.5 41.2 Q119.9 44.7 123.4 45.1 Q119.9 45.5 119.5 49.0 Q119.1 45.5 115.6 45.1 Q119.1 44.7 119.5 41.2 Z"
            fill="var(--boot-arc-hi)"
          />
          <path
            d="M36.8 106.4 Q37.1 109.0 39.7 109.3 Q37.1 109.6 36.8 112.2 Q36.5 109.6 33.9 109.3 Q36.5 109.0 36.8 106.4 Z"
            fill="var(--boot-arc-mid)"
            fillOpacity="0.82"
          />
        </svg>

        <span className="boot-splash-seal">
          <svg width="148" height="148" viewBox="0 0 148 148" fill="none" focusable="false">
            <defs>
              <linearGradient id="bootSealFace" x1="16%" y1="10%" x2="86%" y2="92%">
                <stop offset="0%" stopColor="#e24f37" />
                <stop offset="48%" stopColor="#b52b1d" />
                <stop offset="100%" stopColor="#8c1b12" />
              </linearGradient>
            </defs>
            <rect x="42" y="44" width="64" height="64" rx="12.5" fill="#6b140c" fillOpacity="0.86" />
            <rect x="42" y="42" width="64" height="64" rx="12.5" fill="url(#bootSealFace)" />
            <rect
              x="46.2"
              y="46.2"
              width="55.6"
              height="55.6"
              rx="9.2"
              stroke="#f8e8c6"
              strokeOpacity="0.92"
              strokeWidth="1.55"
            />
            <rect
              x="49.2"
              y="49.2"
              width="49.6"
              height="49.6"
              rx="7.2"
              stroke="#fbf1de"
              strokeOpacity="0.56"
              strokeWidth="0.65"
            />
            <path
              d="M49.4 74h4.2M94.4 74h4.2"
              stroke="#fbf1de"
              strokeOpacity="0.45"
              strokeWidth="0.75"
              strokeLinecap="round"
            />
            <text
              x="74"
              y="68.5"
              textAnchor="middle"
              fill="#fbf2df"
              fontFamily="var(--serif)"
              fontSize="22.5"
              fontWeight="700"
            >
              穿
            </text>
            <text
              x="74"
              y="92.5"
              textAnchor="middle"
              fill="#fbf2df"
              fontFamily="var(--serif)"
              fontSize="22.5"
              fontWeight="700"
            >
              越
            </text>
          </svg>
        </span>
      </div>
    </div>
  );
}
