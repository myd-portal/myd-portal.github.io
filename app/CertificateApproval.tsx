"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, type QueryConstraint } from "firebase/firestore";
import type { User } from "firebase/auth";
import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import { db } from "@/lib/firebase";
import { accountDivision, accountDivisionForApproval, accountOffice, hasAccountDesignation, unitsForOfficeDivision } from "@/lib/account-profile";
import { certificateAppearanceSignatoryForOwner, fieldOperationsAppearanceUnitsForApprover, isFieldOperationsAppearanceApprover } from "@/lib/certificate-signatory";
import { normalizeAccountStatus, type AccountRole } from "@/lib/user-roles";
import { makeDocumentNotification } from "@/lib/document-notifications";
import { makeBlankCertificatePdf } from "@/lib/blank-certificate-pdf";
import { tevDivisions, type TevDivision } from "@/lib/mytev";
import { loadPdfTools } from "@/lib/pdf-tools";
import { appearanceCertificateSignatory, CertificateApprovalSignature, CertificateDisapprovalStamp, CertificateStatusBadge, certificateWorkflowStatus, fieldOperationsAppearanceApprovalSignatureAsset, hasFieldOperationsAppearanceApprovalSignature, type CertificateWorkflowFields, type CertificateWorkflowStatus } from "./CertificateWorkflow";
import DeleteConfirmation from "./DeleteConfirmation";
import RecordPagination, { useRecordPagination } from "./RecordPagination";
import "./certificate-approval.css";
import "./certificate-of-appearance.css";
import "./certificate-workflow.css";

type CertificateCollection = "certificatesOfAppearance" | "completionCertificates" | "appreciationCertificates" | "participationCertificates";
type AppearancePerson = { name: string; gender?: string; office?: string };
type CertificateQueueRecord = CertificateWorkflowFields & {
  id: string;
  collectionName: CertificateCollection;
  certificateType: string;
  ownerId: string;
  unit?: string;
  division?: string;
  recordType?: string;
  ownerRole?: string;
  ownerOffice?: string;
  ownerDivision?: string;
  ownerUnit?: string;
  certificateOffice?: string;
  certificateDivision?: string;
  certificateUnit?: string;
  eventTitle?: string;
  purpose?: string;
  office?: string;
  people?: AppearancePerson[];
  signatoryName?: string;
  designation?: string;
  eventDateFrom?: string;
  eventDateTo?: string;
  eventDate?: string;
  eventTimeFrom?: string;
  eventTimeTo?: string;
  destination?: string;
  eventDestination?: string;
  createdAt?: { toMillis?: () => number };
};

const certificateCollections: { name: CertificateCollection; label: string }[] = [
  { name: "certificatesOfAppearance", label: "Appearance" },
  { name: "completionCertificates", label: "Completion" },
  { name: "appreciationCertificates", label: "Appreciation" },
  { name: "participationCertificates", label: "Participation" },
];

const appearanceLetterhead = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/certificate-of-appearance-blank.jpg`;
const certificateDivisionDisplayNames: Record<string, string> = {
  "Planning, Monitoring and Evaluation Division": "PMED",
  "Agribusiness and Marketing Assistance Division": "AMAD",
  "Regional Agricultural Engineering Division": "RAED",
};

function appearanceDisplayDate(value: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-PH", { month: "long", day: "numeric", year: "numeric" }).format(new Date(`${value}T00:00:00`));
}

function appearanceDisplayDateRange(from?: string, to?: string) {
  const startValue = from ?? "";
  const endValue = to ?? from ?? "";
  if (!startValue) return appearanceDisplayDate(endValue);
  if (!endValue || startValue === endValue) return appearanceDisplayDate(startValue);
  const startDate = new Date(`${startValue}T00:00:00`);
  const endDate = new Date(`${endValue}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return `${appearanceDisplayDate(startValue)} - ${appearanceDisplayDate(endValue)}`;
  const startMonth = new Intl.DateTimeFormat("en-PH", { month: "long" }).format(startDate);
  const endMonth = new Intl.DateTimeFormat("en-PH", { month: "long" }).format(endDate);
  if (startDate.getFullYear() === endDate.getFullYear() && startDate.getMonth() === endDate.getMonth()) {
    return `${startMonth} ${startDate.getDate()} - ${endDate.getDate()}, ${endDate.getFullYear()}`;
  }
  if (startDate.getFullYear() === endDate.getFullYear()) {
    return `${appearanceDisplayDate(startValue)} - ${endMonth} ${endDate.getDate()}, ${endDate.getFullYear()}`;
  }
  return `${appearanceDisplayDate(startValue)} - ${appearanceDisplayDate(endValue)}`;
}

function appearancePronoun(gender?: string) {
  return gender === "female" ? "her" : gender === "male" ? "him" : "them";
}

function officeDivision(office: string) {
  if (office === "AMIA" || office === "FOD-AMIA") return "Agribusiness and Marketing Assistance Division";
  if (office === "AGRISTAT" || office === "FOD-AGRISTAT") return "Planning, Monitoring and Evaluation Division";
  if (office === "DRRM" || office === "FOD-DRRM") return "Disaster Risk Reduction and Management Division";
  return office;
}

