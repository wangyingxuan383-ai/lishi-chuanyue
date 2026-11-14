import type { ContextPreview } from "../../../engine/game";
import * as tree from "../../../engine/tree";
import type { StoryNode, WorldState } from "../../../engine/types";
import type { AppValue } from "../../app/context";
import { MenuSheet } from "../../components/Sheet";

interface PassageMenuProps {
  menuNode: StoryNode; head: StoryNode; busy: boolean;
  setMenuNode: (node: StoryNode | null) => void;
  openWriting: (kind: "rewrite" | "polish", node: StoryNode) => void;
  setRemember: (value: { node: StoryNode; text: string }) => void;
  goBack: (node: StoryNode) => Promise<void>;
  toast: AppValue["toast"];
  setMenuMore: (node: StoryNode | null) => void;
}

export function PassageMenu({ menuNode, head, busy, setMenuNode, openWriting, setRemember, goBack, toast, setMenuMore }: PassageMenuProps) {
  return (
    <MenuSheet
      title={`“${menuNode.narrative.replace(/\s+/g, "").slice(0, 16)}…”`}
      onClose={() => setMenuNode(null)}
      items={[
        { icon: "sparkle", label: "AI 改写", hidden: menuNode.kind === "edit" || !menuNode.narrative.trim() || busy, onSelect: () => openWriting("rewrite", menuNode) },
        { icon: "memo", label: "记住这件事", hidden: menuNode.kind === "edit" || !menuNode.narrative.trim() || busy, onSelect: () => setRemember({ node: menuNode, text: menuNode.narrative.trim() }) },
        { icon: "rewind", label: "回到这里", hidden: menuNode.id === head.id || busy, onSelect: () => void goBack(menuNode) },
        { icon: "copy", label: "复制", onSelect: () => { void navigator.clipboard?.writeText(menuNode.narrative); toast("已复制"); } },
        { icon: "more", label: "更多…", onSelect: () => setMenuMore(menuNode) },
      ]}
    />
  );
}

interface PassageMoreMenuProps {
  menuMore: StoryNode; busy: boolean; devMode: boolean; game: AppValue["game"];
  setMenuMore: (node: StoryNode | null) => void;
  setEditing: (value: { node: StoryNode; field: "narrative" | "action"; text: string }) => void;
  refresh: () => Promise<void>;
  toast: AppValue["toast"];
  setBookmark: (value: { node: StoryNode; name: string }) => void;
  setCardNode: (node: StoryNode) => void;
  setRawNode: (node: StoryNode) => void;
  setUsageNode: (id: string) => void;
}

export function PassageMoreMenu({ menuMore, busy, devMode, game, setMenuMore, setEditing, refresh, toast, setBookmark, setCardNode, setRawNode, setUsageNode }: PassageMoreMenuProps) {
  return (
    <MenuSheet
      title="这一段还可以"
      onClose={() => setMenuMore(null)}
      items={[
        { icon: "pen", label: "自己改写这段文字", hidden: menuMore.kind === "edit" || busy, onSelect: () => setEditing({ node: menuMore, field: "narrative", text: menuMore.narrative }) },
        { icon: "undo", label: "恢复 AI 写的原文", hidden: !menuMore.rewritten || typeof menuMore.meta.original !== "string" || menuMore.meta.original === menuMore.narrative || busy, onSelect: () => void game.repo.restoreNarrative(menuMore.id).then(() => { void refresh(); toast("已恢复原文"); }) },
        { icon: "feather", label: "改我的行动", hidden: !menuMore.actionText || menuMore.actionMode === "continue" || menuMore.actionMode === "skip" || busy, onSelect: () => setEditing({ node: menuMore, field: "action", text: menuMore.actionText ?? "" }) },
        { icon: "bookmark", label: "加书签", hidden: menuMore.kind === "edit", onSelect: () => setBookmark({ node: menuMore, name: menuMore.narrative.replace(/\s+/g, "").slice(0, 12) || "书签" }) },
        { icon: "share", label: "做成书摘卡", hidden: menuMore.kind === "edit" || !menuMore.narrative.trim(), onSelect: () => setCardNode(menuMore) },
        { icon: "coin", label: "这一段的用量", hidden: menuMore.kind === "edit", onSelect: () => setUsageNode(menuMore.id) },
        { icon: "key", label: "查看原始输出（开发者）", hidden: !devMode, onSelect: () => setRawNode(menuMore) },
      ]}
    />
  );
}

