import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { t } from "./i18n";
import "./styles.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error(t("probe.error.missingRoot"));
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
