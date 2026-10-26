"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { addDoc, collection, deleteDoc, doc, getDocs, query, serverTimestamp, updateDoc, where, writeBatch } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "@/lib/firebase";
import { loadPdfTools } from "@/lib/pdf-tools";
import { CertificateStatusBadge, certificateWorkflowStatus, type CertificateWorkflowFields } from "./CertificateWorkflow";
import DeleteConfirmation from "./DeleteConfirmation";
import "./participation.css";
import "./participation-amia.css";
import "./participation-drrm.css";
import "./certificate-workflow.css";

type ParticipationUnit = "AMIA" | "AGRISTAT" | "DRRM";
type ParticipantGender = "female" | "male";
type ParticipantDetails = { name: string; gender: ParticipantGender };
type ParticipantDraft = { name: string; gender: ParticipantGender | "" };
type ParticipationRecord = CertificateWorkflowFields & {
  id: string;
  unit: ParticipationUnit;
  participantNames?: string[];
  participantGenders?: ParticipantGender[];
  participantName?: string;
  eventTitle: string;
  eventDateFrom: string;
  eventDateTo: string;
  eventDestination: string;
  distributionDate?: string;
  distributionSameAsDestination: boolean;
  distributionPlace: string;
  ownerId: string;
  createdAt?: { toMillis?: () => number };
};

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const amiaBlankTemplate = `${basePath}/AMIA%20Certificate%20-%20Blank.jpg`;
const agristatBlankTemplate = `${basePath}/participation-agristat-blank.png`;
const drrmBlankTemplate = `${basePath}/drrm-participation-blank-but-with-logos.jpg`;
const bagongPilipinasLogo = `${basePath}/bagong-pilipinas-logo.webp`;
const daCaragaLogo = `${basePath}/da-caraga-logo.jpg`;
const importTemplate = `${basePath}/Participation_Importing_Template.xlsx`;
const MAX_PARTICIPANTS = 100;

function containedImageLayout(image: HTMLImageElement) {
  const parent = image.offsetParent;
  if (!parent || !image.naturalWidth || !image.naturalHeight) return null;

  const imageBounds = image.getBoundingClientRect();
  const parentBounds = parent.getBoundingClientRect();
  const scale = Math.min(imageBounds.width / image.naturalWidth, imageBounds.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;

  return {
    left: imageBounds.left - parentBounds.left + (imageBounds.width - width) / 2,
    top: imageBounds.top - parentBounds.top + (imageBounds.height - height) / 2,
    width,
    height,
  };
}

function participantDetails(record: ParticipationRecord): ParticipantDetails[] {
  const names = record.participantNames?.map((name) => String(name).trim()).filter(Boolean) ?? [];
  if (names.length) return names.map((name, index) => ({ name, gender: record.participantGenders?.[index] ?? "female" }));
  return record.participantName?.trim() ? [{ name: record.participantName.trim(), gender: "female" }] : [];
}

function participantNames(record: ParticipationRecord) {
  return participantDetails(record).map((person) => person.name);
}

function displayDate(value: string) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-PH", { month: "long", day: "numeric", year: "numeric" }).format(date);
}

function displayDateRange(from: string, to: string) {
  if (!from) return displayDate(to);
  if (!to || from === to) return displayDate(from);
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return `${displayDate(from)} - ${displayDate(to)}`;
  const month = new Intl.DateTimeFormat("en-PH", { month: "long" });
  const startMonth = month.format(start);
  const endMonth = month.format(end);
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${startMonth} ${start.getDate()} - ${end.getDate()}, ${end.getFullYear()}`;
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${displayDate(from)} - ${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${displayDate(from)} - ${displayDate(to)}`;
}

function ordinalDay(value: string) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return <strong>{displayDate(value)}</strong>;
  const day = date.getDate();
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  const month = new Intl.DateTimeFormat("en-PH", { month: "long" }).format(date);
  return <><strong>{day}<sup className="participation-ordinal-suffix">{suffix}</sup></strong> day of <strong>{month} {date.getFullYear()}</strong></>;
}

