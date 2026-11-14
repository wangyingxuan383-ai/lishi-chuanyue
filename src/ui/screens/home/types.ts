import type { World } from "../../../engine/types";

/** One story on the home screen. */
export interface WorldCard {
  world: World;
  protagonist: string;
  lastLine: string;
  clock: string;
  /** The story's hour, for the scene's sky. */
  hour: number;
  turns: number;
  /** The dynasty for the cover's seal; none for a free world or an unknown era. */
  seal?: string;
}

export interface HomeViewProps {
  cards: WorldCard[];
  writing: Set<string>;
  /** Opens a story; `from` is the element the opening animation starts from. */
  onOpen: (card: WorldCard, from: HTMLElement | null) => void;
  onMenu: (card: WorldCard) => void;
  /** The 开始新的故事 button, placed where the design wants it. */
  newStory: React.ReactNode;
}

export function relative(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时前`;
  return `${Math.round(minutes / 1440)} 天前`;
}
