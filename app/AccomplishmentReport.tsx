"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type Ref } from "react";
import type { User } from "firebase/auth";
import { collection, deleteField, doc, getDoc, getDocs, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { accountDivision, accountOffice, accountOfficeOptions, accountUnit, divisionsForOffice, executiveOfficeDivisionOptions, fieldOperationsAssignments, unitsForOfficeDivision } from "@/lib/account-profile";
import { divisionSignatory, tevDivisions } from "@/lib/mytev";
import { loadPdfTools } from "@/lib/pdf-tools";
import { normalizeAccountRole, type AccountRole } from "@/lib/user-roles";
import RecordPagination, { useRecordPagination } from "./RecordPagination";
import "./myar.css";

type Unit = string;
type Profile = { name: string; position: string; unit: Unit; immediateSupervisor: string; fullSignatureURL: string };
type Report = {
  id: string;
  ownerId: string;
  month: string;
  cycle: 1 | 2;
  startDay: number;
  endDay: number;
  activities: string[];
  unit: Unit;
  preparedName: string;
  preparedPosition: string;
  affixSignature?: "Yes" | "No";
  affixSignatureURL?: string;
  affixSignatureName?: string;
  affixSignatureAt?: unknown;
  signatoryName?: string;
  signatoryPosition?: string;
  signatoryDivision?: string;
  createdAt?: unknown;
};

const MAX_ACTIVITIES = 30;
const asset = (path: string) => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
const arDivisionSignatoryNameOverrides: Partial<Record<(typeof tevDivisions)[number], string>> = {
  "Agribusiness and Marketing Assistance Division": "Lynn A. Pare\u00f1as",
  "Integrated Laboratories Division": "Esther B. Carde\u00f1o, DVM",
  "Regional Agricultural Engineering Division": "Rene Q. Morales, RPAE",
};
const arSignatoryOptions = [
  ...tevDivisions.map((division) => {
    const signatory = divisionSignatory(division);
    return {
      value: `division:${division}`,
      label: division,
      name: arDivisionSignatoryNameOverrides[division] ?? signatory.name,
      position: signatory.position,
      division,
    };
  }),
  ...[
    { designation: "Regional Executive Director", name: "ENGR. RICARDO M. O\u00d1ATE JR." },
    { designation: "RTD for Operations", name: "REBECCA R. ATEGA" },
    { designation: "RTD for Research and Regulations", name: "MARCO ANTONIO C. MORIDO" },
  ].map((signatory) => ({
    value: `role:${signatory.designation}`,
    label: signatory.designation,
    name: signatory.name,
    position: signatory.designation,
    division: "",
  })),
].sort((first, second) => first.label.localeCompare(second.label));
const legacyNotedSignatory = { name: "MELODY M. GUIMARY", position: "Chief", division: "Field Operations Division" };
const reportUnits = new Set([
  ...accountOfficeOptions.flatMap((office) => divisionsForOffice(office).flatMap((division) => unitsForOfficeDivision(office, division))),
  ...fieldOperationsAssignments,
  ...tevDivisions,
  ...executiveOfficeDivisionOptions,
  "Regional Executive Director",
]);
const isReportUnit = (value: string): value is Unit => reportUnits.has(value);

function defaultImmediateSupervisor(office: string, division: string, assignment: string, accountRole: AccountRole) {
  const isAdmin = accountRole !== "regular";
  if (office === "Division") {
    if (division === "Field Operations Division") return "division:Field Operations Division";
    if (division === "Agribusiness and Marketing Assistance Division" || division === "Regional Agricultural Engineering Division") {
      return isAdmin ? "role:RTD for Operations" : `division:${division}`;
    }
    if (["Research Division", "Integrated Laboratories Division", "Regulatory Division"].includes(division)) {
      return isAdmin ? "role:RTD for Research and Regulations" : `division:${division}`;
    }
    if (["Planning, Monitoring and Evaluation Division", "Administrative Division", "Finance Division"].includes(division)) {
      return isAdmin ? "role:Regional Executive Director" : `division:${division}`;
    }
    return `division:${division}`;
  }
  if (office === "Office of the Regional Executive Director") {
    if (division === "Office of the Regional Executive Director") return "role:Regional Executive Director";
    if (division === "RTD for Operations") return isAdmin ? "role:Regional Executive Director" : "role:RTD for Operations";
    if (division === "RTD for Research and Regulations") return isAdmin ? "role:Regional Executive Director" : "role:RTD for Research and Regulations";
  }
  if (office === "Field Operations Division" && fieldOperationsAssignments.includes(assignment as (typeof fieldOperationsAssignments)[number])) return "division:Field Operations Division";

  if (office === "Regional Field Office") {
    if (assignment === "Field Operations Division") return isAdmin ? "role:RTD for Operations" : "division:Field Operations Division";
    if (assignment === "Agribusiness and Marketing Assistance Division" || assignment === "Regional Agricultural Engineering Division") {
      return isAdmin ? "role:RTD for Operations" : `division:${assignment}`;
    }
    if (assignment === "RTD for Operations") return isAdmin ? "role:Regional Executive Director" : "role:RTD for Operations";
    if (assignment === "RTD for Research and Regulations") return isAdmin ? "role:Regional Executive Director" : "role:RTD for Research and Regulations";
    if (["Research Division", "Integrated Laboratories Division", "Regulatory Division"].includes(assignment)) {
      return isAdmin ? "role:RTD for Research and Regulations" : `division:${assignment}`;
    }
    if (["Planning, Monitoring and Evaluation Division", "Administrative Division", "Finance Division"].includes(assignment)) {
      return isAdmin ? "role:Regional Executive Director" : `division:${assignment}`;
    }
    if (assignment === "Regional Executive Director") return "role:Regional Executive Director";
  }

  if (tevDivisions.includes(assignment as (typeof tevDivisions)[number])) return `division:${assignment}`;
  if (["Regional Executive Director", "RTD for Operations", "RTD for Research and Regulations"].includes(assignment)) return `role:${assignment}`;
  return "division:Field Operations Division";
}

function manilaDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
}

function lastDayOfMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return year && monthNumber ? new Date(year, monthNumber, 0).getDate() : 31;
}

function reportEditDeadline(report: Pick<Report, "month" | "cycle">) {
  const [year, monthNumber] = report.month.split("-").map(Number);
  if (!year || !monthNumber || monthNumber < 1 || monthNumber > 12) return "0000-00-00";
  const cycleEndDay = report.cycle === 1 ? 15 : lastDayOfMonth(report.month);
  return new Date(Date.UTC(year, monthNumber - 1, cycleEndDay + 6)).toISOString().slice(0, 10);
}

function isReportEditingLocked(report: Pick<Report, "month" | "cycle">, today = manilaDateKey()) {
  return today >= reportEditDeadline(report);
}

function reportEditDeadlineLabel(report: Pick<Report, "month" | "cycle">) {
  const [year, month, day] = reportEditDeadline(report).split("-").map(Number);
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

function monthName(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return year && monthNumber
    ? new Intl.DateTimeFormat("en-PH", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, monthNumber - 1, 1)))
    : "";
}

function reportPeriod(report: Pick<Report, "month" | "startDay" | "endDay">) {
  const [year] = report.month.split("-");
  return `${monthName(report.month)} ${report.startDay}-${report.endDay}, ${year}`;
}

function reportMonth(month: string) {
  return `${monthName(month)} ${month.split("-")[0]}`;
}

function reportUnit(unit: Unit) {
  const unitNames: Partial<Record<Unit, string>> = {
    AMIA: "Adaptation Initiative and Mitigation in Agriculture - Caraga",
    AGRISTAT: "Agricultural Statistics - Caraga",
    DRRM: "Disaster Risk Reduction and Management - Caraga",
  };
  return unitNames[unit as keyof typeof unitNames]
    ?? (fieldOperationsAssignments.includes(unit as (typeof fieldOperationsAssignments)[number]) ? "Field Operations Division" : unit);
}

function applyCurrentProfile(report: Report, profile: Profile | null): Report {
  return profile ? {
    ...report,
    unit: profile.unit,
    preparedName: profile.name,
    preparedPosition: profile.position,
  } : report;
}

