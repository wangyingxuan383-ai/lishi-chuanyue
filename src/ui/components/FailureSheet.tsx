// 查看原因 (R30-T005): why a passage stopped, behind the one-line notice. The
// notice stays tidy; here are the step, what the service said, whether the
// request went out, earlier attempts, and a copyable diagnosis without the
// story text or any key.
import type { Failure, Platform } from "../../platform";
import { useState } from "react";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";

const STAGES: Record<string, string> = {
  prepare: "准备", write: "写正文", record: "整理记录", review: "原著核对", settle: "结算变化", commit: "保存", maintain: "整理设定",
};

const KINDS: Record<string, string> = {
  network: "网络连接", timeout: "等待超时", stream: "服务中途断开", http: "服务返回错误", auth: "Key 或权限", quota: "额度或限流",
  context: "内容超出长度", refused: "服务拒绝", empty: "没有写出正文", format: "记录不完整", review: "原著核对没通过", settle: "变化没能记入",
  stale: "故事已经变化", busy: "故事被占用", system_stop: "系统停止后台", interrupted: "生成被中断", cancelled: "你停止了", limit: "到达本次额度",
  setup: "服务没配置好", storage: "保存出错", unsupported: "模型不支持工具", other: "其他",
};

const HOLDERS: Record<string, string> = { ask: "“查一查”", assistant: "助手", autoplay: "连播", turn: "上一段生成", other: "另一个任务" };

const SENT: Record<string, string> = { yes: "发出了，服务有回应", no: "这次没有发出请求", unknown: "可能没有到达服务" };

/** What to try, in the player's words. */
function advice(kind: string): string {
  switch (kind) {
    case "network": case "timeout": case "stream": return "多半是网络或服务一时不稳。接着写完会从断开的地方重新请求；常出现的话可以换个网络或服务。";
    case "http": return "服务这次没有接受请求。稍后再试；一直这样的话，看看服务原话，或换一个服务。";
    case "auth": return "到设置里检查 API Key 是否正确、是否还有权限。";
    case "quota": return "服务额度不足或请求太频繁。等一会儿再试，或检查账户余额。";
    case "context": return "这次要发给 AI 的内容太多。可以在设置里调小记忆预算，或换一个能读更长内容的模型。";
    case "refused": return "可以换个说法、调整内容尺度，或换一个模型。";
    case "empty": case "format": case "review": case "settle": return "重试会重新请求出错的那一步，已经写好的正文会尽量保留。";
    case "stale": return "故事在这期间有了变化，会按现在的情况重写这一段。";
    case "busy": return "等占用的任务结束后再写；“查一查”可以随时停掉。";
    case "system_stop": case "interrupted": return "手机可能在后台停掉了生成。接着写完即可；写长段时让屏幕保持亮着更稳。";
    case "limit": return "这段用到的请求或时间较多，已先停下，接着写完会用同样的额度继续。";
    case "setup": return "到设置里连接 AI 服务。";
    case "unsupported": return "换一个支持工具调用的模型，或改用较轻的档位。";
    default: return "再试一次；仍然不行的话，复制诊断发给开发者。";
  }
}

function time(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString("zh-CN", { hour12: false });
}

