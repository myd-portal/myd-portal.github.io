"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PDFFont, PDFPage, RGB } from "pdf-lib";
import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import { collection, doc, getDoc, getDocs, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "@/lib/firebase";
import { isSuperadminRole } from "@/lib/user-roles";
import { accountAssignment, accountDivision, accountOffice } from "@/lib/account-profile";
import { formatCurrencyAmount, normalizeCurrencyValue } from "@/lib/currency";
import { tevDivisions, type TevDivision } from "@/lib/mytev";
import { makeDocumentNotification } from "@/lib/document-notifications";
import CurrencyInput from "./CurrencyInput";
import DeleteConfirmation from "./DeleteConfirmation";
import RecordPagination, { useRecordPagination } from "./RecordPagination";
import "./leave-application.css";

type Office = string;
type LeaveType =
  | "Vacation Leave"
  | "Mandatory/Forced Leave"
  | "Sick Leave"
  | "Maternity Leave"
  | "Paternity Leave"
  | "Special Privilege Leave"
  | "Solo Parent Leave"
  | "Study Leave"
  | "10-Day VAWC Leave"
  | "Rehabilitation Privilege"
  | "Special Leave Benefits for Women"
  | "Special Emergency (Calamity) Leave"
  | "Adoption Leave"
  | "Others";
type LeaveStatus = "Pending" | "Approved" | "Disapproved";
type LeaveApplicationRecord = {
  id: string;
  ownerId: string;
  filedDate: string;
  name: string;
  office: Office;
  profileDivision?: string;
  position: string;
  salary: string;
  leaveType: LeaveType;
  leaveDetails: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  specifyAbroad?: string;
  specifyIllness?: string;
  studyLeaveOtherPurpose?: string;
  workingDays: number;
  inclusiveDateFrom: string;
  inclusiveDateTo: string;
  division?: TevDivision;
  signatoryName?: string;
  signatoryPosition?: "Chief" | "OIC";
  affixSignature?: "Yes" | "No";
  affixSignatureURL?: string;
  affixSignatureName?: string;
  affixSignatureAt?: unknown;
  approvalWorkflow?: "fod-myleave";
  approvalStage?: "owner-full" | "project-leader" | "chief" | "returned";
  initialSignerId?: string;
  chiefSignerId?: string;
  affixInitialSignature?: "Yes" | "No";
  affixInitialSignatureURL?: string;
  affixInitialSignatureName?: string;
  affixInitialSignatureAt?: unknown;
  affixChiefSignature?: "Yes" | "No";
  affixChiefSignatureURL?: string;
  affixChiefSignatureName?: string;
  affixChiefSignatureAt?: unknown;
  status: LeaveStatus;
  createdAt?: unknown;
};
type LeaveAdminSignatory = { id: string; name: string; designation: "Chief" | "OIC"; division: string };
type LeaveWorkflowSigners = { projectLeaderId: string; chiefId: string };
type LeaveModuleMode = "owner" | "approval";

const leaveTypes: LeaveType[] = [
  "Vacation Leave",
  "Mandatory/Forced Leave",
  "Sick Leave",
  "Maternity Leave",
  "Paternity Leave",
  "Special Privilege Leave",
  "Solo Parent Leave",
  "Study Leave",
  "10-Day VAWC Leave",
  "Rehabilitation Privilege",
  "Special Leave Benefits for Women",
  "Special Emergency (Calamity) Leave",
  "Adoption Leave",
  "Others",
];
const leaveStatuses: LeaveStatus[] = ["Pending", "Approved", "Disapproved"];
const travelLeaveDetails = ["Within the Philippines", "Abroad"] as const;
const sickLeaveDetails = ["In Hospital", "Out Patient"] as const;
const studyLeaveDetails = ["Completion of Master's Degree", "BAR/Board Examination Review", "Other Purpose"] as const;
const studyLeaveOtherPurposes = ["Monetization of Leave Credits", "Terminal Leave"] as const;
const asset = (path: string) => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
const pdfTextColor: RGB = { type: "RGB" as RGB["type"], red: 0.08, green: 0.08, blue: 0.08 };

function localDateValue() {
  const today = new Date();
  return new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function formatDate(value: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function timestampMillis(value: unknown) {
  if (value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") return value.toMillis() as number;
  return value instanceof Date ? value.getTime() : 0;
}

function signatureDate(value: unknown) {
  const millis = timestampMillis(value);
  if (!millis) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(millis));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}.${part("month")}.${part("day")}`;
}

function signatureTime(value: unknown) {
  const millis = timestampMillis(value);
  return millis ? `${new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(millis))} +0800` : "";
}

function middleInitial(value: string) {
  const first = value.trim().split(/\s+/)[0]?.replace(/\.+$/, "");
  const initial = first ? Array.from(first)[0] : "";
  return initial ? `${initial.toLocaleUpperCase()}.` : "";
}

function fullName(record: Pick<LeaveApplicationRecord, "name" | "firstName" | "middleName" | "lastName">) {
  const parsed = parseName(record.name);
  const first = record.firstName?.trim() || parsed.first;
  const middle = middleInitial(typeof record.middleName === "string" ? record.middleName : parsed.middle);
  const last = record.lastName?.trim() || parsed.last;
  return [first, middle, last].filter(Boolean).join(" ");
}

function leaveCalendarData(record: LeaveApplicationRecord, ownerId: string, status: LeaveStatus = record.status) {
  const parsed = parseName(record.name);
  return {
    leaveApplicationId: record.id,
    ownerId,
    status,
    firstName: record.firstName?.trim() || parsed.first,
    middleInitial: middleInitial(typeof record.middleName === "string" ? record.middleName : parsed.middle),
    lastName: record.lastName?.trim() || parsed.last,
    office: record.office,
    leaveType: record.leaveType,
    inclusiveDateFrom: record.inclusiveDateFrom,
    inclusiveDateTo: record.inclusiveDateTo,
  };
}

function leaveTypeLabel(record: Pick<LeaveApplicationRecord, "leaveType" | "leaveDetails">) {
  const details = record.leaveDetails.trim();
  return record.leaveType === "Others" && details ? `Others (${details})` : record.leaveType;
}

function parseName(value: string) {
  const trimmed = value.trim().replace(/\s+/g, " ");
  const comma = trimmed.indexOf(",");
  if (comma >= 0) {
    const last = trimmed.slice(0, comma).trim();
    const given = trimmed.slice(comma + 1).trim().split(" ").filter(Boolean);
    return { last, first: given[0] ?? "", middle: given.slice(1).join(" ") };
  }
  const parts = trimmed.split(" ").filter(Boolean);
  return { last: parts.length > 1 ? parts[parts.length - 1] : "", first: parts[0] ?? "", middle: parts.slice(1, -1).join(" ") };
}

function normalizeNamePart(value: string) {
  return value.trim().replace(/\s+/g, " ").replace(/,+$/, "").trim();
}

function officeFromProfile(value: unknown): Office | "" {
  const unit = typeof value === "string" ? value.trim() : "";
  const normalized = unit.toUpperCase();
  if (normalized === "AGRISTAT" || normalized === "FOD-AGRISTAT" || normalized === "AGRICULTURAL STATISTICS") return "FOD-AGRISTAT";
  if (normalized === "AMIA" || normalized === "FOD-AMIA") return "FOD-AMIA";
  if (normalized === "DRRM" || normalized === "FOD-DRRM") return "FOD-DRRM";
  return unit;
}

function isFodLeaveOwner(profile: Record<string, unknown>) {
  const role = typeof profile.accountRole === "string" ? profile.accountRole.toLowerCase() : "";
  const unit = typeof profile.unit === "string" ? profile.unit : "";
  return ["regular", "user"].includes(role)
    && profile.office === "Division"
    && profile.division === "Field Operations Division"
    && ["AGRISTAT", "DRRM", "AMIA"].includes(unit === "FOD-AGRISTAT" ? "AGRISTAT" : unit === "FOD-DRRM" ? "DRRM" : unit === "FOD-AMIA" ? "AMIA" : unit);
}

function fodLeaveApproverDesignation(profile: Record<string, unknown>) {
  const role = typeof profile.accountRole === "string" ? profile.accountRole.toLowerCase() : "";
  const status = profile.accountStatus;
  return !isSuperadminRole(profile.accountRole, profile.email)
    && role === "admin"
    && (status === undefined || status === null || status === "Approved")
    && profile.office === "Division"
    && profile.division === "Field Operations Division"
    && profile.unit === "Field Operations Division"
    && ["AGRISTAT/DRRM/AMIA Project Leader", "Chief"].includes(String(profile.designation ?? ""))
    ? String(profile.designation)
    : "";
}

function eligibleLeaveSignatory(profile: Record<string, unknown>, divisionName: string): profile is Record<string, unknown> & { name: string; designation: "Chief" | "OIC" } {
  return !isSuperadminRole(profile.accountRole, profile.email)
    && String(profile.accountRole ?? "").toLowerCase() === "admin"
    && (profile.accountStatus === undefined || profile.accountStatus === null || profile.accountStatus === "Approved")
    && profile.division === divisionName
    && (profile.designation === "Chief" || profile.designation === "OIC")
    && typeof profile.name === "string"
    && profile.name.trim().length > 0;
}

function safePdfText(value: string) {
  return value
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\xFF]/g, "")
    .trim();
}

function fileDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${Number(month)}/${Number(day)}/${year}`;
}

function decimalSalary(value: string) {
  return normalizeCurrencyValue(value);
}

function formatSalaryForDocument(value: string) {
  return formatCurrencyAmount(value);
}

function inclusiveDates(record: Pick<LeaveApplicationRecord, "inclusiveDateFrom" | "inclusiveDateTo">) {
  const from = new Date(`${record.inclusiveDateFrom}T00:00:00Z`);
  const to = new Date(`${record.inclusiveDateTo}T00:00:00Z`);
  const monthDay = (date: Date) => new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(date);
  const year = to.getUTCFullYear();
  if (from.getTime() === to.getTime()) return `${monthDay(from)}, ${year}`;
  if (from.getUTCFullYear() === year && from.getUTCMonth() === to.getUTCMonth()) {
    const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(to);
    return `${month} ${from.getUTCDate()}-${to.getUTCDate()}, ${year}`;
  }
  return `${monthDay(from)} - ${monthDay(to)}, ${year}`;
}

function countWorkingDays(fromValue: string, toValue: string) {
  if (!fromValue || !toValue || toValue < fromValue) return 0;
  const from = Date.parse(`${fromValue}T00:00:00Z`);
  const to = Date.parse(`${toValue}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  const totalDays = Math.floor((to - from) / 86400000) + 1;
  const fullWeeks = Math.floor(totalDays / 7);
  let workingDays = fullWeeks * 5;
  const remainingDays = totalDays % 7;
  const firstDay = new Date(from).getUTCDay();
  for (let offset = 0; offset < remainingDays; offset += 1) {
    const day = (firstDay + offset) % 7;
    if (day !== 0 && day !== 6) workingDays += 1;
  }
  return workingDays;
}

function drawFitText(page: PDFPage, font: PDFFont, value: string, x: number, y: number, maxWidth: number, fontSize = 9.5) {
  const text = safePdfText(value);
  if (!text) return;
  let size = fontSize;
  while (size > 6 && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.25;
  let fittedText = text;
  if (font.widthOfTextAtSize(fittedText, size) > maxWidth) {
    const characters = Array.from(text);
    while (characters.length && font.widthOfTextAtSize(`${characters.join("")}...`, size) > maxWidth) characters.pop();
    fittedText = characters.length ? `${characters.join("")}...` : "";
  }
  if (fittedText) page.drawText(fittedText, { x, y, size, font, color: pdfTextColor });
}

async function createLeaveApplicationPdf(record: LeaveApplicationRecord) {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const response = await fetch(asset("/a4_size_application_letter_template.pdf"), { cache: "force-cache" });
  if (!response.ok) throw new Error("The CSC leave application template could not be loaded.");
  const pdf = await PDFDocument.load(await response.arrayBuffer());
  const page = pdf.getPage(0);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const parsedApplicant = parseName(record.name);
  const applicant = {
    last: record.lastName?.trim() || parsedApplicant.last,
    first: record.firstName?.trim() || parsedApplicant.first,
    middle: typeof record.middleName === "string" ? record.middleName.trim() : parsedApplicant.middle,
  };

  drawFitText(page, bold, record.profileDivision || record.office, 165.64, 878.38, 190, 12.5);
  drawFitText(page, bold, applicant.last, 367.41, 880.68, 103, 12.5);
  drawFitText(page, bold, applicant.first, 476.53, 880.68, 96, 12.5);
  drawFitText(page, bold, applicant.middle, 579.13, 880.68, 103.72, 12.5);
  drawFitText(page, bold, fileDate(record.filedDate), 175.08, 852.47, 104, 9.5);
  drawFitText(page, bold, record.position, 365, 851.98, 161, 9.5);
  drawFitText(page, bold, formatSalaryForDocument(record.salary), 611.04, 851.98, 78, 9.5);

  const leaveTypeRows: Record<Exclude<LeaveType, "Others">, number> = {
    "Vacation Leave": 778.86,
    "Mandatory/Forced Leave": 760.63,
    "Sick Leave": 742.4,
    "Maternity Leave": 724.16,
    "Paternity Leave": 705.91,
    "Special Privilege Leave": 687.67,
    "Solo Parent Leave": 669.44,
    "Study Leave": 651.21,
    "10-Day VAWC Leave": 632.97,
    "Rehabilitation Privilege": 614.74,
    "Special Leave Benefits for Women": 596.97,
    "Special Emergency (Calamity) Leave": 578.27,
    "Adoption Leave": 559.73,
  };
  const selectedLeaveRow = record.leaveType === "Others" ? 522.92 : leaveTypeRows[record.leaveType];
  page.drawText("X", { x: record.leaveType === "Others" ? 68.5 : 79.1, y: selectedLeaveRow - 1, size: 8.5, font: bold, color: pdfTextColor });
  if (record.leaveType === "Others") drawFitText(page, bold, record.leaveDetails, 86.43, 506.56, 332, 8.5);
  const markLeaveDetail = (x: number, y: number) => page.drawText("X", { x, y: y - 1, size: 8.5, font: bold, color: pdfTextColor });
  if (["Vacation Leave", "Special Privilege Leave"].includes(record.leaveType)) {
    if (record.leaveDetails === "Within the Philippines") markLeaveDetail(429.6, 760.63);
    if (record.leaveDetails === "Abroad") {
      markLeaveDetail(429.6, 742.4);
      drawFitText(page, bold, record.specifyAbroad ?? "", 520, 742.4, 163, 8.5);
    }
  }
  if (record.leaveType === "Sick Leave") {
    if (record.leaveDetails === "In Hospital") {
      markLeaveDetail(429.6, 705.91);
      drawFitText(page, bold, record.specifyIllness ?? "", 566, 705.91, 116, 8.5);
    }
    if (record.leaveDetails === "Out Patient") {
      markLeaveDetail(429.6, 687.67);
      drawFitText(page, bold, record.specifyIllness ?? "", 568, 687.67, 114, 8.5);
    }
  }
  if (record.leaveType === "Special Leave Benefits for Women") {
    drawFitText(page, bold, record.specifyIllness ?? "", 502, 633.1, 178, 8.5);
  }
  if (record.leaveType === "Study Leave") {
    if (record.leaveDetails === "Completion of Master's Degree") markLeaveDetail(429.6, 578.27);
    if (record.leaveDetails === "BAR/Board Examination Review") markLeaveDetail(429.6, 559.73);
    if (record.leaveDetails === "Other Purpose") {
      markLeaveDetail(415.4, 541.2);
      if (record.studyLeaveOtherPurpose === "Monetization of Leave Credits") markLeaveDetail(429.6, 522.8);
      if (record.studyLeaveOtherPurpose === "Terminal Leave") markLeaveDetail(429.6, 504.5);
    }
  }
  drawFitText(page, bold, String(record.workingDays), 98.27, 466.51, 240, 9.5);
  drawFitText(page, bold, inclusiveDates(record), 97.65, 429.73, 303, 9.5);

  if (record.affixSignature === "Yes" && record.affixSignatureURL) {
    const signatureResponse = await fetch(record.affixSignatureURL, { cache: "force-cache", mode: "cors" });
    if (!signatureResponse.ok) throw new Error("The saved Full Signature could not be loaded for this Leave Application.");
    const signatureImage = await pdf.embedPng(await signatureResponse.arrayBuffer());
    const signatureImageX = 520;
    const fittedSignature = signatureImage.scaleToFit(68, 35);
    const signatureTextX = signatureImageX + fittedSignature.width + 6;
    const signatureBlockWidth = 116;
    const signatureName = safePdfText((record.affixSignatureName || fullName(record)).toLocaleUpperCase("en-PH"));
    drawFitText(page, font, "Digitally Signed By", signatureTextX, 474, signatureBlockWidth, 7);
    drawFitText(page, bold, signatureName, signatureTextX, 465, signatureBlockWidth, 7);
    drawFitText(page, font, `Date: ${signatureDate(record.affixSignatureAt)}`, signatureTextX, 456, signatureBlockWidth, 7);
    drawFitText(page, font, `Time: ${signatureTime(record.affixSignatureAt)}`, signatureTextX, 447, signatureBlockWidth, 7);
    page.drawImage(signatureImage, { x: signatureImageX, y: 445, width: fittedSignature.width, height: fittedSignature.height });
  }

  if (record.division && record.signatoryName && record.signatoryPosition) {
    const signatureCenter = 561.6;
    const signatureMaxWidth = 205;
    page.drawRectangle({ x: 501, y: 201.5, width: 124, height: 29, color: rgb(1, 1, 1) });
    page.drawRectangle({ x: 443, y: 213, width: 243, height: 1.5, color: rgb(1, 1, 1) });

    const name = safePdfText(record.signatoryName.toLocaleUpperCase("en-PH"));
    let nameSize = 11;
    while (nameSize > 6 && bold.widthOfTextAtSize(name, nameSize) > signatureMaxWidth) nameSize -= 0.25;
    page.drawText(name, { x: signatureCenter - bold.widthOfTextAtSize(name, nameSize) / 2, y: 217.34, size: nameSize, font: bold, color: pdfTextColor });

    const positionText = safePdfText(record.signatoryPosition);
    const divisionText = safePdfText(record.division);
    let positionSize = 9;
    while (positionSize > 6 && italic.widthOfTextAtSize(`${positionText}, `, positionSize) + font.widthOfTextAtSize(divisionText, positionSize) > signatureMaxWidth) positionSize -= 0.25;
    const positionWidth = italic.widthOfTextAtSize(`${positionText}, `, positionSize);
    const divisionWidth = font.widthOfTextAtSize(divisionText, positionSize);
    const lineX = signatureCenter - (positionWidth + divisionWidth) / 2;
    page.drawText(`${positionText}, `, { x: lineX, y: 205.8, size: positionSize, font: italic, color: pdfTextColor });
    page.drawText(divisionText, { x: lineX + positionWidth, y: 205.8, size: positionSize, font, color: pdfTextColor });
  }

  let chiefSignatureMetadataX = 542;
  if (record.approvalWorkflow === "fod-myleave" && record.affixChiefSignature === "Yes" && record.affixChiefSignatureURL) {
    const response = await fetch(record.affixChiefSignatureURL, { cache: "force-cache", mode: "cors" });
    if (!response.ok) throw new Error("The saved Chief Full Signature could not be loaded.");
    const image = await pdf.embedPng(await response.arrayBuffer());
    const fitted = image.scaleToFit(72, 28);
    chiefSignatureMetadataX = 466 + fitted.width + 4;
    const signatureBlockWidth = 686 - chiefSignatureMetadataX;
    const signerName = safePdfText((record.affixChiefSignatureName || "FIELD OPERATIONS CHIEF").toLocaleUpperCase("en-PH"));
    page.drawImage(image, { x: 466, y: 229, width: fitted.width, height: fitted.height });
    drawFitText(page, bold, `Digitally Signed: ${signerName}`, chiefSignatureMetadataX, 252, signatureBlockWidth, 6.5);
    drawFitText(page, font, `Date: ${signatureDate(record.affixChiefSignatureAt)}`, chiefSignatureMetadataX, 244, signatureBlockWidth, 6.5);
    drawFitText(page, font, `Time: ${signatureTime(record.affixChiefSignatureAt)}`, chiefSignatureMetadataX, 236, signatureBlockWidth, 6.5);
  }
  if (record.approvalWorkflow === "fod-myleave" && record.affixInitialSignature === "Yes" && record.affixInitialSignatureURL) {
    const response = await fetch(record.affixInitialSignatureURL, { cache: "force-cache", mode: "cors" });
    if (!response.ok) throw new Error("The saved Project Leader Initial Signature could not be loaded.");
    const image = await pdf.embedPng(await response.arrayBuffer());
    const fitted = image.scaleToFit(34, 20);
    const chiefTime = `Time: ${signatureTime(record.affixChiefSignatureAt)}`;
    const timeTextWidth = font.widthOfTextAtSize(chiefTime, 6.5);
    const x = chiefSignatureMetadataX + timeTextWidth + 4;
    const y = 236 - (fitted.height - 6.5) / 2;
    page.drawImage(image, { x, y, width: fitted.width, height: fitted.height });
  }

  const secondPageResponse = await fetch(asset("/2nd-page-leave-application.png"), { cache: "force-cache" });
  if (!secondPageResponse.ok) throw new Error("The second Leave Application page could not be loaded.");
  const instructionsImage = await pdf.embedPng(await secondPageResponse.arrayBuffer());
  const { width, height } = page.getSize();
  const secondPage = pdf.addPage([width, height]);
  secondPage.drawImage(instructionsImage, { x: 0, y: 0, width, height });

  pdf.setTitle(`Leave Application - ${fullName(record)}`);
  pdf.setSubject("Civil Service Commission Leave Application (CS Form No. 6, Revised 2020)");
  return pdf.save();
}

export default function LeaveApplicationModule({ user, mode = "owner", focusRecordId, onFocusHandled, onPreviewClose }: { user: User; mode?: LeaveModuleMode; focusRecordId?: string; onFocusHandled?: () => void; onPreviewClose?: () => void }) {
  const [records, setRecords] = useState<LeaveApplicationRecord[]>([]);
  const { currentPage, pageCount, visibleRecords, setPage } = useRecordPagination(records);
  const [view, setView] = useState<"list" | "new">("list");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [affixUpdatingId, setAffixUpdatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LeaveApplicationRecord | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [previewRecord, setPreviewRecord] = useState<LeaveApplicationRecord | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [previewRendering, setPreviewRendering] = useState(false);
  const [previewRenderError, setPreviewRenderError] = useState("");
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const handledFocusIdRef = useRef<string | null>(null);

  const [profileDefaults, setProfileDefaults] = useState<{ name: string; office: Office | ""; position: string; fullSignatureURL: string; initialSignatureURL: string; accountRole: string; designation: string; division: string; unit: string; applicant?: { first: string; middle: string; last: string } }>({ name: user.displayName ?? "", office: "", position: "", fullSignatureURL: "", initialSignatureURL: "", accountRole: "", designation: "", division: "", unit: "" });
  const [signatoryOptions, setSignatoryOptions] = useState<LeaveAdminSignatory[]>([]);
  const [signatoryAccountsLoaded, setSignatoryAccountsLoaded] = useState(false);
  const [selectedSignatoryUserId, setSelectedSignatoryUserId] = useState("");
  const [workflowSigners, setWorkflowSigners] = useState<LeaveWorkflowSigners | null>(null);
  const [adminNotificationRecipientIds, setAdminNotificationRecipientIds] = useState<string[]>([]);
  const [filedDate, setFiledDate] = useState(localDateValue());
  const [firstName, setFirstName] = useState(() => parseName(user.displayName ?? "").first);
  const [middleName, setMiddleName] = useState(() => parseName(user.displayName ?? "").middle);
  const [lastName, setLastName] = useState(() => parseName(user.displayName ?? "").last);
  const [office, setOffice] = useState<Office | "">("");
  const [position, setPosition] = useState("");
  const [salary, setSalary] = useState("");
  const [leaveType, setLeaveType] = useState<LeaveType | "">("");
  const [leaveDetails, setLeaveDetails] = useState("");
  const [specifyAbroad, setSpecifyAbroad] = useState("");
  const [specifyIllness, setSpecifyIllness] = useState("");
  const [studyLeaveOtherPurpose, setStudyLeaveOtherPurpose] = useState("");
  const [inclusiveDateFrom, setInclusiveDateFrom] = useState("");
  const [inclusiveDateTo, setInclusiveDateTo] = useState("");
  const [division, setDivision] = useState<TevDivision | "">("");
  const selectedDivisionSignatory = signatoryOptions.find((option) => option.id === selectedSignatoryUserId) ?? null;
  const approvalDesignation = fodLeaveApproverDesignation(profileDefaults);
  const showLeaveDetails = ["Vacation Leave", "Special Privilege Leave", "Sick Leave", "Study Leave"].includes(leaveType);
  const showSpecifyOthers = leaveType === "Others";
  const showSpecifyAbroad = ["Vacation Leave", "Special Privilege Leave"].includes(leaveType) && leaveDetails === "Abroad";
  const showSpecifyIllness = (leaveType === "Sick Leave" && ["In Hospital", "Out Patient"].includes(leaveDetails)) || leaveType === "Special Leave Benefits for Women";
  const showStudyLeaveOtherPurpose = leaveType === "Study Leave" && leaveDetails === "Other Purpose";
  const leaveTypeFieldCount = 1 + [showLeaveDetails, showSpecifyOthers, showSpecifyAbroad, showSpecifyIllness, showStudyLeaveOtherPurpose].filter(Boolean).length;

  useEffect(() => {
    if (!db) {
      setLoading(false);
      setError("Firebase is not configured.");
      return;
    }
    let active = true;
    let unsubscribe = () => {};
    const applyRows = (snapshot: { docs: Array<{ id: string; data: () => Record<string, unknown> }> }) => {
      const rows = snapshot.docs.map((item) => {
        const data = item.data();
        return { id: item.id, ...data, status: leaveStatuses.includes(data.status as LeaveStatus) ? data.status : "Pending" } as LeaveApplicationRecord;
      });
      rows.sort((left, right) => ((right.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0) - ((left.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0));
      setRecords(rows);
      setLoading(false);
    };
    const onFailure = (cause: unknown) => {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not load ${mode === "approval" ? "Leave Application approval tasks" : "Leave Applications"} (${code}).` : `Could not load ${mode === "approval" ? "Leave Application approval tasks" : "Leave Applications"}. Refresh and try again.`);
      setLoading(false);
    };
    if (mode === "owner") {
      unsubscribe = onSnapshot(query(collection(db, "leaveApplications"), where("ownerId", "==", user.uid)), applyRows, onFailure);
      return () => { active = false; unsubscribe(); };
    }
    setLoading(true);
    void (async () => {
      try {
        const profileSnapshot = await getDoc(doc(db, "users", user.uid));
        if (!active) return;
        const designation = profileSnapshot.exists() ? fodLeaveApproverDesignation(profileSnapshot.data()) : "";
        if (!designation) {
          setRecords([]);
          setError("This account is not assigned to Leave Application Approval.");
          setLoading(false);
          return;
        }
        const signerField = designation === "AGRISTAT/DRRM/AMIA Project Leader" ? "initialSignerId" : "chiefSignerId";
        const expectedStage = designation === "AGRISTAT/DRRM/AMIA Project Leader" ? "project-leader" : "chief";
        unsubscribe = onSnapshot(query(collection(db, "leaveApplications"),
          where("approvalWorkflow", "==", "fod-myleave"),
          where(signerField, "==", user.uid),
          where("approvalStage", "==", expectedStage)), (snapshot) => {
          applyRows({ docs: snapshot.docs.filter((item) => item.data().approvalWorkflow === "fod-myleave" && item.data().approvalStage === expectedStage) });
        }, onFailure);
      } catch (cause) {
        if (active) onFailure(cause);
      }
    })();
    return () => { active = false; unsubscribe(); };
  }, [mode, user.uid]);

  useEffect(() => {
    let active = true;
    async function loadProfileDefaults() {
      if (!db) return;
      try {
        const snapshot = await getDoc(doc(db, "users", user.uid));
        if (!active || !snapshot.exists()) return;
        const profile = snapshot.data();
        const normalizedOffice = officeFromProfile(accountOffice(profile));
        const applicant = typeof profile.firstName === "string" && typeof profile.lastName === "string"
          ? { first: profile.firstName, middle: typeof profile.middleName === "string" ? profile.middleName : "", last: profile.lastName }
          : parseName(typeof profile.name === "string" && profile.name.trim() ? profile.name : user.displayName ?? "");
        const defaults = {
          name: typeof profile.name === "string" && profile.name.trim() ? profile.name : user.displayName ?? "",
          position: typeof profile.position === "string" ? profile.position : "",
          office: normalizedOffice,
          fullSignatureURL: typeof profile.fullSignatureURL === "string" ? profile.fullSignatureURL : "",
          initialSignatureURL: typeof profile.initialSignatureURL === "string" ? profile.initialSignatureURL : "",
          accountRole: typeof profile.accountRole === "string" ? profile.accountRole.toLowerCase() : "",
          designation: typeof profile.designation === "string" ? profile.designation : "",
          division: accountDivision(profile),
          unit: accountAssignment(profile),
          applicant,
        };
        setProfileDefaults(defaults);
        setFirstName(applicant.first);
        setMiddleName(applicant.middle);
        setLastName(applicant.last);
        setPosition(defaults.position);
        setOffice(defaults.office);
      } catch {
        // The applicant can fill these fields manually when profile data is unavailable.
      }
    }
    void loadProfileDefaults();
    return () => { active = false; };
  }, [user.uid]);

  useEffect(() => {
    if (!db) return;
    return onSnapshot(doc(db, "users", user.uid), (snapshot) => {
      if (!snapshot.exists()) return;
      const profile = snapshot.data();
      setProfileDefaults((current) => ({
        ...current,
        name: typeof profile.name === "string" && profile.name.trim() ? profile.name : current.name,
        office: officeFromProfile(accountOffice(profile)),
        fullSignatureURL: typeof profile.fullSignatureURL === "string" ? profile.fullSignatureURL : "",
        initialSignatureURL: typeof profile.initialSignatureURL === "string" ? profile.initialSignatureURL : "",
        accountRole: typeof profile.accountRole === "string" ? profile.accountRole.toLowerCase() : current.accountRole,
        designation: typeof profile.designation === "string" ? profile.designation : current.designation,
        division: accountDivision(profile),
        unit: accountAssignment(profile),
      }));
    });
  }, [user.uid]);

  useEffect(() => {
    if (!db || mode !== "owner") return;
    let active = true;
    setSignatoryAccountsLoaded(false);
    void getDocs(collection(db, "users")).then((snapshot) => {
      if (!active) return;
      const options = snapshot.docs.flatMap((account) => {
        const profile = account.data();
        if (!eligibleLeaveSignatory(profile, typeof profile.division === "string" ? profile.division : "")) return [];
        return [{ id: account.id, name: profile.name.trim(), designation: profile.designation, division: String(profile.division) }];
      }).sort((first, second) => first.name.localeCompare(second.name, "en", { sensitivity: "base" }));
      const projectLeader = snapshot.docs.find((account) => fodLeaveApproverDesignation(account.data()) === "AGRISTAT/DRRM/AMIA Project Leader");
      const chief = snapshot.docs.find((account) => fodLeaveApproverDesignation(account.data()) === "Chief");
      setSignatoryOptions(options);
      setWorkflowSigners(projectLeader && chief && projectLeader.id !== chief.id ? { projectLeaderId: projectLeader.id, chiefId: chief.id } : null);
      setAdminNotificationRecipientIds(snapshot.docs
        .filter((account) => account.id !== user.uid && ["superadmin", "admin"].includes(String(account.data().accountRole ?? "").toLowerCase()) && (account.data().accountStatus ?? "Approved") === "Approved")
        .map((account) => account.id));
      setSignatoryAccountsLoaded(true);
    }).catch(() => { if (active) setSignatoryAccountsLoaded(true); });
    return () => { active = false; };
  }, [mode, user.uid]);

  useEffect(() => {
    if (!division) { setSelectedSignatoryUserId(""); return; }
    const matching = signatoryOptions.filter((option) => option.division === division);
    if (!matching.some((option) => option.id === selectedSignatoryUserId)) setSelectedSignatoryUserId(matching[0]?.id ?? "");
  }, [division, selectedSignatoryUserId, signatoryOptions]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!previewUrl || !canvas) return;
    const renderCanvas = canvas;
    let cancelled = false;
    let cancelRender: (() => void) | null = null;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setPreviewRendering(true);
    setPreviewRenderError("");
    canvas.width = 1;
    canvas.height = 1;

    async function renderPdfPage() {
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
        const response = await fetch(previewUrl);
        if (!response.ok) throw new Error("The Leave Application PDF could not be loaded for preview.");
        if (cancelled) return;
        const data = new Uint8Array(await response.arrayBuffer());
        if (cancelled) return;
        loadingTask = pdfjs.getDocument({ data });
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        const page = await pdf.getPage(1);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 2.5 });
        renderCanvas.width = Math.ceil(viewport.width);
        renderCanvas.height = Math.ceil(viewport.height);
        const task = page.render({ canvas: renderCanvas, viewport });
        cancelRender = () => task.cancel();
        await task.promise;
        if (!cancelled) setPreviewRendering(false);
      } catch (cause) {
        if (!cancelled) {
          setPreviewRendering(false);
          setPreviewRenderError(cause instanceof Error ? cause.message : "The Leave Application preview could not be rendered.");
        }
      }
    }

    void renderPdfPage();
    return () => {
      cancelled = true;
      cancelRender?.();
      if (loadingTask) void loadingTask.destroy();
    };
  }, [previewUrl]);

  function resetForm() {
    const applicant = profileDefaults.applicant ?? parseName(profileDefaults.name);
    setFiledDate(localDateValue());
    setFirstName(applicant.first);
    setMiddleName(applicant.middle);
    setLastName(applicant.last);
    setOffice(profileDefaults.office);
    setPosition(profileDefaults.position);
    setSalary("");
    setLeaveType("");
    setLeaveDetails("");
    setSpecifyAbroad("");
    setSpecifyIllness("");
    setStudyLeaveOtherPurpose("");
    setInclusiveDateFrom("");
    setInclusiveDateTo("");
    setDivision("");
    setSelectedSignatoryUserId("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db) { setError("Firebase is not configured."); return; }
    const firestore = db;
    const normalizedFirstName = normalizeNamePart(firstName);
    const normalizedMiddleName = normalizeNamePart(middleName);
    const normalizedLastName = normalizeNamePart(lastName);
    if (!normalizedFirstName || !normalizedLastName) {
      setError("Complete your first and last name in your Profile before creating a Leave Application.");
      return;
    }
    if (!office || !position.trim()) {
      setError("Complete your office and position in your Profile before creating a Leave Application.");
      return;
    }
    if (!division || !selectedDivisionSignatory) {
      setError("Select a division for the Leave Application signatory.");
      return;
    }
    if (inclusiveDateTo < inclusiveDateFrom) {
      setError("The inclusive end date must be on or after the start date.");
      return;
    }
    const calculatedWorkingDays = countWorkingDays(inclusiveDateFrom, inclusiveDateTo);
    if (calculatedWorkingDays === 0) {
      setError("The inclusive dates must include at least one weekday.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (!selectedDivisionSignatory || selectedDivisionSignatory.division !== division) {
        setError(signatoryAccountsLoaded ? "Select an available Chief or OIC Admin signatory for the selected division." : "Admin signatories are still loading. Try again in a moment.");
        return;
      }
      const selectedSignatory = selectedDivisionSignatory;
      if (!selectedSignatory || selectedSignatory.division !== division || !selectedSignatory.name.trim() || !["Chief", "OIC"].includes(selectedSignatory.designation)) {
        setError("The selected Admin signatory is no longer available. Select another signatory.");
        return;
      }
      let workflowFields: Pick<LeaveApplicationRecord, "approvalWorkflow" | "approvalStage" | "initialSignerId" | "chiefSignerId" | "affixInitialSignature" | "affixChiefSignature"> | Record<string, never> = {};
      if (isFodLeaveOwner(profileDefaults)) {
        if (!workflowSigners) {
          setError("The Field Operations Division Project Leader and Chief accounts are not both configured. Contact an administrator before submitting this application.");
          return;
        }
        workflowFields = { approvalWorkflow: "fod-myleave", approvalStage: "owner-full", initialSignerId: workflowSigners.projectLeaderId, chiefSignerId: workflowSigners.chiefId, affixInitialSignature: "No", affixChiefSignature: "No" };
      }
      const leaveRef = doc(collection(db, "leaveApplications"));
      const leaveData = {
        ownerId: user.uid,
        filedDate,
        name: `${normalizedLastName}, ${normalizedFirstName}${normalizedMiddleName ? ` ${normalizedMiddleName}` : ""}`,
        firstName: normalizedFirstName,
        middleName: normalizedMiddleName,
        lastName: normalizedLastName,
        office,
        profileDivision: profileDefaults.division.trim(),
        position: position.trim(),
        salary: decimalSalary(salary),
        leaveType,
        leaveDetails: leaveType === "Others" ? leaveDetails.trim() : ["Vacation Leave", "Special Privilege Leave", "Sick Leave", "Study Leave"].includes(leaveType) ? leaveDetails : "",
        specifyAbroad: ["Vacation Leave", "Special Privilege Leave"].includes(leaveType) && leaveDetails === "Abroad" ? specifyAbroad.trim() : "",
        specifyIllness: leaveType === "Sick Leave" || leaveType === "Special Leave Benefits for Women" ? specifyIllness.trim() : "",
        studyLeaveOtherPurpose: leaveType === "Study Leave" && leaveDetails === "Other Purpose" ? studyLeaveOtherPurpose : "",
        workingDays: calculatedWorkingDays,
        inclusiveDateFrom,
        inclusiveDateTo,
        division,
        signatoryName: selectedSignatory.name.trim(),
        signatoryPosition: selectedSignatory.designation,
        affixSignature: "No" as const,
        status: "Pending",
        ...workflowFields,
        createdAt: serverTimestamp(),
      };
      const record = { id: leaveRef.id, ...leaveData } as LeaveApplicationRecord;
      // The leave application is the primary record. Save it independently so
      // an auxiliary calendar or notification rule cannot reject the entire
      // submission and leave the user with no application at all.
      await setDoc(leaveRef, leaveData);

      try {
        const batch = writeBatch(db);
        batch.set(doc(db, "approvedLeaveCalendar", record.id), leaveCalendarData(record, user.uid));
        if (record.approvalWorkflow !== "fod-myleave") {
          adminNotificationRecipientIds
            .forEach((recipientId) => {
              const notification = makeDocumentNotification(firestore, {
                recipientId,
                ownerId: user.uid,
                documentId: leaveRef.id,
                documentType: "Leave Application",
                applicantName: record.name,
                leaveType: record.leaveType,
                inclusiveDateFrom: record.inclusiveDateFrom,
                inclusiveDateTo: record.inclusiveDateTo,
              });
              batch.set(notification.reference, notification.data);
            });
        }
        await batch.commit();
        setMessage("Leave Application saved.");
      } catch (cause) {
        const code = (cause as { code?: string }).code;
        setMessage(`Leave Application saved, but its calendar or notification sync failed${code ? ` (${code})` : ""}.`);
      }
      setView("list");
      resetForm();
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not save the Leave Application record (${code}).` : "Could not save the Leave Application record. Try again.");
    } finally { setBusy(false); }
  }

  async function changeStatus(record: LeaveApplicationRecord, status: LeaveStatus) {
    if (!db) { setError("Firebase is not configured."); return; }
    if (record.status !== "Pending") {
      setError("Approved or Disapproved Leave Applications cannot be changed.");
      return;
    }
    setUpdatingId(record.id);
    setError("");
    setMessage("");
    try {
      const leaveRef = doc(db, "leaveApplications", record.id);
      const calendarRef = doc(db, "approvedLeaveCalendar", record.id);
      if ((record.status === "Pending" || record.status === "Approved") && status === "Disapproved") {
        await setDoc(calendarRef, leaveCalendarData(record, user.uid));
      }
      const batch = writeBatch(db);
      batch.update(leaveRef, { status });
      if (status === "Pending" || status === "Approved") {
        batch.set(calendarRef, leaveCalendarData(record, user.uid, status));
      } else if (record.status === "Pending" || record.status === "Approved") {
        batch.delete(calendarRef);
      }
      await batch.commit();
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not update Leave Application status (${code}).` : "Could not update Leave Application status.");
    } finally { setUpdatingId(null); }
  }

  async function startLegacyLeaveApprovalWorkflow(record: LeaveApplicationRecord) {
    if (!db) { setError("Firebase is not configured."); return; }
    if (!isFodLeaveOwner(profileDefaults) || record.ownerId !== user.uid || record.approvalWorkflow === "fod-myleave") {
      setError("Only the applicant can send an eligible Field Operations Division Leave Application into this approval workflow.");
      return;
    }
    if (record.status === "Disapproved") {
      setError("A disapproved Leave Application cannot be sent into the signature workflow.");
      return;
    }
    if (record.affixSignature !== "Yes") {
      setError("Affix your Full Signature before sending this application for approval.");
      return;
    }

    setAffixUpdatingId(record.id);
    setError("");
    setMessage("");
    try {
      const accounts = await getDocs(collection(db, "users"));
      const projectLeader = accounts.docs.find((account) => fodLeaveApproverDesignation(account.data()) === "AGRISTAT/DRRM/AMIA Project Leader");
      const chief = accounts.docs.find((account) => fodLeaveApproverDesignation(account.data()) === "Chief");
      if (!projectLeader || !chief || projectLeader.id === chief.id) {
        setError("The Field Operations Division Project Leader and Chief accounts are not both configured. Contact an administrator before sending this application.");
        return;
      }

      const workflowFields = {
        approvalWorkflow: "fod-myleave" as const,
        approvalStage: "project-leader" as const,
        initialSignerId: projectLeader.id,
        chiefSignerId: chief.id,
        affixInitialSignature: "No" as const,
        affixChiefSignature: "No" as const,
        status: "Pending" as const,
      };
      const batch = writeBatch(db);
      batch.update(doc(db, "leaveApplications", record.id), workflowFields);
      batch.set(doc(db, "approvedLeaveCalendar", record.id), leaveCalendarData({ ...record, status: "Pending" }, user.uid, "Pending"));
      const notification = makeDocumentNotification(db, {
        recipientId: projectLeader.id,
        ownerId: record.ownerId,
        documentId: record.id,
        documentType: "Leave Application",
        approvalStep: "initial",
        applicantName: record.name,
        leaveType: record.leaveType,
        inclusiveDateFrom: record.inclusiveDateFrom,
        inclusiveDateTo: record.inclusiveDateTo,
      });
      batch.set(notification.reference, notification.data);
      await batch.commit();
      const updatedRecord = { ...record, ...workflowFields } as LeaveApplicationRecord;
      setRecords((current) => current.map((item) => item.id === record.id ? updatedRecord : item));
      setMessage("This application is Pending and was sent to the Project Leader.");
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not send the Leave Application for approval (${code}).` : "Could not send the Leave Application for approval. Try again.");
    } finally { setAffixUpdatingId(null); }
  }

  async function changeAffixSignature(record: LeaveApplicationRecord, value: "Yes" | "No") {
    if (!db) { setError("Firebase is not configured."); return; }
    if (value === "Yes" && (!profileDefaults.fullSignatureURL.trim() || !profileDefaults.name.trim())) {
      setError("Upload your Full Signature in Profile before affixing it to a Leave Application.");
      return;
    }
    setAffixUpdatingId(record.id);
    setError("");
    setMessage("");
    const signatureFields = value === "Yes"
      ? {
          affixSignature: "Yes" as const,
          affixSignatureURL: profileDefaults.fullSignatureURL.trim(),
          affixSignatureName: profileDefaults.name.trim(),
          affixSignatureAt: serverTimestamp(),
          ...(record.approvalWorkflow === "fod-myleave" ? { approvalStage: "project-leader" as const } : {}),
        }
      : { affixSignature: "No" as const };
    try {
      if (record.approvalWorkflow === "fod-myleave" && value === "Yes" && record.initialSignerId) {
        const batch = writeBatch(db);
        batch.update(doc(db, "leaveApplications", record.id), signatureFields);
        const notification = makeDocumentNotification(db, {
          recipientId: record.initialSignerId,
          ownerId: record.ownerId,
          documentId: record.id,
          documentType: "Leave Application",
          approvalStep: "initial",
          applicantName: record.name,
          leaveType: record.leaveType,
          inclusiveDateFrom: record.inclusiveDateFrom,
          inclusiveDateTo: record.inclusiveDateTo,
        });
        batch.set(notification.reference, notification.data);
        await batch.commit();
      } else {
        await updateDoc(doc(db, "leaveApplications", record.id), signatureFields);
      }
      let updatedRecord: LeaveApplicationRecord = value === "Yes"
        ? { ...record, affixSignature: "Yes", affixSignatureURL: profileDefaults.fullSignatureURL.trim(), affixSignatureName: profileDefaults.name.trim(), affixSignatureAt: new Date(), ...(record.approvalWorkflow === "fod-myleave" ? { approvalStage: "project-leader" as const } : {}) }
        : { ...record, affixSignature: "No" };
      try {
        const savedRecord = await getDoc(doc(db, "leaveApplications", record.id));
        if (savedRecord.exists()) updatedRecord = { id: record.id, ...savedRecord.data(), status: leaveStatuses.includes(savedRecord.data().status) ? savedRecord.data().status : "Pending" } as LeaveApplicationRecord;
      } catch {
        // Keep the successful update and local timestamp if the follow-up read fails.
      }
      setRecords((current) => current.map((item) => item.id === record.id ? updatedRecord : item));
      setMessage(value === "Yes"
        ? record.approvalWorkflow === "fod-myleave"
          ? "Your Full Signature is saved. The application was sent to the Project Leader."
          : isFodLeaveOwner(profileDefaults)
            ? "Full Signature saved. Click Send for Approval to route this older application."
            : "Signature affixed to this Leave Application."
        : "Signature removed from this Leave Application.");
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not update the Leave Application signature (${code}).` : "Could not update the Leave Application signature. Try again.");
    } finally { setAffixUpdatingId(null); }
  }

  async function changeApprovalSignature(record: LeaveApplicationRecord, value: "Yes" | "No") {
    if (!db || !record.approvalWorkflow) return;
    const firestore = db;
    const isProjectLeader = approvalDesignation === "AGRISTAT/DRRM/AMIA Project Leader" && record.approvalStage === "project-leader" && record.initialSignerId === user.uid;
    const isChief = approvalDesignation === "Chief" && record.approvalStage === "chief" && record.chiefSignerId === user.uid;
    if (!isProjectLeader && !isChief) { setError("This Leave Application is not awaiting your signature."); return; }
    const signatureURL = isProjectLeader ? profileDefaults.initialSignatureURL.trim() : profileDefaults.fullSignatureURL.trim();
    if (value === "Yes" && (!signatureURL || !profileDefaults.name.trim())) {
      setError(`Upload your ${isProjectLeader ? "Initial" : "Full"} Signature in Profile before affixing it.`);
      return;
    }
    setAffixUpdatingId(record.id);
    setError("");
    setMessage("");
    const signatureFields = value === "No"
      ? { [isProjectLeader ? "affixInitialSignature" : "affixChiefSignature"]: "No" }
      : isProjectLeader
        ? { affixInitialSignature: "Yes", affixInitialSignatureURL: signatureURL, affixInitialSignatureName: profileDefaults.name.trim(), affixInitialSignatureAt: serverTimestamp(), approvalStage: "chief" }
        : { affixChiefSignature: "Yes", affixChiefSignatureURL: signatureURL, affixChiefSignatureName: profileDefaults.name.trim(), affixChiefSignatureAt: serverTimestamp(), approvalStage: "returned" };
    try {
      if (value === "Yes") {
        const batch = writeBatch(firestore);
        batch.update(doc(firestore, "leaveApplications", record.id), signatureFields);
        const addNotification = (recipientId: string, approvalStep: "chief" | "project-leader-completed" | "returned") => {
          const notification = makeDocumentNotification(firestore, {
            recipientId,
            ownerId: record.ownerId,
            documentId: record.id,
            documentType: "Leave Application",
            approvalStep,
            applicantName: record.name,
            leaveType: record.leaveType,
            inclusiveDateFrom: record.inclusiveDateFrom,
            inclusiveDateTo: record.inclusiveDateTo,
          });
          batch.set(notification.reference, notification.data);
        };
        if (isProjectLeader) {
          if (record.chiefSignerId) addNotification(record.chiefSignerId, "chief");
          addNotification(record.ownerId, "project-leader-completed");
        } else {
          addNotification(record.ownerId, "returned");
        }
        await batch.commit();
      } else {
        await updateDoc(doc(db, "leaveApplications", record.id), signatureFields);
      }
      const updatedRecord: LeaveApplicationRecord = isProjectLeader
        ? value === "Yes"
          ? { ...record, affixInitialSignature: "Yes", affixInitialSignatureURL: signatureURL, affixInitialSignatureName: profileDefaults.name.trim(), affixInitialSignatureAt: new Date(), approvalStage: "chief" }
          : { ...record, affixInitialSignature: "No" }
        : value === "Yes"
          ? { ...record, affixChiefSignature: "Yes", affixChiefSignatureURL: signatureURL, affixChiefSignatureName: profileDefaults.name.trim(), affixChiefSignatureAt: new Date(), approvalStage: "returned" }
          : { ...record, affixChiefSignature: "No" };
      setRecords((current) => current.map((item) => item.id === record.id ? updatedRecord : item));
      setMessage(value === "Yes" ? isProjectLeader ? "Initial Signature affixed. The application was sent to the Chief." : "Full Signature affixed. The application was returned to the applicant." : "Signature choice updated.");
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not update the Leave Application signature (${code}).` : "Could not update the Leave Application signature. Try again.");
    } finally { setAffixUpdatingId(null); }
  }

  async function deleteRecord(record: LeaveApplicationRecord) {
    if (!db) return;
    if (record.approvalWorkflow === "fod-myleave" && record.approvalStage !== "owner-full") {
      setError("This Leave Application cannot be deleted after its signature workflow has started.");
      setPendingDelete(null);
      return;
    }
    if (record.status !== "Pending") {
      setError("Approved or Disapproved Leave Applications cannot be deleted.");
      setPendingDelete(null);
      return;
    }
    setDeletingId(record.id);
    setError("");
    try {
      const leaveRef = doc(db, "leaveApplications", record.id);
      const calendarRef = doc(db, "approvedLeaveCalendar", record.id);
      if (record.status === "Pending" || record.status === "Approved") {
        await setDoc(calendarRef, leaveCalendarData(record, user.uid));
      }
      const batch = writeBatch(db);
      batch.delete(leaveRef);
      if (record.status === "Pending" || record.status === "Approved") batch.delete(calendarRef);
      await batch.commit();
      setPendingDelete(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete Leave Application (${code}).` : "Could not delete Leave Application.");
      setPendingDelete(null);
    } finally { setDeletingId(null); }
  }

  async function openPreview(record: LeaveApplicationRecord) {
    setPreviewLoadingId(record.id);
    setPreviewRendering(true);
    setPreviewRenderError("");
    setError("");
    try {
      let pdfRecord = record;
      if (!pdfRecord.profileDivision && record.ownerId === user.uid && profileDefaults.division.trim()) {
        pdfRecord = { ...record, profileDivision: profileDefaults.division.trim() };
      }
      if (!pdfRecord.profileDivision && db) {
        try {
          const ownerProfile = await getDoc(doc(db, "users", record.ownerId));
          if (ownerProfile.exists()) {
            const profileDivision = accountDivision(ownerProfile.data());
            if (profileDivision) pdfRecord = { ...record, profileDivision };
          }
        } catch {
          // Keep the saved office value if the applicant profile is unavailable.
        }
      }
      const bytes = await createLeaveApplicationPdf(pdfRecord);
      const blob = new Blob([new Uint8Array(bytes).buffer], { type: "application/pdf" });
      const nextUrl = URL.createObjectURL(blob);
      setPreviewRecord(record);
      setPreviewUrl(nextUrl);
    } catch (cause) {
      setPreviewRendering(false);
      setError(cause instanceof Error ? cause.message : "Could not create the Leave Application PDF.");
    } finally { setPreviewLoadingId(null); }
  }

  useEffect(() => {
    if (!focusRecordId) { handledFocusIdRef.current = null; return; }
    if (handledFocusIdRef.current === focusRecordId || loading) return;
    const existing = records.find((record) => record.id === focusRecordId);
    if (existing) {
      handledFocusIdRef.current = focusRecordId;
      void openPreview(existing);
      onFocusHandled?.();
      return;
    }
    if (!db) return;
    let active = true;
    void getDoc(doc(db, "leaveApplications", focusRecordId)).then((snapshot) => {
      if (!active || !snapshot.exists()) return;
      const data = snapshot.data();
      const record = { id: snapshot.id, ...data, status: leaveStatuses.includes(data.status) ? data.status : "Pending" } as LeaveApplicationRecord;
      handledFocusIdRef.current = focusRecordId;
      void openPreview(record);
      onFocusHandled?.();
    }).catch((cause) => {
      const code = (cause as { code?: string }).code;
      if (active) setError(code ? `Could not open the Leave Application (${code}).` : "Could not open the Leave Application.");
    });
    return () => { active = false; };
  }, [focusRecordId, loading, onFocusHandled, openPreview, records]);

  function closePreview() {
    setPreviewRecord(null);
    setPreviewUrl("");
    onPreviewClose?.();
  }

  function printPreview() {
    window.print();
  }

  return <>
    <section className="content-section leave-application-section">
    {error && <div className="error-message leave-application-error" role="alert">{error}</div>}
    {message && <p className="leave-application-message" role="status">{message}</p>}
    {view === "new" ? <>
      <div className="section-heading leave-application-heading"><div><p className="eyebrow">New record</p><h2>Create Leave Application</h2><p className="muted">Enter the details for the Civil Service Commission Leave Application form.</p></div><button type="button" className="ghost-button" onClick={() => { setView("list"); setError(""); }}>Cancel</button></div>
      <form className="leave-application-form" onSubmit={save}>
        <label>Date of Filing<input type="date" value={filedDate} onChange={(event) => setFiledDate(event.target.value)} required /></label>
        <label>Monthly Salary (Optional)<div className="leave-application-currency-field"><span aria-hidden="true">₱</span><CurrencyInput value={salary} onValueChange={setSalary} aria-label="Monthly salary amount in Philippine pesos" placeholder="0.00" /></div></label>
        <div className={`leave-application-leave-type-row leave-application-wide-field leave-application-leave-type-row-${leaveTypeFieldCount}`}>
          <label>Type of Leave<select value={leaveType} onChange={(event) => { const selected = event.target.value as LeaveType | ""; setLeaveType(selected); setLeaveDetails(""); setSpecifyAbroad(""); setSpecifyIllness(""); setStudyLeaveOtherPurpose(""); }} required><option value="" disabled>Select type of leave</option>{leaveTypes.map((option) => <option key={option}>{option}</option>)}</select></label>
          {showLeaveDetails && <label>Details of Leave<select value={leaveDetails} onChange={(event) => { const selected = event.target.value; setLeaveDetails(selected); if (selected !== "Abroad") setSpecifyAbroad(""); if (selected !== "Other Purpose") setStudyLeaveOtherPurpose(""); }} required><option value="" disabled>Select details of leave</option>{(leaveType === "Sick Leave" ? sickLeaveDetails : leaveType === "Study Leave" ? studyLeaveDetails : travelLeaveDetails).map((option) => <option key={option}>{option}</option>)}</select></label>}
          {showSpecifyOthers && <label>Specify Others<textarea rows={3} maxLength={100} value={leaveDetails} onChange={(event) => setLeaveDetails(event.target.value)} placeholder="Specify the other type of leave" required /></label>}
          {showSpecifyAbroad && <label>Specify Abroad<input value={specifyAbroad} onChange={(event) => setSpecifyAbroad(event.target.value)} maxLength={120} required /></label>}
          {showSpecifyIllness && <label>Specify Illness<input value={specifyIllness} onChange={(event) => setSpecifyIllness(event.target.value)} maxLength={120} required /></label>}
          {showStudyLeaveOtherPurpose && <label>Other Purpose<select value={studyLeaveOtherPurpose} onChange={(event) => setStudyLeaveOtherPurpose(event.target.value)} required><option value="" disabled>Select other purpose</option>{studyLeaveOtherPurposes.map((option) => <option key={option}>{option}</option>)}</select></label>}
        </div>
        <div className="leave-application-date-division-row leave-application-wide-field">
          <fieldset className="leave-application-date-range"><legend>Inclusive Dates</legend><label>From<input aria-label="Inclusive start date" type="date" value={inclusiveDateFrom} onChange={(event) => setInclusiveDateFrom(event.target.value)} required /></label><span aria-hidden="true">to</span><label>To<input aria-label="Inclusive end date" type="date" min={inclusiveDateFrom} value={inclusiveDateTo} onChange={(event) => setInclusiveDateTo(event.target.value)} required /></label></fieldset>
          <label>Division<select value={division} onChange={(event) => setDivision(event.target.value as TevDivision | "")} required><option value="" disabled>Select a division</option>{tevDivisions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
        </div>
        <label className="leave-application-wide-field">Admin Signatory<select value={selectedSignatoryUserId} onChange={(event) => setSelectedSignatoryUserId(event.target.value)} disabled={!division || !signatoryAccountsLoaded} required><option value="" disabled>{!division ? "Select a division first" : !signatoryAccountsLoaded ? "Loading Admin signatories…" : "Select a Chief or OIC"}</option>{signatoryOptions.filter((option) => option.division === division).map((option) => <option key={option.id} value={option.id}>{option.name} — {option.designation}</option>)}</select>{division && signatoryAccountsLoaded && !signatoryOptions.some((option) => option.division === division) && <small className="muted">No approved Admin account with Chief or OIC designation is available for this division.</small>}</label>
        <div className="leave-application-form-actions"><button className="primary-button" disabled={busy}>{busy ? "Saving..." : "Save"}</button></div>
      </form>
    </> : <>
      <div className="section-heading leave-application-heading"><div><p className="eyebrow">{mode === "approval" ? "Admin Panel" : "Generated reports"}</p><h2>{mode === "approval" ? "Leave Application Approval" : "Leave Applications"}</h2><p className="muted">{mode === "approval" ? `${records.length} application${records.length === 1 ? "" : "s"} awaiting your signature.` : `${records.length} ${records.length === 1 ? "application" : "applications"} registered to your account.`}</p></div>{mode === "owner" && <button type="button" className="primary-button" onClick={() => { resetForm(); setError(""); setMessage(""); setView("new"); }}>Add</button>}</div>
      {loading ? <p className="muted">Loading {mode === "approval" ? "approval tasks" : "Leave Applications"}...</p> : records.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>{mode === "approval" ? "No Leave Applications awaiting your signature" : "No Leave Applications yet"}</h3><p>{mode === "approval" ? "Applications appear here when they reach your signature step." : "Create a Leave Application to view or download the completed CSC form."}</p>{mode === "owner" && <button type="button" className="text-button plain-action document-create-action" onClick={() => { resetForm(); setError(""); setMessage(""); setView("new"); }}>Add a Leave Application</button>}</div> : <div className="leave-application-records">
        <RecordPagination totalRecords={records.length} currentPage={currentPage} pageCount={pageCount} onPageChange={setPage} label="Leave Application" />
        <div className="leave-application-record-head"><span>Date Filed</span><span>{mode === "approval" ? "Applicant / Type" : "Type of Leave"}</span><span>Inclusive Dates</span><span>{mode === "approval" ? profileDefaults.designation === "AGRISTAT/DRRM/AMIA Project Leader" ? "Affix Initial Signature" : "Affix Full Signature" : "Affix Full Signature"}</span><span>Status</span><span aria-hidden="true" /></div>
        {visibleRecords.map((record) => <article className="leave-application-record" key={record.id}>
          <span className="leave-application-record-date">{formatDate(record.filedDate)}</span><span className="leave-application-record-type">{mode === "approval" && <strong>{record.name}<br /></strong>}{leaveTypeLabel(record)}</span><span className="leave-application-record-dates">{formatDate(record.inclusiveDateFrom)}{record.inclusiveDateTo !== record.inclusiveDateFrom && ` – ${formatDate(record.inclusiveDateTo)}`}</span>
          <label className="leave-application-affix"><select className="affix-signature-select" aria-label={`${mode === "approval" ? profileDefaults.designation === "AGRISTAT/DRRM/AMIA Project Leader" ? "Affix Initial Signature" : "Affix Full Signature" : "Affix Full Signature"} for Leave Application filed ${formatDate(record.filedDate)}`} title={mode === "approval" ? (profileDefaults.designation === "AGRISTAT/DRRM/AMIA Project Leader" ? profileDefaults.initialSignatureURL : profileDefaults.fullSignatureURL) ? undefined : `Upload your ${profileDefaults.designation === "AGRISTAT/DRRM/AMIA Project Leader" ? "Initial" : "Full"} Signature in Profile to enable Yes.` : profileDefaults.fullSignatureURL ? undefined : "Upload your Full Signature in Profile to enable Yes."} value={mode === "approval" ? (profileDefaults.designation === "AGRISTAT/DRRM/AMIA Project Leader" ? record.affixInitialSignature : record.affixChiefSignature) === "Yes" ? "Yes" : "No" : record.affixSignature === "Yes" ? "Yes" : "No"} disabled={affixUpdatingId === record.id || updatingId === record.id || deletingId !== null || (mode === "owner" && record.approvalWorkflow === "fod-myleave" && record.approvalStage !== "owner-full")} onChange={(event) => { if (event.target.value === "Yes" || event.target.value === "No") void (mode === "approval" ? changeApprovalSignature(record, event.target.value) : changeAffixSignature(record, event.target.value)); }}><option value="Yes" disabled={mode === "approval" ? !(profileDefaults.designation === "AGRISTAT/DRRM/AMIA Project Leader" ? profileDefaults.initialSignatureURL.trim() : profileDefaults.fullSignatureURL.trim()) : !profileDefaults.fullSignatureURL.trim()}>Yes</option><option value="No">No</option></select></label>
          <label className={`leave-application-status leave-application-status-${record.status.toLowerCase()}`}><select aria-label={`Status for Leave Application filed ${formatDate(record.filedDate)}`} value={record.status} disabled={mode === "approval" || record.status !== "Pending" || (record.approvalWorkflow === "fod-myleave" && record.approvalStage !== "returned") || updatingId === record.id || affixUpdatingId === record.id || deletingId !== null} onChange={(event) => void changeStatus(record, event.target.value as LeaveStatus)}>{leaveStatuses.map((status) => <option key={status}>{status}</option>)}</select>{updatingId === record.id && <small>Saving...</small>}{record.approvalWorkflow === "fod-myleave" && <small>{record.approvalStage === "owner-full" ? "Awaiting applicant Full Signature" : record.approvalStage === "project-leader" ? "Awaiting Project Leader Initial Signature" : record.approvalStage === "chief" ? "Awaiting Chief Full Signature" : "Signatures complete"}</small>}</label>
          <div className="leave-application-actions"><button type="button" className="row-action" disabled={deletingId !== null || previewLoadingId !== null} onClick={() => void openPreview(record)}>{previewLoadingId === record.id ? "Preparing..." : "View"}</button>{mode === "owner" && isFodLeaveOwner(profileDefaults) && !record.approvalWorkflow && record.status !== "Disapproved" && record.affixSignature === "Yes" && <button type="button" className="row-action" disabled={affixUpdatingId === record.id || deletingId !== null} onClick={() => void startLegacyLeaveApprovalWorkflow(record)}>{affixUpdatingId === record.id ? "Sending..." : "Send for Approval"}</button>}{mode === "owner" && record.status === "Pending" && (record.approvalWorkflow !== "fod-myleave" || record.approvalStage === "owner-full") && <button type="button" className="delete-button" disabled={deletingId !== null || affixUpdatingId === record.id} onClick={() => setPendingDelete(record)}>{deletingId === record.id ? "Deleting..." : "Delete"}</button>}</div>
        </article>)}
      </div>}
    </>}
    </section>
    <DeleteConfirmation open={Boolean(pendingDelete)} title="Confirm Leave Application Deletion?" description="Are you sure you want to delete this Leave Application? This action cannot be undone." busy={Boolean(pendingDelete && deletingId === pendingDelete.id)} onCancel={() => setPendingDelete(null)} onConfirm={() => { if (pendingDelete) void deleteRecord(pendingDelete); }} />
    {previewRecord && previewUrl && <div className="preview-backdrop leave-application-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePreview(); }}>
      <div className="preview-toolbar leave-application-preview-toolbar">
        <span>Leave Application preview · 2 pages</span>
        <button type="button" className="ghost-button" onClick={closePreview}>Close</button>
        <a className="pdf-button" href={previewUrl} download={`leave-application-${previewRecord.filedDate}.pdf`}>Download PDF</a>
        <button type="button" className="pdf-button" onClick={printPreview} disabled={previewRendering || Boolean(previewRenderError)}>Print</button>
        {previewRenderError && <small className="download-error" role="alert">{previewRenderError}</small>}
      </div>
      <div className="leave-application-preview-pages" role="dialog" aria-modal="true" aria-label={`Leave Application for ${fullName(previewRecord)}`}>
        <div className="leave-application-paper">
          {previewRendering && <span className="leave-application-preview-loading">Preparing preview...</span>}
          {previewRenderError && <span className="leave-application-preview-render-error" role="alert">{previewRenderError}</span>}
          <canvas ref={previewCanvasRef} className="leave-application-preview-canvas" aria-label={`Leave Application form for ${fullName(previewRecord)}`} />
        </div>
        <div className="leave-application-paper leave-application-paper-second-page">
          <img src={asset("/2nd-page-leave-application.png")} alt="Leave Application instructions and requirements" />
        </div>
      </div>
    </div>}
  </>;
}
