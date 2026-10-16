import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import DevCheck from "./ui/DevCheck";
import "./ui/styles/base.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DevCheck />
  </StrictMode>,
);
