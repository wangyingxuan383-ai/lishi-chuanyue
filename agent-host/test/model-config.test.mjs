import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { boundModelFetch, modelRequestUrl, modelTransport } from "../src/model-config.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiHost } from "../src/host.mjs";

const transport = (protocol, baseUrl = "https://service.invalid/proxy/v1") => modelTransport({ protocol, baseUrl });
const blocked = (run) => assert.throws(run, error => error.code === "model_endpoint_not_bound");
const endpointRef = "a".repeat(64);

test("four fixed provider paths preserve their native authorized service prefix", () => {
  const chat = transport("chat-completions");
  assert.equal(chat.api, "openai-completions");
  assert.equal(modelRequestUrl(chat, `${chat.baseUrl}/chat/completions`), "https://service.invalid/proxy/v1/chat/completions");
  const responses = transport("openai-responses");
  assert.equal(responses.api, "openai-responses");
  assert.equal(modelRequestUrl(responses, `${responses.baseUrl}/responses`), "https://service.invalid/proxy/v1/responses");
  const anthropic = transport("anthropic");
  assert.equal(anthropic.api, "anthropic-messages");
  assert.equal(modelRequestUrl(anthropic, `${anthropic.baseUrl}/v1/messages?beta=true`), "https://service.invalid/proxy/v1/messages?beta=true");
  assert.equal(modelRequestUrl(anthropic, `${anthropic.baseUrl}/v1/messages/count_tokens`), "https://service.invalid/proxy/v1/messages/count_tokens");
  const gemini = transport("gemini", "https://service.invalid/native/v1beta/");
  assert.equal(gemini.api, "google-generative-ai");
  assert.equal(modelRequestUrl(gemini, `${gemini.baseUrl}/models/gemini-fixture:streamGenerateContent?alt=sse`), "https://service.invalid/native/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse");
  // A v1 binding is not authorization to silently send its key to v1beta.
  blocked(() => modelRequestUrl(transport("gemini"), "https://service.invalid/proxy/v1beta/models/gemini-fixture:streamGenerateContent"));
});

test("full endpoint bindings and custom Anthropic prefixes do not duplicate route segments", () => {
  for (const [protocol, base, sdkSuffix] of [
    ["chat-completions", "/v1/chat/completions", "/chat/completions"],
    ["openai-responses", "/v1/responses", "/responses"],
    ["anthropic", "/proxy/v1/messages", "/v1/messages"],
    ["anthropic", "/proxy/anthropic", "/v1/messages"],
  ]) {
    const current = transport(protocol, `https://service.invalid${base}`);
    const expected = protocol === "anthropic" && base === "/proxy/anthropic" ? `${base}/messages` : base;
    assert.equal(modelRequestUrl(current, `${current.baseUrl}${sdkSuffix}`), `https://service.invalid${expected}`);
  }
  const origin = transport("anthropic", "https://service.invalid");
  assert.equal(modelRequestUrl(origin, "https://service.invalid/v1/messages"), "https://service.invalid/v1/messages");
});

test("native endpoint grants map only each fixed SDK generation route onto its exact saved address", () => {
  for (const [protocol,suffix,query] of [
    ["chat-completions","/chat/completions",""],
    ["openai-responses","/responses",""],
    ["anthropic","/v1/messages","?beta=true"],
    ["gemini","/models/owned-model:streamGenerateContent","?alt=sse"],
    ["gemini","/models/owned-model:generateContent",""],
  ]) {
    const saved="https://service.invalid/proxy/v1/custom_generation";
    const current=modelTransport({protocol,baseUrl:saved,endpointRef,id:"models/owned-model"});
    assert.equal(modelRequestUrl(current,`${saved}${suffix}${query}`),`${saved}${query}`);
    for (const path of ["/arbitrary","/v1/messages/count_tokens","/chat/completions/other","/models/other-model:streamGenerateContent"]) {
      blocked(()=>modelRequestUrl(current,`${saved}${path}`));
    }
    blocked(()=>modelRequestUrl(current,`${saved}${suffix}?api_key=fixture-secret`));
    blocked(()=>modelRequestUrl(current,`${saved}${suffix}?unknown=1`));
    blocked(()=>modelRequestUrl(current,`https://other.invalid/proxy/v1/custom_generation${suffix}`));
    blocked(()=>modelRequestUrl(current,`${saved}/../outside${suffix}`));
    blocked(()=>modelRequestUrl(current,`${saved}%2f..%2foutside${suffix}`));
    blocked(()=>modelRequestUrl(current,`${saved}`));
  }
});

