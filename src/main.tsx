import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./ui/App";
import "./ui/styles/base.css";

// R09-T001: visual direction prototypes over the real screens, dev builds only (?look=scroll|modern|candle).
if (import.meta.env.DEV) {
  const look = new URLSearchParams(location.search).get("look");
  if (look) {
    document.documentElement.dataset.look = look;
    void import("./ui/styles/looks.css");
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
