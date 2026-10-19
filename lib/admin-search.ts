export function searchableAdminText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return `${value.toLocaleDateString("en-PH")} ${value.toISOString()}`;
  if (Array.isArray(value)) return value.map(searchableAdminText).filter(Boolean).join(" ");
  if (!value || typeof value !== "object") return "";

  const timestamp = value as { toDate?: () => Date; toMillis?: () => number };
  if (typeof timestamp.toDate === "function") {
    try { return searchableAdminText(timestamp.toDate()); } catch { return ""; }
  }
  if (typeof timestamp.toMillis === "function") {
    try { return searchableAdminText(new Date(timestamp.toMillis())); } catch { return ""; }
  }

  return Object.values(value).map(searchableAdminText).filter(Boolean).join(" ");
}

export function matchesAdminSearch(value: unknown, query: string) {
  const terms = query.trim().toLocaleLowerCase("en-PH").split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const searchableText = searchableAdminText(value).toLocaleLowerCase("en-PH");
  return terms.every((term) => searchableText.includes(term));
}
