// Play modes in the play screen (R14, docs/plans/R14_PLAY_MODES.md §2): the
// slim banner under the top bar, the end cards in the story's own page style,
// the 玩法 group of 本局设置, and the 连播 picker of 旁观.
import { beatTitle, challengeView, scriptProgress, type ChallengeView } from "../../engine/modes";
import type { Pilot, Script, WorldState } from "../../engine/types";
import { challengeLine } from "./ChallengeSheet";
import { Icon } from "./Icon";
import { scriptLine } from "./ScriptSheet";
import { Sheet } from "./Sheet";
import "./modes.css";

/** Under three days left, the countdown turns to the warning colour. */
const SOON = 3 * 1440;

/**
 * “第 2/5 幕 · 夜探城隍庙” / “挑战 · 还剩 12 天 · 凑够三百两”: one line of 40px,
 * shown only while there is a beat to play or a challenge going on. Both at
 * once share the line; each half opens its own page.
 */
export function ModeBanner({ state, onScript, onChallenge }: { state: WorldState; onScript: () => void; onChallenge: () => void }) {
  const sp = scriptProgress(state);
  const cv = challengeView(state);
  const c = state.challenge;
  const script = sp && !sp.finished && sp.current ? sp : null;
  const challenge = cv?.active ? cv : null;
  if (!script && !challenge) return null;
  const both = !!script && !!challenge;
  const total = c && c.deadlineMinute !== null ? c.deadlineMinute - c.startedMinute : null;
  const used = c && total ? Math.min(1, Math.max(0, (state.time.elapsedMinutes - c.startedMinute) / total)) : null;
  const soon = !!challenge && challenge.remainingMinutes !== null && challenge.remainingMinutes < SOON;
  return (
    <div className="mode-banner">
      {script && (
        <button type="button" onClick={onScript} aria-label={`剧本：第 ${script.index} 幕，共 ${script.total} 幕，${beatTitle(script.current!.text)}。查看与修改剧本`}>
          <span className="text"><em>第 {script.index}/{script.total} 幕</em>{beatTitle(script.current!.text)}</span>
          {!both && <Icon name="forward" size={18} />}
          <i className="meter" style={{ width: `${((script.index - 1) / script.total) * 100}%` }} />
        </button>
      )}
      {challenge && (
        <button type="button" onClick={onChallenge} aria-label={`挑战：${challenge.goal}，${challenge.remaining}。查看挑战`}>
          <span className={`text${soon ? " soon" : ""}`}><em>{both ? challenge.remaining : `挑战 · ${challenge.remaining}`}</em>{both ? "" : challenge.goal}</span>
          <Icon name="forward" size={18} />
          {used !== null && <i className="meter" style={{ width: `${used * 100}%` }} />}
        </button>
      )}
    </div>
  );
}

/** The script is played to its last beat: an epilogue, free play from here, or the life so far. */
export function ScriptEndCard({ script, onEpilogue, onContinue, onLife }: { script: Script; onEpilogue: () => void; onContinue: () => void; onLife: () => void }) {
  const played = script.beats.filter((b) => b.status === "done").length;
  return (
    <div className="ending-card mode-end" role="status">
      <div className="ending-seal" aria-hidden="true"><span>剧</span><span>终</span></div>
      <h2>剧本演完了</h2>
      <p className="ending-line">{script.line || "这一出戏，到此落幕。"}</p>
      <p className="ending-meta"><span>共 {script.beats.length} 幕{played < script.beats.length ? `，演了 ${played} 幕` : ""}</span>{script.ending && <> · <span>想要的结局：{script.ending}</span></>}</p>
      <div className="ending-actions">
        <button className="primary" onClick={onEpilogue}>写尾声</button>
        <button onClick={onContinue}>继续自由发展</button>
      </div>
      <button className="ending-life" onClick={onLife}>这一世小传</button>
    </div>
  );
}

