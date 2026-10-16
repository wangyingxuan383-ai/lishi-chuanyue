// R02 opening: one draft era, three identity cards, a name, and the way you
// arrived. "随便穿" starts immediately. The full wizard comes in R03.
import { useMemo, useRef, useState } from "react";
import { ERAS, type EraDraft, type EraIdentity } from "../../content/eras";
import type { TurnEvent } from "../../engine/game";
import { explainFailure } from "../../engine/llm/providers";
import { useApp, useBack } from "../app/context";
import { StoryText } from "../components/StoryText";

const ORIGINS = ["历史系研究生", "程序员", "外科医生", "中学语文老师", "工程师", "厨师"];
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

function drawIdentities(era: EraDraft): EraIdentity[] {
  return [...era.identities].sort(() => Math.random() - 0.5).slice(0, 3);
}

function randomName(era: EraDraft, gender: "男" | "女"): string {
  return pick(era.names.surnames) + pick(gender === "男" ? era.names.male : era.names.female);
}

const AGE = /(\d+|[一二三四五六七八九十]+)岁/;

export default function NewGame() {
  const { game, replace, pop, toast } = useApp();
  const era = ERAS[0];
  const [cards, setCards] = useState(() => drawIdentities(era));
  const [chosen, setChosen] = useState(0);
  const [gender, setGender] = useState<"男" | "女">("男");
  const [name, setName] = useState(() => randomName(era, "男"));
  const [how, setHow] = useState<"魂穿" | "身穿" | "投胎">("魂穿");
  const [origin, setOrigin] = useState(ORIGINS[0]);
  const [phase, setPhase] = useState<"form" | "loading" | "thinking" | "writing" | "organizing">("form");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  const tip = useMemo(() => pick([
    "长安城有一百零八坊，坊门在暮鼓后关闭。",
    "唐人称一千文为一贯，铜钱用绳子穿起来。",
    "西市胡商云集，波斯、粟特的商队带来香料与宝石。",
    "一个时辰是两个小时，一刻是十五分钟。",
  ]), []);

  useBack(() => {
    if (phase === "form") return false;
    cancelled.current = true;
    return true; // stay; the opening keeps generating
  }, phase !== "form");

  const start = async (identity: EraIdentity, protagonist: string, g: "男" | "女", way: typeof how, from: string) => {
    setError(null);
    setText("");
    setPhase("loading");
    const age = Number(AGE.exec(identity.detail)?.[1]) || 20;
    const onEvent = (e: TurnEvent) => {
      if (e.type === "thinking") setPhase("thinking");
      else if (e.type === "text") { setPhase("writing"); setText(e.full); }
      else if (e.type === "organizing") setPhase("organizing");
      else if (e.type === "failed") { setPhase("form"); setError(explainFailure(e.reason, e.status)); }
    };
    const worldId = await game.createWorld({
      title: `${protagonist}的${era.title.split(" · ").pop()}`,
      eraId: era.id,
      opening: {
        protagonist: { name: protagonist, gender: g, age, identity: identity.title, situation: identity.detail, origin: from },
        transmigration: way,
      },
    }, onEvent);
    if (worldId) {
      replace({ name: "play", worldId });
      if (cancelled.current) toast("开场已写好");
    }
  };

  const randomStart = () => {
    const g = pick(["男", "女"] as const);
    void start(pick(era.identities), randomName(era, g), g, "魂穿", pick(ORIGINS));
  };

  if (phase !== "form") {
    return (
      <div className="screen">
        <div className="topbar"><div className="title"><h1>{era.title}</h1></div></div>
        <div className="screen-body">
          {!text ? (
            <div className="hero">
              <p style={{ fontSize: 20, letterSpacing: 4 }}>穿越中…</p>
              <p className="muted">{tip}</p>
            </div>
          ) : (
            <StoryText text={text} streaming />
          )}
          {phase === "organizing" && <p className="status-line">整理中…</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={pop}>‹</button>
        <div className="title"><h1>开始穿越</h1></div>
      </div>
      <div className="screen-body stack">
        <button className="primary big-btn" onClick={randomStart}>随便穿</button>
        {error && <div className="notice">{error}</div>}
        <div className="card selected">
          <h3>{era.title}</h3>
          <p>{era.blurb}</p>
        </div>
        <div className="row"><span className="grow muted">你会成为谁</span><button className="ghost" onClick={() => { setCards(drawIdentities(era)); setChosen(0); }}>换一批</button></div>
        <div className="list">
          {cards.map((c, i) => (
            <button key={c.title} className={`card${i === chosen ? " selected" : ""}`} onClick={() => setChosen(i)}>
              <h3>{c.title}</h3>
              <p>{c.detail}</p>
            </button>
          ))}
        </div>
        <div className="row">
          <label className="grow">名字<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <button style={{ alignSelf: "flex-end" }} onClick={() => setName(randomName(era, gender))}>换</button>
        </div>
        <div className="segmented">
          {(["男", "女"] as const).map((g) => (
            <button key={g} aria-pressed={gender === g} onClick={() => { setGender(g); setName(randomName(era, g)); }}>{g}</button>
          ))}
        </div>
        <details>
          <summary className="muted">穿越方式：{how}　·　穿越前：{origin}</summary>
          <div className="stack" style={{ marginTop: 10 }}>
            <div className="segmented">
              {(["魂穿", "身穿", "投胎"] as const).map((h) => (
                <button key={h} aria-pressed={how === h} onClick={() => setHow(h)}>{h === "身穿" ? "身穿（困难）" : h}</button>
              ))}
            </div>
            <div className="segmented">
              {ORIGINS.map((o) => <button key={o} aria-pressed={origin === o} onClick={() => setOrigin(o)}>{o}</button>)}
            </div>
          </div>
        </details>
        <button className="primary big-btn" disabled={!name.trim()} onClick={() => void start(cards[chosen], name.trim(), gender, how, origin)}>出发</button>
      </div>
    </div>
  );
}
