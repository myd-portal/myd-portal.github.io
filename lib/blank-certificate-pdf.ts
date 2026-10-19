import type { PDFDocument, PDFPage } from "pdf-lib";
import { divisionSignatory, type TevDivision } from "@/lib/mytev";
import { appearanceCertificateSignatory, certificateDisapprovalStampDetails, fieldOperationsAppearanceApprovalSignatureAsset, type CertificateWorkflowFields } from "@/app/CertificateWorkflow";

type BlankCertificatePdfRecord = CertificateWorkflowFields & {
  division: string;
  eventTitle?: string;
  purpose?: string;
  destination?: string;
  eventDateFrom?: string;
  eventDateTo?: string;
};

const publicAsset = (path: string) => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
const blankCertificatePdfAsset = publicAsset("/certificate-of-appearance.pdf");
const legacyBlankTitle = "Blank Certificate of Appearance";

function certificateDate(value: string, includeMonth = true) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "UTC",
    ...(includeMonth ? { month: "short" as const } : {}),
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function certificateDateRange(from?: string, to?: string) {
  const start = from?.trim() ?? "";
  const end = to?.trim() || start;
  if (!start) return "";
  if (start === end) return certificateDate(start);
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return `${start} - ${end}`;
  if (startDate.getUTCFullYear() === endDate.getUTCFullYear()
    && startDate.getUTCMonth() === endDate.getUTCMonth()) {
    const month = new Intl.DateTimeFormat("en-PH", { month: "long", timeZone: "UTC" }).format(startDate);
    return `${month} ${startDate.getUTCDate()}-${endDate.getUTCDate()}, ${endDate.getUTCFullYear()}`;
  }
  return `${certificateDate(start)}-${certificateDate(end)}`;
}

