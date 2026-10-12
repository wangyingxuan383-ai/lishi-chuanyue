import { useEffect, useRef, useState } from "react";
import { locale, t } from "./i18n";
import { describeFileError, exportProbePack, importProbePack } from "./fileClient";

interface FileProbeProps {
  coreConnected: boolean;
}

interface ImportPreview {
  fileName?: string;
  note: string;
}

export default function FileProbe({ coreConnected }: FileProbeProps) {
  const [text, setText] = useState(() => t("probe.file.sample"));
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [operation, setOperation] = useState<"idle" | "importing" | "exporting">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operationInFlight = useRef(false);
  const mounted = useRef(true);
  const busy = operation !== "idle";

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function performFileOperation(next: "importing" | "exporting"): Promise<void> {
    if (!coreConnected || operationInFlight.current) {
      return;
    }
    operationInFlight.current = true;
    setOperation(next);
    setMessage(null);
    setError(null);
    // The export uses a fixed copy; edits during the picker stay in the editor.
    const exportText = text;
    try {
      if (next === "exporting") {
        const result = await exportProbePack(exportText);
        if (mounted.current) {
          setMessage(t(result.status === "cancelled" ? "probe.file.cancelled" : "probe.file.exported"));
        }
      } else {
        const result = await importProbePack();
        if (mounted.current) {
          if (result.status === "imported") {
            setPreview({ fileName: result.fileName, note: result.note });
            setMessage(t("probe.file.imported"));
          } else {
            setMessage(t("probe.file.cancelled"));
          }
        }
      }
    } catch (caught: unknown) {
      if (mounted.current) {
        setError(describeFileError(caught));
      }
    } finally {
      operationInFlight.current = false;
      if (mounted.current) {
        setOperation("idle");
      }
    }
  }

  function copyPreview(): void {
    if (busy || !preview) {
      return;
    }
    setText(preview.note);
    setError(null);
    setMessage(t("probe.file.copied"));
  }

  return (
    <section className="probe-card" aria-labelledby="file-heading">
      <h2 id="file-heading">{t("probe.file.heading")}</h2>
      <p className="section-description">{t("probe.file.description")}</p>
      {!coreConnected && <p className="notice file-connection-notice">{t("probe.file.unavailable")}</p>}
      <label className="input-label" htmlFor="file-test-text">{t("probe.file.inputLabel")}</label>
      <textarea
        id="file-test-text" value={text} onChange={(event) => setText(event.target.value)}
        aria-describedby="file-test-help" spellCheck={false}
      />
      <p id="file-test-help" className="input-help">
        {t("probe.file.inputHelp", { byteCount: new TextEncoder().encode(text).byteLength.toLocaleString(locale) })}
      </p>
      <div className="file-actions">
        <button
          type="button" className="primary-button" onClick={() => void performFileOperation("exporting")}
          disabled={!coreConnected || busy}
        >
          {t(operation === "exporting" ? "probe.file.exportBusy" : "probe.file.export")}
        </button>
        <button
          type="button" className="secondary-button" onClick={() => void performFileOperation("importing")}
          disabled={!coreConnected || busy}
        >
          {t(operation === "importing" ? "probe.file.importBusy" : "probe.file.import")}
        </button>
      </div>
      <div aria-live="polite">
        {message && <p className="result-success file-message">{message}</p>}
        {error && <p className="error-message">{error}</p>}
      </div>
      {preview && (
        <div className="file-preview">
          <h3>{t("probe.file.previewHeading")}</h3>
          <p className="input-help">{t("probe.file.previewHelp")}</p>
          {preview.fileName && (
            <dl className="info-grid file-metadata">
              <div><dt>{t("probe.file.fileName")}</dt><dd>{preview.fileName}</dd></div>
            </dl>
          )}
          <pre className="echo-output file-preview-text">{preview.note === "" ? t("probe.file.empty") : preview.note}</pre>
          <button type="button" className="secondary-button file-copy" onClick={copyPreview} disabled={busy}>
            {t("probe.file.useImported")}
          </button>
        </div>
      )}
    </section>
  );
}