/** What the service said, for a copied diagnosis: 200 characters, key-like strings and addresses hidden. */
export function saidForCopy(said: string): string {
  const clean = said.replace(/https?:\/\/\S+/gi, "[地址已隐去]").replace(/\b(sk|key|token|bearer)[-_ ]?[A-Za-z0-9_\-]{12,}/gi, "[已隐去]").replace(/\s+/g, " ").trim();
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

/**
 * A plain-text diagnosis: no story text we sent, no prompts, no keys or addresses.
 * `withSaid` adds what the service answered (R30 review #4): it is what explains
 * most failures, but it may echo a bit of the story, so the player can leave it out.
 */
export function diagnosis(failure: Failure | undefined, earlier: Failure[], withSaid = false): string {
  const lines = [`穿越小说模拟 ${typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : ""} 生成失败诊断`.trim()];
  const one = (f: Failure, label: string) => {
    lines.push(`${label}：${KINDS[f.kind] ?? f.kind}（${f.kind}）· ${STAGES[f.stage] ?? f.stage} · ${SENT[f.sent] ?? f.sent} · 请求 ${f.requests} 次${f.status ? ` · HTTP ${f.status}` : ""}${f.partial ? " · 已收到部分内容" : ""} · ${f.at}`);
    if (f.holder) lines.push(`  占用者：${f.holder}`);
    if (withSaid && f.said?.trim()) lines.push(`  服务原话：${saidForCopy(f.said)}`);
  };
  if (failure) one(failure, "这次");
  else lines.push("这次没有结构化失败记录。");
  earlier.filter((f) => f !== failure && f.at !== failure?.at).forEach((f, i) => one(f, `之前第 ${i + 1} 次`));
  return lines.join("\n");
}

/** The last failures across every story, for 设置 → 存档与数据 → 复制诊断 (R30). */
export async function recentDiagnosis(sql: Pick<Platform["sql"], "query">, limit = 20): Promise<string> {
  const rows = await sql.query(`SELECT f.failure_json, f.at, json_extract(r.plan_json,'$.kind') AS kind FROM execution_failures f JOIN execution_runs r ON r.id=f.run_id ORDER BY f.at DESC LIMIT ?`, [limit]);
  const lines = [`穿越小说模拟 ${typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : ""} 最近 ${rows.length} 次生成失败`.trim()];
  for (const row of rows) {
    try {
      const f = JSON.parse(String(row.failure_json)) as Failure;
      lines.push(`${f.at}｜${String(row.kind ?? "")}｜${KINDS[f.kind] ?? f.kind}（${f.kind}）｜${STAGES[f.stage] ?? f.stage}｜${SENT[f.sent] ?? f.sent}｜请求 ${f.requests} 次${f.status ? `｜HTTP ${f.status}` : ""}${f.holder ? `｜占用者：${f.holder}` : ""}`);
    } catch { /* A row written by a newer version is skipped. */ }
  }
  if (rows.length === 0) lines.push("没有失败记录。");
  return lines.join("\n");
}

export function FailureSheet({ text, failure, failures = [], detail, onClose }: { text: string; failure?: Failure; failures?: Failure[]; detail?: string; onClose: () => void }) {
  const { toast } = useApp();
  const [withSaid, setWithSaid] = useState(true);
  const earlier = failures.filter((f) => f.at !== failure?.at);
  const hasSaid = [failure, ...earlier].some((f) => f?.said?.trim());
  const copy = async () => {
    try { await navigator.clipboard.writeText(diagnosis(failure, earlier, withSaid)); toast("已复制诊断"); }
    catch { toast("没能复制，请长按选中后复制"); }
  };
  return (
    <Sheet title="为什么没写成" onClose={onClose}>
      <div className="stack">
        <p className="m-0">{text}</p>
        {failure ? (
          <dl className="facts">
            <dt>出错在</dt><dd>{STAGES[failure.stage] ?? failure.stage}</dd>
            <dt>原因</dt><dd>{KINDS[failure.kind] ?? failure.kind}{failure.status ? `（HTTP ${failure.status}）` : ""}</dd>
            {failure.holder && <><dt>占用者</dt><dd>{HOLDERS[failure.holder] ?? failure.holder}</dd></>}
            {failure.said && <><dt>服务原话</dt><dd className="failure-said">{failure.said}</dd></>}
            <dt>请求</dt><dd>{SENT[failure.sent] ?? failure.sent}{failure.requests > 0 ? `，这次请求了 ${failure.requests} 次` : ""}{failure.partial ? "，已收到部分正文" : ""}</dd>
            <dt>时间</dt><dd>{time(failure.at)}</dd>
          </dl>
        ) : detail ? <p className="muted m-0">{detail}</p> : null}
        {earlier.length > 0 && <>
          <h3 className="settings-sub">之前的尝试</h3>
          {earlier.map((f) => (
            <div key={f.at} className="item-row"><div className="grow"><b>{KINDS[f.kind] ?? f.kind}</b><small>{STAGES[f.stage] ?? f.stage} · {SENT[f.sent] ?? f.sent} · {time(f.at)}</small></div></div>
          ))}
        </>}
        <p className="muted m-0">{advice(failure?.kind ?? "other")}</p>
        {hasSaid && <label className="row"><input type="checkbox" className="check-20" checked={withSaid} onChange={(e) => setWithSaid(e.target.checked)} />带上服务原话（可能含一点故事内容）</label>}
        <div className="notice-actions"><button onClick={() => void copy()}>复制诊断</button></div>
        <p className="field-hint m-0">复制内容包括出错步骤、请求次数、状态和时间{hasSaid && withSaid ? "，以及服务原话的前 200 字（网址和像密钥的字样会隐去）" : ""}。不含你的 Key 和发出的故事正文。</p>
      </div>
    </Sheet>
  );
}