export default function ParticipationCertificate({ user, canCreateFodCertificateTemplates, focusRecordId, onFocusHandled }: { user: User; canCreateFodCertificateTemplates: boolean; focusRecordId?: string; onFocusHandled?: () => void }) {
  const [records, setRecords] = useState<ParticipationRecord[]>([]);
  const [view, setView] = useState<"list" | "new" | "edit">("list");
  const [editingRecord, setEditingRecord] = useState<ParticipationRecord | null>(null);
  const [preview, setPreview] = useState<ParticipationRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ParticipationRecord | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [error, setError] = useState("");
  const handledFocusIdRef = useRef<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!db) {
      setLoading(false);
      setError("Participation certificate storage is unavailable.");
      return;
    }
    getDocs(query(collection(db, "participationCertificates"), where("ownerId", "==", user.uid)))
      .then((snapshot) => {
        const loaded = snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as ParticipationRecord));
        loaded.sort((first, second) => (second.createdAt?.toMillis?.() ?? 0) - (first.createdAt?.toMillis?.() ?? 0));
        setRecords(loaded);
      })
      .catch((cause) => {
        const code = (cause as { code?: string }).code;
        setError(code ? `Could not load participation certificates (${code}).` : "Could not load participation certificates. Refresh and try again.");
      })
      .finally(() => setLoading(false));
  }, [user.uid]);

  useEffect(() => {
    if (!focusRecordId) { handledFocusIdRef.current = null; return; }
    if (handledFocusIdRef.current === focusRecordId || loading) return;
    const record = records.find((item) => item.id === focusRecordId);
    if (!record) return;
    handledFocusIdRef.current = focusRecordId;
    setPreview(record);
    setError("");
    onFocusHandled?.();
  }, [focusRecordId, loading, onFocusHandled, records]);

  async function deleteRecord(record: ParticipationRecord) {
    if (!db || certificateWorkflowStatus(record.status) === "Approved") return;
    setDeletingId(record.id);
    setError("");
    try {
      await deleteDoc(doc(db, "participationCertificates", record.id));
      setRecords((current) => current.filter((item) => item.id !== record.id));
      setPreview((current) => current?.id === record.id ? null : current);
      setPendingDelete(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete the Participation Certificate (${code}).` : "Could not delete the Participation Certificate.");
      setPendingDelete(null);
    } finally {
      setDeletingId(null);
    }
  }

  async function saveParticipation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!canCreateFodCertificateTemplates) {
      setError("FOD certificate templates are available to regular AGRISTAT, AMIA, and DRRM accounts and Field Operations Division admins.");
      return;
    }
    if (!db) {
      setError("Participation certificate storage is unavailable.");
      return;
    }
    const form = new FormData(event.currentTarget);
    const eventDestination = String(form.get("event-destination") ?? "").trim();
    const sameAsDestination = form.get("distribution-same") === "yes";
    const unit = String(form.get("unit") ?? "") as ParticipationUnit;
    if (unit !== "AMIA" && unit !== "DRRM" && unit !== "AGRISTAT") {
      setError("Select a valid participation certificate template.");
      return;
    }
    const names = form.getAll("participant-name").map((value) => String(value).trim());
    const genders = form.getAll("participant-gender").map((value) => String(value) as ParticipantGender);
    if (!names.length || names.length > MAX_PARTICIPANTS || names.some((name) => !name) || genders.length !== names.length || genders.some((gender) => gender !== "female" && gender !== "male")) {
      setError(`Enter a name and gender for each participant (up to ${MAX_PARTICIPANTS}).`);
      return;
    }
    const recordData = {
      unit,
      participantNames: names,
      participantGenders: genders,
      eventTitle: String(form.get("event-title") ?? "").trim(),
      eventDateFrom: String(form.get("event-date-from") ?? ""),
      eventDateTo: String(form.get("event-date-to") ?? ""),
      eventDestination,
      distributionDate: String(form.get("event-date-to") || ""),
      distributionSameAsDestination: sameAsDestination,
      distributionPlace: sameAsDestination ? eventDestination : String(form.get("distribution-place") ?? "").trim(),
      status: "Pending" as const,
      ownerId: user.uid,
      createdAt: serverTimestamp(),
    };
    setSaving(true);
    try {
      const reference = await addDoc(collection(db, "participationCertificates"), recordData);
      setRecords((current) => [{ ...recordData, id: reference.id, createdAt: undefined } as ParticipationRecord, ...current]);
      setView("list");
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not save the participation certificate (${code}).` : "Could not save the participation certificate. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function saveNameCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!db || !editingRecord || certificateWorkflowStatus(editingRecord.status) === "Approved") {
      setError("Approved certificates cannot be edited.");
      return;
    }
    const form = new FormData(event.currentTarget);
    const names = form.getAll("participant-name").map((value) => String(value).trim());
    const genders = form.getAll("participant-gender").map((value) => String(value) as ParticipantGender);
    if (!names.length || names.length > MAX_PARTICIPANTS || names.some((name) => !name) || genders.length !== names.length || genders.some((gender) => gender !== "female" && gender !== "male")) {
      setError(`Enter a name and gender for each participant (up to ${MAX_PARTICIPANTS}).`);
      return;
    }
    setSaving(true);
    try {
      await updateDoc(doc(db, "participationCertificates", editingRecord.id), { participantNames: names, participantGenders: genders });
      setRecords((current) => current.map((record) => record.id === editingRecord.id ? { ...record, participantNames: names, participantGenders: genders } : record));
      setEditingRecord(null);
      setView("list");
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not update the participant details (${code}).` : "Could not update the participant details. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function importParticipations(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setError("");
    setImportMessage("");
    if (!canCreateFodCertificateTemplates) {
      setError("FOD certificate templates are available to regular AGRISTAT, AMIA, and DRRM accounts and Field Operations Division admins.");
      return;
    }
    if (!db) {
      setError("Participation certificate storage is unavailable.");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setError("Choose the Participation_Importing_Template.xlsx workbook (.xlsx).");
      return;
    }

    setImporting(true);
    let imported: ParticipationRecord[] = [];
    try {
      const { parseParticipationImportWorkbook } = await import("@/lib/participation-import");
      const parsed = parseParticipationImportWorkbook(new Uint8Array(await file.arrayBuffer()));
      const certificateCollection = collection(db, "participationCertificates");
      for (let offset = 0; offset < parsed.length; offset += 450) {
        const batch = writeBatch(db);
        const chunk: ParticipationRecord[] = parsed.slice(offset, offset + 450).map((record) => {
          const reference = doc(certificateCollection);
          const data = { ...record, status: "Pending" as const, ownerId: user.uid, createdAt: serverTimestamp() };
          batch.set(reference, data);
          return { ...data, id: reference.id, createdAt: undefined } as ParticipationRecord;
        });
        await batch.commit();
        imported = [...imported, ...chunk];
        setRecords((current) => [...chunk, ...current]);
      }
      const participantCount = imported.reduce((count, record) => count + participantNames(record).length, 0);
      const importedUnits = [...new Set(imported.map((record) => record.unit))].join(" and ");
      setImportMessage(`Imported ${imported.length} ${importedUnits} participation ${imported.length === 1 ? "report" : "reports"} for ${participantCount} ${participantCount === 1 ? "participant" : "participants"}. AMIA certificates use A4 landscape; DRRM certificates use Letter landscape. Distribution dates use the event end date.`);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "Check the template and try again.";
      setError(imported.length
        ? `${detail} ${imported.length} ${imported.length === 1 ? "report was" : "reports were"} imported before the error.`
        : detail);
    } finally {
      setImporting(false);
    }
  }

  async function waitForTemplate() {
    const images = Array.from(pageRef.current?.querySelectorAll<HTMLImageElement>(".participation-paper img") ?? []);
    if (!images.length) throw new Error("The participation certificate preview is unavailable.");
    await Promise.all(images.map(async (image) => {
      if (!image.complete) {
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("The participation certificate blank could not be loaded."));
        });
      }
      if (!image.naturalWidth) throw new Error("The participation certificate blank could not be loaded.");
      if (image.decode) await image.decode();
    }));
    if (document.fonts?.ready) await document.fonts.ready;
  }

  async function downloadPdf() {
    setDownloading(true);
    setError("");
    let originalPaperSizes: Array<[string, string]> = [];
    try {
      const { html2canvas, jsPDF } = await loadPdfTools();
      await waitForTemplate();
      const sheets = Array.from(pageRef.current!.querySelectorAll<HTMLElement>(".participation-print-sheet"));
      const paperFormat = preview?.unit === "DRRM" ? "letter" : "a4";
      const paperSize = preview?.unit === "DRRM" ? "11in" : "297mm";
      originalPaperSizes = sheets.map((sheet): [string, string] => [sheet.style.width, sheet.style.maxWidth]);
      sheets.forEach((sheet) => {
        sheet.style.width = paperSize;
        sheet.style.maxWidth = "none";
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const pdf = new jsPDF({ orientation: "landscape", unit: "in", format: paperFormat });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      for (let index = 0; index < sheets.length; index += 1) {
        const logoLayouts = Array.from(sheets[index].querySelectorAll<HTMLImageElement>(".participation-amia-letterhead img"), containedImageLayout);
        const canvas = await html2canvas(sheets[index], {
          backgroundColor: "#fff",
          logging: false,
          scale: 3,
          useCORS: true,
          onclone: (clonedDocument) => {
            const clonedSheet = clonedDocument.querySelectorAll<HTMLElement>(".participation-print-sheet")[index];
            const clonedLogos = clonedSheet?.querySelectorAll<HTMLImageElement>(".participation-amia-letterhead img") ?? [];
            clonedLogos.forEach((logo, logoIndex) => {
              const layout = logoLayouts[logoIndex];
              if (!layout) return;
              logo.style.setProperty("left", `${layout.left}px`);
              logo.style.setProperty("top", `${layout.top}px`);
              logo.style.setProperty("width", `${layout.width}px`);
              logo.style.setProperty("height", `${layout.height}px`);
              logo.style.setProperty("object-fit", "fill");
            });
          },
        });
        if (index > 0) pdf.addPage(paperFormat, "landscape");
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.97), "JPEG", 0, 0, pageWidth, pageHeight);
      }
      const filename = participantNames(preview!).slice(0, 3).join("-").replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "") || "participant";
      pdf.save(`participation-certificate-${filename}.pdf`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the participation certificate PDF.");
    } finally {
      if (pageRef.current) {
        Array.from(pageRef.current.querySelectorAll<HTMLElement>(".participation-print-sheet")).forEach((sheet, index) => {
          sheet.style.width = originalPaperSizes[index]?.[0] ?? "";
          sheet.style.maxWidth = originalPaperSizes[index]?.[1] ?? "";
        });
      }
      setDownloading(false);
    }
  }

  async function printCertificate() {
    setPrinting(true);
    setError("");
    let printPageStyle: HTMLStyleElement | null = null;
    try {
      await waitForTemplate();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      printPageStyle = document.createElement("style");
      const paperFormat = preview?.unit === "DRRM" ? "letter" : "A4";
      printPageStyle.textContent = `@media print{@page{size:${paperFormat} landscape;margin:0}}`;
      document.head.appendChild(printPageStyle);
      window.print();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to prepare the participation certificate for printing.");
    } finally {
      printPageStyle?.remove();
      setPrinting(false);
    }
  }

  if (preview) {
    return <div className="preview-backdrop participation-preview-backdrop">
      <div className="preview-toolbar participation-preview-toolbar"><span>Participation certificate preview</span><button type="button" className="ghost-button" onClick={() => { setPreview(null); setError(""); }}>Close</button><button type="button" className="pdf-button" disabled={downloading} onClick={() => void downloadPdf()}>{downloading ? "Preparing PDF..." : "Download PDF"}</button><button type="button" className="pdf-button" disabled={printing} onClick={() => void printCertificate()}>{printing ? "Preparing print..." : "Print"}</button></div>
      {error && <p className="participation-error" role="alert">{error}</p>}
      <div className="participation-preview-pages" ref={pageRef}>{participantDetails(preview).map((participant, index) => <section className={`participation-print-sheet participation-print-sheet-${preview.unit.toLowerCase()}`} key={`${preview.id}-${index}`} aria-label={`${preview.unit === "DRRM" ? "Letter" : "A4"} landscape participation certificate for ${participant.name}`}><ParticipationPaper record={preview} participant={participant} /></section>)}</div>
    </div>;
  }

  if (view === "new") {
    return canCreateFodCertificateTemplates
      ? <ParticipationForm onCancel={() => { setView("list"); setError(""); }} onSubmit={saveParticipation} saving={saving} error={error} />
      : <section className="content-section participation-section"><p className="muted">FOD certificate templates are available to regular AGRISTAT, AMIA, and DRRM accounts and Field Operations Division admins.</p><button type="button" className="ghost-button" onClick={() => setView("list")}>Back</button></section>;
  }
  if (view === "edit" && editingRecord) {
    return <ParticipationNameForm record={editingRecord} onCancel={() => { setEditingRecord(null); setView("list"); setError(""); }} onSubmit={saveNameCorrection} saving={saving} error={error} />;
  }

  return <>
  <section className="content-section participation-section">
    <div className="section-heading"><div><p className="eyebrow">Document generator</p><h2>Participation Generated Reports</h2><p className="muted">{canCreateFodCertificateTemplates ? <>Create AGRISTAT, AMIA, and DRRM certificates manually or import rows from the <a className="participation-template-link" href={importTemplate} download="Participation_Importing_Template.xlsx">Participation_Importing_Template.xlsx</a>.</> : "You can view and download your records. Creating FOD certificates is available to regular AGRISTAT, AMIA, and DRRM accounts and Field Operations Division admins."}</p></div>{canCreateFodCertificateTemplates && <div className="participation-list-actions"><button type="button" className="primary-button" onClick={() => { setError(""); setView("new"); }}>Add</button><button type="button" className="ghost-button" disabled={importing} onClick={() => { setError(""); setImportMessage(""); importInputRef.current?.click(); }}>{importing ? "Importing..." : "Import"}</button></div>}</div>
    {canCreateFodCertificateTemplates && <input ref={importInputRef} className="participation-import-input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void importParticipations(event)} aria-label="Import Participation certificate workbook" />}
    {error && <p className="participation-error" role="alert">{error}</p>}
    {importMessage && <p className="participation-success" role="status">{importMessage}</p>}
    {loading ? <p className="muted">Loading participation certificates...</p> : records.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No participation certificates yet</h3><p>{canCreateFodCertificateTemplates ? "Add participation details manually or import the completed Participation_Importing_Template.xlsx workbook." : "Creating FOD certificates is available to regular AGRISTAT, AMIA, and DRRM accounts and Field Operations Division admins."}</p>{canCreateFodCertificateTemplates && <div className="participation-empty-actions"><button type="button" className="text-button plain-action" onClick={() => { setError(""); setView("new"); }}>Add a Participation Certificate</button><button type="button" className="text-button plain-action" disabled={importing} onClick={() => { setError(""); setImportMessage(""); importInputRef.current?.click(); }}>{importing ? "Importing..." : "Upload an excel file"}</button></div>}</div> : <div className="participation-record-list"><div className="participation-record-head"><span>Office</span><span>Participant(s)</span><span>Event</span><span>Event dates</span><span>Status</span><span></span></div>{records.map((record) => <div className="participation-record-row" key={record.id}><span><span className="participation-unit-tag">{record.unit}</span></span><strong>{participantNames(record).join(", ")}</strong><span>{record.eventTitle}</span><span>{displayDateRange(record.eventDateFrom, record.eventDateTo)}</span><span><CertificateStatusBadge record={record} /></span><div className="participation-record-actions">{certificateWorkflowStatus(record.status) !== "Approved" && <button type="button" className="row-action" onClick={() => { setEditingRecord(record); setError(""); setView("edit"); }}>Edit</button>}<button type="button" className="row-action" onClick={() => { setError(""); setPreview(record); }}>View</button>{certificateWorkflowStatus(record.status) !== "Approved" && <button type="button" className="delete-button" disabled={deletingId !== null} onClick={() => setPendingDelete(record)}>{deletingId === record.id ? "Deleting..." : "Delete"}</button>}</div></div>)}</div>}
  </section>
  <DeleteConfirmation open={Boolean(pendingDelete)} title="Confirm Participation Certificate Deletion?" description="Are you sure you want to delete this Participation Certificate? This action cannot be undone." busy={Boolean(pendingDelete && deletingId === pendingDelete.id)} onCancel={() => setPendingDelete(null)} onConfirm={() => { if (pendingDelete) void deleteRecord(pendingDelete); }} />
  </>;
}

function ParticipationForm({ onCancel, onSubmit, saving, error }: { onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; saving: boolean; error: string }) {
  const [participants, setParticipants] = useState<ParticipantDraft[]>([{ name: "", gender: "" }]);
  const [unit, setUnit] = useState<ParticipationUnit>("AMIA");
  const [eventDateFrom, setEventDateFrom] = useState("");
  const [eventDateTo, setEventDateTo] = useState("");
  const [eventDestination, setEventDestination] = useState("");
  const [sameLocation, setSameLocation] = useState(false);
  const [distributionPlace, setDistributionPlace] = useState("");

  return <section className="content-section participation-section participation-form-section">
    <div className="section-heading"><div><p className="eyebrow">New record</p><h2>Create Certificate of Participation</h2><p className="muted">Enter participant and event details. Each participant gets a separate {unit === "DRRM" ? "Letter" : "A4"} landscape certificate.</p></div><button type="button" className="ghost-button" onClick={onCancel}>Cancel</button></div>
    {error && <p className="participation-error" role="alert">{error}</p>}
    <form className="permit-form participation-form" onSubmit={onSubmit}>
      <label className="wide-field">Certificate Template From<select name="unit" value={unit} onChange={(event) => setUnit(event.target.value as ParticipationUnit)}><option value="AGRISTAT">FOD-AGRISTAT</option><option value="AMIA">FOD-AMIA</option><option value="DRRM">FOD-DRRM</option></select></label>
      <ParticipationParticipantsFieldset participants={participants} onChange={(index, values) => setParticipants((current) => current.map((person, personIndex) => personIndex === index ? { ...person, ...values } : person))} onAdd={() => setParticipants((current) => [...current, { name: "", gender: "" }])} onRemove={(index) => setParticipants((current) => current.filter((_, personIndex) => personIndex !== index))} />
      <label>Event&apos;s Title<input name="event-title" maxLength={240} required /></label>
      <label>Event&apos;s Destination<input name="event-destination" maxLength={240} value={eventDestination} onChange={(event) => setEventDestination(event.target.value)} required /></label>
      <div className="wide-field participation-schedule">
        <div className="participation-date-range"><label>Event&apos;s Date (From)<input name="event-date-from" type="date" value={eventDateFrom} onChange={(event) => { setEventDateFrom(event.target.value); if (eventDateTo && eventDateTo < event.target.value) setEventDateTo(""); }} required /></label><span>to</span><label>Event&apos;s Date (To)<input name="event-date-to" type="date" min={eventDateFrom || undefined} value={eventDateTo} onChange={(event) => setEventDateTo(event.target.value)} required /></label></div>
      </div>
      <label className="wide-field participation-checkbox"><input name="distribution-same" type="checkbox" value="yes" checked={sameLocation} onChange={(event) => setSameLocation(event.target.checked)} />Event&apos;s Destination is the same as where the certificate will be awarded</label>
      <label className="wide-field">Certificate Distribution Place<input name="distribution-place" maxLength={240} value={sameLocation ? eventDestination : distributionPlace} onChange={(event) => setDistributionPlace(event.target.value)} readOnly={sameLocation} required={!sameLocation} placeholder={sameLocation ? "Same as event destination" : "Enter distribution place"} /></label>
      <div className="form-actions"><button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save"}</button></div>
    </form>
  </section>;
}

function ParticipationNameForm({ record, onCancel, onSubmit, saving, error }: { record: ParticipationRecord; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; saving: boolean; error: string }) {
  const [participants, setParticipants] = useState<ParticipantDraft[]>(() => participantDetails(record).map((person) => ({ ...person })));
  return <section className="content-section participation-section participation-form-section">
    <div className="section-heading"><div><p className="eyebrow">Correct record</p><h2>Edit participant details</h2><p className="muted">Update participant names or genders for {record.eventTitle}. Other certificate details will stay the same.</p></div><button type="button" className="ghost-button" onClick={onCancel}>Cancel</button></div>
    {error && <p className="participation-error" role="alert">{error}</p>}
    <form className="permit-form participation-name-form" onSubmit={onSubmit}>
      <ParticipationParticipantsFieldset participants={participants} onChange={(index, values) => setParticipants((current) => current.map((person, personIndex) => personIndex === index ? { ...person, ...values } : person))} onAdd={() => setParticipants((current) => [...current, { name: "", gender: "" }])} onRemove={(index) => setParticipants((current) => current.filter((_, personIndex) => personIndex !== index))} />
      <div className="form-actions"><button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save"}</button></div>
    </form>
  </section>;
}

function ParticipationParticipantsFieldset({ participants, onChange, onAdd, onRemove }: { participants: ParticipantDraft[]; onChange: (index: number, values: Partial<ParticipantDraft>) => void; onAdd: () => void; onRemove: (index: number) => void }) {
  return <fieldset className="wide-field participation-participants-fieldset">
    <legend>Participant&apos;s Details</legend>
    <p className="participation-participants-hint">Each participant will receive a separate Participation certificate.</p>
    {participants.map((participant, index) => <div className="participation-person-card" key={index}>
      <h3>Participant {index + 1}</h3>
      <label>Name<input name="participant-name" maxLength={180} value={participant.name} onChange={(event) => onChange(index, { name: event.target.value })} required /></label>
      <label>Gender<select name="participant-gender" value={participant.gender} onChange={(event) => onChange(index, { gender: event.target.value as ParticipantDraft["gender"] })} required><option value="" disabled>Select gender</option><option value="female">Female</option><option value="male">Male</option></select></label>
      {participants.length > 1 && <button type="button" className="remove-participant" aria-label={`Delete participant ${index + 1}`} onClick={() => onRemove(index)}>Delete</button>}
    </div>)}
    <button type="button" className="text-button plain-action add-item-text-button" disabled={participants.length >= MAX_PARTICIPANTS} onClick={onAdd}>+ Add participant</button>
  </fieldset>;
}

function ParticipationPaper({ record, participant }: { record: ParticipationRecord; participant: ParticipantDetails }) {
  const possessive = participant.gender === "female" ? "her" : "his";
  if (record.unit === "AGRISTAT") {
    return <article className="participation-paper participation-paper-agristat">
      <img className="participation-template participation-template-agristat" src={agristatBlankTemplate} alt="" />
      <h1 className="participation-participant participation-participant-agristat">{participant.name}</h1>
      <div className="participation-body participation-body-agristat">
        <p>has actively participated in <strong>{record.eventTitle}</strong> held on <strong>{displayDateRange(record.eventDateFrom, record.eventDateTo).replace(" - ", " – ")}</strong> at <strong>{record.eventDestination}</strong>.</p>
        <p>Given this {ordinalDay(record.distributionDate || record.eventDateTo)} at <strong>{record.distributionPlace}</strong>, <strong>Philippines.</strong></p>
      </div>
      <footer className="participation-signatory participation-signatory-agristat"><strong>ENGR. RICARDO M. OÑATE JR.</strong><em>Regional Executive Director</em></footer>
    </article>;
  }
  if (record.unit === "DRRM") {
    return <article className="participation-paper participation-paper-drrm">
      <img className="participation-template participation-template-drrm" src={drrmBlankTemplate} alt="" />
      <h1 className="participation-participant participation-participant-drrm">{participant.name}</h1>
      <div className="participation-body participation-body-drrm">
        <p>for {possessive} active participation during the <strong className="participation-event-title-drrm">{record.eventTitle}</strong> held on <strong>{displayDateRange(record.eventDateFrom, record.eventDateTo).replace(" - ", " \u2013 ")}</strong> at {record.eventDestination}.</p>
        <p>Given this {ordinalDay(record.distributionDate || record.eventDateTo)} at <strong>{record.distributionPlace}</strong>, <strong>Philippines.</strong></p>
      </div>
      <footer className="participation-signatory participation-signatory-drrm"><strong>ENGR. RICARDO M. O{"\u00d1"}ATE JR.</strong><em>Regional Executive Director</em></footer>
    </article>;
  }

  return <article className="participation-paper participation-paper-amia">
      <img className="participation-template participation-template-amia" src={amiaBlankTemplate} alt="" />
      <header className="participation-amia-letterhead">
        <img src={bagongPilipinasLogo} alt="Bagong Pilipinas" />
        <img src={daCaragaLogo} alt="Department of Agriculture Caraga Region" />
        <div className="participation-amia-agency">
          <span>Republic of the Philippines</span>
          <strong>Department of Agriculture</strong>
          <span>Regional Field Office – XIII</span>
          <span>Capitol Site, Butuan City</span>
        </div>
      </header>
      <p className="participation-amia-bestows">bestows this</p>
      <h2 className="participation-amia-title">Certificate of Participation</h2>
      <p className="participation-amia-to">to</p>
      <h1 className="participation-participant participation-participant-amia">{participant.name}</h1>
      <div className="participation-body participation-body-amia">
        <p>for {possessive} active participation during the <strong><em>{record.eventTitle}</em></strong> conducted on <strong>{displayDateRange(record.eventDateFrom, record.eventDateTo).replace(" - ", " – ")}</strong> at {record.eventDestination}.</p>
        <p>Given this {ordinalDay(record.distributionDate || record.eventDateTo)} in at <strong>{record.distributionPlace}</strong><strong>, Philippines.</strong></p>
      </div>
      <footer className="participation-signatory participation-signatory-amia"><strong>ENGR. RICARDO M. OÑATE JR.</strong><em>Regional Executive Director</em></footer>
  </article>;
}

