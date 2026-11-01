import { describe, it, expect } from "vitest";
import { importMcpConfiguration } from "./agent-mcp";

describe("remote MCP configuration import", () => {
  it("keeps credentials outside server config and imports nothing as authorized", () => {
    const imported = importMcpConfiguration(JSON.stringify({ mcpServers: { books: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer sample-private-token" } }, local: { command: "node", args: ["server.js"] } } }));
    expect(imported.servers).toHaveLength(1);
    expect(imported.servers[0]).toMatchObject({ enabled: false, allowedTools: [], readOnlyTools: [], allowResources: false });
    expect(JSON.stringify(imported.servers)).not.toContain("sample-private-token");
    expect(Object.values(imported.keys)).toEqual(["sample-private-token"]);
    expect(imported.issues[0]).toContain("本机进程");
  });
  it("reports unsupported headers and transport rather than partially enabling them", () => {
    const result = importMcpConfiguration(JSON.stringify({ servers: { custom: { url: "https://example.invalid/mcp", headers: { "X-Api-Key": "not-imported" } }, sse: { type: "sse", url: "https://example.invalid/sse" } } }));
    expect(result.servers).toEqual([]); expect(result.keys).toEqual({}); expect(result.issues).toHaveLength(2);
  });
});
