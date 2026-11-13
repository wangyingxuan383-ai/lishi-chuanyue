/** Match only the explicitly supplied local display fields, without regex or indexing. */
export function localFind(query: string, ...fields: (string | undefined | null)[]): boolean {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
  const words = normalize(query).trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return true;
  const text = fields.map(value => normalize(value ?? "")).join("\n");
  return words.every(word => text.includes(word));
}