function unitsForOffice(office: string, division: string) {
  const certificateUnits = new Set(["AMIA", "AGRISTAT", "DRRM"]);
  return unitsForOfficeDivision(office, division).filter((unit) => certificateUnits.has(unit));
}

function approvalSignerOffice(profile: Record<string, unknown>) {
  const version = typeof profile.profileFieldsVersion === "number" ? profile.profileFieldsVersion : 0;
  const office = typeof profile.office === "string" ? profile.office : "";
  const legacyProjectProgram = typeof profile.projectProgram === "string" ? profile.projectProgram : "";
  const legacyUnit = typeof profile.unit === "string" ? profile.unit : "";
  const rawOffice = version >= 2 && office.length > 0
    ? office
    : legacyProjectProgram.length > 0
      ? legacyProjectProgram
      : legacyUnit.length > 0
        ? legacyUnit
        : office;
  if (version >= 4) return office;
  if (rawOffice === "Field Operations Division (ILD)"
    || ["AGRISTAT", "AMIA", "DRRM", "FOD-AGRISTAT", "FOD-AMIA", "FOD-DRRM"].includes(rawOffice)
    || rawOffice.startsWith("FOD-")) return "Field Operations Division";
  return rawOffice;
}

function displaySchedule(record: CertificateQueueRecord) {
  const from = record.eventDateFrom || record.eventDate || "";
  const to = record.eventDateTo || from;
  if (!from && !to) return "\u2014";
  const fromDate = new Date(`${from}T00:00:00`);
  const toDate = new Date(`${to}T00:00:00`);
  const validRange = !Number.isNaN(fromDate.getTime()) && !Number.isNaN(toDate.getTime());
  const sameYear = validRange && fromDate.getFullYear() === toDate.getFullYear();
  const sameMonth = sameYear && fromDate.getMonth() === toDate.getMonth();
  const formatDate = (date: Date, value: string) => Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric", year: "numeric" }).format(date);
  let schedule = from === to
    ? formatDate(fromDate, from)
    : sameMonth
      ? `${new Intl.DateTimeFormat("en-PH", { month: "long" }).format(fromDate)} ${fromDate.getDate()}-${toDate.getDate()}, ${fromDate.getFullYear()}`
      : sameYear
        ? `${new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric" }).format(fromDate)} \u2013 ${new Intl.DateTimeFormat("en-PH", { month: "short", day: "numeric" }).format(toDate)}, ${fromDate.getFullYear()}`
        : `${formatDate(fromDate, from)} \u2013 ${formatDate(toDate, to)}`;
  if (record.eventTimeFrom) schedule += ` \u00b7 ${record.eventTimeFrom}${record.eventTimeTo ? `\u2013${record.eventTimeTo}` : ""}`;
  return schedule;
}

