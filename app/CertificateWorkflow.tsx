"use client";

import type { ReactNode } from "react";
import { certificateAppearanceSignatoryForOwner } from "@/lib/certificate-signatory";

export type CertificateWorkflowStatus = "Pending" | "Approved" | "Disapproved";

export type CertificateWorkflowFields = {
  status?: CertificateWorkflowStatus;
  decidedAt?: unknown;
  decidedBy?: string;
  signerName?: string;
  signerPosition?: string;
  signerDesignation?: string;
  signerOffice?: string;
  signatureAsset?: string;
  signerSignatureURL?: string;
  ownerRole?: string;
  ownerOffice?: string;
  ownerDivision?: string;
  ownerUnit?: string;
  signatoryName?: string;
  designation?: string;
  signatoryPosition?: string;
  signatoryAdminId?: string;
  certificateOffice?: string;
  certificateDivision?: string;
  certificateUnit?: string;
};

function toDate(value: unknown): Date | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  return null;
}

export function certificateWorkflowStatus(value?: string): CertificateWorkflowStatus {
  return value === "Approved" || value === "Disapproved" ? value : "Pending";
}

export function CertificateStatusBadge({ record, children }: { record: CertificateWorkflowFields; children?: ReactNode }) {
  const status = certificateWorkflowStatus(record.status);
  const decidedAt = toDate(record.decidedAt);
  const decisionTime = decidedAt
    ? new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" }).format(decidedAt)
    : "";

  return <span className={`certificate-workflow-status is-${status.toLowerCase()}`}>
    <strong>{status}</strong>
    {status !== "Pending" && (record.signerName || decisionTime) && <small>{[record.signerName ? `By ${record.signerName}` : "", decisionTime].filter(Boolean).join(" · ")}</small>}
    {children}
  </span>;
}

export function certificateDisapprovalStampDetails(record: CertificateWorkflowFields) {
  if (certificateWorkflowStatus(record.status) !== "Disapproved") return null;
  const decidedAt = toDate(record.decidedAt);
  const dateParts = decidedAt
    ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(decidedAt)
    : [];
  const datePart = (type: string) => dateParts.find((part) => part.type === type)?.value ?? "";
  const date = decidedAt ? `${datePart("year")}.${datePart("month")}.${datePart("day")}` : "—";
  const time = decidedAt
    ? `${new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(decidedAt)} +0800`
    : "—";
  const name = (record.signerName?.trim() || "Approver").toLocaleUpperCase("en");
  return { name, date, time };
}

export function CertificateDisapprovalStamp({ record }: { record: CertificateWorkflowFields }) {
  const details = certificateDisapprovalStampDetails(record);
  if (!details) return null;
  const { name, date, time } = details;
  return <div className="coa-disapproval-stamp" aria-label={`Disapproved by ${name}. Date: ${date}. Time: ${time}.`}>
    <span>Disapproved By</span>
    <strong>{name}</strong>
    <small>Date: {date}</small>
    <small>Time: {time}</small>
  </div>;
}

export function fieldOperationsAppearanceApprovalSignatureAsset(record: CertificateWorkflowFields) {
  if (certificateWorkflowStatus(record.status) !== "Approved"
    || (record.ownerRole !== "regular" && record.ownerRole !== "user")) return "";
  const ownerOffice = record.certificateOffice?.trim() || record.ownerOffice?.trim() || "";
  const ownerDivision = record.certificateDivision?.trim() || record.ownerDivision?.trim() || "";
  const ownerUnit = record.certificateUnit?.trim() || record.ownerUnit?.trim() || "";
  const routedSignatory = certificateAppearanceSignatoryForOwner(ownerOffice, ownerDivision, ownerUnit);
  if (!routedSignatory) return "";
  const signerDesignation = record.signerDesignation?.trim() ?? "";
  if (signerDesignation && signerDesignation !== routedSignatory.designation) return "";
  const hasInvalidSavedSignature = Boolean(record.signatureAsset)
    && (record.signatureAsset !== routedSignatory.signatureAsset || record.signerOffice !== "Division");
  const hasConflictingSignerOffice = Boolean(record.signerOffice) && record.signerOffice !== "Division";
  if (hasInvalidSavedSignature || hasConflictingSignerOffice) return "";
  if (routedSignatory.designation === "AGRISTAT/DRRM/AMIA Project Leader" && !signerDesignation) {
    const signerName = record.signerName?.trim().toLocaleUpperCase("en") ?? "";
    const assignedSignerName = record.signatoryName?.trim().toLocaleUpperCase("en") ?? "";
    if (!signerName || signerName !== assignedSignerName) return "";
  }
  return routedSignatory.signatureAsset;
}

