import test from "node:test";
import assert from "node:assert/strict";
import {ProgressReview,parseReview} from "../src/progress-review.mjs";
test("review decisions are structured and cannot invent a missing decision",()=>{assert.deepEqual(parseReview('```json\n{"decision":"replan","reason":"批量读取时间线"}\n```'),{decision:"replan",reason:"批量读取时间线"});assert.throws(()=>parseReview('已完成'));assert.throws(()=>parseReview('{"decision":"commit","reason":"猜测"}'));});
test("isolated review is bounded, tool-free, billed to root and persists pause/failure",async()=>{
 for(const fail of [false,true]){let captured,saved;const root={options:{directory:'.cache/review-fixture',model:{id:'same-model',inputTokens:475000,maxOutputTokens:8192},nativeModelHttp:true,invokeModelHttp:()=>{},invokeTool:async r=>{saved=r;return {ok:true,data:{paused:true,guidance:{reason:r.args.reason}}};}},taskId:'root',session:{sessionId:'session'},accountingWrites:new Set()};
 const review=new ProgressReview(root,async options=>{captured=options;return {prompt:async()=>{if(fail)throw Error('network');return {text:'{"decision":"pause","reason":"同一时钟反复读取，应保存进度后继续校准"}'};},close:async()=>{},abort:async()=>{}};});
 await assert.rejects(review.run({id:fail?'failed':'pause'}),e=>e.code==='progress_saved');assert.equal(captured.reviewSession,true);assert.equal(captured.model.inputTokens,12000);assert.equal(captured.model.maxOutputTokens,1024);assert.deepEqual(captured.tools,[]);assert.equal(saved.args.decision,fail?'failed':'pause');assert.equal(saved.taskId,'root');
 }
});

test("full pinned Pi review uses a separate tool-free session and the 1024 output limit",{timeout:30000},async()=>{
 const http=await import('node:http'),fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');const {once}=await import('node:events');const {PiHost}=await import('../src/host.mjs');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'r20-review-'));let requests=0,outputLimit;
 const server=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests++;assert.equal((body.tools??[]).length,0);outputLimit=body.max_tokens??body.max_completion_tokens;res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({id:'mock-review',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'{"decision":"replan","reason":"已读取同一位置三次，请改为批量时间线"}'},finish_reason:'stop'}],usage:{prompt_tokens:40,completion_tokens:20}})}\n\ndata: [DONE]\n\n`);});server.listen(0,'127.0.0.1');await once(server,'listening');let saved;
 try{const root={taskId:'root',session:{sessionId:'root-session'},accountingWrites:new Set(),options:{directory,model:{id:'local-review',protocol:'chat-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'OWNED-MOCK-ONLY',inputTokens:475000,maxOutputTokens:8192},invokeTool:async call=>{saved=call;return {ok:true,data:{paused:false}};}}};await new ProgressReview(root,options=>PiHost.create(options)).run({id:'review-owned',goal:'校准日期',recent:[]});assert.equal(requests,1);assert.equal(outputLimit,1024);assert.equal(saved.args.decision,'replan');await fs.mkdir('agent-host/.cache/validation',{recursive:true});await fs.appendFile('agent-host/.cache/validation/ledger.jsonl',JSON.stringify({recordedAt:new Date().toISOString(),case:'r20-full-pi-review',mockRequests:1,realRequests:0})+'\n');}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});}
});
