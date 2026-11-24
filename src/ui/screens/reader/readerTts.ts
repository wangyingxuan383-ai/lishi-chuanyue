// Offline dual-engine TTS audiobook controller for ReaderScreen (R36-T005).
// Supports:
// 1. Native Android TextToSpeech via `platform.system.ttsSpeak` / `ttsStop` + `lishi:tts-event`
// 2. Web / Desktop `window.speechSynthesis` (`SpeechSynthesisUtterance`, `zh-CN`)
// Gracefully detects headless / missing TTS engines without crashing or hanging.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Platform } from "../../../platform";

export type TtsRate = 0.75 | 1.0 | 1.25 | 1.5 | 2.0;
export type TtsSleepMode = 0 | 15 | 30 | 60 | "chapter";
export type TtsStatus = "idle" | "playing" | "paused" | "unavailable";

export const TTS_RATES: TtsRate[] = [0.75, 1.0, 1.25, 1.5, 2.0];
export const TTS_SLEEP_OPTIONS: [TtsSleepMode, string][] = [
  [0, "不定时"],
  [15, "15 分钟"],
  [30, "30 分钟"],
  [60, "60 分钟"],
  ["chapter", "读完本章"],
];

const MISSING_TTS_MSG = "当前设备未安装系统语音朗读引擎";

export interface TtsParagraphInput {
  kind: string;
  text: string;
}

export function isSpeakableParagraph(p: TtsParagraphInput | undefined): boolean {
  if (!p || p.kind === "divider") return false;
  const cleaned = p.text.replace(/[◇✦◆*—\-\s\u3000]/g, "");
  return cleaned.length > 0;
}