export function hasFieldOperationsAppearanceApprovalSignature(record: CertificateWorkflowFields) {
  return Boolean(fieldOperationsAppearanceApprovalSignatureAsset(record));
}

export function appearanceCertificateSignatory(record: CertificateWorkflowFields, defaultName: string, defaultPosition: string) {
  const isProjectLeaderScope = record.certificateOffice === "Division"
    && record.certificateDivision === "Field Operations Division"
    && ["AGRISTAT", "AMIA", "DRRM"].includes(record.certificateUnit ?? "");
  const isApprovedProjectLeaderSignatory = fieldOperationsAppearanceApprovalSignatureAsset(record) === "agristat_and_drrm_focal_persons_amia_project_leader.png"
    && hasFieldOperationsAppearanceApprovalSignature(record);
  const hasRoutedProjectLeaderSignatory = isProjectLeaderScope
    && record.designation === "AGRISTAT/DRRM/AMIA Project Leader"
    && Boolean(record.signatoryPosition?.trim());
  if (!isApprovedProjectLeaderSignatory && !hasRoutedProjectLeaderSignatory) {
    return { name: defaultName, position: defaultPosition, designation: "", isProfileSignatory: false };
  }
  const designation = isApprovedProjectLeaderSignatory
    ? record.signerDesignation?.trim() || "AGRISTAT/DRRM/AMIA Project Leader"
    : record.designation?.trim() || "AGRISTAT/DRRM/AMIA Project Leader";
  const position = isApprovedProjectLeaderSignatory
    ? record.signerPosition?.trim() || record.signerDesignation?.trim() || record.signatoryPosition?.trim() || defaultPosition
    : record.signatoryPosition?.trim() || defaultPosition;
  return {
    name: (isApprovedProjectLeaderSignatory ? record.signerName?.trim() : record.signatoryName?.trim())?.toLocaleUpperCase("en") || defaultName,
    position,
    designation,
    isProfileSignatory: true,
  };
}

export function CertificateApprovalSignature({ record }: { record: CertificateWorkflowFields }) {
  const signatureAsset = fieldOperationsAppearanceApprovalSignatureAsset(record);
  const signatureURL = record.signerSignatureURL?.trim();
  if (!signatureAsset || !signatureURL) return null;
  const approvedAt = toDate(record.decidedAt);
  const dateParts = approvedAt
    ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(approvedAt)
    : [];
  const datePart = (type: string) => dateParts.find((part) => part.type === type)?.value ?? "";
  const approvalDate = approvedAt ? `${datePart("year")}.${datePart("month")}.${datePart("day")}` : "";
  const approvalTime = approvedAt
    ? `${new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(approvedAt)} +0800`
    : "";
  const signerName = (record.signerName?.trim() || record.signerDesignation || "Field Operations Division").toLocaleUpperCase("en");
  return <div className="certificate-approved-signature" aria-label={`Digitally signed by ${signerName}${approvalDate ? ` on ${approvalDate}` : ""}`}>
    <img src={signatureURL} crossOrigin="anonymous" alt={`Full signature of ${signerName}`} />
    <div className="certificate-approved-signature-meta">
      <span>Digitally signed by</span>
      <strong>{signerName}</strong>
      {approvalDate && <small>Date: {approvalDate}</small>}
      {approvalTime && <small>Time: {approvalTime}</small>}
    </div>
  </div>;
}
