import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// 思源宋体 (Noto Serif SC, SIL OFL), bundled so the book look does not depend on the phone's fonts.
// Split by unicode-range: only the subsets a page uses are loaded.
import "@fontsource-variable/noto-serif-sc";
// Foundation stylesheets load before App so component stylesheets naturally win specificity ties.
import "./ui/styles/tokens.css";
import "./ui/styles/base.css";
import "./ui/styles/screens.css";
import "./ui/styles/play.css";
import "./ui/styles/overlays.css";
import "./ui/styles/forms.css";
import "./ui/styles/settings.css";
import "./ui/styles/pages.css";
import "./ui/styles/ink.css";
import App from "./ui/App";
// 华丽 animations and the global reduced-motion / motion="off" hard override last.
import "./ui/styles/motion.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
