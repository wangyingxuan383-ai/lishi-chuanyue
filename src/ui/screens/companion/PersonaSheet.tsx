import { useEffect, useMemo, useState } from "react";
import { BUILTIN_PERSONAS, type CompanionPersona } from "../../../content/personas";
import {
  deletePersona,
  exportPersonaJson,
  listPersonas,
  parsePersonaJson,
  personaFromStoryPerson,
  savePersona,
} from "../../../engine/companion";
import type { Person } from "../../../engine/types";
import { useApp } from "../../app/context";
import { localFind } from "../../app/localFind";
import { Icon } from "../../components/Icon";
import { Sheet } from "../../components/Sheet";
import { Switch } from "../../components/Switch";

export interface PersonaSheetProps {
  personas: CompanionPersona[];
  activePersonaId: string;
  boundWorldId?: string | null;
  boundLineId?: string | null;
  onSelect: (persona: CompanionPersona & { boundLineId?: string | null }) => void;
  onChanged: (personas: CompanionPersona[], selected?: CompanionPersona) => void;
  onClose: () => void;
}

interface PersonaFormState {
  id?: string;
  name: string;
  avatar: string;
  tagline: string;
  roleKind: "assistant" | "advisor" | "roleplay" | "npc";
  systemPrompt: string;
  styleNotes: string;
  greeting: string;
  startersText: string;
  pureRoleplay: boolean;
  memoryScope: "persona" | "global" | "off";
  sourceWorldId?: string | null;
  sourcePersonId?: string | null;
  sourceHeadId?: string | null;
}

const ROLE_LABELS: Record<CompanionPersona["roleKind"], string> = {
  assistant: "创作与问答搭档",
  advisor: "策划与考据顾问",
  roleplay: "沉浸角色扮演",
  npc: "故事人物化身",
};

const MEMORY_SCOPE_OPTIONS: [CompanionPersona["memoryScope"], string, string][] = [
  ["persona", "独立记忆", "只记住和这个角色聊过的内容，互不串戏"],
  ["global", "共享全局记忆", "共用你的创作偏好与通用习惯"],
  ["off", "不记长期记忆", "只看当前对话，不带入也不写入长期记忆"],
];

function emptyForm(): PersonaFormState {
  return {
    name: "",
    avatar: "",
    tagline: "",
    roleKind: "assistant",
    systemPrompt: "",
    styleNotes: "",
    greeting: "",
    startersText: "",
    pureRoleplay: false,
    memoryScope: "persona",
  };
}

function toForm(p: CompanionPersona, asCopy = false): PersonaFormState {
  return {
    id: asCopy ? undefined : p.id,
    name: asCopy ? `${p.name}（自改）` : p.name,
    avatar: p.avatar,
    tagline: p.tagline,
    roleKind: asCopy && p.roleKind === "npc" ? "roleplay" : p.roleKind,
    systemPrompt: p.systemPrompt,
    styleNotes: p.styleNotes || "",
    greeting: p.greeting || "",
    startersText: (p.starters ?? []).join("\n"),
    pureRoleplay: !!p.pureRoleplay,
    memoryScope: p.memoryScope,
    sourceWorldId: asCopy ? null : p.sourceWorldId,
    sourcePersonId: asCopy ? null : p.sourcePersonId,
    sourceHeadId: asCopy ? null : p.sourceHeadId,
  };
}

