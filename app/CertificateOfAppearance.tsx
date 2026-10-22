"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { collection, deleteDoc, doc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";
import type { User } from "firebase/auth";
import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import { db } from "@/lib/firebase";
import { accountOffice, accountOfficeOptions, accountProfileSelection, divisionsForOffice, hasAccountDesignation, unitsForOfficeDivision } from "@/lib/account-profile";
import { certificateAppearanceSignatoryForOwner, isFieldOperationsAppearanceApprover } from "@/lib/certificate-signatory";
import { makeDocumentNotification } from "@/lib/document-notifications";
import { makeBlankCertificatePdf as createBlankCertificatePdf } from "@/lib/blank-certificate-pdf";
import { isSuperadminRole, normalizeAccountStatus, type AccountRole } from "@/lib/user-roles";
import { loadPdfTools } from "@/lib/pdf-tools";
import { divisionSignatory, isTevDivision, tevDivisions, type TevDivision } from "@/lib/mytev";
import { appearanceCertificateSignatory, CertificateApprovalSignature, CertificateDisapprovalStamp, CertificateStatusBadge, certificateWorkflowStatus, hasFieldOperationsAppearanceApprovalSignature, type CertificateWorkflowFields } from "./CertificateWorkflow";
import DeleteConfirmation from "./DeleteConfirmation";
import "./certificate-of-appearance.css";
import "./certificate-workflow.css";

type CertificateGender = "female" | "male" | "unspecified" | "";
type CertificatePerson = { name: string; gender: CertificateGender; office?: string };
type CertificateRecord = CertificateWorkflowFields & {
  id: string;
  recordType?: "appearance" | "blank";
  office?: string;
  ownerRole?: string;
  ownerOffice?: string;
  ownerDivision?: string;
  ownerUnit?: string;
  certificateOffice?: string;
  certificateDivision?: string;
  certificateUnit?: string;
  eventTitle: string;
  destination: string;
  purpose?: string;
  eventDateFrom?: string;
  eventDateTo?: string;
  eventDate?: string;
  people: CertificatePerson[];
  signatoryName: string;
  designation: string;
  division: string;
  ownerId: string;
  createdAt?: { toMillis?: () => number; toDate?: () => Date };
};

type BlankCertificateSubmission = {
  certificateOffice: string;
  certificateDivision: string;
  certificateUnit: string;
  pdfDivision: TevDivision;
  eventTitle: string;
  destination: string;
  eventDateFrom: string;
  eventDateTo: string;
};

const publicAsset = (path: string) => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
const blankCertificateAsset = publicAsset("/certificate-of-appearance-blank.jpg");
const certificateDivisionDisplayNames: Record<string, string> = {
  "Planning, Monitoring and Evaluation Division": "PMED",
  "Agribusiness and Marketing Assistance Division": "AMAD",
  "Regional Agricultural Engineering Division": "RAED",
};
const newPerson = (): CertificatePerson => ({ name: "", gender: "", office: "" });
type AppearanceApprovalAdmin = { id: string; name: string; designation: string; position: string };

function displayDate(value: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-PH", { month: "long", day: "numeric", year: "numeric" }).format(new Date(`${value}T00:00:00`));
}