export function formatSleepRemaining(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.max(0, seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export interface UseReaderTtsOptions {
  platform: Platform;
  paragraphs: TtsParagraphInput[];
  sectionIndex: number;
  onParagraphFocus?: (paragraphIndex: number) => void;
  onSectionEnd?: () => void | Promise<void>;
  toast: (msg: string) => void;
}

export interface ReaderTtsController {
  status: TtsStatus;
  speakingIndex: number | null;
  rate: TtsRate;
  sleepMode: TtsSleepMode;
  sleepRemainingSec: number | null;
  play: (fromIndex?: number) => void;
  pause: () => void;
  resume: () => void;
  toggle: (fromIndex?: number) => void;
  stop: () => void;
  prevParagraph: () => void;
  nextParagraph: () => void;
  setRate: (next: TtsRate) => void;
  setSleepMode: (mode: TtsSleepMode) => void;
}

function hasWebSpeech(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof window.speechSynthesis?.speak === "function" &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

function pickChineseVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
  const voices = synth.getVoices?.() ?? [];
  if (!voices.length) return null;
  return (
    voices.find((v) => /^zh[-_]?CN/i.test(v.lang)) ??
    voices.find((v) => /^zh/i.test(v.lang)) ??
    null
  );
}

export function useReaderTts({
  platform,
  paragraphs,
  sectionIndex,
  onParagraphFocus,
  onSectionEnd,
  toast,
}: UseReaderTtsOptions): ReaderTtsController {
  const [status, setStatus] = useState<TtsStatus>("idle");
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const [rate, setRateState] = useState<TtsRate>(1.0);
  const [sleepMode, setSleepModeState] = useState<TtsSleepMode>(0);
  const [sleepRemainingSec, setSleepRemainingSec] = useState<number | null>(null);

  const statusRef = useRef<TtsStatus>("idle");
  statusRef.current = status;
  const indexRef = useRef<number | null>(null);
  indexRef.current = speakingIndex;
  const rateRef = useRef<TtsRate>(rate);
  rateRef.current = rate;
  const sleepModeRef = useRef<TtsSleepMode>(sleepMode);
  sleepModeRef.current = sleepMode;

  const paragraphsRef = useRef(paragraphs);
  paragraphsRef.current = paragraphs;
  const onFocusRef = useRef(onParagraphFocus);
  onFocusRef.current = onParagraphFocus;
  const onSectionEndRef = useRef(onSectionEnd);
  onSectionEndRef.current = onSectionEnd;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const seqRef = useRef(0);
  const activeUtteranceIdRef = useRef<string | null>(null);
  const webGuardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sleepDeadlineRef = useRef<number | null>(null);
  const prevSectionRef = useRef(sectionIndex);
  const pendingSectionContinueRef = useRef(false);

  const cancelEngines = useCallback(() => {
    seqRef.current += 1;
    activeUtteranceIdRef.current = null;
    if (webGuardTimerRef.current) {
      clearTimeout(webGuardTimerRef.current);
      webGuardTimerRef.current = null;
    }
    void platform.system.ttsStop?.().catch(() => {});
    if (hasWebSpeech()) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore web speech cancel errors */
      }
    }
  }, [platform.system]);

  const markUnavailable = useCallback(() => {
    cancelEngines();
    pendingSectionContinueRef.current = false;
    setStatus("unavailable");
    statusRef.current = "unavailable";
    setSpeakingIndex(null);
    indexRef.current = null;
    toastRef.current(MISSING_TTS_MSG);
  }, [cancelEngines]);

  const stop = useCallback(() => {
    cancelEngines();
    pendingSectionContinueRef.current = false;
    setStatus("idle");
    statusRef.current = "idle";
    setSpeakingIndex(null);
    indexRef.current = null;
  }, [cancelEngines]);

  const findSpeakable = useCallback((start: number, dir: 1 | -1): number | null => {
    const list = paragraphsRef.current;
    for (let i = start; i >= 0 && i < list.length; i += dir) {
      if (isSpeakableParagraph(list[i])) return i;
    }
    return null;
  }, []);

  const speakAtRef = useRef<(idx: number) => void>(() => {});

  const handleParagraphFinished = useCallback(
    (finishedIdx: number) => {
      if (statusRef.current !== "playing") return;
      const nextIdx = findSpeakable(finishedIdx + 1, 1);
      if (nextIdx !== null) {
        speakAtRef.current(nextIdx);
        return;
      }
      // End of current chapter
      if (sleepModeRef.current === "chapter") {
        stop();
        setSleepModeState(0);
        setSleepRemainingSec(null);
        sleepDeadlineRef.current = null;
        toastRef.current("已读完本章，定时朗读结束");
        return;
      }
      if (onSectionEndRef.current) {
        pendingSectionContinueRef.current = true;
        void Promise.resolve(onSectionEndRef.current()).catch(() => {
          pendingSectionContinueRef.current = false;
          stop();
        });
      } else {
        stop();
      }
    },
    [findSpeakable, stop],
  );

  const speakWithWeb = useCallback(
    async (idx: number, text: string, seq: number) => {
      if (!hasWebSpeech()) {
        markUnavailable();
        return;
      }
      const synth = window.speechSynthesis;
      try {
        synth.cancel();
      } catch {
        markUnavailable();
        return;
      }

      // Wait briefly if voices list is still warming up on first open
      let voices = synth.getVoices?.() ?? [];
      if (!voices.length && typeof synth.addEventListener === "function") {
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            synth.removeEventListener("voiceschanged", done);
            resolve();
          };
          synth.addEventListener("voiceschanged", done);
          setTimeout(done, 240);
        });
        if (seq !== seqRef.current) return;
        voices = synth.getVoices?.() ?? [];
      }

      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = "zh-CN";
      utter.rate = rateRef.current;
      const zhVoice = pickChineseVoice(synth);
      if (zhVoice) utter.voice = zhVoice;

      let startedOrEnded = false;
      utter.onstart = () => {
        startedOrEnded = true;
        if (webGuardTimerRef.current) {
          clearTimeout(webGuardTimerRef.current);
          webGuardTimerRef.current = null;
        }
      };
      utter.onend = () => {
        startedOrEnded = true;
        if (webGuardTimerRef.current) {
          clearTimeout(webGuardTimerRef.current);
          webGuardTimerRef.current = null;
        }
        if (seq !== seqRef.current) return;
        handleParagraphFinished(idx);
      };
      utter.onerror = (ev) => {
        startedOrEnded = true;
        if (webGuardTimerRef.current) {
          clearTimeout(webGuardTimerRef.current);
          webGuardTimerRef.current = null;
        }
        if (seq !== seqRef.current) return;
        const errCode = String((ev as SpeechSynthesisErrorEvent)?.error ?? "");
        if (errCode === "canceled" || errCode === "interrupted") return;
        markUnavailable();
      };

      try {
        synth.speak(utter);
      } catch {
        markUnavailable();
        return;
      }

      // Guard against stripped headless WebViews where zero voices exist and `speak()` hangs silently
      if (voices.length === 0) {
        webGuardTimerRef.current = setTimeout(() => {
          if (seq !== seqRef.current || startedOrEnded) return;
          if (!synth.speaking) {
            markUnavailable();
          }
        }, 1400);
      }
    },
    [handleParagraphFinished, markUnavailable],
  );

  const speakAt = useCallback(
    (rawIdx: number) => {
      const targetIdx = findSpeakable(rawIdx, 1);
      if (targetIdx === null) {
        stop();
        return;
      }
      const text = paragraphsRef.current[targetIdx]?.text?.trim() ?? "";
      if (!text) {
        stop();
        return;
      }

      cancelEngines();
      const seq = ++seqRef.current;
      setStatus("playing");
      statusRef.current = "playing";
      setSpeakingIndex(targetIdx);
      indexRef.current = targetIdx;
      onFocusRef.current?.(targetIdx);

      if (platform.name === "android" && typeof platform.system.ttsSpeak === "function") {
        const utteranceId = `tts-${seq}-${targetIdx}`;
        activeUtteranceIdRef.current = utteranceId;
        void platform.system
          .ttsSpeak({ utteranceId, text, rate: rateRef.current })
          .then((ok) => {
            if (seq !== seqRef.current) return;
            if (!ok) {
              activeUtteranceIdRef.current = null;
              if (hasWebSpeech()) {
                void speakWithWeb(targetIdx, text, seq);
              } else {
                markUnavailable();
              }
            }
          })
          .catch(() => {
            if (seq !== seqRef.current) return;
            activeUtteranceIdRef.current = null;
            if (hasWebSpeech()) {
              void speakWithWeb(targetIdx, text, seq);
            } else {
              markUnavailable();
            }
          });
        return;
      }

      void speakWithWeb(targetIdx, text, seq);
    },
    [cancelEngines, findSpeakable, markUnavailable, platform.name, platform.system, speakWithWeb, stop],
  );

  speakAtRef.current = speakAt;

  // Listen for Android native `lishi:tts-event` callbacks
  useEffect(() => {
    const onNativeTts = (ev: Event) => {
      const detail = (ev as CustomEvent<{ utteranceId?: string; state?: "done" | "error" }>).detail;
      if (!detail?.utteranceId || detail.utteranceId !== activeUtteranceIdRef.current) return;
      activeUtteranceIdRef.current = null;
      const curIdx = indexRef.current ?? 0;
      if (detail.state === "done") {
        handleParagraphFinished(curIdx);
      } else {
        markUnavailable();
      }
    };
    window.addEventListener("lishi:tts-event", onNativeTts);
    return () => window.removeEventListener("lishi:tts-event", onNativeTts);
  }, [handleParagraphFinished, markUnavailable]);

  // Auto-start paragraph 0 when advancing to a new section during continuous listening
  useEffect(() => {
    if (prevSectionRef.current === sectionIndex) return;
    prevSectionRef.current = sectionIndex;
    if (pendingSectionContinueRef.current || statusRef.current === "playing") {
      pendingSectionContinueRef.current = false;
      if (paragraphs.length > 0) {
        speakAt(0);
      }
    } else if (statusRef.current === "paused") {
      setSpeakingIndex(0);
      indexRef.current = 0;
    }
  }, [paragraphs, sectionIndex, speakAt]);

  // Also handle async section content load when `pendingSectionContinueRef` is waiting on paragraphs
  useEffect(() => {
    if (pendingSectionContinueRef.current && paragraphs.length > 0) {
      pendingSectionContinueRef.current = false;
      speakAt(0);
    }
  }, [paragraphs, speakAt]);

  // Sleep countdown timer (15 / 30 / 60 minutes)
  useEffect(() => {
    if (typeof sleepMode !== "number" || sleepMode <= 0) {
      sleepDeadlineRef.current = null;
      setSleepRemainingSec(null);
      return;
    }
    const deadline = Date.now() + sleepMode * 60_000;
    sleepDeadlineRef.current = deadline;
    setSleepRemainingSec(sleepMode * 60);

    const timer = setInterval(() => {
      if (!sleepDeadlineRef.current) return;
      const left = Math.max(0, Math.ceil((sleepDeadlineRef.current - Date.now()) / 1000));
      setSleepRemainingSec(left);
      if (left <= 0) {
        sleepDeadlineRef.current = null;
        setSleepModeState(0);
        setSleepRemainingSec(null);
        stop();
        toastRef.current("定时时间到，已停止朗读");
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [sleepMode, stop]);

  // Cleanly stop all TTS playback on unmount
  useEffect(
    () => () => {
      cancelEngines();
    },
    [cancelEngines],
  );

  const play = useCallback(
    (fromIndex?: number) => {
      const start = fromIndex ?? indexRef.current ?? 0;
      speakAt(start);
    },
    [speakAt],
  );

  const pause = useCallback(() => {
    if (statusRef.current !== "playing") return;
    if (platform.name !== "android" && hasWebSpeech()) {
      try {
        window.speechSynthesis.pause();
        setStatus("paused");
        statusRef.current = "paused";
        return;
      } catch {
        /* fallback to cancel-and-remember-index below */
      }
    }
    cancelEngines();
    setStatus("paused");
    statusRef.current = "paused";
  }, [cancelEngines, platform.name]);

  const resume = useCallback(() => {
    if (statusRef.current !== "paused") {
      play();
      return;
    }
    if (platform.name !== "android" && hasWebSpeech() && window.speechSynthesis.paused) {
      try {
        window.speechSynthesis.resume();
        setStatus("playing");
        statusRef.current = "playing";
        return;
      } catch {
        /* fallback to re-speaking current paragraph */
      }
    }
    speakAt(indexRef.current ?? 0);
  }, [platform.name, play, speakAt]);

  const toggle = useCallback(
    (fromIndex?: number) => {
      if (statusRef.current === "playing") {
        pause();
      } else if (statusRef.current === "paused") {
        resume();
      } else {
        play(fromIndex);
      }
    },
    [pause, play, resume],
  );

  const prevParagraph = useCallback(() => {
    const cur = indexRef.current ?? 0;
    const prev = findSpeakable(cur - 1, -1) ?? findSpeakable(0, 1);
    if (prev !== null) speakAt(prev);
  }, [findSpeakable, speakAt]);

  const nextParagraph = useCallback(() => {
    const cur = indexRef.current ?? -1;
    const next = findSpeakable(cur + 1, 1);
    if (next !== null) {
      speakAt(next);
    } else if (onSectionEndRef.current) {
      pendingSectionContinueRef.current = true;
      void Promise.resolve(onSectionEndRef.current());
    }
  }, [findSpeakable, speakAt]);

  const setRate = useCallback(
    (next: TtsRate) => {
      setRateState(next);
      rateRef.current = next;
      if (statusRef.current === "playing") {
        speakAt(indexRef.current ?? 0);
      } else if (statusRef.current === "paused" && hasWebSpeech()) {
        // Cancel web utterance so resume re-speaks cleanly with the new rate
        try {
          window.speechSynthesis.cancel();
        } catch {
          /* ignore */
        }
      }
    },
    [speakAt],
  );

  const setSleepMode = useCallback((mode: TtsSleepMode) => {
    setSleepModeState(mode);
  }, []);

  return {
    status,
    speakingIndex,
    rate,
    sleepMode,
    sleepRemainingSec,
    play,
    pause,
    resume,
    toggle,
    stop,
    prevParagraph,
    nextParagraph,
    setRate,
    setSleepMode,
  };
}
