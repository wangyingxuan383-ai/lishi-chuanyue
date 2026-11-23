import { useCallback, useEffect, useMemo, useState } from "react";
import type { CompanionPersona } from "../../../content/personas";
import {
  deleteMemory,
  listMemories,
  saveMemory,
  toggleMemory,
  type CompanionMemory,
} from "../../../engine/companion";
import { useApp } from "../../app/context";
import { localFind } from "../../app/localFind";
import { Icon } from "../../components/Icon";
import { Sheet } from "../../components/Sheet";
import { Switch } from "../../components/Switch";

export interface MemorySheetProps {
  persona: CompanionPersona;
  onClose: () => void;
  onCountChange?: (count: number) => void;
}

const CATEGORIES: [CompanionMemory["category"], string][] = [
  ["preference", "偏好习惯"],
  ["fact", "重要事实"],
  ["lore", "世界设定"],
  ["bond", "相处羁绊"],
];

const CATEGORY_LABEL: Record<CompanionMemory["category"], string> = {
  preference: "偏好习惯",
  fact: "重要事实",
  lore: "世界设定",
  bond: "相处羁绊",
  relation: "相处关系",
  note: "随手备忘",
};

export function MemorySheet({ persona, onClose, onCountChange }: MemorySheetProps) {
  const { game, toast, ask } = useApp();
  const [tab, setTab] = useState<"persona" | "global">(
    persona.memoryScope === "global" ? "global" : "persona",
  );
  const [memories, setMemories] = useState<CompanionMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [newCategory, setNewCategory] = useState<CompanionMemory["category"]>("preference");
  const [newContent, setNewContent] = useState("");
  const [newPinned, setNewPinned] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCategory, setEditCategory] = useState<CompanionMemory["category"]>("fact");
  const [editContent, setEditContent] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [scoped, general] = await Promise.all([
        listMemories(game, persona.id),
        listMemories(game),
      ]);
      const merged = [...new Map([...scoped, ...general].map((m) => [m.id, m])).values()];
      setMemories(merged);
      const activeCount = merged.filter(
        (m) => m.enabled && (m.scope === "global" || m.personaId === persona.id),
      ).length;
      onCountChange?.(activeCount);
    } catch {
      toast("没能读取记忆簿，请稍后再试");
    } finally {
      setLoading(false);
    }
  }, [game, persona.id, onCountChange, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const personaMemories = useMemo(
    () => memories.filter((m) => m.scope === "persona" && m.personaId === persona.id),
    [memories, persona.id],
  );
  const globalMemories = useMemo(
    () => memories.filter((m) => m.scope === "global"),
    [memories],
  );

  const visibleList = useMemo(() => {
    const source = tab === "persona" ? personaMemories : globalMemories;
    return source
      .filter((m) => localFind(query, m.content, CATEGORY_LABEL[m.category] ?? "记忆"))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }, [tab, personaMemories, globalMemories, query]);

  const handleAdd = async () => {
    const content = newContent.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      await saveMemory(game, {
        scope: tab,
        personaId: tab === "persona" ? persona.id : "",
        category: newCategory,
        content,
        pinned: newPinned,
        enabled: true,
      });
      setNewContent("");
      setNewPinned(false);
      setAdding(false);
      await load();
      toast("已记入记忆簿");
    } catch (err) {
      toast(err instanceof Error ? err.message : "没能保存记忆");
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (m: CompanionMemory, enabled: boolean) => {
    setMemories((prev) => prev.map((x) => (x.id === m.id ? { ...x, enabled } : x)));
    try {
      await toggleMemory(game, m.id, enabled);
      await load();
    } catch {
      await load();
      toast("状态未保存，请重试");
    }
  };

  const handlePin = async (m: CompanionMemory) => {
    if (busy) return;
    setBusy(true);
    try {
      await saveMemory(game, {
        id: m.id,
        scope: m.scope,
        personaId: m.personaId,
        category: m.category,
        content: m.content,
        pinned: !m.pinned,
        enabled: m.enabled,
        sourceSessionId: m.sourceSessionId,
        sourceMessageId: m.sourceMessageId,
      });
      await load();
      toast(m.pinned ? "已取消常驻" : "已设为常驻记忆");
    } catch {
      toast("没能更新常驻状态");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (m: CompanionMemory) => {
    setEditingId(m.id);
    setEditCategory(m.category);
    setEditContent(m.content);
  };

  const handleSaveEdit = async (m: CompanionMemory) => {
    const content = editContent.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      await saveMemory(game, {
        id: m.id,
        scope: m.scope,
        personaId: m.personaId,
        category: editCategory,
        content,
        pinned: m.pinned,
        enabled: m.enabled,
        sourceSessionId: m.sourceSessionId,
        sourceMessageId: m.sourceMessageId,
      });
      setEditingId(null);
      await load();
      toast("记忆已更新");
    } catch {
      toast("没能保存修改");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (m: CompanionMemory) => {
    const ok = await ask({
      title: "删掉这条记忆？",
      message: "删掉后之后的对话不再参考这条内容。",
      confirm: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteMemory(game, m.id);
      await load();
      toast("已删除一条记忆", {
        label: "撤销",
        run: () => {
          void saveMemory(game, {
            scope: m.scope,
            personaId: m.personaId,
            category: m.category,
            content: m.content,
            pinned: m.pinned,
            enabled: m.enabled,
            sourceSessionId: m.sourceSessionId,
            sourceMessageId: m.sourceMessageId,
          }).then(() => load());
        },
      });
    } catch {
      toast("没能删除记忆");
    }
  };

  return (
    <Sheet title="记忆簿" onClose={onClose}>
      <div className="stack">
        <p className="muted m-0">
          这里记下的内容完全透明可控：随时开关、常驻置顶、改字或删除，绝不暗箱记住你不想要的事。
        </p>

        <div className="segmented" role="tablist" aria-label="记忆范围">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "persona"}
            aria-pressed={tab === "persona"}
            onClick={() => {
              setTab("persona");
              setEditingId(null);
            }}
          >
            当前角色记忆（{personaMemories.length}）
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "global"}
            aria-pressed={tab === "global"}
            onClick={() => {
              setTab("global");
              setEditingId(null);
            }}
          >
            全局偏好记忆（{globalMemories.length}）
          </button>
        </div>

        {tab === "persona" && persona.memoryScope === "off" && (
          <div className="notice">
            <div className="notice-body">
              <p>
                「{persona.name}」当前设为“不记长期记忆”，对话时不会带入长期记忆；如需启用可在角色工坊里调整。
              </p>
            </div>
          </div>
        )}

        <div className="row between wrap">
          <span className="muted">
            {tab === "persona"
              ? `只属于「${persona.name}」的相处点滴与设定`
              : "所有开启记忆的角色都会参考的创作习惯与偏好"}
          </span>
          {!adding && (
            <button
              type="button"
              className="primary small"
              onClick={() => {
                setNewCategory(tab === "global" ? "preference" : "fact");
                setAdding(true);
              }}
            >
              <Icon name="plus" size={16} />
              手动记一条
            </button>
          )}
        </div>

        {adding && (
          <div className="memory-composer">
            <div className="segmented" role="group" aria-label="记忆分类">
              {CATEGORIES.map(([cat, label]) => (
                <button
                  key={cat}
                  type="button"
                  aria-pressed={newCategory === cat}
                  onClick={() => setNewCategory(cat)}
                >
                  {label}
                </button>
              ))}
            </div>
            <textarea
              aria-label="新记忆内容"
              rows={3}
              value={newContent}
              placeholder={
                tab === "global"
                  ? "如：我喜欢克制留白的古风对白，不喜欢现代网络热词"
                  : `如：和「${persona.name}」约定过先查清漕运旧案`
              }
              onChange={(e) => setNewContent(e.target.value)}
            />
            <Switch
              label="常驻置顶"
              note="每次对话优先带上这条记忆"
              checked={newPinned}
              onChange={setNewPinned}
            />
            <div className="row">
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => {
                  setAdding(false);
                  setNewContent("");
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="primary grow"
                disabled={busy || !newContent.trim()}
                onClick={() => void handleAdd()}
              >
                {busy ? "正在保存…" : "记下来"}
              </button>
            </div>
          </div>
        )}

        {(personaMemories.length + globalMemories.length) > 4 && (
          <input
            type="search"
            aria-label="查找记忆"
            placeholder="搜索已记下的内容"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}

        {loading && <p className="muted">正在读取记忆簿…</p>}

        {!loading && !visibleList.length && (
          <p className="muted">
            {query.trim()
              ? "没有找到相符的记忆。"
              : "这里还是空的。可以在回答下方点“记住这条”，或点上方“手动记一条”。"}
          </p>
        )}

        <div className="memory-list">
          {visibleList.map((m) => {
            const isEditing = editingId === m.id;
            return (
              <div
                key={m.id}
                className={`memory-card${!m.enabled ? " disabled" : ""}${m.pinned ? " pinned" : ""}`}
              >
                {isEditing ? (
                  <div className="stack gap-2">
                    <div className="segmented" role="group" aria-label="编辑记忆分类">
                      {CATEGORIES.map(([cat, label]) => (
                        <button
                          key={cat}
                          type="button"
                          aria-pressed={editCategory === cat}
                          onClick={() => setEditCategory(cat)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <textarea
                      rows={3}
                      aria-label="编辑记忆内容"
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                    />
                    <div className="row">
                      <button type="button" className="ghost" onClick={() => setEditingId(null)}>
                        取消
                      </button>
                      <button
                        type="button"
                        className="primary grow"
                        disabled={busy || !editContent.trim()}
                        onClick={() => void handleSaveEdit(m)}
                      >
                        保存修改
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="memory-card-head">
                      <div className="memory-badges">
                        <span className="memory-cat-tag">{CATEGORY_LABEL[m.category] ?? "记忆"}</span>
                        {m.pinned && <span className="memory-pin-tag">常驻</span>}
                      </div>
                      <small className="muted">
                        {new Date(m.updatedAt).toLocaleDateString("zh-CN")}
                      </small>
                    </div>
                    <p className="memory-content">{m.content}</p>
                    <div className="memory-card-foot">
                      <Switch
                        label={m.enabled ? "参与对话" : "暂不带入"}
                        checked={m.enabled}
                        onChange={(next) => void handleToggle(m, next)}
                      />
                      <div className="memory-card-actions">
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy}
                          onClick={() => void handlePin(m)}
                        >
                          {m.pinned ? "取消常驻" : "常驻"}
                        </button>
                        <button type="button" className="ghost" onClick={() => startEdit(m)}>
                          编辑
                        </button>
                        <button
                          type="button"
                          className="ghost danger-text"
                          onClick={() => void handleDelete(m)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}
