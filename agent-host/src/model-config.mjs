// Transport-only adaptation for the fixed Pi providers. Pi retains payloads,
// signatures, streaming, retries and compaction; no model loop lives here.
import { AsyncLocalStorage } from "node:async_hooks";

const APIS = Object.freeze({
  "chat-completions": "openai-completions",
  "openai-responses": "openai-responses",
  anthropic: "anthropic-messages",
  gemini: "google-generative-ai",
});
const FETCH_GATE = Symbol.for("lishi.pi.model-fetch-gate.v1");
const MODEL_PROOF_HEADER = "x-lishi-pi-model";

function invalid(code = "model_endpoint_not_bound") {
  const error = new Error(code === "invalid_model_base"
    ? "模型服务地址无效，请检查本机保存的服务与密钥绑定"
    : "模型请求超出所选服务的地址绑定，未发送请求");
  error.code = code;
  return error;
}

function urlOf(value, code) {
  let url;
  try { url = new URL(value); } catch { throw invalid(code); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw invalid(code);
  return url;
}

function scopePath(path) {
  // A server may decode escaped slashes/dots before routing. Check that view
  // too, so a model ID cannot hide ../ outside the bound prefix in escapes.
  let decoded = path;
  for (let i = 0; i < 8; i++) {
    let next;
    try { next = decodeURIComponent(decoded); } catch { throw invalid(); }
    if (next === decoded) break;
    decoded = next;
    if (i === 7) throw invalid();
  }
  if (/[?#\u0000-\u001f\u007f]/u.test(decoded)) throw invalid();
  const normalized = new URL(`https://bound.invalid${decoded}`);
  if (normalized.origin !== "https://bound.invalid") throw invalid();
  return normalized.pathname.replace(/\/+$/u, "");
}

export function modelTransport(model) {
  const protocol = model.protocol ?? "chat-completions";
  const api = APIS[protocol];
  if (!api) throw invalid("invalid_model_base");
  const bound = urlOf(model.baseUrl, "invalid_model_base");
  if (bound.search) throw invalid("invalid_model_base");
  bound.pathname = bound.pathname.replace(/\/+$/u, "");
  const baseUrl = bound.href.replace(/\/$/u, "");
  const boundPath = scopePath(bound.pathname);
  const fullEndpoint = model.endpointRef !== undefined && model.endpointRef !== null;
  if (fullEndpoint && (typeof model.endpointRef !== "string" || !/^[0-9a-f]{64}$/u.test(model.endpointRef))) throw invalid("invalid_model_base");
  const modelId = typeof model.id === "string" ? model.id : "";
  if (fullEndpoint && protocol === "gemini") {
    let decoded = modelId;
    if (!decoded || decoded.length > 512) throw invalid("invalid_model_base");
    for (let depth = 0; depth < 8; depth++) {
      let next;
      try { next = decodeURIComponent(decoded); } catch { throw invalid("invalid_model_base"); }
      if (next === decoded) break;
      decoded = next;
      if (depth === 7) throw invalid("invalid_model_base");
    }
    if (/[\\?#\u0000-\u001f\u007f]/u.test(decoded) || decoded.split("/").some(part => [".", ".."].includes(part))) throw invalid("invalid_model_base");
  }
  return Object.freeze({ protocol, api, baseUrl, origin: bound.origin, path: bound.pathname.replace(/\/+$/u, ""), boundPath, fullEndpoint, modelId });
}

function fullEndpointUrl(transport, url) {
  // Only the paths assembled by this pinned provider SDK are translated. A
  // request to an arbitrary child path cannot inherit the saved endpoint.
  let suffixes;
  switch (transport.protocol) {
    case "chat-completions": suffixes = ["/chat/completions"]; break;
    case "openai-responses": suffixes = ["/responses"]; break;
    case "anthropic": suffixes = ["/v1/messages"]; break;
    case "gemini": {
      const model = transport.modelId.replace(/^models\//u, "");
      suffixes = [`/models/${model}:streamGenerateContent`, `/models/${model}:generateContent`];
      break;
    }
    default: throw invalid();
  }
  if (!suffixes.some(suffix => url.pathname === new URL(`${transport.baseUrl}${suffix}`).pathname)) throw invalid();
  for (const [name, value] of url.searchParams) {
    if (!(transport.protocol === "gemini" && name === "alt" && value === "sse") &&
        !(transport.protocol === "anthropic" && name === "beta" && value === "true")) throw invalid();
  }
  url.pathname = transport.path || "/";
  return url;
}

export function modelRequestUrl(transport, input) {
  const inputUrl = typeof input === "string" || input instanceof URL ? input : input?.url;
  const url = urlOf(inputUrl);
  assertBound(transport, url);
  if (transport.fullEndpoint) {
    fullEndpointUrl(transport, url);
    assertBound(transport, url);
    return url.href;
  }
  // The locked Anthropic SDK concatenates /v1/messages to baseURL. The APP
  // binding is already the service prefix (/v1 or a custom proxy prefix).
  // Translate only that known SDK route, preserving beta/query parameters.
  if (transport.protocol === "anthropic") {
    const sdkPath = `${transport.path}/v1/messages`;
    if (url.pathname === sdkPath || url.pathname === `${sdkPath}/count_tokens`) {
      const endpoint = !transport.path ? "/v1/messages"
        : transport.path.endsWith("/messages") ? transport.path : `${transport.path}/messages`;
      url.pathname = endpoint + url.pathname.slice(sdkPath.length);
    }
  } else if (transport.protocol === "openai-responses" && transport.path.endsWith("/responses")
      && url.pathname === `${transport.path}/responses`) {
    url.pathname = transport.path;
  } else if (transport.protocol === "chat-completions" && transport.path.endsWith("/chat/completions")
      && url.pathname === `${transport.path}/chat/completions`) {
    url.pathname = transport.path;
  }
  assertBound(transport, url);
  return url.href;
}

function assertBound(transport, url) {
  const path = scopePath(url.pathname);
  if (url.origin !== transport.origin || !(path === transport.boundPath || path.startsWith(`${transport.boundPath}/`))) {
    throw invalid();
  }
}

/** Dependency injection is used only by pure local tests, never model input. */
export function boundModelFetch(transport, delegate) {
  return (input, options) => {
    const url = modelRequestUrl(transport, input);
    const original = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
    const request = input instanceof Request && url !== original ? new Request(url, input) : input;
    const next = { ...options, redirect: "error" };
    if (transport.fullEndpoint && transport.protocol === "gemini") {
      // The SDK carries Gemini's model in its original path rather than JSON.
      // Preserve that checked identity across the private native bridge. The
      // native host verifies and removes this header before its HTTP send.
      const headers = new Headers(options?.headers ?? (request instanceof Request ? request.headers : undefined));
      headers.set(MODEL_PROOF_HEADER, Buffer.from(transport.modelId, "utf8").toString("base64"));
      next.headers = headers;
    }
    return delegate(request instanceof Request ? request : url, next);
  };
}

function ensureFetchGuard() {
  let installed = globalThis[FETCH_GATE];
  if (!installed) {
    const original = globalThis.fetch;
    if (typeof original !== "function") throw invalid("invalid_model_base");
    const scopes = new AsyncLocalStorage();
    const guard = (input, options) => {
      const scope = scopes.getStore();
      return scope ? boundModelFetch(scope.transport, scope.delegate ?? original)(input, options) : original(input, options);
    };
    installed = { scopes, original, guard };
    Object.defineProperty(globalThis, FETCH_GATE, { value: installed });
    globalThis.fetch = guard;
  }
  if (globalThis.fetch !== installed.guard) throw invalid("invalid_model_base");
  return installed;
}

export function withModelTransport(transport, operation, delegate) {
  // Google in this fixed Pi version rejects a custom per-request fetch, but
  // calls global fetch. A single process hook with an async-local scope lets
  // that unmodified provider share the same bound-URL/redirect policy. Tool or
  // MCP network work outside this model scope retains its own native policy.
  const { scopes } = ensureFetchGuard();
  return scopes.run({ transport, delegate }, operation);
}
