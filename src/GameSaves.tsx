import { useRef, useState } from "react";
import { type GameWorld, hasGameCore, cancelGameTurn } from "./gameClient";
import { exportGameSave, importGameSave, saveError, type SaveReply } from "./gameSaveClient";
import { saveT as t } from "./gameSaveMessages";
export interface GameSavesProps {world:GameWorld|null;busy:boolean;beginWrite:()=>boolean;endWrite:()=>void;onImported:(world:GameWorld)=>void}
export default function GameSaves({world,busy,beginWrite,endWrite,onImported}:GameSavesProps){
 const [running,setRunning]=useState(false),[message,setMessage]=useState<string|null>(null),[error,setError]=useState<string|null>(null);const working=useRef(false);const activeId=useRef<string|null>(null);const[cancelling,setCancelling]=useState(false);
 async function run(kind:"export"|"import"){
  if(busy||working.current||!hasGameCore()||(kind==="export"&&!world)||!beginWrite())return;
  working.current=true;setRunning(true);setError(null);setMessage(null);setCancelling(false);
  try {const id=crypto.randomUUID();activeId.current=id;const result:SaveReply=kind==="export"?await exportGameSave(id,world!):await importGameSave(id);
   setMessage(t(result.status));if(result.world)onImported(result.world);
  }catch(cause){setError(saveError(cause));}finally{activeId.current=null;working.current=false;setRunning(false);setCancelling(false);endWrite();}
 }
 return <section className="game-library" aria-label={t("heading")}><h2>{t("heading")}</h2><p className="game-muted">{t("help")}</p>
  <div className="game-actions"><button className="game-secondary" disabled={!hasGameCore()||busy||running||!world} onClick={()=>void run("export")}>{t("export")}</button><button className="game-secondary" disabled={!hasGameCore()||busy||running} onClick={()=>void run("import")}>{t("import")}</button></div>
  <p className="game-small game-muted">{t("limits")}</p>{running&&<><p role="status">{t("working")}</p><button type="button" className="game-secondary" disabled={cancelling} onClick={()=>{const id=activeId.current;if(!id)return;setCancelling(true);void cancelGameTurn(id).then(()=>{if(activeId.current===id)setMessage(t("cancelling"));}).catch(cause=>{if(activeId.current===id){setError(saveError(cause));setCancelling(false);}});}}>{t("cancel")}</button></>}{message&&<p role="status" className="game-notice">{message}</p>}{error&&<p role="alert" className="game-error">{error}</p>}
 </section>;
}
