import { unzipSync } from "fflate";
import { accountOfficeOptions, divisionsForOffice, unitsForOfficeDivision } from "@/lib/account-profile";
import { isWithinImportTemplateDateRange } from "@/lib/import-template-rules";
import { divisionSignatory, type TevDivision } from "@/lib/mytev";

export type ImportedAppearancePerson = {
  name: string;
  gender: "female" | "male" | "unspecified";
  office: string;
};

export type ImportedAppearanceRecord = {
  eventTitle: string;
  destination: string;
  eventDateFrom: string;
  eventDateTo: string;
  people: ImportedAppearancePerson[];
  signatoryName: string;
  designation: string;
  division: string;
  certificateOffice?: string;
  certificateDivision?: string;
  certificateUnit?: string;
};

const requiredColumns = [
  "title",
  "destination",
  "datefrom",
  "dateto",
] as const;

const divisionAliases: Record<string, TevDivision> = {
  "Planning, and Monitoring and Evaluation Division": "Planning, Monitoring and Evaluation Division",
  "Administrative Division": "Administrative and Finance Division",
};
const certificateImportDivisions = new Set<TevDivision>([
  "Administrative and Finance Division",
  "Agribusiness and Marketing Assistance Division",
  "Field Operations Division",
  "Finance Division",
  "Integrated Laboratories Division",
  "Planning, Monitoring and Evaluation Division",
  "Regional Agricultural Engineering Division",
  "Regulatory Division",
  "Research Division",
]);

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function excelColumnIndex(reference: string) {
  const column = reference.match(/^[A-Z]+/)?.[0] ?? "";
  return [...column].reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function workbookWorksheetPath(target: string) {
  const packagePath = target.startsWith("/") ? target : `xl/${target}`;
  const segments: string[] = [];
  for (const segment of packagePath.replace(/^\/+/, "").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

function parseDate(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed)) {
    const [year, month, day] = trimmed.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
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

export function parseCertificateImportWorkbook(bytes: Uint8Array): ImportedAppearanceRecord[] {
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
  const workbookBytes = files["xl/workbook.xml"];
  const relationshipsBytes = files["xl/_rels/workbook.xml.rels"];
  if (!workbookBytes || !relationshipsBytes) throw new Error("The workbook is missing its worksheet list.");
  const workbook = parseXml(workbookBytes, "workbook");
  const relationships = parseXml(relationshipsBytes, "worksheet list");
  const sheets = Array.from(workbook.getElementsByTagNameNS("*", "sheet"));
  const sheet = sheets.find((item) => item.getAttribute("name")?.trim().toLowerCase() === "appearance") ?? sheets[0];
  const relationshipId = sheet?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")
    ?? sheet?.getAttribute("r:id");
  const relationship = relationshipId
    ? Array.from(relationships.getElementsByTagNameNS("*", "Relationship")).find((item) => item.getAttribute("Id") === relationshipId)
    : undefined;
  const worksheetPath = relationship?.getAttribute("Target");
  const worksheetBytes = worksheetPath ? files[workbookWorksheetPath(worksheetPath)] : undefined;
  if (!worksheetBytes) throw new Error("The workbook's Appearance worksheet could not be read.");

  const sheetData = parseXml(worksheetBytes, "worksheet").getElementsByTagNameNS("*", "sheetData")[0];
  const rows = sheetData ? Array.from(sheetData.children) : [];
  if (!rows.length) throw new Error("The workbook has no rows to import.");

  const readRow = (row: Element) => {
    const values = new Map<number, string>();
    for (const cell of Array.from(row.children)) {
      const columnIndex = excelColumnIndex(cell.getAttribute("r") ?? "");
      if (columnIndex < 0) continue;
      const type = cell.getAttribute("t");
      if (type === "inlineStr") {
        values.set(columnIndex, Array.from(cell.getElementsByTagNameNS("*", "t"), (text) => text.textContent ?? "").join(""));
        continue;
      }
      const rawValue = cell.getElementsByTagNameNS("*", "v")[0]?.textContent ?? "";
      values.set(columnIndex, type === "s" ? sharedStrings[Number(rawValue)] ?? "" : rawValue);
    }
    return values;
  };

  const headerCells = readRow(rows[0]);
  const headerColumns = [...headerCells].map(([index, value]) => ({ index, name: normalizeHeader(value) }));
  const columnsNamed = (...names: string[]) => headerColumns.filter((column) => names.includes(column.name)).map((column) => column.index);
  const columnNamed = (...names: string[]) => columnsNamed(...names)[0];
  const attendeeNameColumn = columnNamed("attendeename", "name");
  const attendeeGenderColumn = columnNamed("attendeegender", "gender");
  const missingColumns = requiredColumns.filter((column) => columnNamed(column) === undefined);
  const officeColumns = columnsNamed("office");
  const explicitAttendeeOfficeColumn = columnNamed("attendeeoffice");
  const attendeeOfficeColumn = explicitAttendeeOfficeColumn ?? officeColumns[0];
  const certificateOfficeColumn = columnNamed("certificateoffice")
    ?? (explicitAttendeeOfficeColumn === undefined ? officeColumns[1] : officeColumns[0]);
  const certificateDivisionColumn = columnNamed("certificatedivision") ?? (certificateOfficeColumn === undefined ? undefined : columnNamed("division"));
  const certificateUnitColumn = columnNamed("certificateunit", "unitprogramproject", "unit", "programproject");
  const explicitSignatoryDivisionColumn = columnNamed("signatorydivision", "divisionname");
  const fallbackSignatoryDivisionColumn = certificateOfficeColumn === undefined ? columnNamed("division") : certificateDivisionColumn;
  const signatoryDivisionColumn = explicitSignatoryDivisionColumn ?? fallbackSignatoryDivisionColumn;
  if (missingColumns.length || attendeeOfficeColumn === undefined || attendeeNameColumn === undefined || attendeeGenderColumn === undefined
    || signatoryDivisionColumn === undefined
    || (certificateOfficeColumn !== undefined && (certificateDivisionColumn === undefined || certificateUnitColumn === undefined))) {
    throw new Error("Use the CA_Importing_Template.xlsx columns: Title, Destination, Date From, Date To, Attendee Name, Attendee Gender, Attendee Office, certificate Office, Division, and Unit / Program / Project. Add Signatory Division when the certificate Division is not one of the listed DA divisions.");
  }

  const recordsByEvent = new Map<string, ImportedAppearanceRecord>();
  const groupCounts = new Map<string, number>();
  const valueFor = (values: Map<number, string>, column: string) => values.get(columnNamed(column)!)?.trim() ?? "";
  const valueAt = (values: Map<number, string>, column: number | undefined) => column === undefined ? "" : values.get(column)?.trim() ?? "";

  rows.slice(1).forEach((row, index) => {
    const rowNumber = index + 2;
    const values = readRow(row);
    if (![...values.values()].some((value) => value.trim())) return;

    const eventTitle = valueFor(values, "title");
    const destination = valueFor(values, "destination");
    const name = valueAt(values, attendeeNameColumn);
    const office = valueAt(values, attendeeOfficeColumn);
    const certificateOffice = valueAt(values, certificateOfficeColumn);
    const certificateDivision = valueAt(values, certificateDivisionColumn);
    const certificateUnit = valueAt(values, certificateUnitColumn);
    const eventDateFrom = parseDate(valueFor(values, "datefrom"));
    const eventDateTo = parseDate(valueFor(values, "dateto"));
    const rawDivision = valueAt(values, signatoryDivisionColumn)
      || valueAt(values, fallbackSignatoryDivisionColumn);
    const division = (divisionAliases[rawDivision] ?? rawDivision) as TevDivision;
    if (!certificateImportDivisions.has(division)) {
      const needsExplicitSignatoryDivision = certificateOfficeColumn !== undefined && signatoryDivisionColumn === certificateDivisionColumn;
      throw new Error(needsExplicitSignatoryDivision
        ? `Row ${rowNumber}: this certificate Division is not a DA template Signatory Division. Add a Signatory Division column and choose one from the CA template.`
        : `Row ${rowNumber}: choose a valid Signatory Division from the CA template.`);
    }
    const signatory = divisionSignatory(division);

    if (!name) throw new Error(`Row ${rowNumber}: enter a Name for each certificate.`);
    if (!eventTitle || !destination || !eventDateFrom || !eventDateTo || !office) {
      throw new Error(`Row ${rowNumber}: complete the event details and attendee Office.`);
    }
    if (!isWithinImportTemplateDateRange(eventDateFrom) || !isWithinImportTemplateDateRange(eventDateTo)) {
      throw new Error(`Row ${rowNumber}: Date From and Date To must be between January 1, 2026 and December 31, 2027.`);
    }
    if (eventDateTo < eventDateFrom) throw new Error(`Row ${rowNumber}: Date To must be on or after Date From.`);

    if (certificateOfficeColumn !== undefined) {
      if (!certificateOffice || !certificateDivision || !certificateUnit) {
        throw new Error(`Row ${rowNumber}: complete the certificate Office, Division, and Unit / Program / Project.`);
      }
      if (!accountOfficeOptions.includes(certificateOffice as (typeof accountOfficeOptions)[number])
        || !divisionsForOffice(certificateOffice).includes(certificateDivision)
        || !unitsForOfficeDivision(certificateOffice, certificateDivision).includes(certificateUnit)) {
        throw new Error(`Row ${rowNumber}: choose a valid certificate Office, Division, and Unit / Program / Project.`);
      }
      if (signatoryDivisionColumn === certificateDivisionColumn && certificateDivision !== division) {
        throw new Error(`Row ${rowNumber}: the certificate Division must also be a valid Signatory Division, or add a Signatory Division column.`);
      }
    }

    const rawGender = valueAt(values, attendeeGenderColumn).trim().toLowerCase();
    const gender = rawGender === "f" || rawGender === "female"
      ? "female"
      : rawGender === "m" || rawGender === "male"
        ? "male"
        : rawGender
          ? null
          : "unspecified";
    if (!gender) throw new Error(`Row ${rowNumber}: Gender must be Female, Male, or blank.`);

    const eventKey = JSON.stringify([eventTitle, destination, eventDateFrom, eventDateTo, division, certificateOffice, certificateDivision, certificateUnit]);
    let groupKey = eventKey;
    let existing = recordsByEvent.get(groupKey);
    if (existing && existing.people.length >= 100) {
      const nextGroup = (groupCounts.get(eventKey) ?? 0) + 1;
      groupCounts.set(eventKey, nextGroup);
      groupKey = `${eventKey}:${nextGroup}`;
      existing = recordsByEvent.get(groupKey);
    }
    if (existing) {
      existing.people.push({ name, gender, office });
    } else {
      recordsByEvent.set(groupKey, {
        eventTitle,
        destination,
        eventDateFrom,
        eventDateTo,
        people: [{ name, gender, office }],
        signatoryName: signatory.name,
        designation: signatory.position,
        division,
        ...(certificateOfficeColumn !== undefined ? { certificateOffice, certificateDivision, certificateUnit } : {}),
      });
    }
  });

  if (!recordsByEvent.size) throw new Error("The workbook has no completed attendee rows to import.");
  return [...recordsByEvent.values()];
}
