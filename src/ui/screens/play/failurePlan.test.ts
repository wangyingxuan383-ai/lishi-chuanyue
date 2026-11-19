import { diagnosis, recentDiagnosis, saidForCopy } from "../../components/FailureSheet";
import type { Failure, Platform } from "../../../platform";
import { describe, expect, it } from "vitest";
import type { FailReason } from "../../../engine/game";
import { failurePlan } from "./useGeneration";

const ALL: FailReason[] = ["network", "timeout", "stream", "http", "auth", "quota", "context", "refused", "empty", "format", "review", "settle", "stale", "busy", "system_stop", "interrupted", "cancelled", "limit", "setup", "storage", "unsupported", "other"];

describe("one main action per failure (R30, D166)", () => {
  it("gives every kind exactly one labelled main action", () => {
    for (const reason of ALL) for (const hasRun of [true, false]) {
      const plan = failurePlan(reason, hasRun);
      expect(plan.label, reason).toBeTruthy();
      expect(["continue", "redo", "fresh", "settings", "wait"]).toContain(plan.main);
    }
  });

  it("continues interruptions, asks again after a bad answer, and sends settings problems to settings", () => {
    for (const reason of ["network", "timeout", "stream", "system_stop", "interrupted", "limit"] as const) expect(failurePlan(reason, true)).toMatchObject({ main: "continue", label: "接着写完" });
    for (const reason of ["refused", "empty", "format", "review", "settle"] as const) expect(failurePlan(reason, true).main).toBe("redo");
    expect(failurePlan("format", true).label).toBe("重试这一步");
    expect(failurePlan("empty", true).label).toBe("重新写这一段");
    expect(failurePlan("stale", true).main).toBe("fresh");
    expect(failurePlan("busy", false)).toMatchObject({ main: "wait", label: "等它结束再写" });
    // A busy story or a missing key was never a reason to replay a saved run.
    for (const reason of ["auth", "setup"] as const) expect(failurePlan(reason, true)).toMatchObject({ main: "settings", label: "去设置" });
    expect(failurePlan("quota", true).switchService).toBe(true);
    // Refused before any run existed: the same action is sent again.
    expect(failurePlan("network", false).main).toBe("fresh");
  });
});

it("keeps arbitrary service echoes out of both copied diagnoses", async () => {
  const failure: Failure = { kind: "http", stage: "write", sent: "yes", requests: 1, partial: false, status: 400,
    at: "2026-11-18T12:00:00Z", said: "private-fixture-echo", detail: "private-fixture-echo" };
  const sql = { query: async () => [{ failure_json: JSON.stringify(failure), kind: "turn" }] } as Pick<Platform["sql"], "query">;
  for (const text of [diagnosis(failure, []), await recentDiagnosis(sql)]) {
    expect(text).toContain("400");
    expect(text).not.toContain("private-fixture-echo");
  }
});

it("adds the service's words only when asked, short and without addresses or key-like strings", () => {
  const failure: Failure = { kind: "refused", stage: "write", sent: "yes", requests: 1, partial: false,
    at: "2026-11-18T12:00:00Z", said: `The prompt contains sensitive words. see https://relay.example/x key sk-abcdefghijklmnop ${"字".repeat(300)}` };
  expect(diagnosis(failure, [])).not.toContain("sensitive");
  const text = diagnosis(failure, [], true);
  expect(text).toContain("服务原话：The prompt contains sensitive words.");
  expect(text).not.toContain("relay.example");
  expect(text).not.toContain("abcdefghijklmnop");
  expect(saidForCopy("字".repeat(300))).toHaveLength(201);
});
