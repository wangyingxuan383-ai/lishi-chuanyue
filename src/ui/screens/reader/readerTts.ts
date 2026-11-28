// Offline dual-engine TTS audiobook controller for ReaderScreen (R36-T005).
// Supports:
// 1. Native Android TextToSpeech via `platform.system.ttsSpeak` / `ttsStop` + `lishi:tts-event`
// 2. Web / Desktop `window.speechSynthesis` (`SpeechSynthesisUtterance`, `zh-CN`)
// Gracefully detects headless / missing TTS engines without crashing or hanging.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Platform } from "../../../platform";

export type TtsRate = 0.75 | 1.0 | 1.25 | 1.5 | 2.0;
export type TtsSleepMode = "off" | 0 | 15 | 30 | 60 | "chapter";
export type TtsStatus = "idle" | "playing" | "paused" | "unavailable";

export const TTS_RATES: TtsRate[] = [0.75, 1.0, 1.25, 1.5, 2.0];
export const TTS_SLEEP_OPTIONS: [TtsSleepMode, string][] = [
  ["off", "不定时"],
  [15, "15 分钟"],
  [30, "30 分钟"],
  [60, "60 分钟"],
  ["chapter", "读完本章"],
];

const MISSING_TTS_MSG = "当前设备未安装系统语音朗读引擎";
const MAX_CONSECUTIVE_EMPTY_SECTIONS = 12;

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

export interface TtsJumpTarget {
  nonce: number;
  sectionIndex: number;
  paragraphIndex: number;
}

export interface UseReaderTtsOptions {
  platform: Platform;
  paragraphs: TtsParagraphInput[];
  sectionIndex: number;
  sectionReady?: boolean;
  jumpTarget?: TtsJumpTarget | null;
  onParagraphFocus?: (paragraphIndex: number) => void;
  onSectionEnd?: () => void | boolean | Promise<void | boolean>;
  toast: (msg: string) => void;
}