test("an ungranted custom path is not treated as a complete endpoint and malformed grants are rejected", () => {
  const saved="https://service.invalid/proxy/v1/custom_generation";
  assert.equal(modelRequestUrl(transport("chat-completions",saved),`${saved}/chat/completions`),`${saved}/chat/completions`);
  for (const marker of ["", "not-a-locator", "A".repeat(64), 1, {}]) {
    assert.throws(()=>modelTransport({protocol:"chat-completions",baseUrl:saved,endpointRef:marker}),error=>error.code==="invalid_model_base");
  }
  for (const id of [undefined,"","../other-model","models/a%2f..%2fother-model","owned?query","owned#fragment"]) {
    assert.throws(()=>modelTransport({protocol:"gemini",baseUrl:saved,endpointRef,id}),error=>error.code==="invalid_model_base");
  }
});

test("Gemini exact-endpoint transport preserves the checked SDK model identity across the private native bridge", async () => {
  const saved="https://service.invalid/proxy/v1/custom_generation";
  const current=modelTransport({protocol:"gemini",baseUrl:saved,endpointRef,id:"models/owned-model"});
  const controller=new AbortController();
  const request=new Request(`${saved}/models/owned-model:streamGenerateContent?alt=sse`,{
    method:"POST",headers:{"content-type":"application/json","x-lishi-pi-model":"forged"},
    body:JSON.stringify({contents:[{role:"user",parts:[{text:"owned fixture"}]}]}),signal:controller.signal,
  });
  let called=0;
  const fake=boundModelFetch(current,async(input,options)=>{
    called++;
    const actual=new Request(input,options);
    assert.equal(actual.url,`${saved}?alt=sse`);
    assert.equal(Buffer.from(actual.headers.get("x-lishi-pi-model"),"base64").toString("utf8"),"models/owned-model");
    assert.equal(actual.headers.get("content-type"),"application/json");
    assert.deepEqual(await actual.json(),{contents:[{role:"user",parts:[{text:"owned fixture"}]}]});
    controller.abort(); assert.equal(actual.signal.aborted,true);
    return new Response("fixture");
  });
  assert.equal(await(await fake(request)).text(),"fixture");
  assert.equal(called,1);
  blocked(()=>fake(`${saved}/models/other-model:streamGenerateContent?alt=sse`,{method:"POST",body:"{}"}));
  assert.equal(called,1);
});

test("the complete pinned providers construct only the mapped generation paths for granted custom endpoints", async () => {
  // Native transport fixture only: deliberately returns a non-retryable 400
  // before any network send. This checks the actual SDK URL constructors.
  for (const protocol of ["chat-completions","openai-responses","anthropic","gemini"]) {
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),"lishi-custom-model-"));
    const saved="https://service.invalid/proxy/v1/custom_generation";
    const starts=[]; let read=false, host;
    try {
      host=await PiHost.create({ directory, model:{ id:"owned-model",protocol,baseUrl:saved,endpointRef,apiKey:"in-memory-fixture-only",inputTokens:12000,maxOutputTokens:256 },
        tools:[],systemPrompt:"isolated provider transport check",nativeModelHttp:true,invokeTool:async()=>({ok:false,error:{code:"not_used"}}),
        invokeModelHttp:async(action,args)=>{
          if(action==="start") { starts.push(args); return {ok:true,data:{status:400,headers:[["content-type","application/json"]]}}; }
          if(action==="read") { if(read) return {ok:true,data:{done:true}}; read=true; return {ok:true,data:{done:false,chunk:Buffer.from(JSON.stringify({error:{message:"non-retryable local fixture",type:"invalid_request_error"}})).toString("base64")}}; }
          return {ok:true,data:{}};
        },
      });
      await host.prompt("fixture","owned-transport-task").catch(()=>{});
      assert.equal(starts.length,1,`${protocol} did not reach its one native mock admission`);
      const request=starts[0], actual=new URL(request.url);
      assert.equal(actual.origin+actual.pathname,saved,protocol);
      if(protocol==="gemini") {
        const proof=request.headers.find(([name])=>name==="x-lishi-pi-model");
        assert.equal(Buffer.from(proof[1],"base64").toString("utf8"),"owned-model");
      } else {
        assert.equal(JSON.parse(Buffer.from(request.body,"base64").toString("utf8")).model,"owned-model");
      }
    } finally { await host?.close(); await fs.rm(directory,{recursive:true,force:true}); }
  }
});

test("origin, prefix and recursively decoded traversal are checked before invoking fetch", () => {
  const current = transport("chat-completions");
  const target = path => `https://service.invalid${path}`;
  for (const url of [
    "https://other.invalid/proxy/v1/chat/completions", "http://service.invalid/proxy/v1/chat/completions",
    "https://service.invalid:444/proxy/v1/chat/completions", "https://user:password@service.invalid/proxy/v1/chat/completions",
    "file:///proxy/v1/chat/completions", "//other.invalid/proxy/v1/chat/completions",
    target("/proxy/v11/chat/completions"), target("/proxy/v1/../outside"),
    target("/proxy/v1/%2e%2e/outside"), target("/proxy/v1/%252e%252e%252foutside"),
    target("/proxy/v1%2f..%2foutside"), target("/proxy/v1/%255c..%255c..%255coutside"),
    target("/proxy/v1/chat/completions#fragment"), target("/proxy/v1/%00evil"),
  ]) blocked(() => modelRequestUrl(current, url));
  assert.equal(modelRequestUrl(current, target("/proxy/v1/models/a%2Fb")), target("/proxy/v1/models/a%2Fb"));
  let calls = 0;
  const fake = boundModelFetch(current, () => { calls++; return Promise.resolve(new Response("local")); });
  blocked(() => fake("https://other.invalid/proxy/v1/chat/completions"));
  assert.equal(calls, 0);
});