function safeFileName(name: string): string {
  return (name.trim().replace(/[\\/:*?"<>|]+/g, "-") || "角色卡").slice(0, 40);
}

export function extractNpcLineId(p: CompanionPersona & { boundLineId?: string | null }): string | null {
  if (typeof p.boundLineId === "string" && p.boundLineId.trim()) return p.boundLineId.trim();
  const metaLine = p.metadata?.boundLineId;
  if (typeof metaLine === "string" && metaLine.trim()) return metaLine.trim();
  if (p.id.startsWith("npc:")) {
    const parts = p.id.split(":");
    if (parts.length >= 4 && parts[2]) return parts[2];
  }
  return null;
}

export function formatNpcOriginLabel(
  p: CompanionPersona,
  worldTitles: Record<string, string>,
  lineNames: Record<string, string>,
): string {
  if (p.roleKind !== "npc") return "";
  const wid = p.sourceWorldId ?? "";
  const lid = extractNpcLineId(p);
  const metaTitle = typeof p.metadata?.worldTitle === "string" ? p.metadata.worldTitle : "";
  const wTitle = (wid && worldTitles[wid]) || metaTitle || (wid ? "已移除故事" : "");
  const lName =
    (wid && lid && lineNames[`${wid}:${lid}`]) ||
    (lid === "main" ? "主线" : lid ? `路线 ${lid.slice(0, 6)}` : "");
  if (!wTitle && !lName) return "";
  return `${wTitle ? `《${wTitle}》` : "未标注故事"}${lName ? ` · ${lName}` : ""}`;
}

export function groupNpcPersonasByWorld(
  npcs: CompanionPersona[],
  boundWorldId?: string | null,
  targetLineId?: string | null,
): { currentWorldNpcs: CompanionPersona[]; otherWorldNpcs: CompanionPersona[] } {
  if (!boundWorldId) {
    return { currentWorldNpcs: [], otherWorldNpcs: npcs };
  }
  const targetLine = targetLineId || "main";
  const currentWorldNpcs = npcs
    .filter((p) => p.sourceWorldId === boundWorldId)
    .sort((a, b) => {
      const aMatch = (extractNpcLineId(a) ?? "main") === targetLine ? 0 : 1;
      const bMatch = (extractNpcLineId(b) ?? "main") === targetLine ? 0 : 1;
      return aMatch - bMatch;
    });
  const otherWorldNpcs = npcs.filter((p) => p.sourceWorldId !== boundWorldId);
  return { currentWorldNpcs, otherWorldNpcs };
}

export function PersonaSheet({
  personas,
  activePersonaId,
  boundWorldId,
  boundLineId,
  onSelect,
  onChanged,
  onClose,
}: PersonaSheetProps) {
  const { game, toast, ask } = useApp();
  const [view, setView] = useState<"list" | "edit" | "npc">("list");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<PersonaFormState>(emptyForm);
  const [initialSnap, setInitialSnap] = useState<string>(() => JSON.stringify(emptyForm()));
  const [saving, setSaving] = useState(false);
  const [storyPeople, setStoryPeople] = useState<Person[]>([]);
  const [loadingPeople, setLoadingPeople] = useState(false);
  const [effectiveLineId, setEffectiveLineId] = useState<string | null>(boundLineId ?? null);
  const [worldTitles, setWorldTitles] = useState<Record<string, string>>({});
  const [lineNames, setLineNames] = useState<Record<string, string>>({});

  const allPersonas = personas.length ? personas : BUILTIN_PERSONAS;

  useEffect(() => {
    let live = true;
    const npcWorldIds = new Set<string>();
    if (boundWorldId) npcWorldIds.add(boundWorldId);
    for (const p of allPersonas) {
      if (p.roleKind === "npc" && p.sourceWorldId) npcWorldIds.add(p.sourceWorldId);
    }
    if (npcWorldIds.size === 0) return;
    void (async () => {
      const worlds = await game.repo.listWorlds().catch(() => []);
      const titles: Record<string, string> = {};
      for (const w of worlds) titles[w.id] = w.title || "未命名故事";
      const linesMap: Record<string, string> = {};
      await Promise.all(
        [...npcWorldIds].map(async (wid) => {
          const lines = await game.repo.lines(wid).catch(() => []);
          for (const l of lines) {
            linesMap[`${wid}:${l.id}`] = l.name || "主线";
          }
        }),
      );
      if (!live) return;
      setWorldTitles(titles);
      setLineNames(linesMap);
    })();
    return () => {
      live = false;
    };
  }, [game, boundWorldId, allPersonas]);

  const npcOriginText = (p: CompanionPersona): string =>
    formatNpcOriginLabel(p, worldTitles, lineNames);

  const filtered = useMemo(
    () =>
      allPersonas.filter((p) =>
        localFind(query, p.name, p.tagline, ROLE_LABELS[p.roleKind], npcOriginText(p)),
      ),
    [allPersonas, query, worldTitles, lineNames],
  );

  const builtins = filtered.filter((p) => p.builtin);
  const npcs = filtered.filter((p) => !p.builtin && p.roleKind === "npc");
  const { currentWorldNpcs, otherWorldNpcs } = useMemo(
    () => groupNpcPersonasByWorld(npcs, boundWorldId, effectiveLineId ?? boundLineId),
    [npcs, boundWorldId, effectiveLineId, boundLineId],
  );
  const customs = filtered.filter((p) => !p.builtin && p.roleKind !== "npc");

  const dirty = view === "edit" && JSON.stringify(form) !== initialSnap;

  useEffect(() => {
    if (!boundWorldId) {
      setStoryPeople([]);
      setEffectiveLineId(null);
      return;
    }
    let live = true;
    setLoadingPeople(true);
    void (async () => {
      const world = await game.repo.getWorld(boundWorldId);
      const preferredId = boundLineId || world?.currentLineId || null;
      const requested = preferredId ? await game.repo.getLine(preferredId).catch(() => null) : null;
      const line =
        requested && requested.worldId === boundWorldId && !requested.deletedAt
          ? requested
          : world?.currentLineId
            ? await game.repo.getLine(world.currentLineId)
            : null;
      if (live) setEffectiveLineId(line?.id ?? world?.currentLineId ?? boundLineId ?? null);
      if (!line) return [];
      const state = await game.repo.getState(line.nodeId);
      return state.people ?? [];
    })()
      .then((people) => {
        if (live) setStoryPeople(people);
      })
      .catch(() => {
        if (live) setStoryPeople([]);
      })
      .finally(() => {
        if (live) setLoadingPeople(false);
      });
    return () => {
      live = false;
    };
  }, [game, boundWorldId, boundLineId]);

  const startCreate = () => {
    const next = emptyForm();
    setForm(next);
    setInitialSnap(JSON.stringify(next));
    setView("edit");
  };

  const startEdit = (persona: CompanionPersona, asCopy = false) => {
    const next = toForm(persona, asCopy);
    setForm(next);
    setInitialSnap(JSON.stringify(next));
    setView("edit");
  };

  const handleSave = async () => {
    const name = form.name.trim();
    const systemPrompt = form.systemPrompt.trim();
    if (!name) {
      toast("请先填写角色名称");
      return;
    }
    if (!systemPrompt) {
      toast("请填写核心人设与说话风格");
      return;
    }
    setSaving(true);
    try {
      const starters = form.startersText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 6);
      const saved = await savePersona(game, {
        ...(form.id ? { id: form.id } : {}),
        name,
        avatar: form.avatar.trim() || [...name][0] || "灵",
        tagline: form.tagline.trim(),
        roleKind: form.roleKind,
        systemPrompt,
        styleNotes: form.styleNotes.trim(),
        greeting: form.greeting.trim(),
        starters,
        pureRoleplay: form.pureRoleplay,
        memoryScope: form.memoryScope,
        sourceWorldId: form.sourceWorldId ?? null,
        sourcePersonId: form.sourcePersonId ?? null,
        sourceHeadId: form.sourceHeadId ?? null,
        builtin: false,
      });
      const updated = await listPersonas(game);
      onChanged(updated, saved);
      onSelect(saved);
      toast(form.id ? `已保存「${saved.name}」` : `已创建「${saved.name}」`);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : "没能保存角色，请稍后再试");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (persona: CompanionPersona) => {
    if (persona.builtin) return;
    const ok = await ask({
      title: `删除角色「${persona.name}」？`,
      message: "删除后，以往的对话记录仍会保留，但不能再用这个角色设定新开对话。",
      confirm: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await deletePersona(game, persona.id);
      const updated = await listPersonas(game);
      const fallback = updated.find((p) => p.id === activePersonaId) ?? updated[0] ?? BUILTIN_PERSONAS[0];
      onChanged(updated, fallback);
      toast(`已删除「${persona.name}」`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "没能删除角色");
    }
  };

  const handleExport = async (persona: CompanionPersona) => {
    try {
      const text = exportPersonaJson(persona);
      const ok = await game.platform.files.exportText(`${safeFileName(persona.name)}.persona.json`, text);
      if (ok) toast(`已导出「${persona.name}」角色卡`);
    } catch {
      toast("导出未完成，请稍后再试");
    }
  };

  const handleImport = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const raw = await game.platform.files.importText();
      if (!raw) return;
      const parsed = parsePersonaJson(raw);
      const saved = await savePersona(game, { ...parsed, builtin: false });
      const updated = await listPersonas(game);
      onChanged(updated, saved);
      onSelect(saved);
      toast(`已导入角色「${saved.name}」`);
      onClose();
    } catch (err) {
      toast(err instanceof Error && /[\u4e00-\u9fff]/.test(err.message) ? err.message : "没能识别这份角色卡文件，请选择导出的角色卡重试");
    } finally {
      setSaving(false);
    }
  };

  const handleInviteNpc = async (person: Person) => {
    if (!boundWorldId || saving) return;
    setSaving(true);
    try {
      const targetLine = effectiveLineId ?? boundLineId ?? undefined;
      const invited = await personaFromStoryPerson(game, boundWorldId, person.id, targetLine);
      const updated = await listPersonas(game);
      onChanged(updated, invited);
      onSelect(invited);
      toast(`已邀请「${invited.name}」入席对谈`);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : "没能生成人物角色卡");
    } finally {
      setSaving(false);
    }
  };

  const renderCard = (p: CompanionPersona) => {
    const selected = p.id === activePersonaId;
    const badge = p.avatar?.trim() || [...p.name][0] || "灵";
    const originLabel = npcOriginText(p);
    const pLineId = extractNpcLineId(p);
    const isCurrentRouteNpc =
      p.roleKind === "npc" &&
      Boolean(boundWorldId && p.sourceWorldId === boundWorldId) &&
      (pLineId ?? "main") === (effectiveLineId ?? boundLineId ?? "main");
    return (
      <div key={p.id} className={`persona-card${selected ? " selected" : ""}`}>
        <button
          type="button"
          className="persona-card-main"
          onClick={() => {
            onSelect(pLineId ? { ...p, boundLineId: pLineId } : p);
            onClose();
          }}
        >
          <span className={`companion-avatar${p.roleKind === "npc" ? " role-npc" : ""}`} aria-hidden="true">
            {badge.slice(0, 2)}
          </span>
          <span className="persona-card-body">
            <span className="persona-card-title">
              <b>{p.name}</b>
              <span className="companion-role-badge">{ROLE_LABELS[p.roleKind]}</span>
              {isCurrentRouteNpc && <span className="tag">当前路线</span>}
              {selected && <span className="tag">当前</span>}
            </span>
            {originLabel && <small className="muted">{originLabel}</small>}
            {p.tagline && <span className="persona-card-tagline">{p.tagline}</span>}
          </span>
        </button>
        <div className="persona-card-actions">
          <button
            type="button"
            className="ghost"
            onClick={() => {
              onSelect(pLineId ? { ...p, boundLineId: pLineId } : p);
              onClose();
            }}
          >
            选用
          </button>
          {p.builtin ? (
            <button type="button" className="ghost" onClick={() => startEdit(p, true)}>
              以此为模板
            </button>
          ) : (
            <button type="button" className="ghost" onClick={() => startEdit(p, false)}>
              编辑
            </button>
          )}
          <button type="button" className="ghost" onClick={() => void handleExport(p)}>
            导出角色卡
          </button>
          {!p.builtin && (
            <button type="button" className="ghost danger-text" onClick={() => void handleDelete(p)}>
              删除
            </button>
          )}
        </div>
      </div>
    );
  };

  if (view === "npc") {
    return (
      <Sheet title="邀请本局人物对谈" onClose={() => setView("list")}>
        <div className="stack">
          <p className="muted m-0">
            按当前故事进度的来历与近况生成人物化身，闲聊或试戏都不会改动正式存档。
          </p>
          {loadingPeople && <p className="muted">正在读取人物名册…</p>}
          {!loadingPeople && !storyPeople.length && (
            <p className="muted">当前故事还没有已出场的人物记录。</p>
          )}
          <div className="settings-list">
            {storyPeople.map((person) => (
              <button
                key={person.id}
                type="button"
                className="settings-entry"
                disabled={saving}
                onClick={() => void handleInviteNpc(person)}
              >
                <span>
                  <b>
                    {person.name}
                    {!person.alive ? "（已故）" : ""}
                  </b>
                  <small>
                    {person.role || "身份未详"} · 对主角{person.attitude}
                  </small>
                </span>
                <span aria-hidden="true">邀请 ›</span>
              </button>
            ))}
          </div>
          <button type="button" className="ghost" onClick={() => setView("list")}>
            返回角色工坊
          </button>
        </div>
      </Sheet>
    );
  }

  if (view === "edit") {
    return (
      <Sheet title={form.id ? "编辑角色" : "新建角色"} dirty={dirty} onClose={() => setView("list")}>
        <div className="stack">
          <div className="row">
            <label className="field grow">
              名称
              <input
                aria-label="角色名称"
                value={form.name}
                maxLength={24}
                placeholder="如：沈青蝉、松风先生"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label className="field" style={{ width: "84px" }}>
              印章字
              <input
                aria-label="印章字"
                value={form.avatar}
                maxLength={2}
                placeholder={[...form.name.trim()][0] || "灵"}
                onChange={(e) => setForm({ ...form, avatar: e.target.value })}
              />
            </label>
          </div>

          <label className="field">
            头衔 / 一句话简介
            <input
              aria-label="头衔或一句话简介"
              value={form.tagline}
              maxLength={80}
              placeholder="如：毒舌却护短的古风责编，专治卡文"
              onChange={(e) => setForm({ ...form, tagline: e.target.value })}
            />
          </label>

          <div className="field">
            <span className="field-label">角色类型</span>
            <div className="segmented" role="group" aria-label="角色类型">
              <button
                type="button"
                aria-pressed={form.roleKind === "assistant"}
                onClick={() => setForm({ ...form, roleKind: "assistant" })}
              >
                创作与问答搭档
              </button>
              <button
                type="button"
                aria-pressed={form.roleKind === "advisor"}
                onClick={() => setForm({ ...form, roleKind: "advisor" })}
              >
                策划与考据顾问
              </button>
              <button
                type="button"
                aria-pressed={form.roleKind === "roleplay"}
                onClick={() => setForm({ ...form, roleKind: "roleplay" })}
              >
                沉浸角色扮演
              </button>
              {form.roleKind === "npc" && (
                <button type="button" aria-pressed onClick={() => setForm({ ...form, roleKind: "npc" })}>
                  故事人物化身
                </button>
              )}
            </div>
          </div>

          <label className="field">
            核心人设与说话风格
            <textarea
              aria-label="核心人设与说话风格"
              rows={5}
              value={form.systemPrompt}
              placeholder="写清角色的身份来历、性格脾气、对你的称呼，以及说话的腔调与禁忌…"
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            />
          </label>

          <label className="field">
            开场白
            <textarea
              aria-label="开场白"
              rows={2}
              value={form.greeting}
              placeholder="新开对话时角色对你说的第一句话（可留空）"
              onChange={(e) => setForm({ ...form, greeting: e.target.value })}
            />
          </label>

          <Switch
            label="沉浸防出戏"
            note="开启后始终留在角色身份与口吻里，不以场外口吻解释设定"
            checked={form.pureRoleplay}
            onChange={(pureRoleplay) => setForm({ ...form, pureRoleplay })}
          />

          <div className="field">
            <span className="field-label">长期记忆范围</span>
            <div className="segmented" role="group" aria-label="长期记忆范围">
              {MEMORY_SCOPE_OPTIONS.map(([scope, label]) => (
                <button
                  key={scope}
                  type="button"
                  aria-pressed={form.memoryScope === scope}
                  onClick={() => setForm({ ...form, memoryScope: scope })}
                >
                  {label}
                </button>
              ))}
            </div>
            <small className="field-hint">
              {MEMORY_SCOPE_OPTIONS.find(([s]) => s === form.memoryScope)?.[2]}
            </small>
          </div>

          <details>
            <summary className="muted">更多细节（文风补充、开场话题）</summary>
            <div className="stack mt-2">
              <label className="field">
                语气与文风备注（可选）
                <textarea
                  rows={2}
                  value={form.styleNotes}
                  placeholder="如：多用短句，带一点江南茶馆的闲适气"
                  onChange={(e) => setForm({ ...form, styleNotes: e.target.value })}
                />
              </label>
              <label className="field">
                推荐开场话题（可选，每行一条）
                <textarea
                  rows={3}
                  value={form.startersText}
                  placeholder={"帮我盘一盘这局接下来的冲突\n聊聊你眼里的汴京夜市"}
                  onChange={(e) => setForm({ ...form, startersText: e.target.value })}
                />
              </label>
            </div>
          </details>

          <div className="row">
            <button type="button" className="ghost" disabled={saving} onClick={() => setView("list")}>
              返回列表
            </button>
            <button
              type="button"
              className="primary grow"
              disabled={saving || !form.name.trim() || !form.systemPrompt.trim()}
              onClick={() => void handleSave()}
            >
              {saving ? "正在保存…" : "保存并使用"}
            </button>
          </div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="角色工坊" onClose={onClose}>
      <div className="stack">
        <div className="row wrap">
          <button type="button" className="primary" onClick={startCreate}>
            <Icon name="plus" size={18} />
            新建角色
          </button>
          <button type="button" disabled={saving} onClick={() => void handleImport()}>
            <Icon name="share" size={18} />
            导入角色卡
          </button>
          {boundWorldId && storyPeople.length > 0 && (
            <button type="button" onClick={() => setView("npc")}>
              <Icon name="people" size={18} />
              邀请本局人物
            </button>
          )}
        </div>

        {allPersonas.length > 4 && (
          <input
            type="search"
            aria-label="查找角色"
            placeholder="按名字、头衔或类型查找角色"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}

        {builtins.length > 0 && (
          <>
            <h3 className="settings-sub">内置搭档</h3>
            <div className="persona-grid">{builtins.map(renderCard)}</div>
          </>
        )}

        {boundWorldId ? (
          <>
            {currentWorldNpcs.length > 0 && (
              <>
                <h3 className="settings-sub">本局人物化身</h3>
                <div className="persona-grid">{currentWorldNpcs.map(renderCard)}</div>
              </>
            )}
            {otherWorldNpcs.length > 0 && (
              <>
                <h3 className="settings-sub">其他故事人物化身</h3>
                <div className="persona-grid">{otherWorldNpcs.map(renderCard)}</div>
              </>
            )}
          </>
        ) : (
          npcs.length > 0 && (
            <>
              <h3 className="settings-sub">故事人物化身</h3>
              <div className="persona-grid">{npcs.map(renderCard)}</div>
            </>
          )
        )}

        {customs.length > 0 && (
          <>
            <h3 className="settings-sub">自建角色</h3>
            <div className="persona-grid">{customs.map(renderCard)}</div>
          </>
        )}

        {!filtered.length && <p className="muted">没有找到匹配的角色，换个词试试。</p>}
      </div>
    </Sheet>
  );
}