function supervisorSelectionForReport(report: Report) {
  if (report.signatoryDivision) return `division:${report.signatoryDivision}`;
  if (["Regional Executive Director", "RTD for Operations", "RTD for Research and Regulations"].includes(report.signatoryPosition ?? "")) {
    return `role:${report.signatoryPosition}`;
  }
  return "division:Field Operations Division";
}

function createdTime(value: unknown) {
  if (value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") return value.toMillis() as number;
  return value instanceof Date ? value.getTime() : 0;
}

function signatureDate(value: unknown) {
  const millis = createdTime(value);
  if (!millis) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(millis));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}.${part("month")}.${part("day")}`;
}

function signatureTime(value: unknown) {
  const millis = createdTime(value);
  return millis ? `${new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(millis))} +0800` : "";
}

function AccomplishmentReportNotedSignatory({ report }: { report: Report }) {
  const signatory = {
    name: report.signatoryName || legacyNotedSignatory.name,
    position: report.signatoryPosition || legacyNotedSignatory.position,
    division: report.signatoryName ? report.signatoryDivision ?? "" : legacyNotedSignatory.division,
  };
  return <div><strong>{signatory.name.toLocaleUpperCase("en-PH")}</strong><span><em>{signatory.position}</em>{signatory.division ? `, ${signatory.division}` : ""}</span></div>;
}

function AccomplishmentReportDocument({ report, pageRef }: { report: Report; pageRef?: Ref<HTMLElement> }) {
  const estimatedActivityLines = report.activities.reduce((total, activity) => total + activity.split(/\r?\n/).reduce((lineTotal, line) => lineTotal + Math.max(1, Math.ceil(line.length / 90)), 0), 0);
  const activityDensity = Math.min(1, Math.max(0, (estimatedActivityLines - 5) / 25));
  const documentStyle = {
    "--ar-unit-top": `${5.1 - activityDensity * 3.4}cqi`,
    "--ar-activity-top": `${3.3 - activityDensity * 2.5}cqi`,
  } as CSSProperties;
  return <article ref={pageRef} className="ar-document">
    <img className="ar-document-letterhead" src={asset("/Document-Header-Footer.jpg")} alt="" />
    <div className="ar-document-content" style={documentStyle}>
      <header className="ar-document-heading"><h1>ACCOMPLISHMENT REPORT</h1><p>{reportPeriod(report)}</p></header>
      <p className="ar-document-unit">{reportUnit(report.unit)}</p>
      <ol className="ar-document-activities">{report.activities.map((activity, index) => <li key={`${index}-${activity}`}>{activity}</li>)}</ol>
      <section className={`ar-document-prepared${report.affixSignature === "Yes" && report.affixSignatureURL ? " has-affixed-signature" : ""}`}><p>Prepared:</p>{report.affixSignature === "Yes" && report.affixSignatureURL && <div className="ar-document-digital-signature"><img src={report.affixSignatureURL} crossOrigin="anonymous" alt={`Digital signature of ${report.affixSignatureName || report.preparedName}`} /><div><span>Digitally Signed By</span><strong>{(report.affixSignatureName || report.preparedName).toLocaleUpperCase("en-PH")}</strong><small>Date: {signatureDate(report.affixSignatureAt)}</small><small>Time: {signatureTime(report.affixSignatureAt)}</small></div></div>}<div className="ar-document-prepared-name"><strong>{report.preparedName.toLocaleUpperCase("en-PH")}</strong><em>{report.preparedPosition}</em></div></section>
      <section className="ar-document-noted"><p>Noted:</p><AccomplishmentReportNotedSignatory report={report} /></section>
    </div>
  </article>;
}

function AccomplishmentReportPreview({ report, onClose }: { report: Report; onClose: () => void }) {
  const pageRef = useRef<HTMLElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  async function downloadPdf() {
    const page = pageRef.current;
    if (!page) return;
    setDownloading(true);
    setDownloadError("");
    try {
      const { html2canvas, jsPDF } = await loadPdfTools();
      await Promise.all(Array.from(page.querySelectorAll("img")).map(async (image) => {
        if (!image.complete) await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("The accomplishment report letterhead could not be loaded."));
        });
        if (image.naturalWidth === 0) throw new Error("The accomplishment report letterhead could not be loaded.");
        if (image.decode) await image.decode();
      }));
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const canvas = await html2canvas(page, { backgroundColor: "#fff", logging: false, scale: 3, useCORS: true });
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.96), "JPEG", 0, 0, 210, 297);
      pdf.save(`myar-${report.month}-${report.startDay}-${report.endDay}.pdf`);
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause.message : "Unable to create the accomplishment report PDF.");
    } finally {
      setDownloading(false);
    }
  }

  return <div className="ar-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="ar-preview-window" role="dialog" aria-modal="true" aria-label="Accomplishment report preview">
      <div className="ar-preview-actions">
        <button type="button" className="ghost-button" onClick={onClose}>Close</button>
        <button type="button" className="pdf-button" disabled={downloading} onClick={downloadPdf}>{downloading ? "Preparing PDF..." : "Download PDF"}</button>
        <button type="button" className="pdf-button" onClick={() => window.print()}>Print</button>
        {downloadError && <small className="download-error" role="alert">{downloadError}</small>}
      </div>
      <AccomplishmentReportDocument report={report} pageRef={pageRef} />
    </div>
  </div>;
}

export default function AccomplishmentReportModule({ user, focusMonth, focusCycle, onFocusHandled, onPreviewClose }: { user: User; focusMonth?: string; focusCycle?: 1 | 2; onFocusHandled?: () => void; onPreviewClose?: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const { currentPage, pageCount, visibleRecords, setPage } = useRecordPagination(reports);
  const [showForm, setShowForm] = useState(false);
  const [month, setMonth] = useState("");
  const [cycle, setCycle] = useState<1 | 2 | "">("");
  const [activities, setActivities] = useState([""]);
  const [draggedActivityIndex, setDraggedActivityIndex] = useState<number | null>(null);
  const [dropActivityIndex, setDropActivityIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updatingAffixSignatureId, setUpdatingAffixSignatureId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  const [editingReport, setEditingReport] = useState<Report | null>(null);
  const handledFocusPeriodRef = useRef<string | null>(null);
  const [signatorySelection, setSignatorySelection] = useState("");
  const [today, setToday] = useState(manilaDateKey);
  const lastDay = lastDayOfMonth(month);
  const startDay = cycle === 1 ? 1 : cycle === 2 ? 16 : 0;
  const endDay = cycle === 1 ? 15 : cycle === 2 ? lastDay : 0;
  const preparedProfile = profile;
  const selectedSignatory = arSignatoryOptions.find((option) => option.value === signatorySelection);
  const previewReport = selectedReport ? applyCurrentProfile(selectedReport, profile) : null;
  const duplicateReport = !editingReport && reports.some((report) => report.month === month && report.cycle === cycle);

  useEffect(() => {
    if (showForm && !editingReport && profile?.immediateSupervisor && signatorySelection !== profile.immediateSupervisor) {
      setSignatorySelection(profile.immediateSupervisor);
    }
  }, [showForm, editingReport, profile, signatorySelection]);

  useEffect(() => {
    const refreshDate = () => setToday(manilaDateKey());
    const interval = window.setInterval(refreshDate, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  function startNewReport() {
    setEditingReport(null);
    setSignatorySelection(profile?.immediateSupervisor ?? "");
    setMonth("");
    setCycle("");
    setActivities([""]);
    setMessage(null);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function editActivities(report: Report) {
    if (isReportEditingLocked(report)) {
      setMessage({ kind: "error", text: `Editing closed on ${reportEditDeadlineLabel(report)}. This report's activities can no longer be changed.` });
      return;
    }
    setEditingReport(report);
    setSignatorySelection(supervisorSelectionForReport(report));
    setMonth(report.month);
    setCycle(report.cycle);
    setActivities([...report.activities]);
    setMessage(null);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEdit() {
    setEditingReport(null);
    setSignatorySelection("");
    setMonth("");
    setCycle("");
    setActivities([""]);
    setMessage(null);
    setShowForm(false);
  }

  function reorderActivity(sourceIndex: number, targetIndex: number) {
    setActivities((current) => {
      if (sourceIndex < 0 || sourceIndex >= current.length || targetIndex < 0 || targetIndex >= current.length || sourceIndex === targetIndex) return current;
      const reordered = [...current];
      const [activity] = reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, activity);
      return reordered;
    });
  }

  useEffect(() => {
    let current = true;
    let profileLoaded = false;
    let reportsLoaded = false;
    const updateLoading = () => {
      if (current) setLoading(!(profileLoaded && reportsLoaded));
    };

    function load() {
      if (!db) {
        setMessage({ kind: "error", text: "Database is not configured." });
        setLoading(false);
        return () => { current = false; };
      }
      setLoading(true);
      const unsubscribeProfile = onSnapshot(doc(db, "users", user.uid), (profileSnapshot) => {
        if (!current) return;
        const data = profileSnapshot.data();
        const division = data ? accountDivision(data) : "";
        const assignment = data ? accountUnit(data) || division : "";
        const office = data ? accountOffice(data) ?? "" : "";
        const accountRole = normalizeAccountRole(data?.accountRole, user.email);
        if (profileSnapshot.exists() && data && typeof data.name === "string" && typeof data.position === "string" && isReportUnit(assignment)) {
          setProfile({ name: data.name, position: data.position, unit: assignment, immediateSupervisor: defaultImmediateSupervisor(office, division, assignment, accountRole), fullSignatureURL: typeof data.fullSignatureURL === "string" ? data.fullSignatureURL : "" });
        } else {
          setProfile(null);
        }
        profileLoaded = true;
        updateLoading();
      }, (cause) => {
        if (!current) return;
        setProfile(null);
        profileLoaded = true;
        setMessage({ kind: "error", text: cause instanceof Error ? `Could not load your profile. ${cause.message}` : "Could not load your profile. Try again." });
        updateLoading();
      });

      getDocs(query(collection(db, "accomplishmentReports"), where("ownerId", "==", user.uid))).then((reportSnapshot) => {
        if (!current) return;
        const ownReports = reportSnapshot.docs.map((snapshot) => ({ id: snapshot.id, ...snapshot.data() } as Report));
        ownReports.sort((left, right) => right.month.localeCompare(left.month) || right.cycle - left.cycle || createdTime(right.createdAt) - createdTime(left.createdAt));
        setReports(ownReports);
        reportsLoaded = true;
        updateLoading();
      }).catch((cause) => {
        if (!current) return;
        setMessage({ kind: "error", text: cause instanceof Error ? `Could not load your reports. ${cause.message}` : "Could not load your reports. Try again." });
        reportsLoaded = true;
        updateLoading();
      });

      return () => unsubscribeProfile();
    }
    const unsubscribe = load();
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [user.uid]);

  useEffect(() => {
    if (!focusMonth || !focusCycle) { handledFocusPeriodRef.current = null; return; }
    const focusPeriod = `${focusMonth}:${focusCycle}`;
    if (handledFocusPeriodRef.current === focusPeriod || loading) return;
    handledFocusPeriodRef.current = focusPeriod;
    const existing = reports.find((report) => report.month === focusMonth && report.cycle === focusCycle);
    if (existing) {
      setSelectedReport(existing);
    } else {
      setEditingReport(null);
      setSelectedReport(null);
      setSignatorySelection(profile?.immediateSupervisor ?? "");
      setMonth(focusMonth);
      setCycle(focusCycle);
      setActivities([""]);
      setMessage(null);
      setShowForm(true);
    }
    onFocusHandled?.();
  }, [focusCycle, focusMonth, loading, onFocusHandled, profile, reports]);

  async function saveReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    if (editingReport && isReportEditingLocked(editingReport)) {
      setEditingReport(null);
      setActivities([""]);
      setShowForm(false);
      setMessage({ kind: "error", text: `Editing closed on ${reportEditDeadlineLabel(editingReport)}. This report's activities can no longer be changed.` });
      return;
    }
    if (!db) {
      setMessage({ kind: "error", text: "Database is not configured." });
      return;
    }
    if (!month || cycle === "") {
      setMessage({ kind: "error", text: "Select a month and half-month cycle." });
      return;
    }
    if (!editingReport && reports.some((report) => report.month === month && report.cycle === cycle)) {
      setMessage({ kind: "error", text: `A report for ${reportPeriod({ month, startDay, endDay })} is already saved. Edit the existing report instead.` });
      return;
    }
    if (!preparedProfile?.name.trim() || !preparedProfile.position.trim() || !preparedProfile.unit) {
      setMessage({ kind: "error", text: "Complete your name, position, Division, and Unit / Program / Project in Profile before creating a report." });
      return;
    }
    const cleanActivities = activities.map((activity) => activity.trim());
    if (cleanActivities.length === 0 || cleanActivities.length > MAX_ACTIVITIES || cleanActivities.some((activity) => !activity)) {
      setMessage({ kind: "error", text: `Enter at least one activity. Each activity is required, up to ${MAX_ACTIVITIES}.` });
      return;
    }
    setSaving(true);
    try {
      if (editingReport) {
        await updateDoc(doc(db, "accomplishmentReports", editingReport.id), { activities: cleanActivities });
        setReports((current) => current.map((report) => report.id === editingReport.id ? { ...report, activities: cleanActivities } : report));
        setEditingReport(null);
        setActivities([""]);
        setShowForm(false);
        setMessage({ kind: "success", text: "Report activities updated." });
        return;
      }
      if (!selectedSignatory) {
        setMessage({ kind: "error", text: "Select an immediate supervisor." });
        return;
      }
      const data = {
        ownerId: user.uid,
        month,
        cycle,
        startDay,
        endDay,
        activities: cleanActivities,
        unit: preparedProfile.unit,
        preparedName: preparedProfile.name.trim().replace(/\s+/g, " "),
        preparedPosition: preparedProfile.position.trim().replace(/\s+/g, " "),
        signatoryName: selectedSignatory.name,
        signatoryPosition: selectedSignatory.position,
        signatoryDivision: selectedSignatory.division,
        affixSignature: "No" as const,
        createdAt: serverTimestamp(),
      };
      const reportId = `${user.uid}_${month}_${cycle === 1 ? "first" : "second"}`;
      const reportReference = doc(db, "accomplishmentReports", reportId);
      await setDoc(reportReference, data);
      const saved = { ...data, id: reportId, createdAt: undefined } as Report;
      setReports((current) => [saved, ...current].sort((left, right) => right.month.localeCompare(left.month) || right.cycle - left.cycle));
      setActivities([""]);
      setShowForm(false);
      setMessage({ kind: "success", text: "Accomplishment report saved." });
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error ? `Could not ${editingReport ? "update the report activities" : "save this report"}. ${cause.message}` : `Could not ${editingReport ? "update the report activities" : "save this report"}. Try again.` });
    } finally {
      setSaving(false);
    }
  }

  async function updateAffixSignature(report: Report, value: "Yes" | "No") {
    if (!db) {
      setMessage({ kind: "error", text: "Database is not configured." });
      return;
    }
    if (value === "Yes" && (!profile?.fullSignatureURL.trim() || !profile.name.trim())) {
      setMessage({ kind: "error", text: "Upload your Full Signature in Profile before affixing it to a report." });
      return;
    }

    setUpdatingAffixSignatureId(report.id);
    setMessage(null);
    const signatureFields = value === "Yes"
      ? {
          affixSignature: "Yes" as const,
          affixSignatureURL: profile!.fullSignatureURL.trim(),
          affixSignatureName: profile!.name.trim(),
          affixSignatureAt: serverTimestamp(),
        }
      : {
          affixSignature: "No" as const,
          affixSignatureURL: deleteField(),
          affixSignatureName: deleteField(),
          affixSignatureAt: deleteField(),
        };
    try {
      await updateDoc(doc(db, "accomplishmentReports", report.id), signatureFields);
      let updatedReport: Report = value === "Yes"
        ? { ...report, affixSignature: "Yes", affixSignatureURL: profile!.fullSignatureURL.trim(), affixSignatureName: profile!.name.trim(), affixSignatureAt: new Date() }
        : { ...report, affixSignature: "No", affixSignatureURL: undefined, affixSignatureName: undefined, affixSignatureAt: undefined };
      try {
        const savedReport = await getDoc(doc(db, "accomplishmentReports", report.id));
        if (savedReport.exists()) updatedReport = { id: report.id, ...savedReport.data() } as Report;
      } catch {
        // The successful update remains usable with the local timestamp fallback.
      }
      setReports((current) => current.map((item) => item.id === report.id ? updatedReport : item));
      setSelectedReport((current) => current?.id === report.id ? updatedReport : current);
      setMessage({ kind: "success", text: value === "Yes" ? "Signature affixed to this report." : "Signature removed from this report." });
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error ? `Could not update the report signature. ${cause.message}` : "Could not update the report signature. Try again." });
    } finally {
      setUpdatingAffixSignatureId(null);
    }
  }

  return <div className="ar-module">
    {showForm && <section className="content-section ar-entry-section">
      <div className="section-heading"><div><p className="eyebrow">{editingReport ? "myAR · Edit activities" : "myAR · Data entry"}</p><h2>{editingReport ? "Edit Report Activities" : "Accomplishment Report"}</h2><p className="muted">{editingReport ? "Update the activities for this saved report." : "Enter the reporting period and activities. Your profile details fill the report automatically."}</p></div><button type="button" className="ghost-button" disabled={saving} onClick={cancelEdit}>{editingReport ? "Cancel Edit" : "Cancel"}</button></div>
      {message && <p className={`auth-message auth-message-${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
      {loading ? <p className="muted">Loading your profile and reports…</p> : !preparedProfile ? <div className="ar-profile-notice"><strong>Profile details needed</strong><p>Add your name, position, Division, and Unit / Program / Project in Profile to prepare an accomplishment report.</p><button type="button" className="ghost-button" onClick={cancelEdit}>Back to Saved Reports</button></div> : <>
        <form className="ar-form" onSubmit={saveReport}>
          <div className="ar-form-fields">
            <label>Month<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} required disabled={!!editingReport} /></label>
            <label>Half-month Cycle<select value={cycle} onChange={(event) => setCycle(event.target.value ? Number(event.target.value) as 1 | 2 : "")} disabled={!!editingReport} required><option value="" disabled>Select a half-month cycle</option><option value={1}>1–15</option><option value={2}>16–{lastDay}</option></select></label>
            <label>Immediate Supervisor<select value={signatorySelection} disabled><option value="" disabled>Selecting from Profile…</option><optgroup label="Divisions">{arSignatoryOptions.filter((option) => option.value.startsWith("division:")).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup><optgroup label="Regional Officials">{arSignatoryOptions.filter((option) => option.value.startsWith("role:")).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup></select></label>
          </div>
          {duplicateReport && <p className="auth-message auth-message-error" role="status">A report for {reportPeriod({ month, startDay, endDay })} is already saved. Edit it from Saved Reports.</p>}
          <fieldset className="ar-activities-entry"><legend>Activities</legend><p id="ar-reorder-hint" className="ar-reorder-hint">Drag the grip to rearrange activities, or focus a grip and press Alt + Up or Alt + Down.</p><div className="ar-activity-list">{activities.map((activity, index) => <div className={`ar-activity-entry${draggedActivityIndex === index ? " is-dragging" : ""}${dropActivityIndex === index ? " is-drop-target" : ""}`} key={index} onDragOver={(event) => { event.preventDefault(); setDropActivityIndex(index); }} onDragLeave={() => setDropActivityIndex((current) => current === index ? null : current)} onDrop={(event) => { event.preventDefault(); const draggedValue = event.dataTransfer.getData("text/plain"); setDraggedActivityIndex(null); setDropActivityIndex(null); if (!/^\d+$/.test(draggedValue)) return; const draggedIndex = Number(draggedValue); const bounds = event.currentTarget.getBoundingClientRect(); const insertAfter = event.clientY >= bounds.top + bounds.height / 2; const insertionIndex = index + (insertAfter ? 1 : 0); reorderActivity(draggedIndex, draggedIndex < insertionIndex ? insertionIndex - 1 : insertionIndex); }}><button type="button" className="ar-drag-activity" draggable aria-label={`Reorder activity ${index + 1}`} aria-describedby="ar-reorder-hint" onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(index)); setDraggedActivityIndex(index); }} onDragEnd={() => { setDraggedActivityIndex(null); setDropActivityIndex(null); }} onKeyDown={(event) => { if (event.altKey && event.key === "ArrowUp" && index > 0) { event.preventDefault(); reorderActivity(index, index - 1); } else if (event.altKey && event.key === "ArrowDown" && index < activities.length - 1) { event.preventDefault(); reorderActivity(index, index + 1); } }}><svg className="ar-drag-grip" viewBox="0 0 12 20" aria-hidden="true"><circle cx="3" cy="3" r="1.7"/><circle cx="9" cy="3" r="1.7"/><circle cx="3" cy="10" r="1.7"/><circle cx="9" cy="10" r="1.7"/><circle cx="3" cy="17" r="1.7"/><circle cx="9" cy="17" r="1.7"/></svg></button><label htmlFor={`ar-activity-${index}`}>Activity {index + 1}<textarea id={`ar-activity-${index}`} value={activity} maxLength={1200} rows={2} onChange={(event) => setActivities((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder="Describe the activity or accomplishment" required /></label><div className="ar-activity-actions">{activities.length > 1 && <button type="button" className="ar-remove-activity" aria-label={`Delete activity ${index + 1}`} onClick={() => setActivities((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Delete</button>}</div></div>)}</div>{activities.length < MAX_ACTIVITIES && <button type="button" className="text-button plain-action add-item-text-button ar-add-activity" onClick={() => setActivities((current) => [...current, ""])}>+ Add activity</button>}</fieldset>
          <div className="form-actions ar-form-actions"><button className="primary-button" disabled={saving || duplicateReport}>{saving ? "Saving..." : editingReport ? "Update" : "Save"}</button></div>
        </form>
      </>}
    </section>}

    {!showForm && <section className="content-section ar-records-section">
      <div className="section-heading"><div><p className="eyebrow">Your records</p><h2>Saved Reports</h2><p className="muted">{reports.length} {reports.length === 1 ? "report" : "reports"} saved to your account.</p></div><button type="button" className="primary-button ar-add-report-button document-create-action" onClick={startNewReport}>Add</button></div>
      {message && <p className={`auth-message auth-message-${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
      {loading ? <p className="muted">Loading reports...</p> : reports.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No accomplishment reports yet</h3><p>Saved reports will appear here.</p></div> : <div className="permit-table ar-saved-table"><RecordPagination totalRecords={reports.length} currentPage={currentPage} pageCount={pageCount} onPageChange={setPage} label="Saved Report" /><div className="table-head"><span>Month</span><span>Half-month Cycle</span><span>Affix Signature</span><span aria-hidden="true" /></div>{visibleRecords.map((report) => <div className="table-row" key={report.id}><strong>{reportMonth(report.month)}</strong><span>{report.startDay}-{report.endDay}</span><label className="ar-record-affix"><select className="affix-signature-select" aria-label={`Affix signature for ${reportMonth(report.month)} ${report.startDay}-${report.endDay}`} value={report.affixSignature === "Yes" ? "Yes" : "No"} disabled={updatingAffixSignatureId === report.id} onChange={(event) => { if (event.target.value === "Yes" || event.target.value === "No") void updateAffixSignature(report, event.target.value); }}><option value="Yes" disabled={!profile?.fullSignatureURL.trim()}>Yes</option><option value="No">No</option></select></label><div className="ar-record-actions">{isReportEditingLocked(report, today) ? <span className="row-action ar-record-closed" title={`Editing closed on ${reportEditDeadlineLabel(report)}.`}>Closed</span> : <button type="button" className="row-action" onClick={() => editActivities(report)}>Edit</button>}<button type="button" className="row-action" onClick={() => setSelectedReport(report)}>View</button></div></div>)}</div>}
    </section>}

    {previewReport && <AccomplishmentReportPreview report={previewReport} onClose={() => { setSelectedReport(null); onPreviewClose?.(); }} />}
  </div>;
}
