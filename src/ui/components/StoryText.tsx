// Narrative paragraphs; the date line of an opening is emphasised. While a
// passage streams, each sentence fades in as it starts (UX_CN 3: "writing",
// not a jittering cursor); the motion setting turns the fade off in CSS.

const DATE_LINE = (p: string) => p.length < 40 && /[载年]/.test(p) && /[时日]/.test(p) && !/[“”"]/.test(p);

/** Splits after sentence ends (。！？…；), keeping closing quotes with their sentence. */
export function sentences(text: string): string[] {
  return text.match(/[^。！？!?…；]*(?:[。！？!?；]+|…+)[”’」』"]*|[^。！？!?…；]+$/g) ?? (text ? [text] : []);
}

function Streamed({ text }: { text: string }) {
  // Keys are sentence positions, so a sentence keeps its span while it grows
  // and only a new sentence mounts (and fades in).
  return <>{sentences(text).map((s, i) => <span key={i} className="sent">{s}</span>)}</>;
}

export function StoryText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const paragraphs = text.split(/\n+/).filter((p) => p.trim());
  if (streaming && paragraphs.length === 0) paragraphs.push("");
  return (
    <div className={`story-text${streaming ? " streaming" : ""}`}>
      {paragraphs.map((p, i) => {
        const last = streaming && i === paragraphs.length - 1 ? "cursor-blink" : undefined;
        const body = streaming ? <Streamed text={DATE_LINE(p) ? p.trim() : p} /> : DATE_LINE(p) ? p.trim() : p;
        return DATE_LINE(p)
          ? <p key={i} className={["date-line", last].filter(Boolean).join(" ")}>{body}</p>
          : <p key={i} className={last}>{body}</p>;
      })}
    </div>
  );
}

const WAITING = {
  shop: ["掌柜抬眼…", "算盘一停…", "伙计迎上来…"],
  court: ["殿上静了一静…", "内侍低声传话…", "案上奏本翻开…"],
  road: ["风过长路…", "车辙辘辘…", "远处有人吆喝…"],
  home: ["灯下研墨…", "茶还温着…", "窗外有脚步声…"],
  night: ["挑灯…", "更鼓远远传来…", "烛花一跳…"],
  dusk: ["暮鼓将起…", "炊烟起了…", "天色向晚…"],
  day: ["研墨…", "铺纸…", "提笔蘸墨…"],
};

/**
 * A short line to show before the first character arrives, instead of a bare
 * cursor: picked from the place and the hour, always the same for the same
 * moment so it does not flicker between renders.
 */
export function waitingLine(place: string, hour?: number): string {
  const kind: keyof typeof WAITING =
    /店|铺|楼|肆|坊|行|当|馆|栈|市/.test(place) ? "shop"
    : /宫|殿|朝|衙|府|署|阁/.test(place) ? "court"
    : /道|路|驿|渡|郊|野|山|河|江|关/.test(place) ? "road"
    : hour != null && daypart(hour) === "night" ? "night"
    : hour != null && daypart(hour) === "dusk" ? "dusk"
    : /家|宅|院|房|屋|舍|居/.test(place) ? "home"
    : "day";
  const list = WAITING[kind];
  let seed = hour ?? 0;
  for (const ch of place) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  return list[seed % list.length];
}

/** The part of the in-game day the paper tint follows (UX_CN 28): 黄昏 warmer, 夜里 cooler. */
export function daypart(hour: number): "day" | "dusk" | "night" {
  return hour >= 17 && hour < 20 ? "dusk" : hour >= 20 || hour < 5 ? "night" : "day";
}
