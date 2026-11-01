// Isolated full Pi session. Rules request a review; the model chooses what to do.
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
export const PROGRESS_REVIEW_VERSION="1.0.0";
export function parseReview(text) {
  const raw=String(text??"").trim().replace(/^```(?:json)?\s*/u,"").replace(/\s*```$/u,"");
  const value=JSON.parse(raw);
  if(!["continue","replan","pause","ask_user"].includes(value.decision)||typeof value.reason!=="string"||!value.reason.trim()||value.reason.length>3000)throw Error("复核回复缺少有效决定、原因和继续建议");
  return {decision:value.decision,reason:value.reason};
}
export class ProgressReview {
  constructor(root,createHost){this.root=root;this.createHost=createHost;this.active=null;}
  async run(request,options={}) {
    if(this.active)throw Error("进展复核仍在执行");
    const root=this.root,directory=path.join(root.options.directory,"reviews",request.id);
    let host,decision;
    const abort=()=>{void host?.abort();};options.signal?.addEventListener("abort",abort,{once:true});
    try {
      await Promise.all([...root.accountingWrites]);
      host=await this.createHost({directory,model:{...root.options.model,inputTokens:12000,maxOutputTokens:1024},
        reviewSession:true,nativeModelHttp:root.options.nativeModelHttp===true,tools:[],activeTools:[],taskContext:false,
        systemPrompt:`进展复核 ${PROGRESS_REVIEW_VERSION}。你只判断当前任务方法是否有效，没有读写工具。不要判断原著正确性或扩大玩家授权。正常批处理、资料变化和压缩后必要回读允许继续。依据实际读取覆盖、有效草稿和校验变化，决定continue继续、replan换方法、pause保存暂停或ask_user缺必要信息。只返回JSON：{"decision":"...","reason":"具体记录、原因及下一步建议；replan给出可实行的新方法，ask_user写清必要问题"}。`,
        invokeTool:async()=>{throw Error("复核会话没有工具权限");},
        invokeModelHttp:root.options.invokeModelHttp,
      });
      this.active=host;
      if(options.signal?.aborted)throw new DOMException("已停止","AbortError");
      const result=await host.prompt(JSON.stringify(request),root.taskId);
      decision=parseReview(result.text);
    }catch(error){
      if(options.signal?.aborted)throw error;
      decision={decision:"failed",reason:"小上下文进展复核未完整返回有效决定；请检查模型连接或复核记录后明确继续，未据此认定任务没有进展。"};
    }finally{
      options.signal?.removeEventListener("abort",abort);this.active=null;
      await host?.close().catch(()=>{});await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});
    }
    const result=await root.options.invokeTool({sessionId:root.session.sessionId,taskId:root.taskId,toolCallId:`review-${randomUUID()}`,name:"__progress_decision",args:{id:request.id,...decision}},options);
    if(result?.ok!==true){if(result?.error?.code==="stale")return;throw Error("进展判断未保存，任务进度保留");}
    if(result.data?.paused){const error=new Error(result.data.guidance?.reason??"已保存进度并暂停");error.code="progress_saved";throw error;}
  }
  async stop(){await this.active?.abort();}
}
