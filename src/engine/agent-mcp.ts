import type { AgentNetwork } from "./agent";

type Server = NonNullable<AgentNetwork["mcps"]>[number];
/** Parse locally. Tokens stay separate until the existing secret-store save. */
export function importMcpConfiguration(text: string): { servers: Server[]; keys: Record<string, string>; issues: string[] } {
  if (text.length > 262144) throw new Error("配置超过256KiB，请只保留需要的远端服务。");
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error("配置不是有效JSON，请检查后重试。"); }
  const object = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const entries = object.mcpServers ?? object.servers;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("配置需要包含mcpServers或servers服务列表。");
  if (Object.keys(entries).length > 32) throw new Error("一次最多导入32项服务。");
  const servers: Server[] = [], keys: Record<string, string> = {}, issues: string[] = [];
  for (const [name, raw] of Object.entries(entries)) {
    const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const label = name.slice(0, 120);
    if (entry.command || entry.args || entry.env || entry.type === "stdio") { issues.push(`${label}：需要本机进程或环境变量，当前不支持。`); continue; }
    if (entry.type && !["http", "streamable-http", "streamableHttp"].includes(String(entry.type))) { issues.push(`${label}：传输方式不受支持，仅支持Streamable HTTP。`); continue; }
    let url: URL;
    try { url = new URL(String(entry.url ?? entry.serverUrl ?? "")); } catch { issues.push(`${label}：缺少有效的服务地址。`); continue; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => /^(?:key|api_?key|token|access_token|auth|password|secret)$/i.test(key)) || /\$\{|\{\{|<[^>]+>/.test(url.href)) { issues.push(`${label}：地址包含不支持的凭据、变量或协议。`); continue; }
    const headers = entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers) ? entry.headers as Record<string, unknown> : {};
    const names = Object.keys(headers);
    const authorization = names.find(key => key.toLowerCase() === "authorization");
    const bearer = authorization && typeof headers[authorization] === "string" ? /^Bearer\s+([^\r\n]+)$/i.exec(headers[authorization] as string)?.[1]?.trim() : undefined;
    if (names.some(key => key.toLowerCase() !== "authorization") || authorization && (!bearer || /\$\{|\{\{/.test(bearer))) { issues.push(`${label}：当前只支持明确填写的Bearer令牌，不支持额外请求头或变量。`); continue; }
    const id = crypto.randomUUID().slice(0, 12), slot = `agent-mcp-${id}`;
    servers.push({ id, name: label, url: url.href, ...(bearer ? { slot } : {}), enabled: false, allowedTools: [], readOnlyTools: [], allowResources: false, authorizationVersion: 1 });
    if (bearer) keys[slot] = bearer;
  }
  return { servers, keys, issues };
}