test("invalid configured bases never echo a credential or accept an unknown protocol", () => {
  for (const baseUrl of ["https://fixture-secret@service.invalid/v1", "https://service.invalid/v1?key=fixture-secret", "ftp://service.invalid/v1", "invalid-fixture-secret"]) {
    assert.throws(() => modelTransport({ protocol: "chat-completions", baseUrl }), error => {
      assert.equal(error.code, "invalid_model_base");
      assert.ok(!error.message.includes("fixture-secret"));
      return true;
    });
  }
  assert.throws(() => transport("unknown"), error => error.code === "invalid_model_base");
});

test("fetch keeps request body, opaque signatures, headers and cancellation while disabling redirects", async () => {
  const current = transport("anthropic");
  const controller = new AbortController();
  const body = { opaque: { thoughtSignature: "fixture-signature", encrypted_content: "fixture-encrypted" }, messages: [] };
  const request = new Request(`${current.baseUrl}/v1/messages?beta=true`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "fake-local-fixture-only" },
    body: JSON.stringify(body), signal: controller.signal, redirect: "follow",
  });
  let forwarded;
  const fake = boundModelFetch(current, async (input, options) => {
    forwarded = input;
    assert.equal(input.url, "https://service.invalid/proxy/v1/messages?beta=true");
    assert.equal(input.method, "POST");
    assert.equal(input.headers.get("x-api-key"), "fake-local-fixture-only");
    assert.equal(options.redirect, "error");
    assert.deepEqual(await input.clone().json(), body);
    return new Response("local-only");
  });
  assert.equal(await (await fake(request, { redirect: "follow" })).text(), "local-only");
  controller.abort();
  assert.equal(forwarded.signal.aborted, true);
});

test("async-local model scopes survive a returned stream and keep concurrent/tool requests separate", () => {
  // Isolate the process-wide hook. The delegate below is a pure function; no
  // real/global network implementation is reachable from this child.
  const script = `
    import assert from "node:assert/strict";
    const sent = [];
    globalThis.fetch = async (input, options) => {
      sent.push({url: typeof input === "string" ? input : input.url, redirect: options?.redirect});
      return new Response("fixture");
    };
    const {modelTransport, withModelTransport} = await import(${JSON.stringify(new URL("../src/model-config.mjs", import.meta.url).href)});
    const wait = () => new Promise(resolve => setTimeout(resolve, 2));
    const a = modelTransport({protocol:"chat-completions",baseUrl:"https://service.invalid/a/v1"});
    const b = modelTransport({protocol:"anthropic",baseUrl:"https://service.invalid/b/v1"});
    const stream = (scope, path, wrong) => withModelTransport(scope, () => {
      // Pi's adapter returns an event stream before this async request starts.
      const done = (async () => {
        await wait();
        await fetch(path, {redirect:"follow"});
        await wait();
        assert.throws(() => fetch(wrong), error => error.code === "model_endpoint_not_bound");
      })();
      return {done};
    });
    const left = stream(a, "https://service.invalid/a/v1/chat/completions", "https://service.invalid/b/v1/v1/messages");
    const right = stream(b, "https://service.invalid/b/v1/v1/messages", "https://service.invalid/a/v1/chat/completions");
    await Promise.all([left.done, right.done]);
    // Compaction is another async model request through the same entry.
    await withModelTransport(a, async () => { await wait(); await fetch("https://service.invalid/a/v1/chat/completions"); });
    await fetch("https://tools.invalid/outside", {redirect:"manual"});
    assert.deepEqual(sent.map(item => item.url).sort(), [
      "https://service.invalid/a/v1/chat/completions", "https://service.invalid/a/v1/chat/completions",
      "https://service.invalid/b/v1/messages", "https://tools.invalid/outside"
    ].sort());
    assert.equal(sent.filter(item => item.redirect === "error").length, 3);
    assert.equal(sent.find(item => item.url.startsWith("https://tools.invalid")).redirect, "manual");
    // An additional ESM copy must reuse the one installed guard and scope.
    const another = await import(${JSON.stringify(new URL("../src/model-config.mjs?duplicate", import.meta.url).href)});
    await another.withModelTransport(a, async () => { await wait(); await fetch("https://service.invalid/a/v1/chat/completions"); });
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});