export interface ReaderTtsController {
  status: TtsStatus;
  speakingIndex: number | null;
  rate: TtsRate;
  sleepMode: TtsSleepMode;
  sleepRemainingSec: number | null;
  play: (fromIndex?: number) => void;
  playFrom: (fromIndex: number) => void;
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
  sectionReady = true,
  jumpTarget = null,
  onParagraphFocus,
  onSectionEnd,
  toast,
}: UseReaderTtsOptions): ReaderTtsController {
  const [status, setStatus] = useState<TtsStatus>("idle");
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const [rate, setRateState] = useState<TtsRate>(1.0);
  const [sleepMode, setSleepModeState] = useState<TtsSleepMode>("off");
  const [sleepRemainingSec, setSleepRemainingSec] = useState<number | null>(0);

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
  const sectionIndexRef = useRef(sectionIndex);
  sectionIndexRef.current = sectionIndex;
  const sectionReadyRef = useRef(sectionReady);
  sectionReadyRef.current = sectionReady;
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
  const sleepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevSectionRef = useRef(sectionIndex);
  const pendingSectionContinueRef = useRef(false);
  const awaitingAdvanceFromSectionRef = useRef<number | null>(null);
  const emptySectionStreakRef = useRef(0);
  const appliedJumpNonceRef = useRef<number | null>(jumpTarget?.nonce ?? null);
  const pendingJumpParaRef = useRef<{ sectionIndex: number; paragraphIndex: number } | null>(null);

  const clearSleepTimer = useCallback(() => {
    if (sleepIntervalRef.current) {
      clearInterval(sleepIntervalRef.current);
      sleepIntervalRef.current = null;
    }
    sleepDeadlineRef.current = null;
  }, []);

  const cancelEngines = useCallback(
    (opts?: { skipNativeStop?: boolean }) => {
      seqRef.current += 1;
      activeUtteranceIdRef.current = null;
      if (webGuardTimerRef.current) {
        clearTimeout(webGuardTimerRef.current);
        webGuardTimerRef.current = null;
      }
      if (!opts?.skipNativeStop) {
        void platform.system.ttsStop?.().catch(() => {});
      }
      if (hasWebSpeech()) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          /* ignore web speech cancel errors */
        }
      }
    },
    [platform.system],
  );

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
    clearSleepTimer();
    pendingSectionContinueRef.current = false;
    awaitingAdvanceFromSectionRef.current = null;
    pendingJumpParaRef.current = null;
    emptySectionStreakRef.current = 0;
    sleepModeRef.current = "off";
    setSleepModeState("off");
    setSleepRemainingSec(0);
    setStatus("idle");
    statusRef.current = "idle";
    setSpeakingIndex(null);
    indexRef.current = null;
  }, [cancelEngines, clearSleepTimer]);

  const findSpeakable = useCallback((start: number, dir: 1 | -1): number | null => {
    const list = paragraphsRef.current;
    for (let i = start; i >= 0 && i < list.length; i += dir) {
      if (isSpeakableParagraph(list[i])) return i;
    }
    return null;
  }, []);

  const advanceNextSectionOrStop = useCallback(
    (opts?: { skipEmptySection?: boolean }) => {
      if (!opts?.skipEmptySection && sleepModeRef.current === "chapter") {
        stop();
        toastRef.current("已读完本章，定时朗读结束");
        return;
      }
      if (!onSectionEndRef.current) {
        stop();
        return;
      }
      if (emptySectionStreakRef.current > MAX_CONSECUTIVE_EMPTY_SECTIONS) {
        emptySectionStreakRef.current = 0;
        stop();
        toastRef.current("后续章节暂无可朗读正文");
        return;
      }
      cancelEngines();
      awaitingAdvanceFromSectionRef.current = sectionIndexRef.current;
      pendingSectionContinueRef.current = true;
      setStatus("playing");
      statusRef.current = "playing";
      setSpeakingIndex(null);
      indexRef.current = null;
      void Promise.resolve(onSectionEndRef.current())
        .then((res) => {
          if (res === false) {
            pendingSectionContinueRef.current = false;
            awaitingAdvanceFromSectionRef.current = null;
            stop();
          }
        })
        .catch(() => {
          pendingSectionContinueRef.current = false;
          awaitingAdvanceFromSectionRef.current = null;
          stop();
        });
    },
    [cancelEngines, stop],
  );

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
        toastRef.current("已读完本章，定时朗读结束");
        return;
      }
      advanceNextSectionOrStop();
    },
    [advanceNextSectionOrStop, findSpeakable, stop],
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
      const clampedStart = Math.max(0, Math.trunc(rawIdx));
      let targetIdx = findSpeakable(clampedStart, 1);
      if (targetIdx === null && clampedStart > 0) {
        // If user jumped to a trailing divider paragraph, try advancing to next chapter
        // rather than yanking back to paragraph 0.
        if (onSectionEndRef.current && sleepModeRef.current !== "chapter") {
          emptySectionStreakRef.current += 1;
          advanceNextSectionOrStop();
          return;
        }
        stop();
        return;
      }
      if (targetIdx === null) {
        // Entire chapter has zero speakable paragraphs (empty or pure ornament dividers):
        // automatically skip ahead to the next chapter up to MAX_CONSECUTIVE_EMPTY_SECTIONS.
        if (onSectionEndRef.current) {
          emptySectionStreakRef.current += 1;
          advanceNextSectionOrStop({ skipEmptySection: true });
          return;
        }
        stop();
        return;
      }
      const text = paragraphsRef.current[targetIdx]?.text?.trim() ?? "";
      if (!text) {
        if (onSectionEndRef.current) {
          emptySectionStreakRef.current += 1;
          advanceNextSectionOrStop({ skipEmptySection: true });
          return;
        }
        stop();
        return;
      }

      emptySectionStreakRef.current = 0;

      const nativeTtsSpeak =
        platform.name === "android" && typeof platform.system.ttsSpeak === "function"
          ? platform.system.ttsSpeak.bind(platform.system)
          : null;
      cancelEngines({ skipNativeStop: nativeTtsSpeak !== null });
      const seq = ++seqRef.current;
      setStatus("playing");
      statusRef.current = "playing";
      setSpeakingIndex(targetIdx);
      indexRef.current = targetIdx;
      onFocusRef.current?.(targetIdx);

      if (nativeTtsSpeak) {
        const utteranceId = `tts-${seq}-${targetIdx}`;
        activeUtteranceIdRef.current = utteranceId;
        void nativeTtsSpeak({ utteranceId, text, rate: rateRef.current })
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
    [
      advanceNextSectionOrStop,
      cancelEngines,
      findSpeakable,
      markUnavailable,
      platform.name,
      platform.system,
      speakWithWeb,
      stop,
    ],
  );

  speakAtRef.current = speakAt;

  // Listen for Android native `lishi:tts-event` callbacks
  useEffect(() => {
    const onNativeTts = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{
          utteranceId?: string;
          state?: "done" | "error" | "interrupted" | "stopped";
        }>
      ).detail;
      if (!detail?.utteranceId || detail.utteranceId !== activeUtteranceIdRef.current) return;
      activeUtteranceIdRef.current = null;
      const curIdx = indexRef.current ?? 0;
      if (detail.state === "done") {
        handleParagraphFinished(curIdx);
      } else if (detail.state === "interrupted" || detail.state === "stopped") {
        if (statusRef.current === "playing") {
          pendingSectionContinueRef.current = false;
          statusRef.current = "paused";
          setStatus("paused");
        }
      } else {
        const text = paragraphsRef.current[curIdx]?.text?.trim() ?? "";
        if (text && hasWebSpeech()) {
          void speakWithWeb(curIdx, text, seqRef.current);
        } else {
          markUnavailable();
        }
      }
    };
    window.addEventListener("lishi:tts-event", onNativeTts);
    return () => window.removeEventListener("lishi:tts-event", onNativeTts);
  }, [handleParagraphFinished, markUnavailable, speakWithWeb]);

  // Unified section-transition & external-jump effect so simultaneous `(sectionIndex, jumpTarget)`
  // updates in a single React commit never overwrite `jumpTarget.paragraphIndex` back to `0`.
  useEffect(() => {
    const hasNewJump = Boolean(jumpTarget && jumpTarget.nonce !== appliedJumpNonceRef.current);
    if (hasNewJump && jumpTarget) {
      appliedJumpNonceRef.current = jumpTarget.nonce;
      pendingJumpParaRef.current = {
        sectionIndex: jumpTarget.sectionIndex,
        paragraphIndex: Math.max(0, Math.trunc(jumpTarget.paragraphIndex)),
      };
      if (statusRef.current === "playing") {
        pendingSectionContinueRef.current = false;
      }
    }

    const sectionChanged = prevSectionRef.current !== sectionIndex;
    if (sectionChanged) {
      prevSectionRef.current = sectionIndex;
      awaitingAdvanceFromSectionRef.current = null;
      const explicitPara =
        pendingJumpParaRef.current?.sectionIndex === sectionIndex
          ? pendingJumpParaRef.current.paragraphIndex
          : 0;
      if (pendingSectionContinueRef.current || statusRef.current === "playing") {
        cancelEngines();
        if (sectionReady) {
          pendingSectionContinueRef.current = false;
          pendingJumpParaRef.current = null;
          speakAt(explicitPara);
        } else {
          setStatus("playing");
          statusRef.current = "playing";
          setSpeakingIndex(null);
          indexRef.current = null;
          pendingSectionContinueRef.current = true;
        }
      } else if (statusRef.current === "paused") {
        cancelEngines();
        if (pendingJumpParaRef.current?.sectionIndex === sectionIndex) {
          pendingJumpParaRef.current = null;
        }
        setSpeakingIndex(explicitPara);
        indexRef.current = explicitPara;
      }
      return;
    }

    // Same-section explicit jump while playing or paused
    if (hasNewJump && pendingJumpParaRef.current?.sectionIndex === sectionIndex) {
      const targetPara = pendingJumpParaRef.current.paragraphIndex;
      if (statusRef.current === "playing") {
        if (sectionReady && paragraphs.length > 0) {
          pendingJumpParaRef.current = null;
          speakAt(targetPara);
        } else {
          pendingSectionContinueRef.current = true;
        }
      } else if (statusRef.current === "paused") {
        pendingJumpParaRef.current = null;
        setSpeakingIndex(targetPara);
        indexRef.current = targetPara;
      }
      return;
    }

    // Async section content finished loading while waiting to continue
    if (
      pendingSectionContinueRef.current &&
      awaitingAdvanceFromSectionRef.current !== sectionIndex &&
      statusRef.current === "playing" &&
      sectionReady
    ) {
      const explicitPara =
        pendingJumpParaRef.current?.sectionIndex === sectionIndex
          ? pendingJumpParaRef.current.paragraphIndex
          : 0;
      pendingSectionContinueRef.current = false;
      pendingJumpParaRef.current = null;
      speakAt(explicitPara);
    }
  }, [cancelEngines, jumpTarget, paragraphs, sectionIndex, sectionReady, speakAt]);

  // Sleep countdown timer (15 / 30 / 60 minutes)
  useEffect(() => {
    clearSleepTimer();
    if (typeof sleepMode !== "number" || sleepMode <= 0) {
      setSleepRemainingSec(0);
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
        stop();
        toastRef.current("定时时间到，已停止朗读");
      }
    }, 1000);
    sleepIntervalRef.current = timer;
    return () => {
      if (sleepIntervalRef.current === timer) {
        sleepIntervalRef.current = null;
      }
      clearInterval(timer);
    };
  }, [clearSleepTimer, sleepMode, stop]);

  // Cleanly stop all TTS playback & timers on unmount
  useEffect(
    () => () => {
      clearSleepTimer();
      cancelEngines();
    },
    [cancelEngines, clearSleepTimer],
  );

  const play = useCallback(
    (fromIndex?: number) => {
      if (fromIndex !== undefined) {
        const cleanIdx = Math.max(0, Math.trunc(fromIndex));
        pendingJumpParaRef.current = { sectionIndex, paragraphIndex: cleanIdx };
        if (!sectionReadyRef.current) {
          setStatus("playing");
          statusRef.current = "playing";
          pendingSectionContinueRef.current = true;
          return;
        }
        pendingJumpParaRef.current = null;
        speakAt(cleanIdx);
        return;
      }
      const start = indexRef.current ?? 0;
      speakAt(start);
    },
    [sectionIndex, speakAt],
  );

  const pause = useCallback(() => {
    pendingSectionContinueRef.current = false;
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
    } else {
      void advanceNextSectionOrStop();
    }
  }, [advanceNextSectionOrStop, findSpeakable, speakAt]);

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
    playFrom: play,
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
