"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { addDoc, collection, deleteDoc, doc, getDocs, query, serverTimestamp, updateDoc, where, writeBatch } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "@/lib/firebase";
import { loadPdfTools } from "@/lib/pdf-tools";
import { CertificateStatusBadge, certificateWorkflowStatus, type CertificateWorkflowFields } from "./CertificateWorkflow";
import DeleteConfirmation from "./DeleteConfirmation";
import "./completion.css";
import "./completion-amia.css";
import "./certificate-workflow.css";

type CompletionUnit = "AMIA" | "AGRISTAT" | "DRRM";
type CompletionRecord = CertificateWorkflowFields & {
  id: string;
  unit: CompletionUnit;
  participantNames?: string[];
  participantName?: string;
  eventTitle: string;
  eventDateFrom: string;
  eventDateTo: string;
  eventDestination: string;
  distributionSameAsDestination: boolean;
  distributionPlace: string;
  ownerId: string;
  createdAt?: { toMillis?: () => number };
};

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const blankTemplate = `${basePath}/completion-drrm-blank.jpg`;
const agristatBlankTemplate = `${basePath}/completion-agristat-blank.png`;
const amiaBlankTemplate = `${basePath}/AMIA%20Certificate%20-%20Blank.jpg`;
const bagongPilipinasLogo = `${basePath}/bagong-pilipinas-logo.webp`;
const daCaragaLogo = `${basePath}/da-caraga-logo.jpg`;
const importTemplate = `${basePath}/Completion_Importing_Template.xlsx`;
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

function participantNames(record: CompletionRecord) {
  const names = record.participantNames?.map((name) => String(name).trim()).filter(Boolean) ?? [];
  if (names.length) return names;
  return record.participantName?.trim() ? [record.participantName.trim()] : [];
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
  return <><strong>{day}<sup className="completion-ordinal-suffix">{suffix}</sup></strong> day of <strong>{month} {date.getFullYear()}</strong></>;
}