interface MoreMenuProps {
  mouse: boolean; busy: boolean; state: WorldState; dead: boolean; watch?: boolean;
  head: StoryNode; cursor: tree.Cursor; noteOpen: boolean; devMode: boolean;
  game: AppValue["game"]; worldId: string;
  setSheet: (sheet: "toc" | "ask" | "reference" | "notes" | "usage" | "life" | "autoplay" | "skip" | "lines" | "story" | "settings" | "keys" | null) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  setNoteOpen: (open: boolean) => void;
  push: AppValue["push"];
  again: (retry: boolean) => Promise<void>;
  setContext: (context: ContextPreview | null) => void;
}

export function MoreMenu({ mouse, busy, state, dead, watch, head, cursor, noteOpen, devMode, game, worldId, setSheet, undo, redo, setNoteOpen, push, again, setContext }: MoreMenuProps) {
  return (
    <MenuSheet
      onClose={() => setSheet(null)}
      items={[
        { icon: "list", group: "阅读", label: "目录与搜索", onSelect: () => setSheet("toc") },
        { icon: "search", group: "阅读", label: mouse ? "查一查（Ctrl+F）" : "查一查", hidden: busy, onSelect: () => setSheet("ask") },
        { icon: "memo", group: "阅读", label: "原著札记", hidden: !state.source, onSelect: () => setSheet("notes") },
        { icon: "book", group: "阅读", label: "参考资料", hidden: !state.source, onSelect: () => setSheet("reference") },
        { icon: "person", group: "阅读", label: "这一世小传", onSelect: () => setSheet("life") },
        { icon: "play", group: "推进", label: "连播", hidden: busy || dead || watch, onSelect: () => setSheet("autoplay") },
        { icon: "clock", group: "推进", label: "过些日子", hidden: busy, onSelect: () => setSheet("skip") },
        { icon: "undo", group: "推进", label: mouse ? "撤销（Ctrl+Z）" : "撤销", hidden: !head.parentId || busy, onSelect: () => void undo() },
        { icon: "redo", group: "推进", label: mouse ? "重做（Ctrl+Y）" : "重做", hidden: !tree.canRedo(cursor) || busy, onSelect: () => void redo() },
        { icon: "branch", group: "推进", label: "世界线", onSelect: () => setSheet("lines") },
        { icon: "memo", group: "本局", label: "故事设定与要点", onSelect: () => setSheet("story") },
        { icon: "settings", group: "本局", label: "本局设置", onSelect: () => setSheet("settings") },
        { icon: "coin", group: "本局", label: "本局用量", onSelect: () => setSheet("usage") },
        { icon: "feather", group: "本局", label: "幕后要求", hidden: noteOpen || watch, onSelect: () => setNoteOpen(true) },
        { icon: "info", group: "其他", label: mouse ? "游玩指南（F1）" : "游玩指南", onSelect: () => push({ name: "guide" }) },
        { icon: "key", group: "其他", label: "快捷键", hidden: !mouse, onSelect: () => setSheet("keys") },
        { icon: "refresh", group: "其他", label: "用同样设定再开一局", hidden: busy, onSelect: () => void again(false) },
        { icon: "database", group: "其他", label: "查看上下文（开发者）", hidden: !devMode || busy, onSelect: async () => setContext(await game.previewContext(worldId)) },
      ]}
    />
  );
}
