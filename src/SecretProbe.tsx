import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import {
  deleteProbeSecret,
  describeSecretError,
  getProbeSecretStatus,
  saveProbeSecret,
  type ProbeSecretStatus,
} from "./secretClient";

interface SecretProbeProps {
  coreConnected: boolean;
}

type SecretOperation = "idle" | "checking" | "saving" | "deleting";
type SecretView =
  | { kind: "known"; configured: boolean }
  | { kind: "unknown"; lastKnownConfigured: boolean | null };

function statusLabel(view: SecretView): string {
  if (view.kind === "known") {
    return t(view.configured ? "probe.secret.status.configured" : "probe.secret.status.missing");
  }
  if (view.lastKnownConfigured === null) {
    return t("probe.secret.status.unknown");
  }
  return t(view.lastKnownConfigured ? "probe.secret.status.uncertainConfigured" : "probe.secret.status.uncertainMissing");
}

export default function SecretProbe({ coreConnected }: SecretProbeProps) {
  const [view, setView] = useState<SecretView>({ kind: "unknown", lastKnownConfigured: null });
  const [operation, setOperation] = useState<SecretOperation>("idle");
  const [hasDraft, setHasDraft] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const lastKnownConfigured = useRef<boolean | null>(null);
  const operationInFlight = useRef(false);
  const initialReadStarted = useRef(false);
  const mounted = useRef(true);
  const busy = operation !== "idle";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (input.current) {
        input.current.value = "";
      }
    };
  }, []);

  const perform = useCallback(async (
    nextOperation: Exclude<SecretOperation, "idle">,
    work: () => Promise<ProbeSecretStatus>,
  ) => {
    if (operationInFlight.current) {
      return;
    }
    operationInFlight.current = true;
    setOperation(nextOperation);
    setMessage(null);
    setError(null);
    try {
      const status = await work();
      if (!mounted.current) {
        return;
      }
      lastKnownConfigured.current = status.configured;
      setView({ kind: "known", configured: status.configured });
      setMessage(t(
        nextOperation === "saving" ? "probe.secret.saved" :
          nextOperation === "deleting" ? "probe.secret.deleted" : "probe.secret.checked",
      ));
    } catch (caught: unknown) {
      if (mounted.current) {
        setView({ kind: "unknown", lastKnownConfigured: lastKnownConfigured.current });
        setError(describeSecretError(caught));
      }
    } finally {
      operationInFlight.current = false;
      if (mounted.current) {
        setOperation("idle");
      }
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!coreConnected || operationInFlight.current) {
      return;
    }
    await perform("checking", getProbeSecretStatus);
  }, [coreConnected, perform]);

  useEffect(() => {
    if (!coreConnected || initialReadStarted.current) {
      return;
    }
    initialReadStarted.current = true;
    void refreshStatus();
  }, [coreConnected, refreshStatus]);

  async function saveSecret(): Promise<void> {
    if (!coreConnected || operationInFlight.current || !input.current || !hasDraft) {
      return;
    }
    // The first input necessarily passes through this field and the save IPC call.
    // Do not keep the value in React state, render it, or retain it for retries.
    const token = input.current.value;
    input.current.value = "";
    setHasDraft(false);
    await perform("saving", () => saveProbeSecret(token));
  }

  async function deleteSecret(): Promise<void> {
    if (!coreConnected || operationInFlight.current || (view.kind === "known" && !view.configured)) {
      return;
    }
    await perform("deleting", deleteProbeSecret);
  }

  return (
    <section className="probe-card" aria-labelledby="secret-heading">
      <h2 id="secret-heading">{t("probe.secret.heading")}</h2>
      <p className="section-description">{t("probe.secret.description")}</p>
      <p className="notice secret-safety-note">{t("probe.secret.safetyHelp")}</p>
      {!coreConnected && <p className="notice secret-connection-notice">{t("probe.secret.unavailable")}</p>}

      <p className={`secret-status secret-status--${view.kind}`} role="status">
        {statusLabel(view)}
      </p>
      <form onSubmit={(event) => { event.preventDefault(); void saveSecret(); }}>
        <label className="input-label" htmlFor="secret-input">{t("probe.secret.inputLabel")}</label>
        <input
          ref={input} id="secret-input" className="probe-input" type="password" defaultValue=""
          disabled={!coreConnected || busy} autoComplete="off" autoCapitalize="none" spellCheck={false}
          onChange={(event) => {
            setHasDraft(event.currentTarget.value !== "");
            setMessage(null);
          }}
          aria-describedby="secret-input-help"
        />
        <p id="secret-input-help" className="input-help">{t("probe.secret.inputHelp")}</p>
        <div className="secret-actions">
          <button type="submit" className="primary-button" disabled={!coreConnected || busy || !hasDraft}>
            {operation === "saving" ? t("probe.secret.saveBusy") :
              view.kind === "known" && view.configured ? t("probe.secret.replace") : t("probe.secret.save")}
          </button>
          <button type="button" className="secondary-button" onClick={() => void refreshStatus()} disabled={!coreConnected || busy}>
            {operation === "checking" ? t("probe.secret.refreshBusy") : t("probe.secret.refresh")}
          </button>
          <button
            type="button" className="secondary-button" onClick={() => void deleteSecret()}
            disabled={!coreConnected || busy || (view.kind === "known" && !view.configured)}
          >
            {operation === "deleting" ? t("probe.secret.deleteBusy") : t("probe.secret.delete")}
          </button>
        </div>
      </form>
      <div className="secret-feedback" aria-live="polite">
        {message && <p className="result-success secret-message">{message}</p>}
        {error && <p className="error-message">{error}</p>}
      </div>
    </section>
  );
}
