import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { PiHost } from "../src/host.mjs";

test("full Pi keeps newly discovered tools active when the native directory is paged", {timeout:20000}, async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"lishi-pi-discovery-"));let n=0,host;const calls=[],missing=[];
  const server=http.createServer(async(req,res)=>{
    let raw="";for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);n++;
    const available=(body.tools??[]).map(t=>t.function.name);
    let action;
    if(n===1)action=["discover_tools",{names:["read_original"]}];
    if(n===2){if(!available.includes("read_original"))missing.push("read_original");action=["read_original",{}];}
    if(n===3)action=["discover_tools",{names:["read_world"]}];
    if(n===4){if(!available.includes("read_original"))missing.push("read_original");if(!available.includes("read_world"))missing.push("read_world");action=["read_world",{}];}
    const delta=action?{role:"assistant",tool_calls:[{index:0,id:`call-${n}`,type:"function",function:{name:action[0],arguments:JSON.stringify(action[1])}}]}:{role:"assistant",content:"已按实际原文完成查阅。"};
    const chunk=(value,finish)=>({id:`mock-${n}`,object:"chat.completion.chunk",created:1,model:"mock",choices:[{index:0,delta:value,finish_reason:finish}]});
    res.writeHead(200,{"Content-Type":"text/event-stream"});res.end(`data: ${JSON.stringify(chunk(delta,null))}\n\ndata: ${JSON.stringify(chunk({},action?"tool_calls":"stop"))}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    const tools=["discover_tools","read_original","read_world"].map(name=>({name,description:name,parameters:name==="discover_tools"?{type:"object",properties:{names:{type:"array",items:{type:"string"}}},required:["names"]}:{type:"object",properties:{}},readOnly:true}));
    host=await PiHost.create({directory,model:{id:"mock",protocol:"chat-completions",baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:"mock-only",maxOutputTokens:8192},tools,activeTools:["discover_tools"],invokeTool:async call=>{
      calls.push(call.name);
      if(call.name==="discover_tools")return {ok:true,toolLoadout:call.args.names,data:{storedResult:true,paths:["/definitions"],read:{callId:call.toolCallId}}};
      return {ok:true,data:{text:"实际资料"}};
    }});
    await host.prompt("查阅资料","discovery-task");
    assert.deepEqual(missing,[]);assert.deepEqual(calls,["discover_tools","read_original","discover_tools","read_world"]);assert.equal(n,5);
    assert.ok(host.session.getActiveToolNames().includes("read_original"));assert.ok(host.session.getActiveToolNames().includes("read_world"));
  }finally{server.closeAllConnections();await host?.abort().catch(()=>{});await host?.close();await new Promise(r=>server.close(r));await fs.rm(directory,{recursive:true,force:true});}
});