function displayDateRange(from?: string, to?: string) {
  const startValue = from ?? "";
  const endValue = to ?? from ?? "";
  if (!startValue) return displayDate(endValue);
  if (!endValue || startValue === endValue) return displayDate(startValue);
  const startDate = new Date(`${startValue}T00:00:00`);
  const endDate = new Date(`${endValue}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return `${displayDate(startValue)} - ${displayDate(endValue)}`;
  const startMonth = new Intl.DateTimeFormat("en-PH", { month: "long" }).format(startDate);
  const endMonth = new Intl.DateTimeFormat("en-PH", { month: "long" }).format(endDate);
  if (startDate.getFullYear() === endDate.getFullYear() && startDate.getMonth() === endDate.getMonth()) {
    return `${startMonth} ${startDate.getDate()} - ${endDate.getDate()}, ${endDate.getFullYear()}`;
  }
  if (startDate.getFullYear() === endDate.getFullYear()) {
    return `${displayDate(startValue)} - ${endMonth} ${endDate.getDate()}, ${endDate.getFullYear()}`;
  }
  return `${displayDate(startValue)} - ${displayDate(endValue)}`;
}

function eventDateRange(from?: string, to?: string) {
  const start = from ?? "";
  const end = to ?? from ?? "";
  return displayDateRange(start || end, end || start);
}

async function findAppearanceApprovalAdmins(certificateOffice: string, certificateDivision: string, certificateUnit: string, pdfDivision: string) {
  if (!db) return [];
  const snapshot = await getDocs(collection(db, "users"));
  const certificateRoute = certificateAppearanceSignatoryForOwner(certificateOffice.trim(), certificateDivision.trim(), certificateUnit.trim());
  const isUnroutedFieldOperationsUnit = certificateOffice.trim() === "Division" && certificateDivision.trim() === "Field Operations Division";
  const targetDivision = pdfDivision.trim().toLocaleLowerCase("en");
  const admins: AppearanceApprovalAdmin[] = [];
  for (const profile of snapshot.docs) {
    const data = profile.data();
    const profileSelection = accountProfileSelection(data);
    const isAssignedFodApprover = certificateRoute
      && isFieldOperationsAppearanceApprover(data)
      && data.profileFieldsVersion === 4
      && (data.accountStatus === undefined || data.accountStatus === "Approved")
      && data.designation === certificateRoute.designation;
    const isAssignedLegacyApprover = !certificateRoute
      && !isUnroutedFieldOperationsUnit
      && !isSuperadminRole(data.accountRole, data.email)
      && profileSelection.office
      && profileSelection.division.toLocaleLowerCase("en") === targetDivision
      && data.accountRole === "admin"
      && normalizeAccountStatus(data.accountStatus) === "Approved"
      && hasAccountDesignation(data.designation, "Chief");
    if (isAssignedFodApprover || isAssignedLegacyApprover) {
      admins.push({
        id: profile.id,
        name: typeof data.name === "string" ? data.name : "",
        designation: typeof data.designation === "string" ? data.designation : "",
        position: typeof data.position === "string" ? data.position : "",
      });
    }
  }
  return admins;
}

function routedProjectLeaderAdmin(office: string, division: string, unit: string, admins: AppearanceApprovalAdmin[]) {
  const route = certificateAppearanceSignatoryForOwner(office.trim(), division.trim(), unit.trim());
  if (route?.designation !== "AGRISTAT/DRRM/AMIA Project Leader") return undefined;
  return admins.find((admin) => admin.designation === route.designation && admin.name && admin.position);
}

function pronoun(gender: CertificateGender) {
  return gender === "female" ? "her" : gender === "male" ? "him" : "them";
}

export default function CertificateOfAppearance({ user, ownerOffice, ownerDivision, ownerUnit, role, focusRecordId, onFocusHandled }: { user: User; ownerOffice?: string | null; ownerDivision?: string | null; ownerUnit?: string | null; role: AccountRole; focusRecordId?: string; onFocusHandled?: () => void }) {
  const normalizedOwnerOffice = ownerOffice?.trim() ?? "";
  const normalizedOwnerDivision = ownerDivision?.trim() ?? "";
  const normalizedOwnerUnit = ownerUnit?.trim() ?? "";
  const [records, setRecords] = useState<CertificateRecord[]>([]);
  const [view, setView] = useState<"list" | "new" | "edit" | "blank-ca">("list");
  const [editingRecord, setEditingRecord] = useState<CertificateRecord | null>(null);
  const [preview, setPreview] = useState<CertificateRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CertificateRecord | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const handledFocusIdRef = useRef<string | null>(null);
  const [savingBlank, setSavingBlank] = useState(false);
  const [blankPreview, setBlankPreview] = useState<CertificateRecord | null>(null);
  const [blankPreviewUrl, setBlankPreviewUrl] = useState("");
  const [blankPreviewRendering, setBlankPreviewRendering] = useState(false);
  const [blankPreviewError, setBlankPreviewError] = useState("");
  const [blankError, setBlankError] = useState("");
  const [error, setError] = useState("");
  const pagesRef = useRef<HTMLDivElement>(null);
  const blankPreviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    let active = true;
    if (!db) { setLoading(false); setError("Certificate storage is unavailable."); return; }
    getDocs(query(collection(db, "certificatesOfAppearance"), where("ownerId", "==", user.uid)))
      .then(async (snapshot) => {
        if (!active) return;
        const loaded = snapshot.docs.map((item) => {
          const data = item.data();
          const storedOwnerOffice = typeof data.ownerOffice === "string" ? data.ownerOffice : "";
          const savedOwnerOffice = accountOffice({ office: storedOwnerOffice, profileFieldsVersion: 3 }) ?? storedOwnerOffice;
          const blankOffice = data.recordType === "blank"
            ? (typeof data.certificateOffice === "string" ? data.certificateOffice : normalizedOwnerOffice || savedOwnerOffice)
            : "";
          return {
            id: item.id,
            ...data,
            ...(blankOffice ? { certificateOffice: blankOffice, ...(!data.destination ? { destination: blankOffice } : {}) } : {}),
          } as CertificateRecord;
        });
        const signatoryByScope = new Map<string, Promise<AppearanceApprovalAdmin | undefined>>();
        const enriched = await Promise.all(loaded.map(async (record) => {
          if (record.signatoryPosition?.trim()) return record;
          const certificateOffice = record.certificateOffice?.trim() || record.ownerOffice?.trim() || normalizedOwnerOffice;
          const certificateDivision = record.certificateDivision?.trim() || record.ownerDivision?.trim() || normalizedOwnerDivision;
          const certificateUnit = record.certificateUnit?.trim() || record.ownerUnit?.trim() || normalizedOwnerUnit;
          const route = certificateAppearanceSignatoryForOwner(certificateOffice, certificateDivision, certificateUnit);
          if (route?.designation !== "AGRISTAT/DRRM/AMIA Project Leader") return record;
          const key = `${certificateOffice}\u0000${certificateDivision}\u0000${certificateUnit}`;
          let signatoryPromise = signatoryByScope.get(key);
          if (!signatoryPromise) {
            signatoryPromise = findAppearanceApprovalAdmins(certificateOffice, certificateDivision, certificateUnit, record.division)
              .then((admins) => routedProjectLeaderAdmin(certificateOffice, certificateDivision, certificateUnit, admins))
              .catch(() => undefined);
            signatoryByScope.set(key, signatoryPromise);
          }
          const assigned = await signatoryPromise;
          if (!assigned) return record;
          return {
            ...record,
            certificateOffice,
            certificateDivision,
            certificateUnit,
            signatoryName: assigned.name,
            designation: assigned.designation,
            signatoryPosition: assigned.position,
            signatoryAdminId: assigned.id,
          };
        }));
        if (!active) return;
        enriched.sort((first, second) => (second.createdAt?.toMillis?.() ?? 0) - (first.createdAt?.toMillis?.() ?? 0));
        setRecords(enriched);
      })
      .catch((cause) => {
        if (!active) return;
        const code = (cause as { code?: string }).code;
        setError(code ? `Could not load certificates (${code}).` : "Could not load certificates. Refresh and try again.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [user.uid, normalizedOwnerOffice]);

  useEffect(() => {
    if (!focusRecordId) { handledFocusIdRef.current = null; return; }
    if (handledFocusIdRef.current === focusRecordId || loading) return;
    const record = records.find((item) => item.id === focusRecordId);
    if (!record) return;
    handledFocusIdRef.current = focusRecordId;
    setPreview(record);
    onFocusHandled?.();
  }, [focusRecordId, loading, onFocusHandled, records]);

  async function deleteRecord(record: CertificateRecord) {
    if (!db || certificateWorkflowStatus(record.status) === "Approved") return;
    setDeletingId(record.id);
    setError("");
    try {
      await deleteDoc(doc(db, "certificatesOfAppearance", record.id));
      setRecords((current) => current.filter((item) => item.id !== record.id));
      setPreview((current) => current?.id === record.id ? null : current);
      setPendingDelete(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete the Certificate of Appearance (${code}).` : "Could not delete the Certificate of Appearance.");
      setPendingDelete(null);
    } finally {
      setDeletingId(null);
    }
  }

  async function saveCertificate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!db) { setError("Certificate storage is unavailable."); return; }
    const form = new FormData(event.currentTarget);
    const personNames = form.getAll("person-name").map((name) => String(name).trim());
    const genders = form.getAll("person-gender").map((gender) => String(gender) as CertificateGender);
    const division = String(form.get("division-name") ?? "") as TevDivision;
    const certificateOffice = String(form.get("certificate-office") ?? "").trim();
    const certificateDivision = String(form.get("certificate-division") ?? "").trim();
    const certificateUnit = String(form.get("certificate-unit") ?? "").trim();
    if (!isTevDivision(division)) { setError("Select a valid division."); return; }
    if (!accountOfficeOptions.includes(certificateOffice as (typeof accountOfficeOptions)[number])
      || !divisionsForOffice(certificateOffice).includes(certificateDivision)
      || !unitsForOfficeDivision(certificateOffice, certificateDivision).includes(certificateUnit)) {
      setError("Select a valid Certificate Office, Division, and Unit / Program / Project.");
      return;
    }
    const signatory = divisionSignatory(division);
    const certificateScopeFields = { certificateOffice, certificateDivision, certificateUnit };
    setSaving(true);
    let saveStage = "refreshing your sign-in status";
    let certificateSaved = false;
    try {
      await user.reload();
      const token = await user.getIdTokenResult(true);
      if (token.claims.email_verified !== true) {
        throw new Error("Firebase does not currently mark this signed-in account as email verified. Sign out and back in after verifying your email, then try again.");
      }

      saveStage = "loading the assigned approver profile";
      const approvalAdmins = role === "regular"
        ? await findAppearanceApprovalAdmins(certificateOffice, certificateDivision, certificateUnit, division)
        : [];
      if (role === "regular" && !approvalAdmins.length) throw new Error("No approved Certificate of Appearance signatory is assigned to the selected Certificate Office, Division, and Unit. The certificate was not submitted.");
      const assignedProjectLeader = role === "regular"
        ? routedProjectLeaderAdmin(certificateOffice, certificateDivision, certificateUnit, approvalAdmins)
        : undefined;
      if (role === "regular"
        && certificateAppearanceSignatoryForOwner(certificateOffice, certificateDivision, certificateUnit)?.designation === "AGRISTAT/DRRM/AMIA Project Leader"
        && !assignedProjectLeader) {
        throw new Error("No approved Certificate of Appearance signatory with a name and position is assigned to the selected Certificate Office, Division, and Unit. The certificate was not submitted.");
      }
      const recordData = {
        eventTitle: String(form.get("event-title") ?? "").trim(),
        destination: String(form.get("destination") ?? "").trim(),
        eventDateFrom: String(form.get("event-date-from") ?? ""),
        eventDateTo: String(form.get("event-date-to") ?? ""),
        people: personNames.map((name, index) => ({ name, gender: genders[index] || "unspecified", office: String(form.getAll("person-office")[index] ?? "").trim() })),
        signatoryName: assignedProjectLeader?.name || signatory.name,
        designation: assignedProjectLeader?.designation || signatory.position,
        ...(assignedProjectLeader ? { signatoryPosition: assignedProjectLeader.position, signatoryAdminId: assignedProjectLeader.id } : {}),
        division,
        ownerRole: role,
        ...certificateScopeFields,
        status: "Pending" as const,
        ownerId: user.uid,
        createdAt: serverTimestamp(),
      };
      const reference = doc(collection(db, "certificatesOfAppearance"));
      saveStage = "saving the certificate record";
      await setDoc(reference, recordData);
      certificateSaved = true;
      setRecords((current) => [{ ...recordData, id: reference.id, createdAt: undefined }, ...current]);
      setView("list");

      if (role === "regular") {
        const notificationBatch = writeBatch(db);
        for (const recipient of approvalAdmins) {
          const notification = makeDocumentNotification(db, {
            recipientId: recipient.id,
            ownerId: user.uid,
            documentId: reference.id,
            documentType: "Certificate Approval",
            certificateType: "Appearance",
            activityTitle: recordData.eventTitle,
            dateFrom: recordData.eventDateFrom,
            dateTo: recordData.eventDateTo,
            destination: recordData.destination,
          });
          notificationBatch.set(notification.reference, notification.data);
        }
        if (approvalAdmins.length) {
          saveStage = "sending the approval notification";
          await notificationBatch.commit();
        }
      }
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      if (certificateSaved) {
        setError(`The Certificate of Appearance was saved, but Firestore denied ${saveStage}. The assigned approver can still review it in Certificate Approval.`);
      } else setError(cause instanceof Error && cause.message.startsWith("No approved Certificate of Appearance signatory")
        ? cause.message
        : cause instanceof Error && cause.message.startsWith("Firebase does not currently mark this signed-in account")
          ? cause.message
          : code ? `Could not continue while ${saveStage} (${code}). Refresh the page and try again.` : cause instanceof Error ? cause.message : "Could not save the certificate. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function saveNameCorrections(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!db || !editingRecord || certificateWorkflowStatus(editingRecord.status) === "Approved") { setError("Approved certificates cannot be edited."); return; }
    const form = new FormData(event.currentTarget);
    const correctedNames = form.getAll("person-name").map((value) => String(value).trim());
    const genders = form.getAll("person-gender").map((value) => String(value) as CertificateGender);
    const offices = form.getAll("person-office").map((value) => String(value).trim());
    if (!correctedNames.length || correctedNames.length > 100 || correctedNames.some((name) => !name) || offices.some((office) => !office)) {
      setError("Enter a name and office for every attendee (up to 100 attendees).");
      return;
    }
    const people: CertificatePerson[] = correctedNames.map((name, index) => ({
      name,
      gender: genders[index] || editingRecord.people[index]?.gender || "unspecified",
      office: offices[index],
    }));
    setSaving(true);
    try {
      await updateDoc(doc(db, "certificatesOfAppearance", editingRecord.id), { people });
      setRecords((current) => current.map((record) => record.id === editingRecord.id ? { ...record, people } : record));
      setEditingRecord(null);
      setView("list");
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not update the attendees (${code}).` : "Could not update the attendees. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function importCertificates(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setError("");
    setImportMessage("");
    const firestore = db;
    if (!firestore) { setError("Certificate storage is unavailable."); return; }
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setError("Choose the CA_Importing_Template.xlsx workbook (.xlsx).");
      return;
    }

    setImporting(true);
    let imported: CertificateRecord[] = [];
    try {
      const { parseCertificateImportWorkbook } = await import("@/lib/certificate-import");
      const parsed = parseCertificateImportWorkbook(new Uint8Array(await file.arrayBuffer()));
      const certificateCollection = collection(firestore, "certificatesOfAppearance");
      const defaultCertificateScopeFields = normalizedOwnerOffice && normalizedOwnerDivision && normalizedOwnerUnit
        ? { certificateOffice: normalizedOwnerOffice, certificateDivision: normalizedOwnerDivision, certificateUnit: normalizedOwnerUnit }
        : {};
      const adminsByScope = new Map<string, Promise<AppearanceApprovalAdmin[]>>();
      const routedRecords = await Promise.all(parsed.map(async (record) => {
        const certificateOffice = record.certificateOffice || normalizedOwnerOffice;
        const certificateDivision = record.certificateDivision || normalizedOwnerDivision;
        const certificateUnit = record.certificateUnit || normalizedOwnerUnit;
        const recordCertificateScopeFields = certificateOffice && certificateDivision && certificateUnit
          ? { certificateOffice, certificateDivision, certificateUnit }
          : defaultCertificateScopeFields;
        let approvalAdmins: AppearanceApprovalAdmin[] = [];
        let assignedProjectLeader: AppearanceApprovalAdmin | undefined;
        if (role === "regular") {
          const scopeKey = `${certificateOffice}\u0000${certificateDivision}\u0000${certificateUnit}\u0000${record.division}`;
          let adminsPromise = adminsByScope.get(scopeKey);
          if (!adminsPromise) {
            adminsPromise = findAppearanceApprovalAdmins(certificateOffice, certificateDivision, certificateUnit, record.division);
            adminsByScope.set(scopeKey, adminsPromise);
          }
          approvalAdmins = await adminsPromise;
          if (!approvalAdmins.length) {
            throw new Error(`No approved Certificate of Appearance signatory is assigned to ${certificateOffice}, ${certificateDivision}, and ${certificateUnit}. The workbook was not imported.`);
          }
          const route = certificateAppearanceSignatoryForOwner(certificateOffice, certificateDivision, certificateUnit);
          if (route?.designation === "AGRISTAT/DRRM/AMIA Project Leader") {
            assignedProjectLeader = routedProjectLeaderAdmin(certificateOffice, certificateDivision, certificateUnit, approvalAdmins);
            if (!assignedProjectLeader) {
              throw new Error(`No approved Certificate of Appearance signatory with a name and position is assigned to ${certificateOffice}, ${certificateDivision}, and ${certificateUnit}. The workbook was not imported.`);
            }
          }
        }
        const reference = doc(certificateCollection);
        const data = {
          ...record,
          ...(assignedProjectLeader ? {
            signatoryName: assignedProjectLeader.name,
            designation: assignedProjectLeader.designation,
            signatoryPosition: assignedProjectLeader.position,
            signatoryAdminId: assignedProjectLeader.id,
          } : {}),
          ownerRole: role,
          ...recordCertificateScopeFields,
          status: "Pending" as const,
          ownerId: user.uid,
          createdAt: serverTimestamp(),
        };
        return { reference, data, approvalAdmins };
      }));

      let batch = writeBatch(firestore);
      let batchWriteCount = 0;
      let batchRecords: CertificateRecord[] = [];
      const commitBatch = async () => {
        if (!batchWriteCount) return;
        await batch.commit();
        imported = [...imported, ...batchRecords];
        setRecords((current) => [...batchRecords, ...current]);
        batch = writeBatch(firestore);
        batchWriteCount = 0;
        batchRecords = [];
      };
      for (const { reference, data, approvalAdmins } of routedRecords) {
        const operationCount = 1 + approvalAdmins.length;
        if (operationCount > 450) throw new Error("Too many assigned signatories were found for an imported certificate.");
        if (batchWriteCount && batchWriteCount + operationCount > 450) await commitBatch();
        batch.set(reference, data);
        for (const recipient of approvalAdmins) {
          const notification = makeDocumentNotification(firestore, {
            recipientId: recipient.id,
            ownerId: user.uid,
            documentId: reference.id,
            documentType: "Certificate Approval",
            certificateType: "Appearance",
            activityTitle: data.eventTitle,
            dateFrom: data.eventDateFrom,
            dateTo: data.eventDateTo,
            destination: data.destination,
          });
          batch.set(notification.reference, notification.data);
        }
        batchWriteCount += operationCount;
        batchRecords.push({ ...data, id: reference.id, createdAt: undefined } as CertificateRecord);
      }
      await commitBatch();
      setImportMessage(role === "regular"
        ? `Imported ${imported.length} certificate ${imported.length === 1 ? "report" : "reports"} and notified the assigned approver${imported.length === 1 ? "" : "s"}.`
        : `Imported ${imported.length} certificate ${imported.length === 1 ? "report" : "reports"}.`);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "Check the template and try again.";
      setError(imported.length
        ? `${detail} ${imported.length} ${imported.length === 1 ? "report was" : "reports were"} imported before the error.`
        : detail);
    } finally {
      setImporting(false);
    }
  }

  async function waitForImages() {
    if (!pagesRef.current) throw new Error("The certificate preview is unavailable.");
    await Promise.all(Array.from(pagesRef.current.querySelectorAll("img"), async (image) => {
      if (!image.complete) await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("The Certificate of Appearance blank could not be loaded."));
      });
      if (!image.naturalWidth) throw new Error("The Certificate of Appearance blank could not be loaded.");
      if (image.decode) await image.decode();
    }));
    if (document.fonts?.ready) await document.fonts.ready;
  }

  async function downloadPdf() {
    setDownloading(true);
    setError("");
    try {
      const { html2canvas, jsPDF } = await loadPdfTools();
      await waitForImages();
      const sheets = Array.from(pagesRef.current!.querySelectorAll<HTMLElement>(".coa-print-sheet"));
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      for (let index = 0; index < sheets.length; index += 1) {
        const canvas = await html2canvas(sheets[index], { backgroundColor: "#fff", logging: false, scale: 3, useCORS: true });
        if (index > 0) pdf.addPage();
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.96), "JPEG", 0, 0, 210, 297);
      }
      const fileName = blankPreview
        ? `certificate-of-appearance-blank-${blankPreview.division.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}.pdf`
        : `certificate-of-appearance-${preview?.eventDateFrom || preview?.eventDate || "record"}.pdf`;
      pdf.save(fileName);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the PDF.");
    } finally {
      setDownloading(false);
    }
  }

  async function printCertificates() {
    setPrinting(true);
    setError("");
    try {
      if (blankPreview) {
        if (blankPreviewRendering || !blankPreviewCanvasRef.current) throw new Error("Wait for the Certificate of Appearance preview to finish loading.");
      } else {
        await waitForImages();
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      window.print();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to prepare the certificates for printing.");
    } finally {
      setPrinting(false);
    }
  }

  async function makeBlankCertificatePdf(record: CertificateRecord) {
    return createBlankCertificatePdf(record);
  }

  async function saveBlankCertificate(submission: BlankCertificateSubmission) {
    const { certificateOffice, certificateDivision, certificateUnit, pdfDivision } = submission;
    if (!accountOfficeOptions.includes(certificateOffice as (typeof accountOfficeOptions)[number])
      || !divisionsForOffice(certificateOffice).includes(certificateDivision)
      || !unitsForOfficeDivision(certificateOffice, certificateDivision).includes(certificateUnit)
      || !isTevDivision(pdfDivision)) {
      setBlankError("Select a valid Certificate Office, Division, Unit / Program / Project, and template division.");
      return;
    }
    const eventTitle = submission.eventTitle.trim();
    const destination = submission.destination.trim();
    const eventDateFrom = submission.eventDateFrom.trim();
    const eventDateTo = submission.eventDateTo.trim();
    if (!eventTitle || !destination || !eventDateFrom || !eventDateTo) {
      setBlankError("Enter the event title, destination, and both event dates.");
      return;
    }
    if (eventDateTo < eventDateFrom) {
      setBlankError("The event end date must be on or after the start date.");
      return;
    }
    setBlankError("");
    setImportMessage("");
    if (!db) { setBlankError("Certificate storage is unavailable."); return; }
    setSavingBlank(true);
    let saveStage = "refreshing your sign-in status";
    let certificateSaved = false;
    try {
      await user.reload();
      const token = await user.getIdTokenResult(true);
      if (token.claims.email_verified !== true) {
        throw new Error("Firebase does not currently mark this signed-in account as email verified. Sign out and back in after verifying your email, then try again.");
      }
      const signatory = divisionSignatory(pdfDivision);
      saveStage = "loading the assigned approver profile";
      const approvalAdmins = role === "regular"
        ? await findAppearanceApprovalAdmins(certificateOffice, certificateDivision, certificateUnit, pdfDivision)
        : [];
      if (role === "regular" && !approvalAdmins.length) throw new Error("No approved Certificate of Appearance signatory is assigned to the selected Certificate Office, Division, and Unit. The blank certificate was not submitted.");
      const assignedProjectLeader = role === "regular"
        ? routedProjectLeaderAdmin(certificateOffice, certificateDivision, certificateUnit, approvalAdmins)
        : undefined;
      if (role === "regular"
        && certificateAppearanceSignatoryForOwner(certificateOffice, certificateDivision, certificateUnit)?.designation === "AGRISTAT/DRRM/AMIA Project Leader"
        && !assignedProjectLeader) {
        throw new Error("No approved Certificate of Appearance signatory with a name and position is assigned to the selected Certificate Office, Division, and Unit. The blank certificate was not submitted.");
      }
      const recordData = {
        recordType: "blank" as const,
        eventTitle,
        destination,
        ownerRole: role,
        certificateOffice,
        certificateDivision,
        certificateUnit,
        eventDateFrom,
        eventDateTo,
        people: [] as CertificatePerson[],
        signatoryName: assignedProjectLeader?.name || signatory.name,
        designation: assignedProjectLeader?.designation || signatory.position,
        ...(assignedProjectLeader ? { signatoryPosition: assignedProjectLeader.position, signatoryAdminId: assignedProjectLeader.id } : {}),
        division: pdfDivision,
        status: "Pending" as const,
        ownerId: user.uid,
        createdAt: serverTimestamp(),
      };
      const reference = doc(collection(db, "certificatesOfAppearance"));
      saveStage = "saving the certificate record";
      await setDoc(reference, recordData);
      certificateSaved = true;
      setRecords((current) => [{ ...recordData, id: reference.id, createdAt: undefined }, ...current]);
      setView("list");

      if (role === "regular") {
        const notificationBatch = writeBatch(db);
        for (const recipient of approvalAdmins) {
          const notification = makeDocumentNotification(db, {
            recipientId: recipient.id,
            ownerId: user.uid,
            documentId: reference.id,
            documentType: "Certificate Approval",
            certificateType: "Appearance",
            activityTitle: eventTitle,
            dateFrom: recordData.eventDateFrom,
            dateTo: recordData.eventDateTo,
            destination,
          });
          notificationBatch.set(notification.reference, notification.data);
        }
        if (approvalAdmins.length) {
          saveStage = "sending the approval notification";
          await notificationBatch.commit();
        }
      }
      setImportMessage(`Saved a blank Certificate of Appearance for ${eventTitle}.`);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      if (certificateSaved) {
        setImportMessage(`The blank Certificate of Appearance for ${eventTitle} was saved, but Firestore denied ${saveStage}. The assigned approver can still review it in Certificate Approval.`);
      } else setBlankError(cause instanceof Error && cause.message.startsWith("No approved Certificate of Appearance signatory")
        ? cause.message
        : cause instanceof Error && cause.message.startsWith("Firebase does not currently mark")
          ? cause.message
        : code === "permission-denied"
          ? `Firestore denied access while ${saveStage}. This message does not identify which access rule failed. Confirm the app is using the ps-taguibo database and retry after refreshing the page.`
        : code ? `Could not save the blank certificate (${code}).` : "Could not save the blank certificate. Try again.");
    } finally {
      setSavingBlank(false);
    }
  }

  function viewSavedBlankCertificate(record: CertificateRecord) {
    if (!isTevDivision(record.division)) {
      setError("The saved certificate has an invalid division.");
      return;
    }
    setError("");
    setBlankPreviewError("");
    setBlankPreviewRendering(true);
    setBlankPreview(record);
    void makeBlankCertificatePdf(record).then((bytes) => {
      const pdfData = new Uint8Array(bytes).buffer as ArrayBuffer;
      setBlankPreviewUrl(URL.createObjectURL(new Blob([pdfData], { type: "application/pdf" })));
    }).catch((cause) => {
      setBlankPreviewRendering(false);
      setBlankPreviewError(cause instanceof Error ? cause.message : "The blank Certificate of Appearance PDF could not be created.");
    });
  }

  function downloadBlankPreviewPdf() {
    if (!blankPreview || !blankPreviewUrl) return;
    const downloadLink = document.createElement("a");
    downloadLink.href = blankPreviewUrl;
    downloadLink.download = `certificate-of-appearance-blank-${blankPreview.division.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}.pdf`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
  }

  if (preview) {
    const pages: CertificatePerson[][] = [];
    for (let index = 0; index < preview.people.length; index += 2) pages.push(preview.people.slice(index, index + 2));
    return <div className="preview-backdrop coa-preview-backdrop">
      <div className="preview-toolbar coa-preview-toolbar"><span>Certificate of Appearance preview</span><button type="button" className="ghost-button" onClick={() => { setPreview(null); setError(""); }}>Close</button><button type="button" className="pdf-button" disabled={downloading} onClick={() => void downloadPdf()}>{downloading ? "Preparing PDF..." : "Download PDF"}</button><button type="button" className="pdf-button" disabled={printing} onClick={() => void printCertificates()}>{printing ? "Preparing print..." : "Print"}</button></div>
      {error && <p className="coa-error" role="alert">{error}</p>}
      <div className="coa-preview-pages" ref={pagesRef}>{pages.map((people, pageIndex) => <section className="coa-print-sheet" key={`sheet-${pageIndex}`} aria-label={`A4 page ${pageIndex + 1}`}>
        {people.map((person, personIndex) => <CertificatePaper key={`${person.name}-${personIndex}`} record={preview} person={person} />)}
      </section>)}</div>
    </div>;
  }

  if (view === "new") return <CertificateForm ownerOffice={normalizedOwnerOffice} ownerDivision={normalizedOwnerDivision} ownerUnit={normalizedOwnerUnit} onCancel={() => { setView("list"); setError(""); }} onSubmit={saveCertificate} saving={saving} error={error} />;
  if (view === "edit" && editingRecord) return <CertificateNamesForm record={editingRecord} onCancel={() => { setEditingRecord(null); setView("list"); setError(""); }} onSubmit={saveNameCorrections} saving={saving} error={error} />;
  if (view === "blank-ca") return <BlankCertificateGenerator ownerOffice={normalizedOwnerOffice} ownerDivision={normalizedOwnerDivision} ownerUnit={normalizedOwnerUnit} onCancel={() => { setView("list"); setBlankError(""); }} onSave={(submission) => void saveBlankCertificate(submission)} saving={savingBlank} error={blankError} />;

  if (blankPreview) return <div className="preview-backdrop coa-preview-backdrop">
    <div className="preview-toolbar coa-preview-toolbar"><span>Certificate of Appearance preview</span><button type="button" className="ghost-button" onClick={() => { setBlankPreview(null); setBlankPreviewUrl(""); setBlankPreviewError(""); setError(""); }}>Close</button><button type="button" className="pdf-button" disabled={!blankPreviewUrl || blankPreviewRendering || Boolean(blankPreviewError)} onClick={downloadBlankPreviewPdf}>Download PDF</button><button type="button" className="pdf-button" disabled={printing || blankPreviewRendering || Boolean(blankPreviewError)} onClick={() => void printCertificates()}>{printing ? "Preparing print..." : "Print"}</button></div>
    {blankPreviewRendering && <p className="coa-preview-loading">Preparing preview...</p>}
    {blankPreviewError && <p className="coa-error" role="alert">{blankPreviewError}</p>}
    <div className="coa-blank-preview-paper"><canvas ref={blankPreviewCanvasRef} className="coa-blank-preview-canvas" aria-label={`Blank Certificate of Appearance for ${blankPreview.division}`} /></div>
  </div>;

  return <>
  <section className="content-section form-section coa-list-section">
    <div className="section-heading"><div><p className="eyebrow">Document generator</p><h2>Appearance Generated Reports</h2><p className="muted">Create certificates manually or import the <a className="coa-template-link" href={publicAsset("/CA_Importing_Template.xlsx")} download="CA_Importing_Template.xlsx">CA_Importing_Template.xlsx</a>.</p></div><div className="coa-list-actions"><button type="button" className="primary-button" onClick={() => { setError(""); setView("new"); }}>Add</button><button type="button" className="ghost-button" disabled={importing} onClick={() => { setError(""); setImportMessage(""); importInputRef.current?.click(); }}>{importing ? "Importing..." : "Import"}</button><button type="button" className="ghost-button" onClick={() => { setBlankError(""); setView("blank-ca"); }}>Blank Certificate</button></div></div>
    <input ref={importInputRef} className="coa-import-input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void importCertificates(event)} aria-label="Import Certificate of Appearance workbook" />
    {error && <p className="coa-error" role="alert">{error}</p>}
    {importMessage && <p className="coa-success" role="status">{importMessage}</p>}
    {loading ? <p className="muted">Loading certificates...</p> : records.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No certificates yet</h3><p>Add appearance details manually or import the completed CA_Importing_Template.xlsx workbook.</p><div className="coa-empty-actions"><button type="button" className="text-button plain-action" onClick={() => { setError(""); setView("new"); }}>Add Appearance Certificate</button><button type="button" className="text-button plain-action" disabled={importing} onClick={() => { setError(""); setImportMessage(""); importInputRef.current?.click(); }}>{importing ? "Importing..." : "Upload an excel file"}</button></div></div> : <div className="coa-record-list"><div className="coa-record-head"><span>Event&apos;s Title</span><span>Event&apos;s Destination</span><span>Event&apos;s Date</span><span>Status</span><span></span></div>{records.map((record) => {
      const legacyBlankTitle = record.recordType === "blank" && record.eventTitle === "Blank Certificate of Appearance";
      const displayTitle = legacyBlankTitle ? record.purpose?.trim() || "Blank Certificate of Appearance" : record.eventTitle;
      return <div className="coa-record-row" key={record.id}><strong>{displayTitle}</strong><span>{record.destination || record.certificateOffice || "—"}</span><span>{displayDateRange(record.eventDateFrom ?? record.eventDate, record.eventDateTo ?? record.eventDateFrom ?? record.eventDate) || "—"}</span><span><CertificateStatusBadge record={record} /></span><div className="coa-record-actions">{record.recordType === "blank" ? <button type="button" className="row-action" onClick={() => viewSavedBlankCertificate(record)}>View</button> : <>{certificateWorkflowStatus(record.status) === "Pending" && <button type="button" className="row-action" onClick={() => { setEditingRecord(record); setError(""); setView("edit"); }}>Edit</button>}<button type="button" className="row-action" onClick={() => { setError(""); setPreview(record); }}>View</button></>}{certificateWorkflowStatus(record.status) === "Pending" && <button type="button" className="delete-button" disabled={deletingId !== null} onClick={() => setPendingDelete(record)}>{deletingId === record.id ? "Deleting..." : "Delete"}</button>}</div></div>;
    })}</div>}
  </section>
  <DeleteConfirmation open={Boolean(pendingDelete)} title="Confirm Certificate of Appearance Deletion?" description="Are you sure you want to delete this Certificate of Appearance? This action cannot be undone." busy={Boolean(pendingDelete && deletingId === pendingDelete.id)} onCancel={() => setPendingDelete(null)} onConfirm={() => { if (pendingDelete) void deleteRecord(pendingDelete); }} />
  </>;
}

function BlankCertificateGenerator({ ownerOffice, ownerDivision, ownerUnit, onCancel, onSave, saving, error }: { ownerOffice: string; ownerDivision: string; ownerUnit: string; onCancel: () => void; onSave: (submission: BlankCertificateSubmission) => void; saving: boolean; error: string }) {
  const initialOffice = accountOfficeOptions.includes(ownerOffice as (typeof accountOfficeOptions)[number]) ? ownerOffice : accountOfficeOptions[0];
  const initialDivisionOptions = divisionsForOffice(initialOffice);
  const initialDivision = initialDivisionOptions.includes(ownerDivision) ? ownerDivision : initialDivisionOptions[0] ?? "";
  const initialUnitOptions = unitsForOfficeDivision(initialOffice, initialDivision);
  const initialUnit = initialUnitOptions.includes(ownerUnit) ? ownerUnit : initialUnitOptions[0] ?? "";
  const [certificateOffice, setCertificateOffice] = useState(initialOffice);
  const [certificateDivision, setCertificateDivision] = useState(initialDivision);
  const [certificateUnit, setCertificateUnit] = useState(initialUnit);
  const [templateDivision, setTemplateDivision] = useState<TevDivision | "">(() => isTevDivision(initialDivision) ? initialDivision : tevDivisions[0]);
  const [eventDateFrom, setEventDateFrom] = useState("");
  const [eventDateTo, setEventDateTo] = useState("");
  const certificateDivisionOptions = divisionsForOffice(certificateOffice);
  const certificateUnitOptions = unitsForOfficeDivision(certificateOffice, certificateDivision);
  const selectedPdfDivision = isTevDivision(certificateDivision)
    ? certificateDivision
    : templateDivision;

  function changeCertificateOffice(nextOffice: string) {
    const nextDivisions = divisionsForOffice(nextOffice);
    const nextDivision = nextDivisions[0] ?? "";
    const nextUnits = unitsForOfficeDivision(nextOffice, nextDivision);
    setCertificateOffice(nextOffice);
    setCertificateDivision(nextDivision);
    setCertificateUnit(nextUnits[0] ?? "");
    if (isTevDivision(nextDivision)) setTemplateDivision(nextDivision);
  }

  function changeCertificateDivision(nextDivision: string) {
    const nextUnits = unitsForOfficeDivision(certificateOffice, nextDivision);
    setCertificateDivision(nextDivision);
    setCertificateUnit(nextUnits[0] ?? "");
    if (isTevDivision(nextDivision)) setTemplateDivision(nextDivision);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (selectedPdfDivision) onSave({
      certificateOffice,
      certificateDivision,
      certificateUnit,
      pdfDivision: selectedPdfDivision,
      eventTitle: String(form.get("event-title") ?? ""),
      destination: String(form.get("destination") ?? ""),
      eventDateFrom,
      eventDateTo,
    });
  }

  return <section className="content-section form-section coa-form-section coa-blank-section">
    <div className="section-heading"><div><p className="eyebrow">Blank certificate</p><h2>Save a Blank Certificate of Appearance</h2><p className="muted">Choose the certificate office, division, and unit or program, then enter the event details. The saved certificate will appear in Appearance Generated Reports.</p></div><button type="button" className="ghost-button" onClick={onCancel}>Cancel</button></div>
    {error && <p className="coa-error" role="alert">{error}</p>}
    <form className="permit-form coa-blank-form" onSubmit={submit}>
      <div className="wide-field coa-blank-profile-row" aria-label="Certificate Office, Certificate Division, and Certificate Unit / Program / Project">
        <label>Certificate Office<select value={certificateOffice} onChange={(event) => changeCertificateOffice(event.target.value)} required><option value="" disabled>Select an Office</option>{accountOfficeOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label>Certificate Division<select value={certificateDivision} onChange={(event) => changeCertificateDivision(event.target.value)} required><option value="" disabled>Select a Division</option>{certificateDivisionOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label>Certificate Unit / Program / Project<select value={certificateUnit} onChange={(event) => setCertificateUnit(event.target.value)} required><option value="" disabled>Select a Unit / Program / Project</option>{certificateUnitOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      </div>
      {!isTevDivision(certificateDivision) && <label className="wide-field">Certificate Template Signatory Division<select value={templateDivision} onChange={(event) => setTemplateDivision(event.target.value as TevDivision | "")} required><option value="" disabled>Select a template division</option>{tevDivisions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>}
      <label>Event&apos;s Title<input name="event-title" maxLength={240} required /></label>
      <label>Event&apos;s Destination<input name="destination" maxLength={180} required /></label>
      <div className="wide-field coa-date-range"><label>Event&apos;s Date (From)<input type="date" value={eventDateFrom} onChange={(event) => { setEventDateFrom(event.target.value); if (eventDateTo && event.target.value && eventDateTo < event.target.value) setEventDateTo(""); }} required /></label><span>to</span><label>Event&apos;s Date (To)<input type="date" min={eventDateFrom || undefined} value={eventDateTo} onChange={(event) => setEventDateTo(event.target.value)} required /></label></div>
      <div className="wide-field form-actions"><button type="submit" className="primary-button" disabled={!certificateOffice || !certificateDivision || !certificateUnit || !selectedPdfDivision || saving}>{saving ? "Saving..." : "Save"}</button></div>
    </form>
  </section>;
}

function CertificateForm({ ownerOffice, ownerDivision, ownerUnit, onCancel, onSubmit, saving, error }: { ownerOffice: string; ownerDivision: string; ownerUnit: string; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; saving: boolean; error: string }) {
  const [people, setPeople] = useState([newPerson()]);
  const [eventDateFrom, setEventDateFrom] = useState("");
  const initialOffice = accountOfficeOptions.includes(ownerOffice as (typeof accountOfficeOptions)[number]) ? ownerOffice : accountOfficeOptions[0];
  const initialDivisionOptions = divisionsForOffice(initialOffice);
  const initialDivision = initialDivisionOptions.includes(ownerDivision) ? ownerDivision : initialDivisionOptions[0] ?? "";
  const initialUnitOptions = unitsForOfficeDivision(initialOffice, initialDivision);
  const initialUnit = initialUnitOptions.includes(ownerUnit) ? ownerUnit : initialUnitOptions[0] ?? "";
  const initialTemplateDivision = isTevDivision(ownerDivision) ? ownerDivision : tevDivisions[0];
  const [certificateOffice, setCertificateOffice] = useState(initialOffice);
  const [certificateDivision, setCertificateDivision] = useState(initialDivision);
  const [certificateUnit, setCertificateUnit] = useState(initialUnit);
  const [templateDivision, setTemplateDivision] = useState<TevDivision>(initialTemplateDivision);
  const certificateDivisionOptions = divisionsForOffice(certificateOffice);
  const certificateUnitOptions = unitsForOfficeDivision(certificateOffice, certificateDivision);
  const selectedPdfDivision = isTevDivision(certificateDivision)
    ? certificateDivision
    : templateDivision;

  function changeCertificateOffice(nextOffice: string) {
    const nextDivisions = divisionsForOffice(nextOffice);
    const nextDivision = nextDivisions[0] ?? "";
    const nextUnits = unitsForOfficeDivision(nextOffice, nextDivision);
    setCertificateOffice(nextOffice);
    setCertificateDivision(nextDivision);
    setCertificateUnit(nextUnits[0] ?? "");
    if (isTevDivision(nextDivision)) setTemplateDivision(nextDivision);
  }

  function changeCertificateDivision(nextDivision: string) {
    const nextUnits = unitsForOfficeDivision(certificateOffice, nextDivision);
    setCertificateDivision(nextDivision);
    setCertificateUnit(nextUnits[0] ?? "");
    if (isTevDivision(nextDivision)) setTemplateDivision(nextDivision);
  }
  return <section className="content-section form-section coa-form-section">
    <div className="section-heading"><div><p className="eyebrow">New record</p><h2>Create Certificate of Appearance</h2><p className="muted">Enter the event details and one or more attendees. Two certificates fit on each A4 page.</p></div><button type="button" className="ghost-button" onClick={onCancel}>Cancel</button></div>
    {error && <p className="coa-error" role="alert">{error}</p>}
    <form className="permit-form coa-form" onSubmit={onSubmit}>
      <label>Event&apos;s Title<input name="event-title" maxLength={240} required /></label>
      <label>Event&apos;s Destination<input name="destination" maxLength={180} required /></label>
      <div className="wide-field coa-date-range"><label>Event&apos;s Date (From)<input name="event-date-from" type="date" value={eventDateFrom} onChange={(event) => setEventDateFrom(event.target.value)} required /></label><span>to</span><label>Event&apos;s Date (To)<input name="event-date-to" type="date" min={eventDateFrom || undefined} required /></label></div>
      <div className="wide-field coa-certificate-scope-row" aria-label="Certificate Office, Certificate Division, and Certificate Unit / Program / Project">
        <label>Certificate Office<select name="certificate-office" value={certificateOffice} onChange={(event) => changeCertificateOffice(event.target.value)} required><option value="" disabled>Select an Office</option>{accountOfficeOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label>Certificate Division<select name="certificate-division" value={certificateDivision} onChange={(event) => changeCertificateDivision(event.target.value)} required><option value="" disabled>Select a Division</option>{certificateDivisionOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label>Certificate Unit / Program / Project<select name="certificate-unit" value={certificateUnit} onChange={(event) => setCertificateUnit(event.target.value)} required><option value="" disabled>Select a Unit / Program / Project</option>{certificateUnitOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      </div>
      <input type="hidden" name="division-name" value={selectedPdfDivision} />
      {!isTevDivision(certificateDivision) && <label className="wide-field">Certificate Template Signatory Division<select value={templateDivision} onChange={(event) => setTemplateDivision(event.target.value as TevDivision)} required>{tevDivisions.map((division) => <option key={division} value={division}>{division}</option>)}</select></label>}
      <fieldset className="wide-field coa-people-fieldset"><legend>Attendees</legend>{people.map((person, index) => <div className="coa-person-row" key={index}>
        <label>Name<input name="person-name" maxLength={160} value={person.name} onChange={(event) => setPeople((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} placeholder={`Person ${index + 1}`} required /></label>
        <label>Gender<select name="person-gender" value={person.gender} onChange={(event) => setPeople((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, gender: event.target.value as CertificateGender } : item))}><option value="" disabled>Select gender</option><option value="female">Female</option><option value="male">Male</option></select></label>
        <label>Office<input name="person-office" maxLength={180} value={person.office ?? ""} onChange={(event) => setPeople((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, office: event.target.value } : item))} required /></label>
        {people.length > 1 && <button type="button" className="remove-participant" aria-label={`Delete person ${index + 1}`} onClick={() => setPeople((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Delete</button>}
      </div>)}<button type="button" className="text-button plain-action add-item-text-button" onClick={() => setPeople((current) => [...current, newPerson()])}>+ Add person</button></fieldset>
      <div className="form-actions"><button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save"}</button></div>
    </form>
  </section>;
}

function CertificateNamesForm({ record, onCancel, onSubmit, saving, error }: { record: CertificateRecord; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; saving: boolean; error: string }) {
  const [people, setPeople] = useState<CertificatePerson[]>(() => record.people.map((person) => ({ ...person, gender: person.gender || "unspecified", office: person.office ?? record.office ?? "" })));
  return <section className="content-section form-section coa-form-section">
    <div className="section-heading"><div><p className="eyebrow">Edit record</p><h2>Edit attendees</h2><p className="muted">Update or add attendees for {record.eventTitle}.</p></div><button type="button" className="ghost-button" onClick={onCancel}>Cancel</button></div>
    {error && <p className="coa-error" role="alert">{error}</p>}
    <form className="permit-form coa-name-edit-form" onSubmit={onSubmit}>
      <fieldset className="wide-field coa-people-fieldset"><legend>Attendees</legend>{people.map((person, index) => <div className="coa-person-row" key={`${record.id}-${index}`}>
        <label>Name<input name="person-name" maxLength={160} value={person.name} onChange={(event) => setPeople((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} required /></label>
        <label>Gender<select name="person-gender" value={person.gender || "unspecified"} onChange={(event) => setPeople((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, gender: event.target.value as CertificateGender } : item))}><option value="unspecified">Unspecified</option><option value="female">Female</option><option value="male">Male</option></select></label>
        <label>Office<input name="person-office" maxLength={180} value={person.office ?? ""} onChange={(event) => setPeople((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, office: event.target.value } : item))} required /></label>
        {people.length > 1 && <button type="button" className="remove-participant" aria-label={`Delete person ${index + 1}`} onClick={() => setPeople((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Delete</button>}
      </div>)}<button type="button" className="text-button add-item-text-button" disabled={people.length >= 100} onClick={() => setPeople((current) => [...current, { ...newPerson(), gender: "unspecified", office: record.people[0]?.office ?? record.office ?? "" }])}>+ Add attendee</button></fieldset>
      <div className="form-actions"><button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save"}</button></div>
    </form>
  </section>;
}

function CertificatePaper({ record, person }: { record: CertificateRecord; person: CertificatePerson }) {
  const showApprovalSignature = hasFieldOperationsAppearanceApprovalSignature(record);
  const showDisapprovalStamp = certificateWorkflowStatus(record.status) === "Disapproved";
  const signatory = appearanceCertificateSignatory(record, record.signatoryName, record.designation);
  return <article className="coa-certificate-card">
    <img className="coa-letterhead" src={blankCertificateAsset} alt="" />
    <div className="coa-letterhead-header">
      <span>Republic of the Philippines</span>
      <strong>DEPARTMENT OF AGRICULTURE</strong>
      <span>Regional Field Office 13</span>
      <span>Capitol Site, Butuan City 8600</span>
    </div>
    <h1 className="coa-title">CERTIFICATE OF APPEARANCE</h1>
    <div className="coa-copy">
      <p>This is to certify that <strong className="coa-name">{person.name}</strong> of the <strong className="coa-office">{person.office ?? record.office}</strong> has attended the <strong><em>“{record.eventTitle}”</em></strong> held in <strong>{record.destination}</strong> on <strong>{eventDateRange(record.eventDateFrom ?? record.eventDate, record.eventDateTo ?? record.eventDateFrom ?? record.eventDate)}</strong>.</p>
      <p>This certification is issued upon the request of the above-named person for whatever legal purpose it may serve {pronoun(person.gender)} best.</p>
    </div>
    <div className={`coa-signatory-block${showApprovalSignature ? " is-approved" : ""}${showDisapprovalStamp ? " is-disapproved" : ""}`}>
      <CertificateDisapprovalStamp record={record} />
      <CertificateApprovalSignature record={record} />
      <footer className="coa-signatory"><strong>{signatory.name}</strong><div className="coa-signatory-role">{signatory.isProfileSignatory
        ? <em>{signatory.designation} / {signatory.position}</em>
        : <><em>{signatory.position},</em> <span>{certificateDivisionDisplayNames[record.division] ?? record.division}</span></>}</div></footer>
    </div>
  </article>;
}
