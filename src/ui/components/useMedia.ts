// Media queries for the Windows desktop (R10-T001).
import { useEffect, useState } from "react";

export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const list = matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** Wide enough to keep the character panel open beside the story. */
export const useWide = () => useMedia("(min-width: 1000px)");
/** A mouse and keyboard rather than a touch screen: Enter sends. */
export const useMouse = () => useMedia("(hover: hover) and (pointer: fine)");
