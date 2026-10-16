import { TANG_748 } from "./tang-748";
import type { EraDraft } from "./types";

export const ERAS: EraDraft[] = [TANG_748];

export function getEra(id: string): EraDraft {
  return ERAS.find((e) => e.id === id) ?? TANG_748;
}

export type { EraDraft, EraIdentity } from "./types";
