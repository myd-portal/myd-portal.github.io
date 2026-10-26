import { unzipSync } from "fflate";
import { isWithinImportTemplateDateRange } from "@/lib/import-template-rules";

export type ImportedAppreciationSpeaker = {
  name: string;
  gender: "female" | "male";
  position: string;
  office: string;
};

export type ImportedAppreciationRecord = {
  unit: "AMIA" | "AGRISTAT" | "DRRM";
  speakers: ImportedAppreciationSpeaker[];
  eventTitle: string;
  eventDateFrom: string;
  eventDateTo: string;
  eventDestination: string;
  distributionSameAsDestination: boolean;
  distributionPlace: string;
};

const requiredColumns = [
  "unit", "title", "destination", "datefrom", "dateto", "name", "gender", "position", "office", "distributionplace",
] as const;
const MAX_IMPORTED_SPEAKERS = 100;

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function excelColumnIndex(reference: string) {
  const column = reference.match(/^[A-Z]+/)?.[0] ?? "";
  return [...column].reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function parseDate(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed)) {
    const [year, month, day] = trimmed.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return "";
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const serial = Number(trimmed);
    if (serial >= 1 && serial <= 2958465) {
      const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    }
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function parseAppreciationImportWorkbook(bytes: Uint8Array): ImportedAppreciationRecord[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("This file is not a readable .xlsx workbook.");
  }

  const decoder = new TextDecoder();
  const parseXml = (content: Uint8Array, description: string) => {
    const document = new DOMParser().parseFromString(decoder.decode(content), "application/xml");
    if (document.getElementsByTagName("parsererror").length) throw new Error(`The ${description} could not be read.`);
    return document;
  };
  const sharedStrings = files["xl/sharedStrings.xml"]
    ? Array.from(parseXml(files["xl/sharedStrings.xml"], "workbook text").getElementsByTagNameNS("*", "si"), (item) =>
      Array.from(item.getElementsByTagNameNS("*", "t"), (text) => text.textContent ?? "").join("")
    )
    : [];
  const worksheet = files["xl/worksheets/sheet1.xml"];
  if (!worksheet) throw new Error("The workbook is missing its first worksheet.");
  const rows = Array.from(parseXml(worksheet, "worksheet").getElementsByTagNameNS("*", "sheetData")[0]?.children ?? []);
  if (!rows.length) throw new Error("The workbook has no rows to import.");

  const readRow = (row: Element) => {
    const values = new Map<number, string>();
    for (const cell of Array.from(row.children)) {
      const column = excelColumnIndex(cell.getAttribute("r") ?? "");
      if (column < 0) continue;
      if (cell.getAttribute("t") === "inlineStr") {
        values.set(column, Array.from(cell.getElementsByTagNameNS("*", "t"), (text) => text.textContent ?? "").join(""));
        continue;
      }
      const raw = cell.getElementsByTagNameNS("*", "v")[0]?.textContent ?? "";
      values.set(column, cell.getAttribute("t") === "s" ? sharedStrings[Number(raw)] ?? "" : raw);
    }
    return values;
  };

  const headers = readRow(rows[0]);
  const columns = new Map([...headers].map(([index, value]) => [normalizeHeader(value), index] as const));
  const templateFromColumn = columns.get("certificatetemplatefrom") ?? columns.get("assignment") ?? columns.get("unit");
  if (templateFromColumn !== undefined) columns.set("unit", templateFromColumn);
  if (requiredColumns.some((column) => !columns.has(column))) {
    throw new Error("Use the Appreciation_Importing_Template.xlsx columns: Certificate Template From, Title, Destination, Date From, Date To, Name, Gender, Position, Office, and Distribution Place.");
  }

  const valueFor = (values: Map<number, string>, column: typeof requiredColumns[number]) => values.get(columns.get(column)!)?.trim() ?? "";
  const grouped = new Map<string, ImportedAppreciationRecord>();
  const groupCounts = new Map<string, number>();
  const lastGroupKeys = new Map<string, string>();
  rows.slice(1).forEach((row, index) => {
    const rowNumber = index + 2;
    const values = readRow(row);
    if (![...values.values()].some((value) => value.trim())) return;
    const unit = valueFor(values, "unit").toUpperCase().replace(/^FOD-/, "");
    if (unit !== "DRRM" && unit !== "AMIA" && unit !== "AGRISTAT") throw new Error(`Row ${rowNumber}: Certificate Template From must be AGRISTAT, AMIA, or DRRM.`);
    const rawGender = valueFor(values, "gender").trim().toLowerCase();
    const speakerGender = rawGender === "f" || rawGender === "female" ? "female" : rawGender === "m" || rawGender === "male" ? "male" : "";
    const speakerName = valueFor(values, "name");
    const speakerPosition = valueFor(values, "position");
    const speakerOffice = valueFor(values, "office");
    const eventTitle = valueFor(values, "title");
    const eventDestination = valueFor(values, "destination");
    const eventDateFrom = parseDate(valueFor(values, "datefrom"));
    const eventDateTo = parseDate(valueFor(values, "dateto"));
    const rawDistributionPlace = valueFor(values, "distributionplace");
    const distributionPlace = rawDistributionPlace || eventDestination;
    if (!speakerName || !speakerGender || !speakerPosition || !speakerOffice || !eventTitle || !eventDestination || !eventDateFrom || !eventDateTo) {
      throw new Error(`Row ${rowNumber}: complete Certificate Template From, speaker details, event, date, and destination fields.`);
    }
    if (!isWithinImportTemplateDateRange(eventDateFrom) || !isWithinImportTemplateDateRange(eventDateTo)) {
      throw new Error(`Row ${rowNumber}: Date From and Date To must be between January 1, 2026 and December 31, 2027.`);
    }
    if (eventDateTo < eventDateFrom) throw new Error(`Row ${rowNumber}: Date To must be on or after Date From.`);
    if (speakerName.length > 180 || speakerPosition.length > 180 || speakerOffice.length > 240 || eventTitle.length > 240 || eventDestination.length > 240 || distributionPlace.length > 240) {
      throw new Error(`Row ${rowNumber}: speaker, event, destination, and distribution fields exceed their allowed lengths.`);
    }
    const distributionSameAsDestination = rawDistributionPlace.trim().toLowerCase() === eventDestination.trim().toLowerCase() || !rawDistributionPlace;
    const eventKey = JSON.stringify([unit, eventTitle, eventDateFrom, eventDateTo, eventDestination, distributionPlace]);
    let groupKey = lastGroupKeys.get(eventKey) ?? eventKey;
    let existing = grouped.get(groupKey);
    if (existing && existing.speakers.length >= MAX_IMPORTED_SPEAKERS) {
      const nextGroup = (groupCounts.get(eventKey) ?? 0) + 1;
      groupCounts.set(eventKey, nextGroup);
      groupKey = `${eventKey}:${nextGroup}`;
      existing = grouped.get(groupKey);
    }
    if (existing) {
      existing.speakers.push({ name: speakerName, gender: speakerGender, position: speakerPosition, office: speakerOffice });
    } else {
      grouped.set(groupKey, {
        unit,
        speakers: [{ name: speakerName, gender: speakerGender, position: speakerPosition, office: speakerOffice }],
        eventTitle,
        eventDateFrom,
        eventDateTo,
        eventDestination,
        distributionSameAsDestination,
        distributionPlace: distributionSameAsDestination ? eventDestination : distributionPlace,
      });
    }
    lastGroupKeys.set(eventKey, groupKey);
  });

  if (!grouped.size) throw new Error("The workbook has no completed speaker rows to import.");
  return [...grouped.values()];
}
