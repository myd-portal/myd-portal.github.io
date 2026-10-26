"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { addDoc, collection, deleteDoc, doc, getDocs, query, serverTimestamp, updateDoc, where, writeBatch } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "@/lib/firebase";
import { loadPdfTools } from "@/lib/pdf-tools";
import { CertificateStatusBadge } from "./CertificateWorkflow";
import DeleteConfirmation from "./DeleteConfirmation";
import "./appreciation.css";
import "./appreciation-amia.css";
import "./certificate-workflow.css";

type AppreciationGender = "female" | "male";
type AppreciationSpeaker = { name: string; gender: AppreciationGender; position: string; office: string };
type AppreciationSpeakerDraft = { name: string; gender: AppreciationGender | ""; position: string; office: string };
type AppreciationRecord = {
  id: string;
  unit: "AMIA" | "AGRISTAT" | "DRRM";
  speakers?: AppreciationSpeaker[];
  speakerName: string;
  speakerGender: AppreciationGender;
  speakerPosition: string;
  speakerOffice: string;
  eventTitle: string;
  eventDateFrom: string;
  eventDateTo: string;
  eventDestination: string;
  distributionSameAsDestination: boolean;
  distributionPlace: string;
  status?: "Pending" | "Approved" | "Disapproved";
  ownerId: string;
  createdAt?: { toMillis?: () => number };
};

const MAX_SPEAKERS = 100;

const asset = (path: string) => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
const blankAppreciation = asset("/appreciation-drrm-blank.jpg");
const blankAgristatAppreciation = asset("/appreciation-agristat-blank.png");
const blankAmiaAppreciation = asset("/AMIA%20Certificate%20-%20Blank.jpg");
const bagongPilipinasLogo = asset("/bagong-pilipinas-logo.webp");
const daCaragaLogo = asset("/da-caraga-logo.jpg");
const importTemplate = asset("/Appreciation_Importing_Template.xlsx");

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