export default function CertificateApproval({ user, role, office, division, unit, assignment, designation, focusRecordId, onFocusHandled }: {
  user: User;
  role: AccountRole;
  office?: string | null;
  division?: string | null;
  unit?: string | null;
  assignment?: string | null;
  designation?: string;
  accountName?: string;
  focusRecordId?: string;
  onFocusHandled?: () => void;
}) {
  const [records, setRecords] = useState<CertificateQueueRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [approvalDiagnostic, setApprovalDiagnostic] = useState("");
  const [message, setMessage] = useState("");
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CertificateQueueRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [blankPreviewRecord, setBlankPreviewRecord] = useState<CertificateQueueRecord | null>(null);
  const [blankPreviewUrl, setBlankPreviewUrl] = useState("");
  const [blankPreviewLoading, setBlankPreviewLoading] = useState(false);
  const [blankPreviewRendering, setBlankPreviewRendering] = useState(false);
  const [blankPreviewPrinting, setBlankPreviewPrinting] = useState(false);
  const [blankPreviewError, setBlankPreviewError] = useState("");
  const [appearancePreviewRecord, setAppearancePreviewRecord] = useState<CertificateQueueRecord | null>(null);
  const [appearancePreviewError, setAppearancePreviewError] = useState("");
  const [appearancePreviewDownloading, setAppearancePreviewDownloading] = useState(false);
  const [appearancePreviewPrinting, setAppearancePreviewPrinting] = useState(false);
  const blankPreviewRequest = useRef(0);
  const blankPreviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const appearancePreviewPagesRef = useRef<HTMLDivElement>(null);
  const handledFocusIdRef = useRef<string | null>(null);
  const { currentPage, pageCount, visibleRecords, setPage } = useRecordPagination(records);
  const isChiefAdmin = role === "admin" && hasAccountDesignation(designation, "Chief");
  const isFodChiefAdmin = isChiefAdmin && office === "Division" && division === "Field Operations Division" && unit === "Field Operations Division";
  const isFodProjectLeaderAdmin = role === "admin"
    && office === "Division"
    && division === "Field Operations Division"
    && unit === "Field Operations Division"
    && designation === "AGRISTAT/DRRM/AMIA Project Leader";
  const isAppearanceApprovalAdmin = isChiefAdmin || isFodProjectLeaderAdmin;
  const reviewDivision = accountDivisionForApproval(office ?? "", unit ?? assignment ?? "", division ?? "");

  useEffect(() => () => {
    if (blankPreviewUrl) URL.revokeObjectURL(blankPreviewUrl);
  }, [blankPreviewUrl]);

  useEffect(() => {
    const canvas = blankPreviewCanvasRef.current;
    if (!blankPreviewUrl || !canvas) return;
    const renderCanvas = canvas;
    let cancelled = false;
    let cancelRender: (() => void) | null = null;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setBlankPreviewRendering(true);
    setBlankPreviewError("");
    renderCanvas.width = 1;
    renderCanvas.height = 1;

    async function renderBlankPreview() {
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
        const response = await fetch(blankPreviewUrl);
        if (!response.ok) throw new Error("The blank Certificate of Appearance PDF could not be loaded.");
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
        if (!cancelled) setBlankPreviewRendering(false);
      } catch (cause) {
        if (!cancelled) {
          setBlankPreviewRendering(false);
          setBlankPreviewError(cause instanceof Error ? cause.message : "The blank Certificate of Appearance preview could not be rendered.");
        }
      }
    }

    void renderBlankPreview();
    return () => {
      cancelled = true;
      cancelRender?.();
      if (loadingTask) void loadingTask.destroy();
    };
  }, [blankPreviewUrl]);

  const accessMessage = useMemo(() => {
    if (role === "admin" && (!isAppearanceApprovalAdmin || !office || !reviewDivision)) return "Certificate Approval is available to designated Chief and AGRISTAT/DRRM/AMIA Project Leader signatories.";
    return "";
  }, [isAppearanceApprovalAdmin, office, reviewDivision, role]);

  useEffect(() => {
    let active = true;
    setRecords([]);
    setError("");
    setMessage("");
    if (!db || (role === "admin" && (!isAppearanceApprovalAdmin || !office || !reviewDivision))) {
      setLoading(false);
      return () => { active = false; };
    }

    const firestore = db;
    setLoading(true);
    async function loadRecords() {
      try {
        const snapshots = await Promise.all(certificateCollections.map(async ({ name, label }) => {
          const constraints: QueryConstraint[] = [];
          if (role === "regular") constraints.push(where("ownerId", "==", user.uid));
          if (role === "admin") {
            if (name === "certificatesOfAppearance" && isFodChiefAdmin) {
              constraints.push(where("ownerRole", "==", "regular"));
              constraints.push(where("certificateOffice", "==", "Division"));
              constraints.push(where("certificateDivision", "==", "Field Operations Division"));
              const units = fieldOperationsAppearanceUnitsForApprover("Chief");
              constraints.push(where("certificateUnit", "in", [...units]));
            } else if (name === "certificatesOfAppearance" && isFodProjectLeaderAdmin) {
              constraints.push(where("ownerRole", "==", "regular"));
              constraints.push(where("certificateOffice", "==", "Division"));
              constraints.push(where("certificateDivision", "==", "Field Operations Division"));
              const units = fieldOperationsAppearanceUnitsForApprover("AGRISTAT/DRRM/AMIA Project Leader");
              constraints.push(where("certificateUnit", "in", [...units]));
            } else if (name === "certificatesOfAppearance" && isChiefAdmin) {
              constraints.push(where("division", "==", officeDivision(reviewDivision)));
            } else if (name !== "certificatesOfAppearance" && isChiefAdmin) {
              const units = unitsForOffice(office!, reviewDivision);
              if (!units.length) return [];
              constraints.push(units.length === 1 ? where("unit", "==", units[0]) : where("unit", "in", units));
            } else return [];
          }
          const result = await getDocs(query(collection(firestore, name), ...constraints));
          return result.docs.map((item) => ({
            ...item.data(),
            id: item.id,
            collectionName: name,
            certificateType: label,
          } as CertificateQueueRecord));
        }));
        const loadedRecords = snapshots.flat();
        let currentProjectLeader: { id: string; name: string; designation: string; position: string } | null = null;
        if (isFodProjectLeaderAdmin) {
          try {
            const profileSnapshot = await getDoc(doc(firestore, "users", user.uid));
            if (profileSnapshot.exists()) {
              const profile = profileSnapshot.data();
              if (isFieldOperationsAppearanceApprover(profile)
                && normalizeAccountStatus(profile.accountStatus) === "Approved"
                && typeof profile.name === "string"
                && typeof profile.position === "string") {
                currentProjectLeader = {
                  id: user.uid,
                  name: profile.name,
                  designation: typeof profile.designation === "string" ? profile.designation : "",
                  position: profile.position,
                };
              }
            }
          } catch {
            // Keep loading the approval queue if the profile lookup fails.
          }
        }
        const blankOwnerIds = [...new Set(loadedRecords
          .filter((record) => record.collectionName === "certificatesOfAppearance" && record.recordType === "blank" && (!record.ownerOffice?.trim() || !record.ownerDivision?.trim() || !record.ownerUnit?.trim()))
          .map((record) => record.ownerId)
          .filter(Boolean))];
        const ownerProfiles = new Map<string, { office: string; division: string; unit: string }>();
        await Promise.all(blankOwnerIds.map(async (ownerId) => {
          try {
            const ownerProfile = await getDoc(doc(firestore, "users", ownerId));
            if (ownerProfile.exists()) {
              const data = ownerProfile.data();
              ownerProfiles.set(ownerId, {
                office: accountOffice(data) ?? "",
                division: accountDivision(data),
                unit: typeof data.unit === "string" ? data.unit.trim() : "",
              });
            }
          } catch {
            // Keep the approval list available if an owner's profile cannot be loaded.
          }
        }));
        if (!active) return;
        const enrichedRecords = loadedRecords.map((record) => {
          if (record.collectionName !== "certificatesOfAppearance") return record;
          const storedOwnerOffice = record.ownerOffice?.trim() ?? "";
          const ownerOffice = (storedOwnerOffice ? accountOffice({ office: storedOwnerOffice, profileFieldsVersion: 3 }) : null)
            || ownerProfiles.get(record.ownerId)?.office
            || "";
          const ownerProfile = ownerProfiles.get(record.ownerId);
          const certificateOffice = record.certificateOffice?.trim() || ownerOffice;
          const certificateDivision = record.certificateDivision || record.ownerDivision || ownerProfile?.division || "";
          const certificateUnit = record.certificateUnit || record.ownerUnit || ownerProfile?.unit || "";
          const projectLeaderScope = certificateOffice === "Division"
            && certificateDivision === "Field Operations Division"
            && ["AGRISTAT", "AMIA", "DRRM"].includes(certificateUnit);
          const attachCurrentProjectLeader = isFodProjectLeaderAdmin
            && projectLeaderScope
            && !record.signatoryPosition?.trim()
            && currentProjectLeader?.designation === "AGRISTAT/DRRM/AMIA Project Leader";
          return {
            ...record,
            ownerOffice,
            ownerDivision: record.ownerDivision || ownerProfile?.division || "",
            ownerUnit: record.ownerUnit || ownerProfile?.unit || "",
            certificateOffice,
            certificateDivision,
            certificateUnit,
            destination: record.destination || certificateOffice || "",
            ...(attachCurrentProjectLeader && currentProjectLeader ? {
              signatoryName: currentProjectLeader.name,
              designation: currentProjectLeader.designation,
              signatoryPosition: currentProjectLeader.position,
              signatoryAdminId: currentProjectLeader.id,
            } : {}),
          };
        }).sort((left, right) => (right.createdAt?.toMillis?.() ?? 0) - (left.createdAt?.toMillis?.() ?? 0));
        setRecords(enrichedRecords);
        if (isFodProjectLeaderAdmin) {
          enrichedRecords.forEach((record) => {
            const signatureAsset = fieldOperationsAppearanceApprovalSignatureAsset(record);
            if (record.collectionName === "certificatesOfAppearance"
              && certificateWorkflowStatus(record.status) === "Approved"
              && !record.signatureAsset
              && record.decidedBy === user.uid
              && signatureAsset === "agristat_and_drrm_focal_persons_amia_project_leader.png") {
              void updateDoc(doc(firestore, record.collectionName, record.id), { signatureAsset }).catch(() => {
                // The preview still resolves the assigned image if a legacy record cannot be repaired.
              });
            }
          });
        }
      } catch (cause) {
        if (!active) return;
        const code = (cause as { code?: string }).code;
        setError(code ? `Could not load certificates for approval (${code}).` : "Could not load certificates for approval. Refresh and try again.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadRecords();
    return () => { active = false; };
  }, [user.uid, role, office, division, unit, assignment, reviewDivision, isChiefAdmin, isFodChiefAdmin, isFodProjectLeaderAdmin, isAppearanceApprovalAdmin]);

  async function decide(record: CertificateQueueRecord, status: Exclude<CertificateWorkflowStatus, "Pending">) {
    if (!db || certificateWorkflowStatus(record.status) === "Approved") return;
    const key = `${record.collectionName}:${record.id}`;
    setSavingKey(key);
    setError("");
    setApprovalDiagnostic("");
    setMessage("");
    let signerProfile: Record<string, unknown> | null = null;
    try {
      const signerSnapshot = await getDoc(doc(db, "users", user.uid));
      if (signerSnapshot.exists()) signerProfile = signerSnapshot.data();
    } catch {
      // Fall through to a clear profile verification error below.
    }
    if (!signerProfile) {
      setError("Could not verify your approval profile. Refresh and try again.");
      setSavingKey(null);
      return;
    }
    const signerOffice = approvalSignerOffice(signerProfile);
    const signerDesignation = typeof signerProfile.designation === "string" ? signerProfile.designation : "";
    const signerName = typeof signerProfile.name === "string" ? signerProfile.name : "";
    const signerPosition = typeof signerProfile.position === "string" ? signerProfile.position : "";
    let ownerProfile: Record<string, unknown> | null = null;
    if (record.ownerId && record.ownerId !== user.uid) {
      try {
        const ownerSnapshot = await getDoc(doc(db, "users", record.ownerId));
        if (ownerSnapshot.exists()) ownerProfile = ownerSnapshot.data();
      } catch {
        // Approval can continue without the owner's profile, but the special signature requires it.
      }
    }
    const ownerRole = record.ownerRole ?? ownerProfile?.accountRole;
    const ownerOffice = record.ownerOffice?.trim() || (ownerProfile ? accountOffice(ownerProfile) ?? "" : "");
    const ownerDivision = record.ownerDivision?.trim() || (ownerProfile ? accountDivision(ownerProfile) : "");
    const ownerUnit = record.ownerUnit?.trim() || (typeof ownerProfile?.unit === "string" ? ownerProfile.unit.trim() : "");
    const certificateOffice = record.certificateOffice?.trim() || ownerOffice;
    const certificateDivision = record.certificateDivision?.trim() || ownerDivision;
    const certificateUnit = record.certificateUnit?.trim() || ownerUnit;
    const ownerSignatory = certificateAppearanceSignatoryForOwner(certificateOffice, certificateDivision, certificateUnit);
    const isRegularFieldOperationsOwner = (ownerRole === "regular" || ownerRole === "user") && Boolean(ownerSignatory);
    const signerMatchesAppearanceRoute = Boolean(ownerSignatory)
      && signerProfile.profileFieldsVersion === 4
      && normalizeAccountStatus(signerProfile.accountStatus) === "Approved"
      && isFieldOperationsAppearanceApprover(signerProfile)
      && signerDesignation === ownerSignatory?.designation;
    const signerMatchesAssignedProjectLeader = record.signatoryAdminId === undefined || record.signatoryAdminId === user.uid;
    const useAppearanceSignature = record.collectionName === "certificatesOfAppearance"
      && isRegularFieldOperationsOwner
      && signerMatchesAppearanceRoute
      && (ownerSignatory?.designation !== "AGRISTAT/DRRM/AMIA Project Leader" || signerMatchesAssignedProjectLeader)
      && status === "Approved";
    const decision = {
      status,
      decidedAt: serverTimestamp(),
      decidedBy: user.uid,
      signerName,
      signerPosition,
      signerDesignation,
      signerOffice,
      signatureAsset: useAppearanceSignature ? ownerSignatory?.signatureAsset ?? "" : "",
    };
    try {
      const certificateRef = doc(db, record.collectionName, record.id);
      let decisionNotification: ReturnType<typeof makeDocumentNotification> | null = null;
      const notificationOwnerRole = record.ownerRole ?? ownerProfile?.accountRole;
      if (record.ownerId && record.ownerId !== user.uid && (notificationOwnerRole === "regular" || notificationOwnerRole === "user")) {
        decisionNotification = makeDocumentNotification(db, {
          recipientId: record.ownerId,
          ownerId: user.uid,
          documentId: record.id,
          documentType: "Certificate Decision",
          certificateType: record.certificateType,
          certificateCollection: record.collectionName,
          decisionStatus: status,
          activityTitle: record.eventTitle || `Certificate of ${record.certificateType}`,
          destination: record.destination || record.eventDestination || "",
        });
      }
      let appliedDecision = decision;
      let signatureSkipped = false;
      try {
        await updateDoc(certificateRef, decision);
      } catch (cause) {
        const code = (cause as { code?: string }).code;
        if (!decision.signatureAsset || code !== "permission-denied") throw cause;
        appliedDecision = { ...decision, signatureAsset: "" };
        await updateDoc(certificateRef, appliedDecision);
        signatureSkipped = true;
      }
      if (signatureSkipped && decision.signatureAsset === "agristat_and_drrm_focal_persons_amia_project_leader.png") {
        try {
          await updateDoc(certificateRef, { signatureAsset: decision.signatureAsset });
          appliedDecision = { ...appliedDecision, signatureAsset: decision.signatureAsset };
          signatureSkipped = false;
        } catch {
          // The certificate preview resolves the approved signatory image from its scope if this repair is denied.
        }
      }
      setRecords((current) => current.map((item) => item.id === record.id && item.collectionName === record.collectionName ? { ...item, ...appliedDecision, decidedAt: new Date() } : item));
      let notificationSent = false;
      if (decisionNotification) {
        try {
          await setDoc(decisionNotification.reference, decisionNotification.data);
          notificationSent = true;
        } catch (cause) {
          console.warn("Certificate decision was saved, but the owner notification could not be sent.", cause);
        }
      }
      setMessage(record.certificateType === "Appearance" && status === "Approved"
        ? "Appearance certificate approved."
        : `${record.certificateType} certificate ${status.toLowerCase()}${signatureSkipped ? "; the approved signatory image will appear in the certificate preview" : ""}${notificationSent ? "; the owner was notified." : decisionNotification ? "; the owner notification could not be sent." : "."}`);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      if (code === "permission-denied") {
        const diagnostic = {
          collection: record.collectionName,
          certificateId: record.id,
          recordType: record.recordType ?? "appearance",
          certificatePdfDivision: record.division ?? "",
          certificateOwnerId: record.ownerId,
          currentStatus: record.status ?? "Pending",
          authEmailVerified: user.emailVerified,
          activeAccountRole: role,
          activeOffice: office ?? "",
          activeDivision: division ?? "",
          activeUnit: unit ?? "",
          activeDesignation: designation ?? "",
          signerIsChiefAdmin: isChiefAdmin,
          signerProfileFieldsVersion: signerProfile.profileFieldsVersion ?? null,
          signerAccountRole: signerProfile.accountRole ?? null,
          signerAccountStatus: signerProfile.accountStatus ?? null,
          signerProfileEmailVerified: signerProfile.emailVerified ?? null,
          signerOffice,
          signerDivision: signerProfile.division ?? "",
          signerUnit: signerProfile.unit ?? "",
          signerDesignation,
          ownerProfileFieldsVersion: ownerProfile?.profileFieldsVersion ?? null,
          ownerProfileRole: ownerProfile?.accountRole ?? null,
          ownerProfileOffice: ownerProfile?.office ?? null,
          ownerProfileDivision: accountDivision(ownerProfile ?? {}),
          ownerProfileUnit: ownerProfile?.unit ?? null,
          isRegularFieldOperationsOwner,
          ownerOffice,
          ownerDivision,
          ownerUnit,
          certificateOffice,
          certificateDivision,
          certificateUnit,
          ownerSignatory,
          signerMatchesAppearanceRoute,
          useAppearanceSignature,
          signatureAsset: decision.signatureAsset,
        };
        const diagnosticText = JSON.stringify(diagnostic, null, 2);
        setApprovalDiagnostic(diagnosticText);
        console.warn(`Certificate decision rejected by Firestore rules: ${diagnosticText}`);
      }
      setError(code ? `Could not update this certificate (${code}).` : "Could not update this certificate. Refresh and try again.");
    } finally {
      setSavingKey(null);
    }
  }

  async function deleteRecord() {
    if (!db || !pendingDelete || certificateWorkflowStatus(pendingDelete.status) === "Approved") return;
    setDeleting(true);
    setError("");
    try {
      await deleteDoc(doc(db, pendingDelete.collectionName, pendingDelete.id));
      setRecords((current) => current.filter((record) => record.id !== pendingDelete.id || record.collectionName !== pendingDelete.collectionName));
      setMessage(`${pendingDelete.certificateType} certificate deleted.`);
      setPendingDelete(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete this certificate (${code}).` : "Could not delete this certificate.");
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  async function viewBlankAppearance(record: CertificateQueueRecord) {
    const divisionName = record.division ?? "";
    const requestId = ++blankPreviewRequest.current;
    setBlankPreviewRecord(record);
    setBlankPreviewUrl("");
    setBlankPreviewError("");
    setBlankPreviewLoading(true);
    if (!tevDivisions.includes(divisionName as TevDivision)) {
      setBlankPreviewError("The saved certificate has an invalid division.");
      setBlankPreviewLoading(false);
      return;
    }
    try {
      const bytes = await makeBlankCertificatePdf({ ...record, division: divisionName });
      if (blankPreviewRequest.current !== requestId) return;
      const pdfData = new Uint8Array(bytes).buffer as ArrayBuffer;
      setBlankPreviewRendering(true);
      setBlankPreviewUrl(URL.createObjectURL(new Blob([pdfData], { type: "application/pdf" })));
    } catch (cause) {
      if (blankPreviewRequest.current === requestId) {
        setBlankPreviewError(cause instanceof Error ? cause.message : "The blank Certificate of Appearance PDF could not be created.");
      }
    } finally {
      if (blankPreviewRequest.current === requestId) setBlankPreviewLoading(false);
    }
  }

  function closeBlankPreview() {
    blankPreviewRequest.current += 1;
    setBlankPreviewRecord(null);
    setBlankPreviewUrl("");
    setBlankPreviewError("");
    setBlankPreviewLoading(false);
    setBlankPreviewRendering(false);
  }

  function downloadBlankPreviewPdf() {
    if (!blankPreviewRecord || !blankPreviewUrl) return;
    const divisionSlug = (blankPreviewRecord.division ?? "appearance")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const downloadLink = document.createElement("a");
    downloadLink.href = blankPreviewUrl;
    downloadLink.download = `certificate-of-appearance-blank-${divisionSlug}.pdf`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
  }

  function viewAppearance(record: CertificateQueueRecord) {
    setAppearancePreviewError(record.people?.length ? "" : "This appearance certificate has no attendees to preview.");
    setAppearancePreviewRecord(record);
  }

  useEffect(() => {
    if (!focusRecordId) { handledFocusIdRef.current = null; return; }
    if (handledFocusIdRef.current === focusRecordId || loading) return;
    const record = records.find((item) => item.id === focusRecordId && item.collectionName === "certificatesOfAppearance");
    if (!record) return;
    handledFocusIdRef.current = focusRecordId;
    setAppearancePreviewError(record.people?.length ? "" : "This appearance certificate has no attendees to preview.");
    setAppearancePreviewRecord(record);
    onFocusHandled?.();
  }, [focusRecordId, loading, onFocusHandled, records]);

  async function waitForAppearanceImages() {
    if (!appearancePreviewPagesRef.current) throw new Error("The certificate preview is unavailable.");
    await Promise.all(Array.from(appearancePreviewPagesRef.current.querySelectorAll("img"), async (image) => {
      if (!image.complete) await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("The Certificate of Appearance blank could not be loaded."));
      });
      if (!image.naturalWidth) throw new Error("The Certificate of Appearance blank could not be loaded.");
      if (image.decode) await image.decode();
    }));
    if (document.fonts?.ready) await document.fonts.ready;
  }

  async function downloadAppearancePreviewPdf() {
    setAppearancePreviewDownloading(true);
    setAppearancePreviewError("");
    try {
      const { html2canvas, jsPDF } = await loadPdfTools();
      await waitForAppearanceImages();
      const sheets = Array.from(appearancePreviewPagesRef.current!.querySelectorAll<HTMLElement>(".coa-print-sheet"));
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      for (let index = 0; index < sheets.length; index += 1) {
        const canvas = await html2canvas(sheets[index], { backgroundColor: "#fff", logging: false, scale: 3, useCORS: true });
        if (index > 0) pdf.addPage();
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.96), "JPEG", 0, 0, 210, 297);
      }
      pdf.save(`certificate-of-appearance-${appearancePreviewRecord?.eventDateFrom || appearancePreviewRecord?.eventDate || "record"}.pdf`);
    } catch (cause) {
      setAppearancePreviewError(cause instanceof Error ? cause.message : "Unable to create the PDF.");
    } finally {
      setAppearancePreviewDownloading(false);
    }
  }

  async function printAppearancePreview() {
    setAppearancePreviewPrinting(true);
    setAppearancePreviewError("");
    try {
      await waitForAppearanceImages();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      window.print();
    } catch (cause) {
      setAppearancePreviewError(cause instanceof Error ? cause.message : "Unable to prepare the certificates for printing.");
    } finally {
      setAppearancePreviewPrinting(false);
    }
  }

  function closeAppearancePreview() {
    setAppearancePreviewRecord(null);
    setAppearancePreviewError("");
  }

  async function printBlankPreview() {
    setBlankPreviewPrinting(true);
    setBlankPreviewError("");
    try {
      if (blankPreviewLoading || blankPreviewRendering || !blankPreviewCanvasRef.current) {
        throw new Error("Wait for the Certificate of Appearance preview to finish loading.");
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      window.print();
    } catch (cause) {
      setBlankPreviewError(cause instanceof Error ? cause.message : "Unable to prepare the certificate for printing.");
    } finally {
      setBlankPreviewPrinting(false);
    }
  }

  const appearancePreviewPages: AppearancePerson[][] = [];
  for (let index = 0; index < (appearancePreviewRecord?.people?.length ?? 0); index += 2) {
    appearancePreviewPages.push(appearancePreviewRecord!.people!.slice(index, index + 2));
  }

  return <>
    <section className="content-section certificate-approval-section">
      <div className="section-heading">
        <div><p className="eyebrow">Admin Panel</p><h2>Certificate Approval</h2><p className="muted">Review certificate submissions and their current status.</p></div>
      </div>
      {accessMessage && <p className="certificate-approval-notice">{accessMessage}</p>}
      {role === "regular" && <p className="certificate-approval-notice">Your certificates appear here with their current approval status. Only an authorized administrator can change a status.</p>}
      {error && <p className="certificate-approval-error" role="alert">{error}</p>}
      {approvalDiagnostic && process.env.NODE_ENV !== "production" && <details className="certificate-approval-debug"><summary>Approval diagnostic details</summary><pre>{approvalDiagnostic}</pre></details>}
      {message && <p className="certificate-approval-success" role="status">{message}</p>}
      {loading ? <p className="muted">Loading certificates...</p> : role === "admin" && !isAppearanceApprovalAdmin ? null : !accessMessage && records.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No certificates to show</h3><p>Submitted certificates will appear here with their status.</p></div> : records.length > 0 && <div className="certificate-approval-table-wrap"><div className="certificate-approval-table">
        <div className="certificate-approval-head"><span>Type of Certificate</span><span>Title</span><span>Schedule</span><span>Destination</span><span>Status</span><span>Action</span></div>
        {visibleRecords.map((record) => {
          const status = certificateWorkflowStatus(record.status);
          const rowKey = `${record.collectionName}:${record.id}`;
          const canManage = role === "superadmin" || isAppearanceApprovalAdmin;
          const isAppearanceCertificate = record.collectionName === "certificatesOfAppearance";
          const isBlankAppearance = isAppearanceCertificate && record.recordType === "blank";
          const isLegacyBlankTitle = isBlankAppearance && record.eventTitle === "Blank Certificate of Appearance";
          const displayTitle = isLegacyBlankTitle ? record.purpose?.trim() || "Blank Certificate of Appearance" : record.eventTitle;
          return <div className="certificate-approval-row" key={rowKey}>
            <strong>{record.certificateType}</strong>
            {isBlankAppearance
              ? <span>{displayTitle || "Blank Certificate of Appearance"}</span>
              : <span>{record.eventTitle || `Certificate of ${record.certificateType}`}</span>}
            <span>{displaySchedule(record)}</span>
            <span>{record.destination || record.eventDestination || "—"}</span>
            <span><CertificateStatusBadge record={record} /></span>
            <div className="certificate-approval-actions">{isAppearanceCertificate && <button type="button" className="row-action" disabled={blankPreviewLoading} onClick={() => isBlankAppearance ? void viewBlankAppearance(record) : viewAppearance(record)}>View</button>}{canManage && status === "Pending" && <>
              <button type="button" className="row-action" disabled={savingKey !== null || deleting} onClick={() => void decide(record, "Approved")}>{savingKey === rowKey ? "Saving..." : "Approve"}</button>
              <button type="button" className="row-action" disabled={savingKey !== null || deleting} onClick={() => void decide(record, "Disapproved")}>Disapprove</button>
              <button type="button" className="delete-button" disabled={savingKey !== null || deleting} onClick={() => setPendingDelete(record)}>Delete</button>
            </>}</div>
          </div>;
        })}
      </div><RecordPagination totalRecords={records.length} currentPage={currentPage} pageCount={pageCount} onPageChange={setPage} label="Certificate Approval" /></div>}
    </section>
    {blankPreviewRecord && <div className="preview-backdrop coa-preview-backdrop" role="dialog" aria-modal="true" aria-label="Blank Certificate of Appearance preview">
      <div className="preview-toolbar coa-preview-toolbar"><span>Certificate of Appearance preview</span><button type="button" className="ghost-button" onClick={closeBlankPreview}>Close</button><button type="button" className="pdf-button" disabled={!blankPreviewUrl || blankPreviewLoading || blankPreviewRendering || Boolean(blankPreviewError)} onClick={downloadBlankPreviewPdf}>Download PDF</button><button type="button" className="pdf-button" disabled={blankPreviewPrinting || blankPreviewLoading || blankPreviewRendering || Boolean(blankPreviewError)} onClick={() => void printBlankPreview()}>{blankPreviewPrinting ? "Preparing print..." : "Print"}</button></div>
      {blankPreviewLoading || blankPreviewRendering ? <p className="coa-preview-loading">Preparing preview...</p> : null}
      {blankPreviewError && <p className="coa-error" role="alert">{blankPreviewError}</p>}
      <div className="coa-blank-preview-paper"><canvas ref={blankPreviewCanvasRef} className="coa-blank-preview-canvas" aria-label={`Blank Certificate of Appearance for ${blankPreviewRecord.division ?? "the selected division"}`} /></div>
    </div>}
    {appearancePreviewRecord && <div className="preview-backdrop coa-preview-backdrop" role="dialog" aria-modal="true" aria-label="Certificate of Appearance preview">
      <div className="preview-toolbar coa-preview-toolbar"><span>Certificate of Appearance preview</span><button type="button" className="ghost-button" onClick={closeAppearancePreview}>Close</button><button type="button" className="pdf-button" disabled={!appearancePreviewRecord.people?.length || appearancePreviewDownloading || Boolean(appearancePreviewError)} onClick={() => void downloadAppearancePreviewPdf()}>{appearancePreviewDownloading ? "Preparing PDF..." : "Download PDF"}</button><button type="button" className="pdf-button" disabled={!appearancePreviewRecord.people?.length || appearancePreviewPrinting || Boolean(appearancePreviewError)} onClick={() => void printAppearancePreview()}>{appearancePreviewPrinting ? "Preparing print..." : "Print"}</button></div>
      {appearancePreviewError && <p className="coa-error" role="alert">{appearancePreviewError}</p>}
      <div className="coa-preview-pages" ref={appearancePreviewPagesRef}>{appearancePreviewPages.map((people, pageIndex) => <section className="coa-print-sheet" key={`sheet-${pageIndex}`} aria-label={`A4 page ${pageIndex + 1}`}>
        {people.map((person, personIndex) => <ApproverCertificatePaper key={`${person.name}-${personIndex}`} record={appearancePreviewRecord} person={person} />)}
      </section>)}</div>
    </div>}
    <DeleteConfirmation open={Boolean(pendingDelete)} title="Delete certificate?" description="This certificate will be permanently removed. This action cannot be undone." busy={deleting} onCancel={() => setPendingDelete(null)} onConfirm={() => void deleteRecord()} />
  </>;
}

function ApproverCertificatePaper({ record, person }: { record: CertificateQueueRecord; person: AppearancePerson }) {
  const showApprovalSignature = hasFieldOperationsAppearanceApprovalSignature(record);
  const showDisapprovalStamp = certificateWorkflowStatus(record.status) === "Disapproved";
  const signatory = appearanceCertificateSignatory(record, record.signatoryName ?? "", record.designation ?? "");
  return <article className="coa-certificate-card">
    <img className="coa-letterhead" src={appearanceLetterhead} alt="" />
    <div className="coa-letterhead-header">
      <span>Republic of the Philippines</span>
      <strong>DEPARTMENT OF AGRICULTURE</strong>
      <span>Regional Field Office 13</span>
      <span>Capitol Site, Butuan City 8600</span>
    </div>
    <h1 className="coa-title">CERTIFICATE OF APPEARANCE</h1>
    <div className="coa-copy">
      <p>This is to certify that <strong className="coa-name">{person.name}</strong> of the <strong className="coa-office">{person.office ?? record.office}</strong> has attended the <strong><em>“{record.eventTitle}”</em></strong> held in <strong>{record.destination}</strong> on <strong>{appearanceDisplayDateRange(record.eventDateFrom ?? record.eventDate, record.eventDateTo ?? record.eventDateFrom ?? record.eventDate)}</strong>.</p>
      <p>This certification is issued upon the request of the above-named person for whatever legal purpose it may serve {appearancePronoun(person.gender)} best.</p>
    </div>
    <div className={`coa-signatory-block${showApprovalSignature ? " is-approved" : ""}${showDisapprovalStamp ? " is-disapproved" : ""}`}>
      <CertificateDisapprovalStamp record={record} />
      <CertificateApprovalSignature record={record} />
      <footer className="coa-signatory"><strong>{signatory.name}</strong><div className="coa-signatory-role">{signatory.isProfileSignatory
        ? <em>{signatory.designation} / {signatory.position}</em>
        : <><em>{signatory.position},</em> <span>{certificateDivisionDisplayNames[record.division ?? ""] ?? record.division}</span></>}</div></footer>
    </div>
  </article>;
}
