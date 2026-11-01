// Historical whole-story Agent fixture. Current entry follows the separate
// assistant conversation; old evidence remains in its recorded validation.
// Set LISHI_R16_LEGACY_UI=1 only on the matching historical code revision.
if (process.env.LISHI_R16_LEGACY_UI !== "1") {
  await import("./agent-chat.mjs");
  process.exit(process.exitCode ?? 0);
}
// Focused Agent/canon/update/reading check against the resident Rust host.
// node --import tsx scripts/ui/agent.mjs
// Uses only an isolated SQLite database and a local simulated model. On a
// failure the session stays open; fix the issue and enter "resume" to retry
// that checkpoint, or "quit" to close it. No real service or key is read.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { once } from "node:events";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";
import { HostBridge, hostRequest } from "../../devserver/host.ts";
import { relayStream } from "../../devserver/relay.ts";
import { connectFake } from "./connect.mjs";

const root=process.cwd(), port=1428, modelPort=1438;
const origin=`http://127.0.0.1:${port}`, modelOrigin=`http://127.0.0.1:${modelPort}`;
const out=path.join(root,"output/playwright/agent-r16");
const isolated=process.env.LISHI_AGENT_UI_RUN_DIR??await fs.mkdtemp(path.join(root,".cache/r16-agent-ui-"));
await fs.mkdir(out,{recursive:true});
const secretFile=path.join(isolated,"fake-secrets.json");try{await fs.access(secretFile);}catch{await fs.writeFile(secretFile,"{}");}
process.env.LISHI_DEV_DATABASE_DIR=path.join(isolated,"database");
process.env.LISHI_DEV_SECRETS_FILE=secretFile;
const host=new HostBridge(root), secrets=new Map(), results=[], errors=[], requests=[];
for(const [slot,entry] of Object.entries(JSON.parse(await fs.readFile(secretFile,"utf8"))))secrets.set(slot,entry);
const version=JSON.parse(await fs.readFile(path.join(root,"package.json"),"utf8")).version;
let releaseVersion="0.99.1", slow=false, holdCompose=false, releaseCompose=null, composeStarted=null;
let server,browser,context,page,fixture, phaseIndex=0;
const check=(name,ok,detail)=>{results.push({name,ok:!!ok,...(detail?{detail}:{})});console.log(`${ok?"PASS":"FAIL"} ${name}${detail?` — ${JSON.stringify(detail)}`:""}`);assert.ok(ok,name);};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const save=async()=>fs.writeFile(path.join(out,"results.json"),JSON.stringify({phaseIndex,isolated:path.relative(root,isolated),realModelRequests:0,mockModelRequests:requests.length,results,errors,requests:requests.map(({kind,chars,model,toolNames})=>({kind,chars,model,toolNames}))},null,2));
const shot=async name=>{await delay(180);await page.screenshot({path:path.join(out,`${name}.png`)});};
const read=req=>new Promise((resolve,reject)=>{let raw="";req.on("data",b=>raw+=b);req.on("end",()=>{try{resolve(JSON.parse(raw||"{}"));}catch(e){reject(e);}});req.on("error",reject);});
const json=(res,value,status=200)=>{res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(value));};
const calls=items=>({content:"",tool_calls:items.map(([name,args],i)=>({id:`call_${requests.length}_${i}`,type:"function",function:{name,arguments:JSON.stringify(args)}}))});
const narrative="阿白拱手唤了一声阿姊，阿青从灯座下取出青铜钥匙。阿兰被你及时救下，此刻仍在书铺里养伤；这条本局分支没有改回原著。\n\n";
const normalRecord={time:5,log:"在青石桥书铺核对约定",choices:["问清钥匙的来历","继续照料阿兰","等阿青回来"]};
const prose=()=>narrative+Array.from({length:22},(_,i)=>`雨丝落在青石桥上。第${i+1}阵风吹过书铺，灯影轻轻摇晃，众人按本局已经发生的事情继续交谈。\n\n`).join("");
const fullProse=()=>`${prose()}<record>${JSON.stringify(normalRecord)}</record>`;
const toolNames=body=>(body.messages??[]).flatMap(m=>m.tool_calls??[]).map(c=>c.function?.name);
function replyFor(body){
  const messages=body.messages??[], prompt=JSON.stringify(messages), names=toolNames(body), definitions=(body.tools??[]).map(t=>t.function?.name);
  if(definitions.includes("report_capability"))return{kind:"capability",message:calls([["report_capability",{value:"ready"}]])};
  if(prompt.includes("只回复两个字"))return{kind:"connection",message:{content:"你好"}};
  if(messages.some(m=>m.role==="system"&&m.content?.startsWith("根据本局事实、玩家行动")))return{kind:"compose",message:{content:fullProse()}};
  const correction=prompt.includes("对这个回合按原著纠错");
  if(definitions.length&&(!names.includes("read_skill")||!names.includes("read_original")))return{kind:correction?"correction-tools":"canon-tools",message:calls([["read_skill",{name:"canon-reference"}],["search_original",{query:"阿青 阿白 阿姊 青铜钥匙 灯座 阿兰"}],["read_original",{section:0,chunk:0,neighbors:1}]])};
  if(correction){
    const corrections=[
      {detail:"阿青与阿白为姐弟，应称阿姊。",citations:[{bookId:fixture.bookId,section:0,chunk:0,title:"第一章 青石桥",quote:"阿青是阿白的姐姐。阿白应称她为阿姊。"}]},
      {detail:"信物为青铜钥匙，原先藏在灯座下。",citations:[{bookId:fixture.bookId,section:0,chunk:0,title:"第一章 青石桥",quote:"青铜钥匙藏在灯座下。"}]},
    ];
    return{kind:"correction-preview",message:{content:JSON.stringify({narrative:narrative+"这一回合在书铺的谈话至此结束。",record:{time:5,log:"核对称谓、姐弟关系和钥匙，保留救人分支",choices:["继续照料阿兰"]},correctionPatch:{people:[{name:"阿青",role:"阿白的姐姐",attitude:"友善",note:"阿白称她为阿姊"}]},corrections})}};
  }
  if(definitions.includes("compose_draft")){
    if(!names.includes("compose_draft"))return{kind:"agent-compose-call",message:calls([["compose_draft",{instructions:"核实阿姊称谓、姐弟关系和青铜钥匙；保留玩家救下阿兰的分支。"}]])};
    return{kind:"agent-commit-call",message:calls([["commit_turn",{narrative:prose(),record:normalRecord}]])};
  }
  if(prompt.includes("只输出一个 JSON 对象")&&prompt.includes("本回合正文"))return{kind:"extract",message:{content:JSON.stringify(normalRecord)}};
  return{kind:"classic",message:{content:fullProse()}};
}
const mock=http.createServer(async(req,res)=>{
  if(req.method==="GET"&&req.url.endsWith("/models"))return json(res,{data:[{id:"fake-agent",object:"model"}]});
  try{
    const body=await read(req), reply=replyFor(body);
    requests.push({kind:reply.kind,chars:JSON.stringify(body.messages??[]).length,model:body.model,toolNames:toolNames(body),containsHidden:JSON.stringify(body.messages??[]).includes("北地王子")});
    if(reply.kind==="compose"&&holdCompose){composeStarted?.();await new Promise(resolve=>releaseCompose=resolve);holdCompose=false;}
    if(!slow||reply.message.tool_calls||reply.kind!=="classic")return json(res,{choices:[{message:reply.message,finish_reason:reply.message.tool_calls?"tool_calls":"stop"}],usage:{prompt_tokens:40,completion_tokens:30}});
    res.writeHead(200,{"Content-Type":"text/event-stream"});res.flushHeaders();
    const text=reply.message.content;
    for(let i=0;i<text.length;i+=45){if(res.destroyed)break;res.write(`data: ${JSON.stringify({choices:[{delta:{content:text.slice(i,i+45)},finish_reason:null}]})}\n\n`);await delay(55);}
    if(!res.destroyed){res.write(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:"stop"}],usage:{prompt_tokens:40,completion_tokens:30}})}\n\ndata: [DONE]\n\n`);res.end();}
  }catch{if(!res.headersSent)json(res,{error:"local fixture failed"},500);else res.end();}
});
mock.listen(modelPort,"127.0.0.1");await once(mock,"listening");
const plugin={name:"agent-isolated-host",configureServer(vite){vite.middlewares.use("/__dev",async(req,res)=>{
  try{
    if(req.url.startsWith("/host/"))return hostRequest(host,req.url.slice(6),req,res);
    const body=await read(req);
    if(req.url==="/config")return json(res,{});
    if(req.url==="/secret/set"){assert.equal(new URL(body.boundBaseUrl).origin,modelOrigin);secrets.set(body.slot,body);await fs.writeFile(secretFile,JSON.stringify(Object.fromEntries(secrets)));return json(res,null);}
    if(req.url==="/secret/remove"){secrets.delete(body.slot);await fs.writeFile(secretFile,JSON.stringify(Object.fromEntries(secrets)));return json(res,null);}
    if(req.url==="/secret/has")return json(res,{configured:secrets.has(body.slot),boundBaseUrl:secrets.get(body.slot)?.boundBaseUrl??null});
    assert.equal(new URL(body.url).origin,modelOrigin);
    if(req.url==="/llm/get"){const upstream=await fetch(body.url);return json(res,{status:upstream.status,body:await upstream.text()});}
    if(req.url==="/llm/stream"){res.writeHead(200,{"Content-Type":"application/x-ndjson"});res.flushHeaders();const controller=new AbortController();res.on("close",()=>controller.abort());await relayStream({...body,key:"fake-ui-key",signal:controller.signal},event=>res.write(JSON.stringify(event)+"\n"));return res.end();}
    json(res,{error:"unexpected isolated route"},404);
  }catch(error){if(!res.headersSent)json(res,{code:"fixture",message:String(error)},500);else res.end();}
});}};
server=await createServer({root,configFile:false,envDir:false,cacheDir:path.join(isolated,"vite"),plugins:[react(),plugin],logLevel:"warn",define:{__APP_VERSION__:JSON.stringify(version)},server:{host:"127.0.0.1",port,strictPort:true,hmr:false,watch:{ignored:["**/target/**","**/.cache/**","**/output/**","**/src-tauri/**"]}}});await server.listen();
browser=await chromium.launch({channel:"msedge"});context=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true,deviceScaleFactor:2,locale:"zh-CN",reducedMotion:"reduce"});
await context.route("**/*",route=>{
  const url=new URL(route.request().url());
  if(url.origin===origin)return route.continue();
  if(url.href.startsWith("https://api.github.com/repos/wangyingxuan383-ai/lishi-chuanyue/releases?"))return route.fulfill({status:200,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify([{tag_name:`v${releaseVersion}`,name:`历史穿越 ${releaseVersion}`,body:"- 原著查证与持续生成。",draft:false,prerelease:false,html_url:`https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/tag/v${releaseVersion}`,published_at:"2026-10-24T00:00:00Z",assets:[{name:`chuanyue-${releaseVersion}.apk`,size:1000000,digest:`sha256:${"7".repeat(64)}`,browser_download_url:`https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/download/v${releaseVersion}/chuanyue-${releaseVersion}.apk`}]}])});
  errors.push(`blocked outside fixture: ${url.origin}${url.pathname}`);return route.abort();
});
async function newPage(){page=await context.newPage();page.setDefaultTimeout(20000);page.on("pageerror",error=>errors.push(error.message));await page.goto(origin);await page.waitForFunction(()=>!!window.__lishi?.game,{timeout:90000});}
async function home(){await page.reload();await page.waitForFunction(()=>!!window.__lishi?.game);await page.getByRole("button",{name:/^(开始穿越|开始新的故事)$/}).waitFor();}
async function open(title){await home();await page.getByRole("button",{name:`继续“${title}”`,exact:true}).click();await page.locator(".story .turn[data-node-id]").first().waitFor();await delay(180);}
async function settled(){await page.getByRole("button",{name:"停止",exact:true}).waitFor({state:"hidden",timeout:30000});await delay(350);}
const scroll=()=>page.locator(".story").evaluate(el=>({top:el.scrollTop,height:el.scrollHeight,client:el.clientHeight,gap:el.scrollHeight-el.scrollTop-el.clientHeight}));
const anchor=()=>page.locator(".story").evaluate(el=>{const top=el.getBoundingClientRect().top;const p=[...el.querySelectorAll(".story-text p")].find(p=>p.getBoundingClientRect().bottom>top+2);return{top:el.scrollTop,text:p?.textContent,y:p?.getBoundingClientRect().top};});
async function send(text){await page.locator(".inputbar textarea").fill(text);await page.locator(".send-btn").click();await page.getByRole("button",{name:"停止",exact:true}).waitFor();}
async function reading(enabled){await home();await page.getByRole("button",{name:/^设置/}).click();await page.getByRole("button",{name:/^阅读与外观/}).click();const row=page.locator(".setting",{has:page.getByText("生成时自动滚动",{exact:true})});await row.getByRole("button",{name:enabled?"开":"关",exact:true}).click();await shot(enabled?"reading-on":"reading-off");}

let phases=[
  ["connect-and-seed",async()=>{
    await newPage();await page.getByRole("button",{name:/^(开始穿越|服务商：)/}).first().waitFor();if(await page.getByRole("button",{name:"开始穿越",exact:true}).isVisible())await page.getByRole("button",{name:"开始穿越",exact:true}).click();await connectFake(page,{port:modelPort,model:"fake-agent"});await page.getByRole("button",{name:/随便穿/}).waitFor();
    await page.locator(".template-card").first().click();check("new story defaults to Agent",await page.getByRole("group",{name:"执行方式"}).getByRole("button",{name:"Agent",exact:true}).getAttribute("aria-pressed")==="true");await shot("new-game-agent");
    fixture=await page.evaluate(async()=>{
      const {game}=window.__lishi;const {sampleState}=await import("/src/engine/testing/fixtures.ts");const {saveBook}=await import("/src/engine/sources/library.ts");
      const book={id:crypto.randomUUID(),title:"青石桥短篇",format:"txt",createdAt:new Date().toISOString(),sections:[{title:"第一章 青石桥",text:"阿青是阿白的姐姐。阿白应称她为阿姊。青铜钥匙藏在灯座下。阿兰在原著此夜遇害。"},{title:"第二章 夜访",text:"阿白又名小白。阿青将青铜钥匙交给阿白，约在青石桥会面。"},{title:"第三章 雪",text:"隐藏身份：阿白其实是北地王子。后来的太师之位属于他。"}]};await saveBook(game.repo,book);
      const base=()=>{const s=sampleState();s.version=2;s.era={mode:"free",clockStyle:"elapsed",packId:null,currency:{units:[{name:"文",value:1}]}};s.time={start:"书铺初日",elapsedMinutes:0,startHour:8};s.protagonist.name="沈行";s.protagonist.identity="书铺旅人";return s;};
      const common={mode:"free",pilot:"player",chapterEvery:0,autoUpkeep:false,choiceCount:3,fortune:"off",premise:"青石桥边的书铺。玩家已经救下阿兰，此事作为本局分支保留。"};
      const long=await game.repo.createWorld({title:"长篇阅读验证",eraId:"free",settings:common,opening:{parentId:null,kind:"opening",narrative:"阅读开场。",state:base()}});let head=long.node;
      for(let i=1;i<=35;i++){const state=base();state.time.elapsedMinutes=i*5;head=await game.repo.appendNode(long.world.id,long.line.id,{parentId:head.id,kind:"turn",actionMode:"continue",actionText:"",narrative:Array.from({length:12},(_,j)=>`旧回合${i}第${j+1}段：窗外雨声疏密交替，书铺里的人按自己的经历说话，灯火映着桌上的纸页。`).join("\n\n"),record:{time:5},choices:["看看窗外","继续读书","听听雨声"],state});}
      const state=base();state.source={bookId:book.id,fanfic:true,plot:"rewrite",through:1,position:1,instructions:"核对称谓、亲属关系和钥匙。玩家已明确救下阿兰，保留这条改写。不要泄露第二章之后的身份。",method:"search"};state.people=[{id:"qing",name:"阿青",aliases:[],role:"书铺主人",attitude:"友善",notes:[],alive:true},{id:"lan",name:"阿兰",aliases:[],role:"本局被玩家救下的朋友",attitude:"友善",notes:["玩家明确改写：已救下阿兰"],alive:true}];state.facts=[{id:"branch",detail:"玩家已救下阿兰",origin:"player",citations:[]}];
      const canon=await game.repo.createWorld({title:"原著纠错验证",eraId:"free",settings:common,opening:{parentId:null,kind:"opening",narrative:"你救下阿兰，回到青石桥书铺。",state}});
      const wrong=await game.repo.appendNode(canon.world.id,canon.line.id,{parentId:canon.node.id,kind:"turn",actionMode:"say",actionText:"和阿白核对信物",narrative:"阿白唤阿青阿兄，二人自称表兄弟。银钥匙藏在柜子里。阿兰仍在你救下的书铺养伤。",record:{time:5},state});const later=await game.repo.appendNode(canon.world.id,canon.line.id,{parentId:wrong.id,kind:"turn",actionMode:"continue",narrative:"原路线后续：你与阿兰约定明日见面。",record:{time:5},state});
      const agentState=structuredClone(state);agentState.executionMode="agent";const agent=await game.repo.createWorld({title:"Agent接管验证",eraId:"free",settings:common,opening:{parentId:null,kind:"opening",narrative:"阿兰已经获救，你们在书铺核对人物与钥匙。",state:agentState}});
      const interrupted=await game.repo.createWorld({title:"续写验证",eraId:"free",settings:common,opening:{parentId:null,kind:"opening",narrative:"你在书铺等候。",state:base()}});await game.repo.appendNode(interrupted.world.id,interrupted.line.id,{parentId:interrupted.node.id,kind:"turn",actionMode:"continue",narrative:"这段尚未写完的书铺正文：",status:"interrupted",state:base()});
      const observer=await game.repo.createWorld({title:"连播验证",eraId:"free",settings:{...common,pilot:"ai"},opening:{parentId:null,kind:"opening",narrative:"主角在书铺准备自行行动。",state:base()}});
      await game.repo.setSetting("tip:longPress",true);await game.repo.setSetting("notifAsked",true);await game.repo.setSetting("whatsNewSeen",["0.11.1"]);return{bookId:book.id,long:long.world.id,canon:canon.world.id,canonLine:canon.line.id,wrong:wrong.id,later:later.id,opening:canon.node.id,agent:agent.world.id,interrupted:interrupted.world.id,observer:observer.world.id};
    });await fs.writeFile(path.join(isolated,"fixture.json"),JSON.stringify(fixture));check("legacy story stores no executionMode and stays classic",await page.evaluate(async id=>{const {game}=window.__lishi;const tree=await import("/src/engine/tree.ts");const s=await game.repo.getState((await tree.cursor(game.repo,id)).head.id);return s.executionMode===undefined;},fixture.long));
  }],
  ["update-dots",async()=>{
    await home();await page.getByRole("button",{name:"设置，有新版本",exact:true}).waitFor();check("home uses a red dot",await page.locator(".update-mark .update-dot").count()===1);await shot("home-update-dot");
    await page.reload();await page.getByRole("button",{name:"设置，有新版本",exact:true}).waitFor();check("red dot survives restart",true);await page.getByRole("button",{name:"设置，有新版本",exact:true}).click();await page.getByRole("button",{name:"关于与更新，有新版本",exact:true}).waitFor();await shot("settings-update-dot");await page.getByRole("button",{name:"关于与更新，有新版本",exact:true}).click();check("visiting About does not mark the release read",await page.locator(".status-card .update-dot").count()===1);await shot("about-update-dot");
    await page.getByRole("button",{name:"去更新",exact:true}).click();await page.getByText(/下载较慢时，建议开启代理/).waitFor();check("update details preserve proxy reminder",true);await shot("update-detail-proxy");await page.locator(".sheet-close").last().click();await page.waitForFunction(()=>!document.querySelector(".status-card .update-dot"));check("opening release details clears that version",true);
    releaseVersion="0.99.2";await page.getByRole("button",{name:"检查更新",exact:true}).click();await page.locator(".status-card .update-dot").waitFor();check("new release gets a new red dot",true);
  }],
  ["default-reading-position",async()=>{
    await reading(false);await open("长篇阅读验证");check("more than 30 turns are loaded",await page.locator(".turn[data-node-id]").count()>=30);await page.locator(".story").evaluate(el=>el.scrollTop=el.scrollHeight-el.clientHeight-250);await delay(100);const before=await anchor();slow=true;await send("阅读位置验证，不触屏等到结束");const samples=[];while(await page.getByRole("button",{name:"停止",exact:true}).isVisible()){samples.push(await anchor());await delay(100);}await settled();samples.push(await anchor());check("default off: untouched generation and completion retain text position",samples.every(s=>s.text===before.text&&Math.abs(s.y-before.y)<=2),{before,after:samples.at(-1),maxDelta:Math.max(...samples.map(s=>Math.abs(s.y-before.y)))});await shot("reading-stable-after-36");
  }],
  ["follow-pause-and-arrow",async()=>{
    const measured=results.find(r=>r.name==="arrow jumps once and does not enable following when off"&&!r.ok)?.detail;
    if(measured){check("arrow jumps once and does not enable following when off",measured.end.gap>100&&measured.end.top>measured.arrow.top+300,{...measured,note:"250ms sample was during smooth movement; final viewport remains above new text"});slow=false;return;}
    await reading(true);await open("长篇阅读验证");await send("打开跟随验证");await settled();check("enabled reading follows to bottom",(await scroll()).gap<100);
    await send("上滑暂停验证");await delay(450);await page.locator(".story").evaluate(el=>el.scrollTop-=650);await delay(100);const paused=await anchor();await settled();const after=await anchor();check("manual upward scroll pauses following",paused.text===after.text&&Math.abs(paused.y-after.y)<=2,{paused,after});
    await reading(false);await open("长篇阅读验证");await page.locator(".story").evaluate(el=>el.scrollTop-=650);await send("关闭跟随时箭头只跳一次");await delay(350);const start=await scroll();await page.getByRole("button",{name:"回到底部 ↓"}).click();await delay(250);const arrow=await scroll();await settled();const end=await scroll();check("arrow jumps once and does not enable following when off",end.gap>100&&end.top>start.top+300,{start,arrow,end});slow=false;
  }],
  ["regenerate-continue-autoplay",async()=>{
    await open("长篇阅读验证");await page.getByRole("button",{name:"重说",exact:true}).click();await settled();check("regenerate keeps another version",await page.getByRole("button",{name:"上一版",exact:true}).count()===1);
    await open("续写验证");await page.getByRole("button",{name:"续写",exact:true}).click();await settled();check("interrupted continuation commits the original passage",await page.getByText("这段没有写完。",{exact:false}).count()===0);
    await open("连播验证");const result=await page.evaluate(async id=>{const {game}=window.__lishi;const events=[];const h=game.autoplay(id,{turns:2},e=>events.push(e.type));const value=await h.done;return{...value,events};},fixture.observer);check("native autoplay completes two passages",result.steps===2&&result.reason==="count",result);await shot("autoplay-complete");
  }],
  ["canon-correction-preview-and-branch",async()=>{
    await open("原著纠错验证");const target=page.locator(`[data-node-id="${fixture.wrong}"]`);await target.scrollIntoViewIfNeeded();await target.dispatchEvent("pointerdown",{pointerType:"touch",button:0,clientX:100,clientY:200});await delay(500);await target.dispatchEvent("pointerup",{pointerType:"touch",button:0});await page.getByRole("button",{name:"AI 改写",exact:true}).click();await page.getByRole("button",{name:"按原著纠错",exact:true}).waitFor();check("bound-book rewrite defaults to canon correction",await page.getByRole("button",{name:"按原著纠错",exact:true}).getAttribute("aria-pressed")==="true");await shot("canon-options");await page.getByRole("button",{name:"生成改稿",exact:true}).click();await page.getByRole("button",{name:"采用改稿",exact:true}).waitFor({timeout:30000});check("whole-turn preview and original citations are visible",(await page.getByLabel("改稿预览").inputValue()).includes("阿姊")&&(await page.locator(".writing-assist").textContent()).includes("青铜钥匙藏在灯座下。"));await shot("canon-citations-preview");await page.getByRole("button",{name:"采用改稿",exact:true}).click();await page.locator(".writing-assist").waitFor({state:"hidden"});
    const state=await page.evaluate(async f=>{const {game}=window.__lishi;const tree=await import("/src/engine/tree.ts");const c=await tree.cursor(game.repo,f.canon);return{head:c.head,line:c.line,old:await game.repo.getLine(f.canonLine),facts:await game.repo.getState(c.head.id),later:await game.repo.getNode(f.later)};},fixture);check("adopting early correction preserves old route and later passage",state.line.id!==fixture.canonLine&&state.old.nodeId===fixture.later&&state.later.narrative.includes("原路线后续"));check("new route stops at corrected turn and keeps player rescue",state.head.parentId===fixture.opening&&state.head.narrative.includes("阿兰")&&state.facts.people.find(p=>p.name==="阿兰")?.alive===true);
    await shot("canon-revision-route");const reference=state.head.meta.reference;check("reference provenance is inspectable and chapter bounded",reference.binding.through===1&&reference.passages.some(p=>p.kind==="original")&&reference.passages.every(p=>p.section<=1));
    const opening=page.locator(`[data-node-id="${fixture.opening}"]`);await opening.scrollIntoViewIfNeeded();await opening.dispatchEvent("pointerdown",{pointerType:"touch",button:0,clientX:100,clientY:200});await delay(500);await opening.dispatchEvent("pointerup",{pointerType:"touch",button:0});await page.getByRole("button",{name:"AI 改写",exact:true}).click();await page.getByText(/这个旧开场没有保存初始信息/).waitFor();await shot("legacy-opening-baseline");await page.locator(".sheet-close").last().click();
  }],
  ["agent-tools-detach-reattach",async()=>{
    if(!globalThis.__r16ConsumeComposition){
      const previous=replyFor;globalThis.__r16ObservedRequests=[];
      replyFor=(body)=>{globalThis.__r16ObservedRequests.push({chars:JSON.stringify(body.messages??[]).length,containsHidden:JSON.stringify(body.messages??[]).includes("北地王子")});const last=body.messages?.at(-1);const call=body.messages?.flatMap(m=>m.tool_calls??[]).find(c=>c.id===last?.tool_call_id);if((body.tools??[]).some(t=>t.function?.name==="commit_turn")&&last?.role==="tool"&&["compose_draft","check_draft"].includes(call?.function?.name)){const value=JSON.parse(last.content);const content=value.text??"";const record=JSON.parse(content.split("<record>")[1].split("</record>")[0]);return{kind:"agent-commit-call",message:calls([["commit_turn",{narrative:content.split("<record>")[0],record}]])};}return previous(body);};globalThis.__r16ConsumeComposition=true;
    }
    slow=false;await open("Agent接管验证");holdCompose=true;const started=new Promise(resolve=>composeStarted=resolve);const before=await page.evaluate(async id=>Number((await window.__lishi.game.platform.sql.query("SELECT COUNT(*) AS n FROM usage WHERE world_id=?",[id]))[0].n),fixture.agent);await send("核实称谓、姐弟关系和钥匙，继续保留我救下阿兰的改写");await started;await page.close();await newPage();await page.getByRole("button",{name:"继续“Agent接管验证”",exact:true}).click();await page.getByRole("button",{name:"停止",exact:true}).waitFor();check("returning page attaches to the still-running native Agent",true);releaseCompose();await settled();
    const result=await page.evaluate(async id=>{const {game}=window.__lishi;const tree=await import("/src/engine/tree.ts");const c=await tree.cursor(game.repo,id);const rows=await game.platform.sql.query("SELECT id,purpose FROM usage WHERE world_id=?",[id]);const runs=await game.platform.sql.query("SELECT budget_json FROM execution_runs WHERE world_id=? AND status='committed'",[id]);const steps=await game.platform.sql.query("SELECT kind FROM execution_steps WHERE run_id=(SELECT id FROM execution_runs WHERE world_id=? AND status='committed' LIMIT 1)",[id]);return{node:c.head,usage:rows.length,unique:new Set(rows.map(r=>r.id)).size,budget:JSON.parse(runs[0].budget_json),steps:steps.map(s=>s.kind),state:await game.repo.getState(c.head.id)};},fixture.agent);
    check("Agent reads skill/original and composes then commits through SDK",["read_skill","search_original","read_original","compose_draft","commit_turn"].every(k=>result.steps.includes(k)),result.steps);check("reattached Agent commits once without duplicate usage",result.node.narrative.includes("阿姊")&&result.usage===result.unique&&result.usage-before===result.budget.modelRequests,{usage:result.usage,budget:result.budget});check("Agent keeps the player branch and does not leak later identity",result.state.people.find(p=>p.name==="阿兰")?.alive===true&&!result.node.narrative.includes("北地王子"));await shot("agent-returned-complete");
    check("scoped original search never sends the hidden third chapter",globalThis.__r16ObservedRequests.length>0&&!globalThis.__r16ObservedRequests.some(r=>r.containsHidden));check("no page errors",errors.length===0,errors);
  }],
];
try{
  for(;phaseIndex<phases.length;phaseIndex++){
    const [name,run]=phases[phaseIndex];
    for(;;){try{console.log(`CHECKPOINT ${phaseIndex} ${name}`);await phases[phaseIndex][1]();await save();break;}catch(error){console.log(`CHECKPOINT_FAILED ${phaseIndex} ${name}: ${String(error.stack??error)}`);await shot(`failure-${phaseIndex}`).catch(()=>{});await save();const terminal=readline.createInterface({input:process.stdin,output:process.stdout});const answer=await new Promise(resolve=>terminal.question('Enter "resume" after the targeted fix, or "quit": ',resolve));terminal.close();if(answer.trim()!=="resume")throw error;const source=await fs.readFile(import.meta.filename,"utf8");const block=source.split("let phases=[\n")[1].split("\n];\ntry{")[0];phases=eval(`[${block}]`);}}
  }
  console.log(`COMPLETE ${results.length} checks; ${requests.length} local simulated requests; 0 real requests`);await save();
}finally{releaseCompose?.();await browser?.close();await server?.close();host.close();mock.close();}