function displayDate(value: string) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-PH", { month: "long", day: "numeric", year: "numeric" }).format(date);
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
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) return `${startMonth} ${start.getDate()} - ${end.getDate()}, ${end.getFullYear()}`;
  if (start.getFullYear() === end.getFullYear()) return `${displayDate(from)} - ${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
  return `${displayDate(from)} - ${displayDate(to)}`;
}

function ordinalDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return <strong>{displayDate(value)}</strong>;
  const day = date.getDate();
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  const month = new Intl.DateTimeFormat("en-PH", { month: "long" }).format(date);
  return <><strong>{day}<sup className="appreciation-ordinal">{suffix}</sup></strong> day of <strong>{month} {date.getFullYear()}</strong></>;
}

function countryLocation(value: string) {
  return /philippines/i.test(value) ? value : `${value}, Philippines`;
}

function recordSpeakers(record: AppreciationRecord): AppreciationSpeaker[] {
  const speakers = record.speakers?.filter((speaker) => speaker && String(speaker.name ?? "").trim()) ?? [];
  if (speakers.length) return speakers;
  return record.speakerName?.trim() ? [{ name: record.speakerName, gender: record.speakerGender, position: record.speakerPosition, office: record.speakerOffice }] : [];
}

function primarySpeakerFields(speakers: AppreciationSpeaker[]) {
  const primary = speakers[0];
  return { speakerName: primary.name, speakerGender: primary.gender, speakerPosition: primary.position, speakerOffice: primary.office };
}

export default function AppreciationCertificate({ user, focusRecordId, onFocusHandled }: { user: User; focusRecordId?: string; onFocusHandled?: () => void }) {
  const [records, setRecords] = useState<AppreciationRecord[]>([]);
  const [view, setView] = useState<"list" | "new" | "edit">("list");
  const [preview, setPreview] = useState<AppreciationRecord | null>(null);
  const [editingRecord, setEditingRecord] = useState<AppreciationRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AppreciationRecord | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const handledFocusIdRef = useRef<string | null>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!db) { setLoading(false); setError("Appreciation certificate storage is unavailable."); return; }
    getDocs(query(collection(db, "appreciationCertificates"), where("ownerId", "==", user.uid)))
      .then((snapshot) => {
        const loaded = snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as AppreciationRecord));
        loaded.sort((left, right) => (right.createdAt?.toMillis?.() ?? 0) - (left.createdAt?.toMillis?.() ?? 0));
        setRecords(loaded);
      })
      .catch((cause) => {
        const code = (cause as { code?: string }).code;
        setError(code ? `Could not load Appreciation certificates (${code}).` : "Could not load Appreciation certificates. Refresh and try again.");
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

  async function deleteRecord(record: AppreciationRecord) {
    if (!db) return;
    setDeletingId(record.id);
    setError("");
    try {
      await deleteDoc(doc(db, "appreciationCertificates", record.id));
      setRecords((current) => current.filter((item) => item.id !== record.id));
      setPreview((current) => current?.id === record.id ? null : current);
      setPendingDelete(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete the Appreciation Certificate (${code}).` : "Could not delete the Appreciation Certificate.");
      setPendingDelete(null);
    } finally {
      setDeletingId(null);
    }
  }

  async function saveAppreciation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!db) { setError("Appreciation certificate storage is unavailable."); return; }
    const form = new FormData(event.currentTarget);
    const eventDestination = String(form.get("event-destination") ?? "").trim();
    const sameAsDestination = form.get("distribution-same") === "yes";
    const unit = String(form.get("unit") ?? "") as "AMIA" | "AGRISTAT" | "DRRM";
    if (unit !== "AMIA" && unit !== "DRRM" && unit !== "AGRISTAT") { setError("Select a valid appreciation certificate template."); return; }
    const names = form.getAll("speaker-name").map((value) => String(value).trim());
    const genders = form.getAll("speaker-gender").map((value) => String(value) as AppreciationGender);
    const positions = form.getAll("speaker-position").map((value) => String(value).trim());
    const offices = form.getAll("speaker-office").map((value) => String(value).trim());
    if (!names.length || names.length > MAX_SPEAKERS || names.some((name) => !name) || genders.length !== names.length || genders.some((gender) => !gender) || positions.length !== names.length || positions.some((position) => !position) || offices.length !== names.length || offices.some((office) => !office)) {
      setError(`Enter complete details for each resource speaker (up to ${MAX_SPEAKERS}).`);
      return;
    }
    const speakers = names.map((name, index) => ({ name, gender: genders[index], position: positions[index], office: offices[index] }));
    const distributionPlace = sameAsDestination ? eventDestination : String(form.get("distribution-place") ?? "").trim();
    const recordData = {
      unit,
      speakers,
      ...primarySpeakerFields(speakers),
      eventTitle: String(form.get("event-title") ?? "").trim(),
      eventDateFrom: String(form.get("event-date-from") ?? ""),
      eventDateTo: String(form.get("event-date-to") ?? ""),
      eventDestination,
      distributionSameAsDestination: sameAsDestination,
      distributionPlace,
      status: "Pending" as const,
      ownerId: user.uid,
      createdAt: serverTimestamp(),
    };
    setSaving(true);
    try {
      const reference = await addDoc(collection(db, "appreciationCertificates"), recordData);
      setRecords((current) => [{ ...recordData, id: reference.id, createdAt: undefined } as AppreciationRecord, ...current]);
      setView("list");
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not save the Appreciation certificate (${code}).` : "Could not save the Appreciation certificate. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function saveSpeakerCorrections(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!db || !editingRecord) { setError("The Appreciation certificate could not be updated."); return; }
    const form = new FormData(event.currentTarget);
    const names = form.getAll("speaker-name").map((value) => String(value).trim());
    const genders = form.getAll("speaker-gender").map((value) => String(value) as AppreciationGender);
    const positions = form.getAll("speaker-position").map((value) => String(value).trim());
    const offices = form.getAll("speaker-office").map((value) => String(value).trim());
    if (!names.length || names.length > MAX_SPEAKERS || names.some((name) => !name) || genders.length !== names.length || genders.some((gender) => !gender) || positions.length !== names.length || positions.some((position) => !position) || offices.length !== names.length || offices.some((office) => !office)) {
      setError(`Enter complete details for each resource speaker (up to ${MAX_SPEAKERS}).`);
      return;
    }
    const speakers = names.map((name, index) => ({ name, gender: genders[index], position: positions[index], office: offices[index] }));
    const speakerFields = { speakers, ...primarySpeakerFields(speakers) };
    setSaving(true);
    try {
      await updateDoc(doc(db, "appreciationCertificates", editingRecord.id), speakerFields);
      setRecords((current) => current.map((record) => record.id === editingRecord.id ? { ...record, ...speakerFields } : record));
      setEditingRecord(null);
      setView("list");
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not update the resource speaker details (${code}).` : "Could not update the resource speaker details. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function importAppreciations(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setError("");
    setImportMessage("");
    if (!db) { setError("Appreciation certificate storage is unavailable."); return; }
    if (!file.name.toLowerCase().endsWith(".xlsx")) { setError("Choose the Appreciation_Importing_Template.xlsx workbook (.xlsx)."); return; }

    setImporting(true);
    let imported: AppreciationRecord[] = [];
    try {
      const { parseAppreciationImportWorkbook } = await import("@/lib/appreciation-import");
      const parsed = parseAppreciationImportWorkbook(new Uint8Array(await file.arrayBuffer()));
      const target = collection(db, "appreciationCertificates");
      for (let offset = 0; offset < parsed.length; offset += 450) {
        const batch = writeBatch(db);
        const chunk: AppreciationRecord[] = parsed.slice(offset, offset + 450).map((record) => {
          const reference = doc(target);
          const data = { ...record, ...primarySpeakerFields(record.speakers), status: "Pending" as const, ownerId: user.uid, createdAt: serverTimestamp() };
          batch.set(reference, data);
          return { ...data, id: reference.id, createdAt: undefined } as AppreciationRecord;
        });
        await batch.commit();
        imported = [...imported, ...chunk];
        setRecords((current) => [...chunk, ...current]);
      }
      const speakerCount = imported.reduce((total, record) => total + recordSpeakers(record).length, 0);
      const unitCounts = imported.reduce<Partial<Record<"AMIA" | "AGRISTAT" | "DRRM", number>>>((counts, record) => {
        counts[record.unit] = (counts[record.unit] ?? 0) + 1;
        return counts;
      }, {});
      const importedUnits = (["AMIA", "DRRM"] as const)
        .filter((unit) => unitCounts[unit])
        .map((unit) => `${unit} (${unitCounts[unit]})`)
        .join(", ");
      setImportMessage(`Imported ${imported.length} Appreciation ${imported.length === 1 ? "report" : "reports"}${importedUnits ? `: ${importedUnits}` : ""}, containing ${speakerCount} ${speakerCount === 1 ? "speaker" : "speakers"}. Each unit uses its own certificate template and sheet size. Distribution dates use the event end date.`);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "Check the template and try again.";
      setError(imported.length ? `${detail} ${imported.length} ${imported.length === 1 ? "report was" : "reports were"} imported before the error.` : detail);
    } finally {
      setImporting(false);
    }
  }

  async function waitForBlank() {
    const images = Array.from(pagesRef.current?.querySelectorAll<HTMLImageElement>(".appreciation-paper img") ?? []);
    if (!images.length) throw new Error("The Appreciation certificate preview is unavailable.");
    await Promise.all(images.map(async (image) => {
      if (!image.complete) await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("The Appreciation certificate image could not be loaded."));
      });
      if (!image.naturalWidth) throw new Error("The Appreciation certificate image could not be loaded.");
      if (image.decode) await image.decode();
    }));
    if (document.fonts?.ready) await document.fonts.ready;
  }

  async function downloadPdf() {
    setDownloading(true);
    setError("");
    let papers: HTMLElement[] = [];
    let originalPaperSizes: Array<[string, string]> = [];
    try {
      const { html2canvas, jsPDF } = await loadPdfTools();
      await waitForBlank();
      papers = Array.from(pagesRef.current?.querySelectorAll<HTMLElement>(".appreciation-print-sheet") ?? []);
      if (!papers.length) throw new Error("The Appreciation certificate preview is unavailable.");
      originalPaperSizes = papers.map((paper): [string, string] => [paper.style.width, paper.style.maxWidth]);
      const isA4 = preview!.unit !== "DRRM";
      const paperFormat = isA4 ? "a4" : "letter";
      const paperWidth = isA4 ? "297mm" : "11in";
      papers.forEach((paper) => {
        paper.style.width = paperWidth;
        paper.style.maxWidth = "none";
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const pdf = new jsPDF({ orientation: "landscape", unit: "in", format: paperFormat });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      for (let index = 0; index < papers.length; index += 1) {
        const logoLayouts = Array.from(papers[index].querySelectorAll<HTMLImageElement>(".appreciation-amia-letterhead img"), containedImageLayout);
        const canvas = await html2canvas(papers[index], {
          backgroundColor: "#fff",
          logging: false,
          scale: 3,
          useCORS: true,
          onclone: (clonedDocument) => {
            const clonedPaper = clonedDocument.querySelectorAll<HTMLElement>(".appreciation-print-sheet")[index];
            const clonedLogos = clonedPaper?.querySelectorAll<HTMLImageElement>(".appreciation-amia-letterhead img") ?? [];
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
      const filename = recordSpeakers(preview!).slice(0, 3).map((speaker) => speaker.name).join("-").trim().replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "") || "speaker";
      pdf.save(`appreciation-certificate-${filename}.pdf`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the Appreciation certificate PDF.");
    } finally {
      papers.forEach((paper, index) => {
        paper.style.width = originalPaperSizes[index]?.[0] ?? "";
        paper.style.maxWidth = originalPaperSizes[index]?.[1] ?? "";
      });
      setDownloading(false);
    }
  }

  async function printCertificate() {
    setPrinting(true);
    setError("");
    let printPageStyle: HTMLStyleElement | null = null;
    try {
      await waitForBlank();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      printPageStyle = document.createElement("style");
      printPageStyle.textContent = preview!.unit !== "DRRM"
        ? "@media print{@page{size:A4 landscape;margin:0}}"
        : "@media print{@page{size:11in 8.5in;margin:0}}";
      document.head.appendChild(printPageStyle);
      window.print();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to prepare the Appreciation certificate for printing.");
    } finally {
      printPageStyle?.remove();
      setPrinting(false);
    }
  }

  if (preview) return <div className="preview-backdrop appreciation-preview-backdrop">
    <div className="preview-toolbar appreciation-preview-toolbar"><span>Appreciation certificate preview</span><button type="button" className="ghost-button" onClick={() => { setPreview(null); setError(""); }}>Close</button><button type="button" className="pdf-button" disabled={downloading} onClick={() => void downloadPdf()}>{downloading ? "Preparing PDF..." : "Download PDF"}</button><button type="button" className="pdf-button" disabled={printing} onClick={() => void printCertificate()}>{printing ? "Preparing print..." : "Print"}</button></div>
    {error && <p className="appreciation-error" role="alert">{error}</p>}
    <div className="appreciation-preview-pages" ref={pagesRef}>{recordSpeakers(preview).map((speaker, index) => <section className={`appreciation-print-sheet${preview.unit === "AMIA" ? " appreciation-print-sheet-amia" : preview.unit === "AGRISTAT" ? " appreciation-print-sheet-agristat" : ""}`} key={`${preview.id}-${index}`} aria-label={`${preview.unit === "DRRM" ? "Letter" : "A4"} landscape Appreciation certificate for ${speaker.name}`}><AppreciationPaper record={preview} speaker={speaker} /></section>)}</div>
  </div>;

  if (view === "new") return <AppreciationForm onCancel={() => { setView("list"); setError(""); }} onSubmit={saveAppreciation} saving={saving} error={error} />;
  if (view === "edit" && editingRecord) return <AppreciationSpeakerForm record={editingRecord} onCancel={() => { setEditingRecord(null); setView("list"); setError(""); }} onSubmit={saveSpeakerCorrections} saving={saving} error={error} />;

  return <>
  <section className="content-section appreciation-section">
    <div className="section-heading"><div><p className="eyebrow">Document generator</p><h2>Appreciation Generated Reports</h2><p className="muted">Create certificates manually or import the <a className="appreciation-template-link" href={importTemplate} download="Appreciation_Importing_Template.xlsx">Appreciation_Importing_Template.xlsx</a>.</p></div><div className="appreciation-list-actions"><button type="button" className="primary-button" onClick={() => { setError(""); setView("new"); }}>Add</button><button type="button" className="ghost-button" disabled={importing} onClick={() => { setError(""); setImportMessage(""); importInputRef.current?.click(); }}>{importing ? "Importing..." : "Import"}</button></div></div>
    <input ref={importInputRef} className="appreciation-import-input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void importAppreciations(event)} aria-label="Import Appreciation certificate workbook" />
    {error && <p className="appreciation-error" role="alert">{error}</p>}
    {importMessage && <p className="appreciation-success" role="status">{importMessage}</p>}
    {loading ? <p className="muted">Loading Appreciation certificates...</p> : records.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No Appreciation certificates yet</h3><p>Add the speaker and event details manually or import the completed Appreciation_Importing_Template.xlsx workbook.</p><div className="appreciation-empty-actions"><button type="button" className="text-button plain-action" onClick={() => { setError(""); setView("new"); }}>Add an Appreciation Certificate</button><button type="button" className="text-button plain-action" disabled={importing} onClick={() => { setError(""); setImportMessage(""); importInputRef.current?.click(); }}>{importing ? "Importing..." : "Upload an excel file"}</button></div></div> : <div className="appreciation-record-list"><div className="appreciation-record-head"><span>Unit</span><span>Resource Speaker(s)</span><span>Event&apos;s Title</span><span>Event Dates</span><span>Status</span><span></span></div>{records.map((record) => <div className="appreciation-record-row" key={record.id}><span><span className="appreciation-unit-tag">{record.unit}</span></span><strong>{recordSpeakers(record).map((speaker) => speaker.name).join(", ")}</strong><span>{record.eventTitle}</span><span>{displayDateRange(record.eventDateFrom, record.eventDateTo)}</span><span><CertificateStatusBadge record={record} /></span><div className="appreciation-record-actions"><button type="button" className="row-action" onClick={() => { setEditingRecord(record); setError(""); setView("edit"); }}>Edit</button><button type="button" className="row-action" onClick={() => { setError(""); setPreview(record); }}>View</button><button type="button" className="delete-button" disabled={deletingId !== null} onClick={() => setPendingDelete(record)}>{deletingId === record.id ? "Deleting..." : "Delete"}</button></div></div>)}</div>}
  </section>
  <DeleteConfirmation open={Boolean(pendingDelete)} title="Confirm Appreciation Certificate Deletion?" description="Are you sure you want to delete this Appreciation Certificate? This action cannot be undone." busy={Boolean(pendingDelete && deletingId === pendingDelete.id)} onCancel={() => setPendingDelete(null)} onConfirm={() => { if (pendingDelete) void deleteRecord(pendingDelete); }} />
  </>;
}

function AppreciationForm({ onCancel, onSubmit, saving, error }: { onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; saving: boolean; error: string }) {
  const [speakers, setSpeakers] = useState<AppreciationSpeakerDraft[]>([{ name: "", gender: "", position: "", office: "" }]);
  const [eventDateFrom, setEventDateFrom] = useState("");
  const [eventDateTo, setEventDateTo] = useState("");
  const [eventDestination, setEventDestination] = useState("");
  const [sameLocation, setSameLocation] = useState(false);
  const [distributionPlace, setDistributionPlace] = useState("");
  const updateSpeaker = (index: number, values: Partial<AppreciationSpeakerDraft>) => setSpeakers((current) => current.map((speaker, row) => row === index ? { ...speaker, ...values } : speaker));

  return <section className="content-section appreciation-section appreciation-form-section">
    <div className="section-heading"><div><p className="eyebrow">New record</p><h2>Create Certificate of Appreciation</h2><p className="muted">Enter one or more resource speakers and the event details. AGRISTAT and AMIA certificates print on A4; DRRM certificates print on landscape Letter paper. Each speaker gets a separate certificate.</p></div><button type="button" className="ghost-button" onClick={onCancel}>Cancel</button></div>
    {error && <p className="appreciation-error" role="alert">{error}</p>}
    <form className="permit-form appreciation-form" onSubmit={onSubmit}>
      <label className="wide-field">Certificate Template From<select name="unit" defaultValue="AMIA"><option value="AGRISTAT">FOD-AGRISTAT</option><option value="AMIA">FOD-AMIA</option><option value="DRRM">FOD-DRRM</option></select></label>
      <AppreciationSpeakersFieldset speakers={speakers} onChange={updateSpeaker} onAdd={() => setSpeakers((current) => [...current, { name: "", gender: "", position: "", office: "" }])} onRemove={(index) => setSpeakers((current) => current.filter((_, row) => row !== index))} />
      <label>Event&apos;s Title<input name="event-title" maxLength={240} required /></label>
      <label>Event&apos;s Destination<input name="event-destination" maxLength={240} value={eventDestination} onChange={(event) => setEventDestination(event.target.value)} required /></label>
      <div className="wide-field appreciation-schedule">
        <div className="appreciation-date-range"><label>Event&apos;s Date (From)<input name="event-date-from" type="date" value={eventDateFrom} onChange={(event) => { setEventDateFrom(event.target.value); if (eventDateTo && eventDateTo < event.target.value) setEventDateTo(""); }} required /></label><span>to</span><label>Event&apos;s Date (To)<input name="event-date-to" type="date" min={eventDateFrom || undefined} value={eventDateTo} onChange={(event) => setEventDateTo(event.target.value)} required /></label></div>
      </div>
      <label className="wide-field appreciation-checkbox"><input name="distribution-same" type="checkbox" value="yes" checked={sameLocation} onChange={(event) => setSameLocation(event.target.checked)} />Event&apos;s Destination is the same as where the certificate will be awarded</label>
      {!sameLocation && <label className="wide-field">Certificate Distribution Place<input name="distribution-place" maxLength={240} value={distributionPlace} onChange={(event) => setDistributionPlace(event.target.value)} required placeholder="Enter distribution place" /></label>}
      <div className="form-actions"><button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save"}</button></div>
    </form>
  </section>;
}

function AppreciationSpeakerForm({ record, onCancel, onSubmit, saving, error }: { record: AppreciationRecord; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; saving: boolean; error: string }) {
  const [speakers, setSpeakers] = useState<AppreciationSpeakerDraft[]>(() => recordSpeakers(record).map((speaker) => ({ ...speaker })));
  const updateSpeaker = (index: number, values: Partial<AppreciationSpeakerDraft>) => setSpeakers((current) => current.map((speaker, row) => row === index ? { ...speaker, ...values } : speaker));

  return <section className="content-section appreciation-section appreciation-form-section">
    <div className="section-heading"><div><p className="eyebrow">Correct record</p><h2>Edit resource speaker{speakers.length === 1 ? "" : "s"}</h2><p className="muted">Correct names or add speakers for {record.eventTitle}. Event details will stay the same.</p></div><button type="button" className="ghost-button" onClick={onCancel}>Cancel</button></div>
    {error && <p className="appreciation-error" role="alert">{error}</p>}
    <form className="permit-form appreciation-form" onSubmit={onSubmit}>
      <AppreciationSpeakersFieldset speakers={speakers} onChange={updateSpeaker} onAdd={() => setSpeakers((current) => [...current, { name: "", gender: "", position: "", office: "" }])} onRemove={(index) => setSpeakers((current) => current.filter((_, row) => row !== index))} />
      <div className="form-actions"><button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save"}</button></div>
    </form>
  </section>;
}

function AppreciationSpeakersFieldset({ speakers, onChange, onAdd, onRemove }: { speakers: AppreciationSpeakerDraft[]; onChange: (index: number, values: Partial<AppreciationSpeakerDraft>) => void; onAdd: () => void; onRemove: (index: number) => void }) {
  return <fieldset className="wide-field appreciation-speakers-fieldset">
    <legend>Resource Speaker&apos;s Details</legend>
    <p className="appreciation-speakers-hint">Each speaker will receive a separate Appreciation certificate.</p>
    {speakers.map((speaker, index) => <div className="appreciation-speaker-card" key={index}>
      <h3>Speaker {index + 1}</h3>
      <label>Name<input name="speaker-name" maxLength={180} value={speaker.name} onChange={(event) => onChange(index, { name: event.target.value })} required /></label>
      <label>Gender<select name="speaker-gender" value={speaker.gender} onChange={(event) => onChange(index, { gender: event.target.value as AppreciationSpeakerDraft["gender"] })} required><option value="" disabled>Select gender</option><option value="female">Female</option><option value="male">Male</option></select></label>
      <label>Position<input name="speaker-position" maxLength={180} value={speaker.position} onChange={(event) => onChange(index, { position: event.target.value })} required /></label>
      <label>Office<input name="speaker-office" maxLength={240} value={speaker.office} onChange={(event) => onChange(index, { office: event.target.value })} required /></label>
      {speakers.length > 1 && <button type="button" className="remove-participant" aria-label={`Delete speaker ${index + 1}`} onClick={() => onRemove(index)}>Delete</button>}
    </div>)}
    <button type="button" className="text-button plain-action add-item-text-button" disabled={speakers.length >= MAX_SPEAKERS} onClick={onAdd}>+ Add speaker</button>
  </fieldset>;
}

function AppreciationPaper({ record, speaker }: { record: AppreciationRecord; speaker: AppreciationSpeaker }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const objectPronoun = speaker.gender === "female" ? "her" : "his";

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let active = true;

    const fitBodyText = () => {
      if (!active) return;
      let low = 0.65;
      let high = 2;
      let best = low;
      const requiredHeight = () => {
        const items = Array.from(body.children) as HTMLElement[];
        const gap = Number.parseFloat(window.getComputedStyle(body).rowGap) || 0;
        return items.reduce((height, item) => height + item.getBoundingClientRect().height, 0) + Math.max(0, items.length - 1) * gap;
      };

      for (let step = 0; step < 14; step += 1) {
        const size = (low + high) / 2;
        body.style.setProperty("--appreciation-body-size", `${size}cqi`);
        if (requiredHeight() <= body.clientHeight + 1) {
          best = size;
          low = size;
        } else {
          high = size;
        }
      }

      body.style.setProperty("--appreciation-body-size", `${best}cqi`);
    };

    const observer = new ResizeObserver(fitBodyText);
    observer.observe(body);
    fitBodyText();
    void document.fonts.ready.then(fitBodyText);

    return () => {
      active = false;
      observer.disconnect();
    };
  }, [record]);

  if (record.unit === "AMIA") {
    const possessive = speaker.gender === "female" ? "her" : "his";
    return <article className="appreciation-paper appreciation-paper-amia">
      <img className="appreciation-blank appreciation-blank-amia" src={blankAmiaAppreciation} alt="" />
      <header className="appreciation-amia-letterhead">
        <img src={bagongPilipinasLogo} alt="Bagong Pilipinas" />
        <img src={daCaragaLogo} alt="Department of Agriculture Caraga Region" />
        <div className="appreciation-amia-agency">
          <span>Republic of the Philippines</span>
          <strong>Department of Agriculture</strong>
          <span>Regional Field Office – XIII</span>
          <span>Capitol Site, Butuan City</span>
        </div>
      </header>
      <p className="appreciation-amia-bestows">bestows this</p>
      <h2 className="appreciation-amia-title">Certificate of Appreciation</h2>
      <p className="appreciation-amia-to">to</p>
      <div className="appreciation-speaker-name appreciation-speaker-name-amia">{speaker.name}</div>
      <div className="appreciation-speaker-role appreciation-speaker-role-amia"><em>{speaker.position}</em>,{" "}<strong>{speaker.office}</strong></div>
      <div className="appreciation-body appreciation-body-amia" ref={bodyRef}>
        <p>in appreciation of {possessive} invaluable expertise and insight on {possessive} field as a <strong>RESOURCE SPEAKER</strong> in the <strong><em>{record.eventTitle}</em></strong> conducted on <strong>{displayDateRange(record.eventDateFrom, record.eventDateTo)}</strong> at {record.eventDestination}.</p>
        <p>Given this {ordinalDate(record.eventDateTo)} in at <strong>{countryLocation(record.distributionPlace)}</strong>.</p>
        <footer className="appreciation-signatory appreciation-signatory-amia"><strong>ENGR. RICARDO M. OÑATE JR.</strong><em>Regional Executive Director</em></footer>
      </div>
    </article>;
  }

  if (record.unit === "AGRISTAT") {
    return <article className="appreciation-paper appreciation-paper-agristat">
      <img className="appreciation-blank appreciation-blank-agristat" src={blankAgristatAppreciation} alt="" />
      <div className="appreciation-speaker-name appreciation-speaker-name-agristat">{speaker.name}</div>
      <div className="appreciation-speaker-role appreciation-speaker-role-agristat"><em>{speaker.position}</em>, {speaker.office}</div>
      <div className="appreciation-body appreciation-body-agristat" ref={bodyRef}>
        <p>For {objectPronoun} exemplary service, commitment, and invaluable shared insights as <strong>RESOURCE SPEAKER</strong> for <strong>{record.eventTitle}</strong> held on <strong>{displayDateRange(record.eventDateFrom, record.eventDateTo)}</strong> at <strong>{record.eventDestination}</strong>.</p>
        <p>Given this {ordinalDate(record.eventDateTo)} at <strong>{countryLocation(record.distributionPlace)}</strong>.</p>
        <footer className="appreciation-signatory appreciation-signatory-agristat"><strong>ENGR. RICARDO M. OÑATE JR.</strong><em>Regional Executive Director</em></footer>
      </div>
    </article>;
  }

  return <article className="appreciation-paper">
    <img className="appreciation-blank" src={blankAppreciation} alt="" />
    <div className="appreciation-speaker-name">{speaker.name}</div>
    <div className="appreciation-speaker-role"><em>{speaker.position}</em>, {speaker.office}</div>
    <div className="appreciation-body" ref={bodyRef}>
      <p>For {objectPronoun} exemplary service, commitment, and invaluable shared insights as <strong>RESOURCE SPEAKER</strong> for <strong>{record.eventTitle}</strong> held on <strong>{displayDateRange(record.eventDateFrom, record.eventDateTo)}</strong> at <strong>{record.eventDestination}</strong>.</p>
      <p>Given this {ordinalDate(record.eventDateTo)} at <strong>{countryLocation(record.distributionPlace)}</strong>.</p>
      <footer className="appreciation-signatory"><strong>ENGR. RICARDO M. O&#209;ATE JR.</strong><em>Regional Executive Director</em></footer>
    </div>

  </article>;
}
