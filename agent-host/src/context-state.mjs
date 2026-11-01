import { estimateRequestTokens } from "./context-budget.mjs";

/** A rebuildable UI observation of Pi's window, never a second transcript. */
export class ContextState {
  constructor(host) {
    this.host=host;this.lastRequestInputTokens=null;this.lastRequestAt=null;this.overhead=0;
    this.requestId=null;this.requestModel=null;this.requestCompactionVersion=null;this.lastRequestEstimatedTokens=null;this.estimateRatio=null;
    const recent=host.manager.getBranch().findLast(e=>e.type==="message"&&e.message?.role==="assistant"&&!['error','aborted'].includes(e.message.stopReason)&&e.message.usage);
    if(recent){this.response(recent.message,"model");this.lastRequestAt=recent.timestamp;}
  }
  estimate() {
    const h=this.host;
    const projection=h.manager.buildSessionProjection();
    return estimateRequestTokens(h.pi,{messages:projection.messages,systemPrompt:h.session.agent.state.systemPrompt,tools:h.session.agent.state.tools});
  }
  request(details,purpose) {
    if(purpose!=="model")return;
    this.overhead=Math.max(0,details.estimatedInputTokens-this.estimate());
    this.lastRequestEstimatedTokens=details.estimatedInputTokens;
    this.requestId=`request-${this.host.requestGeneration ?? 0}`;
    this.requestModel=this.host.session?.agent?.state?.model?.id ?? this.host.options.model?.id ?? null;
    this.requestCompactionVersion=this.host.manager.getBranch().filter(e=>e.type==="compaction").length;
    this.emit({usedTokens:details.estimatedInputTokens,measurement:"estimated"});
  }
  identifyRequest(id,purpose) {if(purpose==="model"){this.requestId=id;this.emit();}}
  response(message,purpose) {
    if(purpose!=="model"||["error","aborted"].includes(message?.stopReason))return;
    const u=message?.usage;
    if(u&&[u.input,u.cacheRead??0,u.cacheWrite??0].every(n=>Number.isFinite(n)&&n>=0)&&u.input+(u.cacheRead??0)+(u.cacheWrite??0)>0) {
      this.lastRequestInputTokens=u.input+(u.cacheRead??0)+(u.cacheWrite??0);
      this.lastRequestAt=new Date().toISOString();
      this.estimateRatio=this.lastRequestEstimatedTokens>0 ? this.lastRequestInputTokens/this.lastRequestEstimatedTokens : null;
    }
  }
  emit(overrides={}) {
    const h=this.host;if(!h.taskId||h.closed||h.options.readonlyChild||h.options.reviewSession)return;
    try {
      const branch=h.manager.getBranch(), compactions=branch.filter(e=>e.type==="compaction"), last=compactions.at(-1);
      const pending=h.session.isCompacting;
      const data={version:1,attemptId:h.options.nativeAttempt??"",usedTokens:pending?null:this.estimate()+this.overhead,
        effectiveInputBudgetTokens:h.budget.effectiveInputBudgetTokens,requestedTokens:h.budget.inputBudgetTokens,
        modelWindowTokens:h.budget.modelContextWindowTokens,outputReserveTokens:h.budget.outputReserveTokens,
        measurement:pending?"pending":"estimated",lastRequestInputTokens:this.lastRequestInputTokens,lastRequestAt:this.lastRequestAt,
        requestId:this.requestId,requestModel:this.requestModel,requestCompactionVersion:this.requestCompactionVersion,
        lastRequestEstimatedTokens:this.lastRequestEstimatedTokens,estimateRatio:this.estimateRatio,
        compactions:compactions.length,lastCompactionAt:last?.timestamp??null,tokensBefore:last?.tokensBefore??null,
        summaryChars:last?.summary?.length??null,updatedAt:new Date().toISOString(),...overrides};
      h.options.onEvent?.({sessionId:h.session.sessionId,taskId:h.taskId,event:{type:"context_state",data}});
    }catch {
      h.options.onEvent?.({sessionId:h.session.sessionId,taskId:h.taskId,event:{type:"context_state",data:{version:1,
        attemptId:h.options.nativeAttempt??"",measurement:"unknown",usedTokens:null,
        effectiveInputBudgetTokens:h.budget.effectiveInputBudgetTokens,updatedAt:new Date().toISOString()}}});
    }
  }
  compacted() {this.overhead=0;this.emit();}
}