const eventFontFamily = 'Cambria, "Times New Roman", serif';
type CanvasTextRun = { text: string; bold?: boolean; italic?: boolean };

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, width: number, size: number) {
  context.font = `${size}px ${eventFontFamily}`;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (context.measureText(line).width > width) {
      let chunk = "";
      for (const character of word) {
        if (chunk && context.measureText(`${chunk}${character}`).width > width) {
          lines.push(chunk);
          chunk = character;
        } else chunk += character;
      }
      line = chunk;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function wrapCanvasRuns(context: CanvasRenderingContext2D, runs: CanvasTextRun[], width: number, size: number) {
  const lines: CanvasTextRun[][] = [[]];
  let lineWidth = 0;
  let pendingSpace = false;
  const currentLine = () => lines[lines.length - 1];
  const append = (text: string, bold: boolean, italic: boolean) => {
    const line = currentLine();
    const previous = line[line.length - 1];
    if (previous?.bold === bold && previous.italic === italic) previous.text += text;
    else line.push({ text, bold, italic });
  };
  const setFont = (run: CanvasTextRun) => {
    context.font = `${run.italic ? "italic " : ""}${run.bold ? "bold " : ""}${size}px ${eventFontFamily}`;
  };

  for (const run of runs) {
    setFont(run);
    for (const token of run.text.match(/\s+|\S+/g) ?? []) {
      if (/^\s+$/.test(token)) {
        pendingSpace = currentLine().length > 0;
        continue;
      }
      const space = pendingSpace && currentLine().length > 0 ? " " : "";
      pendingSpace = false;
      const tokenWidth = context.measureText(token).width;
      const spaceWidth = space ? context.measureText(space).width : 0;
      if (lineWidth + spaceWidth + tokenWidth > width && currentLine().length > 0) {
        lines.push([]);
        lineWidth = 0;
      } else if (space) {
        append(space, Boolean(run.bold), Boolean(run.italic));
        lineWidth += spaceWidth;
      }

      if (tokenWidth <= width) {
        append(token, Boolean(run.bold), Boolean(run.italic));
        lineWidth += tokenWidth;
        continue;
      }

      for (const character of token) {
        const characterWidth = context.measureText(character).width;
        if (lineWidth + characterWidth > width && currentLine().length > 0) {
          lines.push([]);
          lineWidth = 0;
        }
        append(character, Boolean(run.bold), Boolean(run.italic));
        lineWidth += characterWidth;
      }
    }
  }
  return lines.filter((line) => line.length > 0);
}

async function makeCambriaRichTextImage(runs: CanvasTextRun[], width: number, height: number, baseline: number, fontSize: number, justify = false) {
  await Promise.all([
    document.fonts.load(`${fontSize}px Cambria`),
    document.fonts.load(`bold ${fontSize}px Cambria`),
    document.fonts.load(`italic bold ${fontSize}px Cambria`),
  ]);
  const scale = 4;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to prepare the certificate event details.");
  context.scale(scale, scale);
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#111";
  context.textBaseline = "alphabetic";
  const spaceCount = justify
    ? runs.reduce((count, run) => count + (run.text.match(/ /g)?.length ?? 0), 0)
    : 0;
  const lineWidth = runs.reduce((total, run) => {
    context.font = `${run.italic ? "italic " : ""}${run.bold ? "bold " : ""}${fontSize}px ${eventFontFamily}`;
    return total + context.measureText(run.text).width;
  }, 0);
  const extraSpace = spaceCount ? Math.max(0, width - 2 - lineWidth) / spaceCount : 0;
  let x = 1;
  for (const run of runs) {
    context.font = `${run.italic ? "italic " : ""}${run.bold ? "bold " : ""}${fontSize}px ${eventFontFamily}`;
    for (const part of run.text.split(/( +)/).filter(Boolean)) {
      context.fillText(part, x, baseline);
      x += context.measureText(part).width;
      if (justify && /^ +$/.test(part)) x += extraSpace * part.length;
    }
  }
  return canvas.toDataURL("image/png");
}

async function makeCambriaTextImage(text: string, width: number, height: number, baseline: number, fontSize: number, justify = false) {
  return makeCambriaRichTextImage([{ text }], width, height, baseline, fontSize, justify);
}

async function drawEventDetails(pdf: PDFDocument, page: PDFPage, record: BlankCertificatePdfRecord) {
  const legacyTitle = record.eventTitle?.trim() === legacyBlankTitle;
  const title = (legacyTitle ? record.purpose : record.eventTitle)?.trim() || "";
  const destination = record.destination?.trim() || "";
  const dateRange = certificateDateRange(record.eventDateFrom, record.eventDateTo);
  const eventRuns: CanvasTextRun[] = [
    { text: "attended the “" },
    ...(title ? [{ text: title, bold: true, italic: true }] : []),
    ...(title ? [{ text: "”" }] : []),
    ...(destination ? [{ text: " held in " }, { text: destination, bold: true }] : []),
    ...(dateRange ? [{ text: " on " }, { text: dateRange, bold: true }] : []),
    { text: "." },
  ];
  const legalText = "This certification is issued upon the request of the above-named person for whatever legal purpose it may serve him/her best.";
  await document.fonts.load("12px Cambria");
  await document.fonts.load("bold 12px Cambria");
  const measureCanvas = document.createElement("canvas");
  const measureContext = measureCanvas.getContext("2d");
  if (!measureContext) throw new Error("Unable to prepare the certificate event details.");
  const bodyFontSize = 12;
  const bodyWidth = 468;
  const bodyLineHeight = 14.5;
  const eventLines = wrapCanvasRuns(measureContext, eventRuns, bodyWidth, bodyFontSize);
  const legalLines = wrapCanvasText(measureContext, legalText, bodyWidth, bodyFontSize);
  const [eventImages, legalImages] = await Promise.all([
    Promise.all(eventLines.map((line, index) => makeCambriaRichTextImage(line, bodyWidth, 16.2, 12.5, bodyFontSize, index < eventLines.length - 1))),
    Promise.all(legalLines.map((line, index) => makeCambriaTextImage(line, bodyWidth, 16.2, 12.5, bodyFontSize, index < legalLines.length - 1))),
  ]);
  const [embeddedEventImages, embeddedLegalImages] = await Promise.all([
    Promise.all(eventImages.map((image) => pdf.embedPng(image))),
    Promise.all(legalImages.map((image) => pdf.embedPng(image))),
  ]);
  const eventStartY = 646.26;
  const lastEventY = eventStartY - (eventLines.length - 1) * bodyLineHeight;
  const legalStartY = lastEventY - bodyLineHeight - 10;
  const { rgb } = await import("pdf-lib");

  for (const offset of [0, -413.2864]) {
    page.drawRectangle({ x: 62.5, y: 520 + offset, width: 473, height: 139.5, color: rgb(1, 1, 1) });
    embeddedEventImages.forEach((image, index) => {
      const baseline = eventStartY - index * bodyLineHeight + offset;
      page.drawImage(image, { x: 63.76, y: baseline - 3.7, width: bodyWidth, height: 16.2 });
    });
    embeddedLegalImages.forEach((image, index) => {
      const baseline = legalStartY - index * bodyLineHeight + offset;
      page.drawImage(image, { x: 63.76, y: baseline - 3.7, width: bodyWidth, height: 16.2 });
    });
  }
}

function approvalDate(value: unknown) {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
  }
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

async function makeSignatoryBlockImage(name: string, designation: string, division: string, profileDesignation?: string) {
  await Promise.all([
    document.fonts.load("bold 12px Cambria"),
    document.fonts.load("italic 11px Cambria"),
    document.fonts.load("11px Cambria"),
  ]);

  const width = 271.5;
  const height = 32;
  const scale = 4;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to prepare the signatory details.");
  context.scale(scale, scale);
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#111";
  context.textAlign = "right";
  context.textBaseline = "alphabetic";

  const displayName = name.toLocaleUpperCase("en");
  let nameSize = 12;
  context.font = `bold ${nameSize}px Cambria, "Times New Roman", serif`;
  while (context.measureText(displayName).width > width - 4 && nameSize > 8) {
    nameSize -= 0.25;
    context.font = `bold ${nameSize}px Cambria, "Times New Roman", serif`;
  }
  context.fillText(displayName, width, 14.5);

  let roleSize = 11;
  if (profileDesignation) {
    const roleLine = `${profileDesignation} / ${designation}`;
    context.font = `italic ${roleSize}px Cambria, "Times New Roman", serif`;
    while (context.measureText(roleLine).width > width - 4 && roleSize > 8) {
      roleSize -= 0.25;
      context.font = `italic ${roleSize}px Cambria, "Times New Roman", serif`;
    }
    context.fillText(roleLine, width, 29.9);
  } else {
    const divisionText = division;
    const designationText = `${designation},`;
    context.font = `${roleSize}px Cambria, "Times New Roman", serif`;
    while (context.measureText(`${designationText} ${divisionText}`).width > width - 4 && roleSize > 8) {
      roleSize -= 0.25;
      context.font = `${roleSize}px Cambria, "Times New Roman", serif`;
    }
    const divisionWidth = context.measureText(divisionText).width;
    const spaceWidth = context.measureText(" ").width;
    context.font = `italic ${roleSize}px Cambria, "Times New Roman", serif`;
    context.fillText(designationText, width - divisionWidth - spaceWidth, 29.9);
    context.font = `${roleSize}px Cambria, "Times New Roman", serif`;
    context.fillText(divisionText, width, 29.9);
  }

  return canvas.toDataURL("image/png");
}

export async function makeBlankCertificatePdf(record: BlankCertificatePdfRecord) {
  const response = await fetch(blankCertificatePdfAsset);
  if (!response.ok) throw new Error("The Certificate of Appearance PDF could not be loaded.");
  const { PDFDocument, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.load(await response.arrayBuffer());
  const page = pdf.getPages()[0];
  if (!page) throw new Error("The Certificate of Appearance PDF has no pages.");

  const division = record.division as TevDivision;
  await drawEventDetails(pdf, page, record);
  const templateSignatory = divisionSignatory(division);
  const signatory = appearanceCertificateSignatory(record, templateSignatory.name, templateSignatory.position);
  const signatoryImage = await pdf.embedPng(await makeSignatoryBlockImage(signatory.name, signatory.position, division, signatory.isProfileSignatory ? signatory.designation : undefined));
  for (const y of [480, 66.5]) {
    page.drawImage(signatoryImage, { x: 260, y, width: 271.5, height: 32 });
  }

  const signatureAsset = fieldOperationsAppearanceApprovalSignatureAsset(record);
  if (signatureAsset) {
    const signatureResponse = await fetch(publicAsset(`/${signatureAsset}`));
    if (!signatureResponse.ok) throw new Error("The Certificate of Appearance signatory signature could not be loaded.");
    const signatureImage = await pdf.embedPng(await signatureResponse.arrayBuffer());
    const [regularFont, boldFont] = await Promise.all([pdf.embedFont("Helvetica"), pdf.embedFont("Helvetica-Bold")]);
    const approvedAt = approvalDate(record.decidedAt);
    const dateParts = approvedAt
      ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(approvedAt)
      : [];
    const datePart = (type: string) => dateParts.find((part) => part.type === type)?.value ?? "";
    const approvalDateText = approvedAt ? `${datePart("year")}.${datePart("month")}.${datePart("day")}` : "";
    const approvalTime = approvedAt
      ? `${new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(approvedAt)} +0800`
      : "";
    const metadataRight = 531.5;
    const metadataColumnWidth = 102;
    const metadataSize = 6.8;
    const signerNameSize = 7.1;
    const signerName = (record.signerName?.trim() || record.signerDesignation || "Field Operations Division").toLocaleUpperCase("en");
    const fittedSignerNameSize = Math.min(signerNameSize, signerNameSize * metadataColumnWidth / boldFont.widthOfTextAtSize(signerName, signerNameSize));
    const drawRightAlignedText = (text: string, y: number, size: number, font: typeof regularFont) => {
      page.drawText(text, { x: metadataRight - font.widthOfTextAtSize(text, size), y, size, font });
    };
    for (const y of [480, 66.5]) {
      page.drawImage(signatureImage, { x: 360.5, y: y + 38, width: 102, height: 51 });
      drawRightAlignedText("Digitally Signed By", y + 72, metadataSize, regularFont);
      drawRightAlignedText(signerName, y + 64, fittedSignerNameSize, boldFont);
      if (approvalDateText) drawRightAlignedText(`Date: ${approvalDateText}`, y + 56, metadataSize, regularFont);
      if (approvalTime) drawRightAlignedText(`Time: ${approvalTime}`, y + 48, metadataSize, regularFont);
    }
  }

  const disapprovalStamp = certificateDisapprovalStampDetails(record);
  if (disapprovalStamp) {
    const [regularFont, boldFont] = await Promise.all([pdf.embedFont("Helvetica"), pdf.embedFont("Helvetica-Bold")]);
    const stampX = 360.5;
    const stampWidth = 171;
    const stampHeight = 44;
    const stampColor = rgb(0.64, 0.16, 0.13);
    for (const y of [480, 66.5]) {
      const stampY = y + 40;
      page.drawRectangle({ x: stampX, y: stampY, width: stampWidth, height: stampHeight, color: rgb(1, 0.99, 0.985), borderColor: stampColor, borderWidth: 1.5 });
      const drawRightAlignedText = (text: string, textY: number, size: number, font: typeof regularFont) => {
        const textWidth = font.widthOfTextAtSize(text, size);
        page.drawText(text, { x: stampX + stampWidth - 6 - textWidth, y: textY, size, font, color: stampColor });
      };
      drawRightAlignedText("Disapproved By", stampY + 32, 7.5, regularFont);
      const nameSize = Math.min(8.5, 8.5 * (stampWidth - 12) / boldFont.widthOfTextAtSize(disapprovalStamp.name, 8.5));
      drawRightAlignedText(disapprovalStamp.name, stampY + 21, nameSize, boldFont);
      drawRightAlignedText(`Date: ${disapprovalStamp.date}`, stampY + 11, 6.5, regularFont);
      drawRightAlignedText(`Time: ${disapprovalStamp.time}`, stampY + 3, 6.5, regularFont);
    }
  }
  return pdf.save();
}
