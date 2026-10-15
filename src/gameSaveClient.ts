import {invoke,isTauri} from "@tauri-apps/api/core";
import {parseWorld,type GameWorld}from "./gameClient";
import {saveT as t}from "./gameSaveMessages";
export interface SaveReply{status:"exported"|"imported"|"cancelled";fileName:string|null;world:GameWorld|null}
function parse(v:unknown):SaveReply{
 if(!v||typeof v!=="object"||Array.isArray(v))throw Error("save_invalid");const r=v as Record<string,unknown>;
 if(Object.keys(r).length!==3||!["status","fileName","world"].every(k=>Object.hasOwn(r,k))||!(["exported","imported","cancelled"] as unknown[]).includes(r.status)||!(r.fileName===null||typeof r.fileName==="string"&&r.fileName.length<=1024&&!/[\u0000-\u001f\u007f]/u.test(r.fileName)))throw Error("save_invalid");
 const world=r.world===null?null:parseWorld(r.world);if((r.status==="imported")!==(world!==null))throw Error("save_invalid");return{status:r.status as SaveReply["status"],fileName:r.fileName as string|null,world};
}
export function saveError(v:unknown):string{const code=v instanceof Error?v.message:typeof v==="object"&&v&&"code"in v?String(v.code):String(v);return t(code==="save_cancelled"?"cancelled":code==="save_duplicate"?"duplicate":code==="save_too_large"||code==="timejump_too_large"?"large":code==="game_busy"||code==="file_busy"?"busy":code.startsWith("save_invalid")||code.startsWith("timejump_")||code==="save_incompatible"?"invalid":"unknown");}
async function call(command:string,args:Record<string,unknown>):Promise<SaveReply>{if(!isTauri())throw Error("save_unavailable");return parse(await invoke(command,args));}
export const exportGameSave=(operationId:string,world:GameWorld)=>call("export_game_save",{operationId,worldId:world.setup.worldId,branchId:world.branchId,expectedHeadTurnId:world.headTurnId});
export const importGameSave=(operationId:string)=>call("import_game_save",{operationId});
