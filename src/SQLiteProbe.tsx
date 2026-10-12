import { useCallback, useEffect, useRef, useState } from "react";
import { describeProbeError, readProbeNote, saveProbeNote, type ProbeNote } from "./probeClient";
import { locale, t } from "./i18n";

interface SQLiteProbeProps {
  coreConnected: boolean;
}

type NoteOperation = "idle" | "reading" | "saving";

function formatSavedTime(savedAtMs: number): string {
  const savedDate = new Date(savedAtMs);
  if (!Number.isFinite(savedDate.getTime())) {
    return t("probe.error.savedTimeInvalid");
  }
  return savedDate.toLocaleString(locale, { timeZone: "Asia/Shanghai", hour12: false });
}

export default function SQLiteProbe({ coreConnected }: SQLiteProbeProps) {
  const [savedNote, setSavedNote] = useState<ProbeNote | null>(null);
  const [hasReadNote, setHasReadNote] = useState(false);
  const [draft, setDraft] = useState("");
  const [operation, setOperation] = useState<NoteOperation>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operationInFlight = useRef(false);
  const initialReadStarted = useRef(false);
  const draftHasEdits = useRef(false);
  const draftVersion = useRef(0);
  const mounted = useRef(true);
  const draftByteCount = new TextEncoder().encode(draft).byteLength;
  const busy = operation !== "idle";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reloadNote = useCallback(async () => {
    if (operationInFlight.current) {
      return;
    }

    operationInFlight.current = true;
    setOperation("reading");
    setMessage(null);
    setError(null);

    try {
      const note = await readProbeNote();
      if (!mounted.current) {
        return;
      }

      setSavedNote(note);
      setHasReadNote(true);
      if (!draftHasEdits.current) {
        setDraft(note?.text ?? "");
      }
      setMessage(draftHasEdits.current ? t("probe.note.readPreserved") : t("probe.note.readConfirmed"));
    } catch (caught: unknown) {
      if (mounted.current) {
        setError(describeProbeError(caught));
      }
    } finally {
      operationInFlight.current = false;
      if (mounted.current) {
        setOperation("idle");
      }
    }
  }, []);

  useEffect(() => {
    if (!coreConnected || initialReadStarted.current) {
      return;
    }
    initialReadStarted.current = true;
    void reloadNote();
  }, [coreConnected, reloadNote]);

  async function saveNote() {
    if (!coreConnected || operationInFlight.current) {
      return;
    }

    const submittedText = draft;
    const submittedVersion = draftVersion.current;
    operationInFlight.current = true;
    setOperation("saving");
    setMessage(null);
    setError(null);

    try {
      const note = await saveProbeNote(submittedText);
      if (!mounted.current) {
        return;
      }

      if (note.text !== submittedText) {
        setError(t("probe.error.noteMismatch"));
        return;
      }

      setSavedNote(note);
      setHasReadNote(true);

      if (draftVersion.current === submittedVersion) {
        draftHasEdits.current = false;
        setDraft(note.text);
        setMessage(t("probe.note.saveConfirmed", { revision: note.revision }));
      } else {
        setMessage(t("probe.note.saveWithNewEdits", { revision: note.revision }));
      }
    } catch (caught: unknown) {
      if (mounted.current) {
        setError(describeProbeError(caught));
      }
    } finally {
      operationInFlight.current = false;
      if (mounted.current) {
        setOperation("idle");
      }
    }
  }

  return (
    <section className="probe-card" aria-labelledby="sqlite-heading">
      <h2 id="sqlite-heading">{t("probe.note.heading")}</h2>
      <p className="section-description">{t("probe.note.description")}</p>

      {!coreConnected && <p className="notice note-connection-notice">{t("probe.note.unavailable")}</p>}

      <label className="input-label" htmlFor="note-input">{t("probe.note.inputLabel")}</label>
      <textarea
        id="note-input"
        value={draft}
        onChange={(event) => {
          draftHasEdits.current = true;
          draftVersion.current += 1;
          setDraft(event.target.value);
          setMessage(null);
        }}
        rows={5}
        spellCheck={false}
        aria-describedby="note-input-help"
      />
      <p id="note-input-help" className="input-help">
        {t("probe.note.inputHelp", { byteCount: draftByteCount.toLocaleString(locale) })}
      </p>

      <div className="note-actions">
        <button
          type="button"
          className="primary-button"
          onClick={() => void saveNote()}
          disabled={!coreConnected || busy}
        >
          {operation === "saving" ? t("probe.note.saveBusy") : t("probe.note.save")}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void reloadNote()}
          disabled={!coreConnected || busy}
        >
          {operation === "reading" ? t("probe.note.readBusy") : t("probe.note.read")}
        </button>
      </div>

      <div className="note-feedback" aria-live="polite">
        {message && <p className="result-success note-message">{message}</p>}
        {error && <p className="error-message">{error}</p>}
      </div>

      <div className="saved-note">
        <h3>{t("probe.note.savedHeading")}</h3>
        {!hasReadNote && <p className="section-description">{t("probe.note.notRead")}</p>}
        {hasReadNote && savedNote === null && <p className="section-description">{t("probe.note.notSaved")}</p>}
        {savedNote && (
          <>
            <dl className="info-grid note-metadata">
              <div>
                <dt>{t("probe.note.revision")}</dt>
                <dd>{savedNote.revision}</dd>
              </div>
              <div>
                <dt>{t("probe.note.savedTime")}</dt>
                <dd>{formatSavedTime(savedNote.savedAtMs)}</dd>
              </div>
            </dl>
            <pre className="echo-output saved-note-text">{savedNote.text === "" ? t("probe.note.empty") : savedNote.text}</pre>
          </>
        )}
      </div>
    </section>
  );
}
