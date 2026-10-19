import type { Color, PDFFont, PDFPage } from "pdf-lib";
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

function fitFontSize(text: string, width: number, font: { widthOfTextAtSize: (value: string, size: number) => number }, maxSize: number, minSize: number) {
  for (let size = maxSize; size >= minSize; size -= 0.25) {
    if (font.widthOfTextAtSize(text, size) <= width) return size;
  }
  return minSize;
}

function wrapText(text: string, width: number, font: { widthOfTextAtSize: (value: string, size: number) => number }, size: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (font.widthOfTextAtSize(line, size) > width) {
      let chunk = "";
      for (const character of word) {
        if (chunk && font.widthOfTextAtSize(`${chunk}${character}`, size) > width) {
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

function drawEventDetails(page: PDFPage, record: BlankCertificatePdfRecord, font: PDFFont, white: Color) {
  const legacyTitle = record.eventTitle?.trim() === legacyBlankTitle;
  const title = (legacyTitle ? record.purpose : record.eventTitle)?.trim() || "";
  const destination = record.destination?.trim() || "";
  const dateRange = certificateDateRange(record.eventDateFrom, record.eventDateTo);
  for (const offset of [0, -413.2864]) {
    const titleRows = [
      { x: 137.019, y: 646.26 + offset, width: 389.2 },
      { x: 63.76, y: 621.99 + offset, width: 461 },
    ];
    for (const row of titleRows) {
      page.drawRectangle({ x: row.x - 1, y: row.y - 3.7, width: row.width + 2, height: 16.2, color: white });
    }
    page.drawRectangle({ x: 106.5, y: 603.8 + offset, width: 236, height: 16.2, color: white });
    page.drawRectangle({ x: 363.2, y: 603.8 + offset, width: 146.5, height: 16.2, color: white });

    let titleSize = 11.5;
    let titleLines = wrapText(title, 388, font, titleSize);
    while (titleLines.length > 2 && titleSize > 8.5) {
      titleSize -= 0.25;
      titleLines = wrapText(title, 388, font, titleSize);
    }
    titleLines.slice(0, 2).forEach((line, index) => {
      page.drawText(line, { x: titleRows[index].x, y: titleRows[index].y, size: titleSize, font });
    });

    if (destination) {
      const destinationSize = fitFontSize(destination, 230, font, 11.5, 7.5);
      page.drawText(destination, { x: 108, y: 607.49 + offset, size: destinationSize, font });
    }
    if (dateRange) {
      const dateSize = fitFontSize(dateRange, 140, font, 10.5, 8);
      page.drawText(dateRange, { x: 364.5, y: 607.49 + offset, size: dateSize, font });
    }
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
  const eventFont = await pdf.embedFont("TimesRoman");
  drawEventDetails(page, record, eventFont, rgb(1, 1, 1));
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
