import { useCallback, useEffect, useRef, useState } from "react";
import SQLiteProbe from "./SQLiteProbe";
import StreamProbe from "./StreamProbe";
import { t } from "./i18n";
import {
  describeProbeError,
  echoText,
  getProbeInfo,
  hasNativeCore,
  type EchoResult,
  type ProbeInfo,
} from "./probeClient";

type ConnectionState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "connected"; info: ProbeInfo }
  | { status: "error"; message: string };

interface CompletedEcho {
  result: EchoResult;
  matchesInput: boolean;
}

function connectionLabel(connection: ConnectionState): string {
  switch (connection.status) {
    case "loading":
      return t("probe.core.loading");
    case "unavailable":
      return t("probe.core.unavailable");
    case "connected":
      return t("probe.core.connected");
    case "error":
      return t("probe.core.failed");
  }
}

export default function App() {
  const [connection, setConnection] = useState<ConnectionState>(() =>
    hasNativeCore() ? { status: "loading" } : { status: "unavailable" },
  );
  const [text, setText] = useState(t("probe.echo.sample"));
  const [echo, setEcho] = useState<CompletedEcho | null>(null);
  const [echoError, setEchoError] = useState<string | null>(null);
  const [isEchoing, setIsEchoing] = useState(false);
  const refreshGeneration = useRef(0);
  const echoInFlight = useRef(false);

  const refreshCore = useCallback(async () => {
    const generation = ++refreshGeneration.current;

    if (!hasNativeCore()) {
      setConnection({ status: "unavailable" });
      return;
    }

    setConnection({ status: "loading" });

    try {
      const info = await getProbeInfo();
      if (generation === refreshGeneration.current) {
        setConnection({ status: "connected", info });
      }
    } catch (error: unknown) {
      if (generation === refreshGeneration.current) {
        setConnection({ status: "error", message: describeProbeError(error) });
      }
    }
  }, []);

  useEffect(() => {
    void refreshCore();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [refreshCore]);

  async function sendEcho() {
    if (echoInFlight.current || connection.status !== "connected") {
      return;
    }

    const submittedText = text;
    echoInFlight.current = true;
    setIsEchoing(true);
    setEcho(null);
    setEchoError(null);

    try {
      const result = await echoText(submittedText);
      setEcho({ result, matchesInput: result.text === submittedText });
    } catch (error: unknown) {
      setEchoError(describeProbeError(error));
    } finally {
      echoInFlight.current = false;
      setIsEchoing(false);
    }
  }

  return (
    <main className="probe-page">
      <header className="page-header">
        <span className="stage-label">{t("probe.page.stage")}</span>
        <h1>{t("probe.page.title")}</h1>
        <p>{t("probe.page.description")}</p>
      </header>

      <section className="probe-card" aria-labelledby="core-heading">
        <div className="card-heading">
          <div>
            <h2 id="core-heading">{t("probe.core.heading")}</h2>
            <p className={`connection-status connection-status--${connection.status}`} role="status">
              <span className="status-dot" aria-hidden="true" />
              {connectionLabel(connection)}
            </p>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void refreshCore()}
            disabled={connection.status === "loading"}
          >
            {connection.status === "loading" ? t("probe.core.refreshBusy") : t("probe.core.refresh")}
          </button>
        </div>

        {connection.status === "connected" && (
          <dl className="info-grid">
            <div>
              <dt>{t("probe.core.version")}</dt>
              <dd>{connection.info.coreVersion}</dd>
            </div>
            <div>
              <dt>{t("probe.core.platform")}</dt>
              <dd>{connection.info.platform}</dd>
            </div>
          </dl>
        )}
        {connection.status === "unavailable" && (
          <p className="notice">
            {t("probe.core.browserNotice")}
          </p>
        )}
        {connection.status === "error" && <p className="error-message">{connection.message}</p>}
      </section>

      <section className="probe-card" aria-labelledby="echo-heading">
        <h2 id="echo-heading">{t("probe.echo.heading")}</h2>
        <p className="section-description">{t("probe.echo.description")}</p>

        <label className="input-label" htmlFor="echo-input">{t("probe.echo.inputLabel")}</label>
        <textarea
          id="echo-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
          spellCheck={false}
          aria-describedby="echo-input-help"
        />
        <p id="echo-input-help" className="input-help">{t("probe.echo.inputHelp")}</p>

        <button
          type="button"
          className="primary-button"
          onClick={() => void sendEcho()}
          disabled={connection.status !== "connected" || isEchoing}
        >
          {isEchoing ? t("probe.echo.sendBusy") : t("probe.echo.send")}
        </button>

        <div className="echo-feedback" aria-live="polite">
          {echoError && <p className="error-message">{echoError}</p>}
          {echo && (
            <div className="echo-result">
              <p className={echo.matchesInput ? "result-success" : "error-message"}>
                {echo.matchesInput ? t("probe.echo.matches") : t("probe.echo.mismatch")}
              </p>
              <dl className="info-grid result-counts">
                <div>
                  <dt>{t("probe.echo.scalarCount")}</dt>
                  <dd>{echo.result.unicodeScalarCount}</dd>
                </div>
                <div>
                  <dt>{t("probe.echo.byteCount")}</dt>
                  <dd>{echo.result.utf8ByteCount}</dd>
                </div>
              </dl>
              <h3>{t("probe.echo.returnedText")}</h3>
              <pre className="echo-output">{echo.result.text === "" ? t("probe.echo.empty") : echo.result.text}</pre>
            </div>
          )}
        </div>
      </section>

      <SQLiteProbe coreConnected={connection.status === "connected"} />
      <StreamProbe coreConnected={connection.status === "connected"} />

      <footer className="page-footer">{t("probe.page.footer")}</footer>
    </main>
  );
}
