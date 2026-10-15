import { lazy, Suspense, useState } from "react";
import Game from "./Game";
import { t } from "./i18n";
const TechnicalProbes = lazy(() => import("./TechnicalProbes"));
export default function App() {
 const [showProbes,setShowProbes]=useState(false),[openedProbes,setOpenedProbes]=useState(false);
 return <>
  <nav className="app-navigation" aria-label={t("app.navigation")}>
   <button type="button" className="secondary-button" onClick={()=>setShowProbes(false)} aria-pressed={!showProbes}>{t("app.game")}</button>
   <button type="button" className="secondary-button" onClick={()=>{setOpenedProbes(true);setShowProbes(true);}} aria-pressed={showProbes}>{t("app.probes")}</button>
  </nav>
  <div hidden={showProbes}><Game/></div>
  {openedProbes && <div hidden={!showProbes}><Suspense fallback={<p role="status">{t("probe.core.loading")}</p>}><TechnicalProbes/></Suspense></div>}
 </>;
}
