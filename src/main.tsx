import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./ui/App";
// 思源宋体 (Noto Serif SC, SIL OFL), bundled so the book look does not depend on the phone's fonts (D160).
// Split by unicode-range: only the subsets a page uses are loaded.
import "@fontsource-variable/noto-serif-sc";
// Order matters: later files win ties (same order as the former single base.css).
import "./ui/styles/tokens.css";
import "./ui/styles/base.css";
import "./ui/styles/screens.css";
import "./ui/styles/play.css";
import "./ui/styles/overlays.css";
import "./ui/styles/forms.css";
import "./ui/styles/settings.css";
import "./ui/styles/pages.css";
// 墨韵 differences last, so they win over the shared rules when its style is chosen.
import "./ui/styles/ink.css";
// 华丽 animations (only at data-motion="rich").
import "./ui/styles/motion.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