/** A challenge won or lost: what it came to, how long it took, and the ways on. */
export function ChallengeEndCard({ view, onAgain, onBack, onContinue }: { view: ChallengeView; onAgain: () => void; onBack: () => void; onContinue: () => void }) {
  const won = view.status === "won";
  return (
    <div className={`ending-card mode-end ${won ? "won" : "lost"}`} role="status">
      <div className="ending-seal" aria-hidden="true">{won ? <><span>功</span><span>成</span></> : <><span>未</span><span>竟</span></>}</div>
      <h2>{won ? "挑战成功" : "挑战失败"}</h2>
      <p className="ending-line">{view.outcome || (won ? "做到了。" : "这一回，没能做到。")}</p>
      <p className="ending-meta"><span>{view.goal}</span> · <span>用了 {view.days} 天{view.turns ? `，${view.turns} 回合` : ""}</span></p>
      <div className="ending-actions">
        <button className="primary" onClick={onAgain}>再挑战一次</button>
        <button onClick={onBack}>回到之前</button>
        <button className="ghost" onClick={onContinue}>继续玩下去</button>
      </div>
    </div>
  );
}

/** 本局设置 → 玩法: who plays the protagonist, and the ways into the 剧本 and 挑战 pages. */
export function ModesSettings({ state, pilot, onPilot, onScript, onChallenge, busy }: {
  state: WorldState; pilot: Pilot; busy: boolean;
  onPilot: (p: Pilot) => void; onScript: () => void; onChallenge: () => void;
}) {
  const script = scriptLine(state);
  const challenge = challengeLine(state);
  const ended = !!state.challenge && state.challenge.status !== "active";
  return (
    <>
      <span className="muted">主角由谁来演</span>
      <div className="segmented" role="group" aria-label="主角由谁来演">
        <button aria-pressed={pilot !== "ai"} disabled={busy} onClick={() => onPilot("player")}>我</button>
        <button aria-pressed={pilot === "ai"} disabled={busy} onClick={() => onPilot("ai")}>AI，我在幕后指点</button>
      </div>
      <div className="mode-entries">
        <button className="settings-entry" onClick={onScript} aria-label={script ? `剧本：${script}，查看与修改` : "加一个剧本"}>
          <span><b>剧本</b><small>{script ?? "定好几幕骨架，AI 按幕推进"}</small></span>
          <span aria-hidden="true">{script ? "查看与修改 ›" : "加一个 ›"}</span>
        </button>
        <button className="settings-entry" onClick={onChallenge} aria-label={challenge && !ended ? `挑战：${challenge}，查看与修改` : ended ? `挑战：${challenge}，查看或换一个` : "加一个挑战"}>
          <span><b>挑战</b><small>{challenge ?? "定一个目标和期限，成败自负"}</small></span>
          <span aria-hidden="true">{challenge && !ended ? "查看与修改 ›" : ended ? "查看 ›" : "加一个 ›"}</span>
        </button>
      </div>
    </>
  );
}

/** 连播: how many passages in a row. */
export function AutoplaySheet({ onStart, onClose }: { onStart: (turns: number) => void; onClose: () => void }) {
  return (
    <Sheet title="连播几段？" onClose={onClose}>
      <div className="stack">
        <div className="autoplay-pick">
          {[3, 5, 10].map((n) => (
            <button key={n} aria-label={`连播 ${n} 段`} onClick={() => onStart(n)}><b>{n}</b><small>段</small></button>
          ))}
        </div>
        <p className="muted" style={{ margin: 0 }}>一段接一段往下演，每段照常调用 AI。随时可以停。</p>
      </div>
    </Sheet>
  );
}

/** Which end card the head turn earns: the challenge that ended there, the script finished there. */
export function endsAt(state: WorldState, before: WorldState | null): { challenge: boolean; script: boolean } {
  const c = state.challenge;
  const challenge = !!c && (c.status === "won" || c.status === "lost") && before?.challenge?.status === "active";
  const now = scriptProgress(state);
  const was = before ? scriptProgress(before) : null;
  const script = !!now?.finished && !!was && !was.finished;
  return { challenge, script };
}