export default function CompletionCertificate({ user, focusRecordId, onFocusHandled }: { user: User; focusRecordId?: string; onFocusHandled?: () => void }) {
  const [records, setRecords] = useState<CompletionRecord[]>([]);
  const [view, setView] = useState<"list" | "new" | "edit">("list");
  const [editingRecord, setEditingRecord] = useState<CompletionRecord | null>(null);
  const [preview, setPreview] = useState<CompletionRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CompletionRecord | null>(null);
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
      setError("Completion certificate storage is unavailable.");
      return;
    }
    getDocs(query(collection(db, "completionCertificates"), where("ownerId", "==", user.uid)))
      .then((snapshot) => {
        const loaded = snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as CompletionRecord));
        loaded.sort((first, second) => (second.createdAt?.toMillis?.() ?? 0) - (first.createdAt?.toMillis?.() ?? 0));
        setRecords(loaded);
      })
      .catch((cause) => {
        const code = (cause as { code?: string }).code;
        setError(code ? `Could not load completion certificates (${code}).` : "Could not load completion certificates. Refresh and try again.");
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
    onFocusHandled?.();
  }, [focusRecordId, loading, onFocusHandled, records]);

  async function deleteRecord(record: CompletionRecord) {
    if (!db || certificateWorkflowStatus(record.status) === "Approved") return;
    setDeletingId(record.id);
    setError("");
    try {
      await deleteDoc(doc(db, "completionCertificates", record.id));
      setRecords((current) => current.filter((item) => item.id !== record.id));
      setPreview((current) => current?.id === record.id ? null : current);
      setPendingDelete(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete the Completion Certificate (${code}).` : "Could not delete the Completion Certificate.");
      setPendingDelete(null);
    } finally {
      setDeletingId(null);
    }
  }

  async function saveCompletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!db) {
      setError("Completion certificate storage is unavailable.");
      return;
    }
    const form = new FormData(event.currentTarget);
    const eventDestination = String(form.get("event-destination") ?? "").trim();
    const sameAsDestination = form.get("distribution-same") === "yes";
    const unit = String(form.get("unit") ?? "") as CompletionUnit;
    if (unit !== "DRRM" && unit !== "AMIA" && unit !== "AGRISTAT") {
      setError("Select a valid completion certificate template.");
      return;
    }
    const names = form.getAll("participant-name").map((value) => String(value).trim());
    if (!names.length || names.length > MAX_PARTICIPANTS || names.some((name) => !name)) {
      setError(`Enter a name for each completer (up to ${MAX_PARTICIPANTS}).`);
      return;
    }
    const recordData = {
      unit,
      participantNames: names,
      eventTitle: String(form.get("event-title") ?? "").trim(),
      eventDateFrom: String(form.get("event-date-from") ?? ""),
      eventDateTo: String(form.get("event-date-to") ?? ""),
      eventDestination,
      distributionSameAsDestination: sameAsDestination,
      distributionPlace: sameAsDestination ? eventDestination : String(form.get("distribution-place") ?? "").trim(),
      status: "Pending" as const,
      ownerId: user.uid,
      createdAt: serverTimestamp(),
    };
    setSaving(true);
    try {
      const reference = await addDoc(collection(db, "completionCertificates"), recordData);
      setRecords((current) => [{ ...recordData, id: reference.id, createdAt: undefined } as CompletionRecord, ...current]);
      setView("list");
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not save the completion certificate (${code}).` : "Could not save the completion certificate. Try again.");
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
    const names = new FormData(event.currentTarget).getAll("participant-name").map((value) => String(value).trim());
    if (!names.length || names.length > MAX_PARTICIPANTS || names.some((name) => !name)) {
      setError(`Enter a name for each completer (up to ${MAX_PARTICIPANTS}).`);
      return;
    }
    setSaving(true);
    try {
      await updateDoc(doc(db, "completionCertificates", editingRecord.id), { participantNames: names });
      setRecords((current) => current.map((record) => record.id === editingRecord.id ? { ...record, participantNames: names } : record));
      setEditingRecord(null);
      setView("list");
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not update the completer name (${code}).` : "Could not update the completer name. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function importCompletions(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setError("");
    setImportMessage("");
    if (!db) {
      setError("Completion certificate storage is unavailable.");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setError("Choose the Completion_Importing_Template.xlsx workbook (.xlsx).");
      return;
    }

    setImporting(true);
    let imported: CompletionRecord[] = [];
    try {
      const { parseCompletionImportWorkbook } = await import("@/lib/completion-import");
      const parsed = parseCompletionImportWorkbook(new Uint8Array(await file.arrayBuffer()));
      const certificateCollection = collection(db, "completionCertificates");
      for (let offset = 0; offset < parsed.length; offset += 450) {
        const batch = writeBatch(db);
        const chunk: CompletionRecord[] = parsed.slice(offset, offset + 450).map((record) => {
          const reference = doc(certificateCollection);
          const data = { ...record, status: "Pending" as const, ownerId: user.uid, createdAt: serverTimestamp() };
          batch.set(reference, data);
          return { ...data, id: reference.id, createdAt: undefined } as CompletionRecord;
        });
        await batch.commit();
        imported = [...imported, ...chunk];
        setRecords((current) => [...chunk, ...current]);
      }
      const unitCounts = imported.reduce<Partial<Record<CompletionUnit, number>>>((counts, record) => {
        counts[record.unit] = (counts[record.unit] ?? 0) + 1;
        return counts;
      }, {});
      const importedUnits = (["AMIA", "DRRM"] as const)
        .filter((unit) => unitCounts[unit])
        .map((unit) => `${unit} (${unitCounts[unit]})`)
        .join(", ");
      setImportMessage(`Imported ${imported.length} completion ${imported.length === 1 ? "report" : "reports"}${importedUnits ? `: ${importedUnits}` : ""}. Each unit uses its own certificate template and sheet size. Distribution dates use the event end date.`);
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
    const images = Array.from(pageRef.current?.querySelectorAll<HTMLImageElement>(".completion-paper img") ?? []);
    if (!images.length) throw new Error("The completion certificate preview is unavailable.");
    await Promise.all(images.map(async (image) => {
      if (!image.complete) {
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("The completion certificate blank could not be loaded."));
        });
      }
      if (!image.naturalWidth) throw new Error("The completion certificate blank could not be loaded.");
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
      const sheets = Array.from(pageRef.current!.querySelectorAll<HTMLElement>(".completion-print-sheet"));
      const isA4 = preview!.unit !== "DRRM";
      const paperFormat = isA4 ? "a4" : "letter";
      const paperSize = isA4 ? "297mm" : "11in";
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
        const logoLayouts = Array.from(sheets[index].querySelectorAll<HTMLImageElement>(".completion-amia-letterhead img"), containedImageLayout);
        const canvas = await html2canvas(sheets[index], {
          backgroundColor: "#fff",
          logging: false,
          scale: 3,
          useCORS: true,
          onclone: (clonedDocument) => {
            const clonedSheet = clonedDocument.querySelectorAll<HTMLElement>(".completion-print-sheet")[index];
            const clonedLogos = clonedSheet?.querySelectorAll<HTMLImageElement>(".completion-amia-letterhead img") ?? [];
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
      const filename = participantNames(preview!).slice(0, 3).join("-").replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "") || "completer";
      pdf.save(`completion-certificate-${filename}.pdf`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the completion certificate PDF.");
    } finally {
      if (pageRef.current) {
        Array.from(pageRef.current.querySelectorAll<HTMLElement>(".completion-print-sheet")).forEach((sheet, index) => {
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
      printPageStyle.textContent = preview!.unit !== "DRRM"
        ? "@media print{@page{size:A4 landscape;margin:0}}"
        : "@media print{@page{size:11in 8.5in;margin:0}}";
      document.head.appendChild(printPageStyle);
      window.print();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to prepare the completion certificate for printing.");
    } finally {
      printPageStyle?.remove();
      setPrinting(false);
    }
  }

  if (preview) {
    return <div className="preview-backdrop completion-preview-backdrop">
      <div className="preview-toolbar completion-preview-toolbar"><span>Completion certificate preview</span><button type="button" className="ghost-button" onClick={() => { setPreview(null); setError(""); }}>Close</button><button type="button" className="pdf-button" disabled={downloading} onClick={() => void downloadPdf()}>{downloading ? "Preparing PDF..." : "Download PDF"}</button><button type="button" className="pdf-button" disabled={printing} onClick={() => void printCertificate()}>{printing ? "Preparing print..." : "Print"}</button></div>
      {error && <p className="completion-error" role="alert">{error}</p>}
      <div className="completion-preview-pages" ref={pageRef}>{participantNames(preview).map((name, index) => <section className={`completion-print-sheet${preview.unit === "AMIA" ? " completion-print-sheet-amia" : preview.unit === "AGRISTAT" ? " completion-print-sheet-agristat" : ""}`} key={`${preview.id}-${index}`} aria-label={`${preview.unit === "DRRM" ? "Letter" : "A4"} landscape completion certificate for ${name}`}><CompletionPaper record={preview} participantName={name} /></section>)}</div>
    </div>;
  }

  if (view === "new") {
    return <CompletionForm onCancel={() => { setView("list"); setError(""); }} onSubmit={saveCompletion} saving={saving} error={error} />;
  }
  if (view === "edit" && editingRecord) {
    return <CompletionNameForm record={editingRecord} onCancel={() => { setEditingRecord(null); setView("list"); setError(""); }} onSubmit={saveNameCorrection} saving={saving} error={error} />;
  }

  return <>
  <section className="content-section completion-section">
    <div className="section-heading"><div><p className="eyebrow">Document generator</p><h2>Completion Generated Reports</h2><p className="muted">Create certificates manually or import the <a className="completion-template-link" href={importTemplate} download="Completion_Importing_Template.xlsx">Completion_Importing_Template.xlsx</a>.</p></div><div className="completion-list-actions"><button type="button" className="primary-button" onClick={() => { setError(""); setView("new"); }}>Add</button><button type="button" className="ghost-button" disabled={importing} onClick={() => { setError(""); setImportMessage(""); importInputRef.current?.click(); }}>{importing ? "Importing..." : "Import"}</button></div></div>
    <input ref={importInputRef} className="completion-import-input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void importCompletions(event)} aria-label="Import Completion certificate workbook" />
    {error && <p className="completion-error" role="alert">{error}</p>}
    {importMessage && <p className="completion-success" role="status">{importMessage}</p>}
    {loading ? <p className="muted">Loading completion certificates...</p> : records.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No completion certificates yet</h3><p>Add completion details manually or import the completed Completion_Importing_Template.xlsx workbook.</p><div className="completion-empty-actions"><button type="button" className="text-button plain-action" onClick={() => { setError(""); setView("new"); }}>Add a Completion Certificate</button><button type="button" className="text-button plain-action" disabled={importing} onClick={() => { setError(""); setImportMessage(""); importInputRef.current?.click(); }}>{importing ? "Importing..." : "Upload an excel file"}</button></div></div> : <div className="completion-record-list"><div className="completion-record-head"><span>Office</span><span>Completer(s)</span><span>Event</span><span>Event dates</span><span>Status</span><span></span></div>{records.map((record) => <div className="completion-record-row" key={record.id}><span><span className="completion-unit-tag">{record.unit}</span></span><strong>{participantNames(record).join(", ")}</strong><span>{record.eventTitle}</span><span>{displayDateRange(record.eventDateFrom, record.eventDateTo)}</span><span><CertificateStatusBadge record={record} /></span><div className="completion-record-actions">{certificateWorkflowStatus(record.status) !== "Approved" && <button type="button" className="row-action" onClick={() => { setEditingRecord(record); setError(""); setView("edit"); }}>Edit</button>}<button type="button" className="row-action" onClick={() => { setError(""); setPreview(record); }}>View</button>{certificateWorkflowStatus(record.status) !== "Approved" && <button type="button" className="delete-button" disabled={deletingId !== null} onClick={() => setPendingDelete(record)}>{deletingId === record.id ? "Deleting..." : "Delete"}</button>}</div></div>)}</div>}
  </section>
  <DeleteConfirmation open={Boolean(pendingDelete)} title="Confirm Completion Certificate Deletion?" description="Are you sure you want to delete this Completion Certificate? This action cannot be undone." busy={Boolean(pendingDelete && deletingId === pendingDelete.id)} onCancel={() => setPendingDelete(null)} onConfirm={() => { if (pendingDelete) void deleteRecord(pendingDelete); }} />
  </>;
}

function CompletionForm({ onCancel, onSubmit, saving, error }: { onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; saving: boolean; error: string }) {
  const [names, setNames] = useState([""]);
  const [eventDateFrom, setEventDateFrom] = useState("");
  const [eventDateTo, setEventDateTo] = useState("");
  const [eventDestination, setEventDestination] = useState("");
  const [sameLocation, setSameLocation] = useState(false);
  const [distributionPlace, setDistributionPlace] = useState("");

  return <section className="content-section completion-section completion-form-section">
    <div className="section-heading"><div><p className="eyebrow">New record</p><h2>Create Certificate of Completion</h2><p className="muted">Enter the event and completer details. AGRISTAT and AMIA certificates print on A4; DRRM certificates print on landscape Letter paper.</p></div><button type="button" className="ghost-button" onClick={onCancel}>Cancel</button></div>
    {error && <p className="completion-error" role="alert">{error}</p>}
    <form className="permit-form completion-form" onSubmit={onSubmit}>
      <label className="wide-field">Certificate Template From<select name="unit" defaultValue="AMIA"><option value="AGRISTAT">FOD-AGRISTAT</option><option value="AMIA">FOD-AMIA</option><option value="DRRM">FOD-DRRM</option></select></label>
      <fieldset className="wide-field completion-participants-fieldset"><legend>Completer&apos;s Name</legend><p className="completion-participants-hint">Enter one or more names. A separate certificate will be created for each completer.</p>{names.map((name, index) => <div className="completion-name-row" key={index}><label>Completer {index + 1}<input name="participant-name" maxLength={180} value={name} onChange={(event) => setNames((current) => current.map((person, personIndex) => personIndex === index ? event.target.value : person))} required /></label>{names.length > 1 && <button type="button" className="remove-participant" aria-label={`Delete completer ${index + 1}`} onClick={() => setNames((current) => current.filter((_, personIndex) => personIndex !== index))}>Delete</button>}</div>)}<button type="button" className="text-button plain-action add-item-text-button" disabled={names.length >= MAX_PARTICIPANTS} onClick={() => setNames((current) => [...current, ""])}>+ Add completer</button></fieldset>
      <label>Event&apos;s Title<input name="event-title" maxLength={240} required /></label>
      <label>Event&apos;s Destination<input name="event-destination" maxLength={240} value={eventDestination} onChange={(event) => setEventDestination(event.target.value)} required /></label>
      <div className="wide-field completion-schedule">
        <div className="completion-date-range"><label>Event&apos;s Date (From)<input name="event-date-from" type="date" value={eventDateFrom} onChange={(event) => { setEventDateFrom(event.target.value); if (eventDateTo && eventDateTo < event.target.value) setEventDateTo(""); }} required /></label><span>to</span><label>Event&apos;s Date (To)<input name="event-date-to" type="date" min={eventDateFrom || undefined} value={eventDateTo} onChange={(event) => setEventDateTo(event.target.value)} required /></label></div>
      </div>
      <label className="wide-field completion-checkbox"><input name="distribution-same" type="checkbox" value="yes" checked={sameLocation} onChange={(event) => setSameLocation(event.target.checked)} />Event&apos;s Destination is the same as where the certificate will be awarded</label>
      <label className="wide-field">Certificate Distribution Place<input name="distribution-place" maxLength={240} value={sameLocation ? eventDestination : distributionPlace} onChange={(event) => setDistributionPlace(event.target.value)} readOnly={sameLocation} required={!sameLocation} placeholder={sameLocation ? "Same as event destination" : "Enter distribution place"} /></label>
      <div className="form-actions"><button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save"}</button></div>
    </form>
  </section>;
}

function CompletionNameForm({ record, onCancel, onSubmit, saving, error }: { record: CompletionRecord; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; saving: boolean; error: string }) {
  const [names, setNames] = useState(() => participantNames(record));
  return <section className="content-section completion-section completion-form-section">
    <div className="section-heading"><div><p className="eyebrow">Correct record</p><h2>Edit completer name{names.length === 1 ? "" : "s"}</h2><p className="muted">Update the name{names.length === 1 ? "" : "s"} for {record.eventTitle}. Other certificate details will stay the same.</p></div><button type="button" className="ghost-button" onClick={onCancel}>Cancel</button></div>
    {error && <p className="completion-error" role="alert">{error}</p>}
    <form className="permit-form completion-name-form" onSubmit={onSubmit}>
      <fieldset className="wide-field completion-participants-fieldset"><legend>Completer&apos;s Name</legend>{names.map((name, index) => <div className="completion-name-row" key={index}><label>Completer {index + 1}<input name="participant-name" maxLength={180} value={name} onChange={(event) => setNames((current) => current.map((person, personIndex) => personIndex === index ? event.target.value : person))} required /></label>{names.length > 1 && <button type="button" className="remove-participant" aria-label={`Delete completer ${index + 1}`} onClick={() => setNames((current) => current.filter((_, personIndex) => personIndex !== index))}>Delete</button>}</div>)}<button type="button" className="text-button plain-action add-item-text-button" disabled={names.length >= MAX_PARTICIPANTS} onClick={() => setNames((current) => [...current, ""])}>+ Add completer</button></fieldset>
      <div className="form-actions"><button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save"}</button></div>
    </form>
  </section>;
}

function CompletionPaper({ record, participantName }: { record: CompletionRecord; participantName: string }) {
  if (record.unit === "AMIA") {
    return <article className="completion-paper completion-paper-amia">
      <img className="completion-template completion-template-amia" src={amiaBlankTemplate} alt="" />
      <header className="completion-amia-letterhead">
        <img src={bagongPilipinasLogo} alt="Bagong Pilipinas" />
        <img src={daCaragaLogo} alt="Department of Agriculture Caraga Region" />
        <div className="completion-amia-agency">
          <span>Republic of the Philippines</span>
          <strong>Department of Agriculture</strong>
          <span>Regional Field Office – XIII</span>
          <span>Capitol Site, Butuan City</span>
        </div>
      </header>
      <p className="completion-amia-bestows">bestows this</p>
      <h2 className="completion-amia-title">Certificate of Completion</h2>
      <p className="completion-amia-to">to</p>
      <h1 className="completion-participant completion-participant-amia">{participantName}</h1>
      <div className="completion-body completion-body-amia">
        <p>for having successfully completed the <strong className="completion-event-title">{record.eventTitle}</strong> during <strong>{displayDateRange(record.eventDateFrom, record.eventDateTo).replace(" - ", " – ")}</strong> at <strong>{record.eventDestination}</strong>.</p>
        <p>Given this {ordinalDay(record.eventDateTo)} in at <strong>{record.distributionPlace}</strong>, <strong>Philippines.</strong></p>
      </div>
      <footer className="completion-signatory completion-signatory-amia"><strong>ENGR. RICARDO M. OÑATE JR.</strong><em>Regional Executive Director</em></footer>
    </article>;
  }
  if (record.unit === "AGRISTAT") {
    return <article className="completion-paper completion-paper-agristat">
      <img className="completion-template completion-template-agristat" src={agristatBlankTemplate} alt="" />
      <h1 className="completion-participant completion-participant-agristat">{participantName}</h1>
      <div className="completion-body completion-body-agristat">
        <p>has completed the <strong className="completion-event-title">{record.eventTitle}</strong> held on <strong>{displayDateRange(record.eventDateFrom, record.eventDateTo).replace(" - ", " – ")}</strong>, at <strong>{record.eventDestination}</strong>.</p>
        <p>Given this {ordinalDay(record.eventDateTo)} at <strong>{record.distributionPlace}</strong>, <strong>Philippines.</strong></p>
      </div>
      <footer className="completion-signatory completion-signatory-agristat"><strong>ENGR. RICARDO M. OÑATE JR.</strong><em>Regional Executive Director</em></footer>
    </article>;
  }
  return <article className="completion-paper">
    <img className="completion-template" src={blankTemplate} alt="" />
    <h1 className="completion-participant">{participantName}</h1>
    <div className="completion-body">
      <p>has completed the <strong className="completion-event-title">{record.eventTitle}</strong> during <strong>{displayDateRange(record.eventDateFrom, record.eventDateTo)}</strong> at {record.eventDestination}.</p>
      <p>Given this {ordinalDay(record.eventDateTo)} at <strong>{record.distributionPlace}</strong>, <strong>Philippines.</strong></p>
    </div>
    <footer className="completion-signatory"><strong>ENGR. RICARDO M. OÑATE JR.</strong><em>Regional Executive Director</em></footer>
  </article>;
}
