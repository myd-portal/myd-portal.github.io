export const accountSuffixOptions = ["Jr.", "Sr.", "I", "II", "III", "IV", "V"] as const;

export type AccountSuffix = (typeof accountSuffixOptions)[number];

function cleanNamePart(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

export function normalizeAccountSuffix(value: unknown): AccountSuffix | "" {
  const cleaned = cleanNamePart(value).replace(/\.$/, "").toLocaleLowerCase("en-PH");
  return accountSuffixOptions.find((suffix) => suffix.replace(/\.$/, "").toLocaleLowerCase("en-PH") === cleaned) ?? "";
}

export function accountMiddleInitial(value: unknown) {
  const middleName = cleanNamePart(value);
  const initial = middleName ? Array.from(middleName.replace(/\.+$/, ""))[0] : "";
  return initial ? `${initial.toLocaleUpperCase("en-PH")}.` : "";
}

export function formatAccountName(firstName: unknown, middleName: unknown, lastName: unknown, suffix?: unknown) {
  return [
    cleanNamePart(firstName),
    accountMiddleInitial(middleName),
    cleanNamePart(lastName),
    normalizeAccountSuffix(suffix),
  ].filter(Boolean).join(" ");
}

export function parseAccountName(value: string) {
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (!cleaned) return { firstName: "", middleName: "", lastName: "", suffix: "" };

  const comma = cleaned.indexOf(",");
  if (comma >= 0) {
    const lastNameParts = cleaned.slice(0, comma).trim().split(" ").filter(Boolean);
    let suffix = normalizeAccountSuffix(lastNameParts.at(-1));
    if (suffix) lastNameParts.pop();
    const givenNameParts = cleaned.slice(comma + 1).trim().split(" ").filter(Boolean);
    const givenSuffix = normalizeAccountSuffix(givenNameParts.at(-1));
    if (!suffix && givenSuffix) suffix = givenSuffix;
    if (givenSuffix) givenNameParts.pop();
    return {
      firstName: givenNameParts[0] ?? "",
      middleName: givenNameParts.slice(1).join(" "),
      lastName: lastNameParts.join(" "),
      suffix,
    };
  }

  const parts = cleaned.split(" ").filter(Boolean);
  const suffix = normalizeAccountSuffix(parts.at(-1));
  if (suffix) parts.pop();
  const lastName = parts.length > 1 ? parts.pop() ?? "" : "";
  const firstName = parts.shift() ?? "";
  return { firstName, middleName: parts.join(" "), lastName, suffix };
}
