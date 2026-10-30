"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { collection, doc, onSnapshot, query, serverTimestamp, where, writeBatch } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "@/lib/firebase";
import "./mynotes.css";
import "./mynotes-large.css";
import "./mynotes-mobile.css";

type NoteStatus = "Pending" | "Done";
type Note = {
  id: string;
  ownerId: string;
  date: string;
  task: string;
  status: NoteStatus;
  remarks: string;
  order: number;
  createdAt?: unknown;
};

const MAX_TASKS = 30;
const MAX_TEXT_LENGTH = 1200;

function manilaDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function isValidDateKey(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatNoteDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

function createdTime(value: unknown) {
  return value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function"
    ? value.toMillis() as number
    : 0;
}

function reorder<T>(items: T[], sourceIndex: number, targetIndex: number) {
  if (sourceIndex < 0 || sourceIndex >= items.length || targetIndex < 0 || targetIndex >= items.length || sourceIndex === targetIndex) return items;
  const reordered = [...items];
  const [item] = reordered.splice(sourceIndex, 1);
  reordered.splice(targetIndex, 0, item);
  return reordered;
}

function dropReordered(event: DragEvent<HTMLDivElement>, targetIndex: number, itemCount: number, onMove: (source: number, target: number) => void) {
  event.preventDefault();
  const draggedValue = event.dataTransfer.getData("text/plain");
  if (!/^\d+$/.test(draggedValue)) return;
  const sourceIndex = Number(draggedValue);
  const bounds = event.currentTarget.getBoundingClientRect();
  const insertionIndex = targetIndex + (event.clientY >= bounds.top + bounds.height / 2 ? 1 : 0);
  const destinationIndex = sourceIndex < insertionIndex ? insertionIndex - 1 : insertionIndex;
  if (destinationIndex >= 0 && destinationIndex < itemCount) onMove(sourceIndex, destinationIndex);
}

function DragGrip({ index, hintId, onMove, onDragStart, onDragEnd, className = "", disabled = false }: { index: number; hintId: string; onMove: (source: number, target: number) => void; onDragStart?: (index: number) => void; onDragEnd?: () => void; className?: string; disabled?: boolean }) {
  return <button
    type="button"
    className={`my-notes-drag-grip ${className}`}
    draggable
    disabled={disabled}
    aria-label={`Reorder task ${index + 1}`}
    aria-describedby={hintId}
    onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(index)); onDragStart?.(index); }}
    onDragEnd={onDragEnd}
    onKeyDown={(event) => {
      if (event.altKey && event.key === "ArrowUp" && index > 0) { event.preventDefault(); onMove(index, index - 1); }
      else if (event.altKey && event.key === "ArrowDown") { event.preventDefault(); onMove(index, index + 1); }
    }}
  ><svg className="my-notes-grip-icon" viewBox="0 0 12 20" aria-hidden="true"><circle cx="3" cy="3" r="1.7"/><circle cx="9" cy="3" r="1.7"/><circle cx="3" cy="10" r="1.7"/><circle cx="9" cy="10" r="1.7"/><circle cx="3" cy="17" r="1.7"/><circle cx="9" cy="17" r="1.7"/></svg></button>;
}

export default function MyNotes({ user }: { user: User }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [draftNotes, setDraftNotes] = useState<Note[]>([]);
  const [selectedDate, setSelectedDate] = useState(manilaDateKey);
  const [today, setToday] = useState(manilaDateKey);
  const [dateFilterTouched, setDateFilterTouched] = useState(false);
  const [formDate, setFormDate] = useState("");
  const [formTasks, setFormTasks] = useState([""]);
  const [draggedCreateIndex, setDraggedCreateIndex] = useState<number | null>(null);
  const [dropCreateIndex, setDropCreateIndex] = useState<number | null>(null);
  const [draggedEditIndex, setDraggedEditIndex] = useState<number | null>(null);
  const [dropEditIndex, setDropEditIndex] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadNotesKey, setReloadNotesKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const savingDraftRef = useRef(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  useEffect(() => {
    const interval = window.setInterval(() => setToday(manilaDateKey()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!dateFilterTouched) setSelectedDate(today);
  }, [dateFilterTouched, today]);

  useEffect(() => {
    if (!db) {
      setLoadError("Database is not configured.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError("");
    return onSnapshot(query(collection(db, "myNotes"), where("ownerId", "==", user.uid)), (snapshot) => {
      const loadedNotes = snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as Note));
      loadedNotes.sort((left, right) => right.date.localeCompare(left.date) || left.order - right.order || createdTime(left.createdAt) - createdTime(right.createdAt) || left.id.localeCompare(right.id));
      setNotes(loadedNotes);
      setLoadError("");
      setLoading(false);
    }, (cause) => {
      setLoadError(cause instanceof Error ? `Could not load your notes. ${cause.message}` : "Could not load your notes. Try again.");
      setLoading(false);
    });
  }, [reloadNotesKey, user.uid]);

  const records = useMemo(() => notes.filter((note) => note.date === selectedDate).sort((left, right) => left.order - right.order || createdTime(left.createdAt) - createdTime(right.createdAt) || left.id.localeCompare(right.id)), [notes, selectedDate]);

  useEffect(() => {
    setDraftNotes(records);
  }, [records]);

  const hasDraftChanges = draftNotes.length !== records.length || draftNotes.some((note, index) => {
    const saved = records[index];
    return !saved || note.id !== saved.id || note.task !== saved.task || note.status !== saved.status || note.remarks !== saved.remarks || note.order !== index;
  });
  const donePercentage = draftNotes.length ? Math.round(draftNotes.filter((note) => note.status === "Done").length / draftNotes.length * 100) : 0;

  useLayoutEffect(() => {
    const textareas = editorRef.current?.querySelectorAll<HTMLTextAreaElement>("textarea");
    textareas?.forEach((textarea) => {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight + 2}px`;
    });
  }, [draftNotes, selectedDate]);

  function startNewNotes() {
    if (savingDraftRef.current) return;
    if (hasDraftChanges && !window.confirm("Discard unsaved changes to this date's notes?")) return;
    setFormDate("");
    setFormTasks([""]);
    setMessage(null);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelNewNotes() {
    setShowForm(false);
    setFormTasks([""]);
    setMessage(null);
  }

  async function saveNewNotes(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    if (!db) { setMessage({ kind: "error", text: "Database is not configured." }); return; }
    const cleanTasks = formTasks.map((task) => task.trim());
    if (!isValidDateKey(formDate)) { setMessage({ kind: "error", text: "Choose a valid date." }); return; }
    if (cleanTasks.length === 0 || cleanTasks.length > MAX_TASKS || cleanTasks.some((task) => !task || task.length > MAX_TEXT_LENGTH)) {
      setMessage({ kind: "error", text: `Enter a task for each row, up to ${MAX_TASKS} tasks. Each task can contain up to ${MAX_TEXT_LENGTH} characters.` });
      return;
    }
    setSaving(true);
    try {
      const firestore = db;
      const batch = writeBatch(firestore);
      const existingOrders = notes.filter((note) => note.date === formDate).map((note) => note.order);
      const firstOrder = existingOrders.length ? Math.max(...existingOrders) + 1 : 0;
      const newNotes = cleanTasks.map((task, index) => {
        const reference = doc(collection(firestore, "myNotes"));
        batch.set(reference, { ownerId: user.uid, date: formDate, task, status: "Pending", remarks: "", order: firstOrder + index, createdAt: serverTimestamp() });
        return { id: reference.id, ownerId: user.uid, date: formDate, task, status: "Pending" as const, remarks: "", order: firstOrder + index, createdAt: Date.now() };
      });
      await batch.commit();
      setNotes((current) => {
        const next = [...current];
        newNotes.forEach((newNote) => {
          const existingIndex = next.findIndex((note) => note.id === newNote.id);
          if (existingIndex < 0) next.push(newNote);
          else next[existingIndex] = newNote;
        });
        return next;
      });
      setSelectedDate(formDate);
      setShowForm(false);
      setFormTasks([""]);
      setMessage({ kind: "success", text: "Notes saved." });
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error ? `Could not save your notes. ${cause.message}` : "Could not save your notes. Try again." });
    } finally {
      setSaving(false);
    }
  }

  function updateDraft(id: string, field: "task" | "status" | "remarks", value: string) {
    setDraftNotes((current) => current.map((note) => note.id === id ? { ...note, [field]: value } : note));
  }

  async function saveChanges() {
    if (savingDraftRef.current || !hasDraftChanges) return;
    setMessage(null);
    if (!db) { setMessage({ kind: "error", text: "Database is not configured." }); return; }
    if (draftNotes.some((note) => !note.task.trim() || note.task.trim().length > MAX_TEXT_LENGTH || note.remarks.length > MAX_TEXT_LENGTH)) {
      setMessage({ kind: "error", text: `Each task description is required and can contain up to ${MAX_TEXT_LENGTH} characters. Remarks can contain up to ${MAX_TEXT_LENGTH} characters.` });
      return;
    }
    savingDraftRef.current = true;
    setSaving(true);
    try {
      const firestore = db;
      for (let start = 0; start < draftNotes.length; start += 450) {
        const batch = writeBatch(firestore);
        draftNotes.slice(start, start + 450).forEach((note, offset) => {
          batch.update(doc(firestore, "myNotes", note.id), {
            task: note.task.trim(),
            status: note.status,
            remarks: note.remarks.trim(),
            order: start + offset,
          });
        });
        await batch.commit();
      }
      setNotes((current) => current.map((note) => {
        const index = draftNotes.findIndex((draft) => draft.id === note.id);
        return index >= 0 ? { ...draftNotes[index], task: draftNotes[index].task.trim(), remarks: draftNotes[index].remarks.trim(), order: index } : note;
      }));
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error ? `Could not update your notes. ${cause.message}` : "Could not update your notes. Try again." });
    } finally {
      savingDraftRef.current = false;
      setSaving(false);
    }
  }

  function moveDraft(sourceIndex: number, targetIndex: number) {
    setDraftNotes((current) => reorder(current, sourceIndex, targetIndex));
  }

  return <div className="my-notes-module">
    {showForm && <section className="content-section my-notes-entry-section">
      <div className="section-heading"><div><p className="eyebrow">myNotes · Data entry</p><h2>Add Notes</h2><p className="muted">Choose a date and list its tasks. Drag tasks to change their order.</p></div><button type="button" className="ghost-button" disabled={saving} onClick={cancelNewNotes}>Cancel</button></div>
      {message && <div className={`auth-message auth-message-${message.kind}`} role={message.kind === "error" ? "alert" : "status"}><span>{message.text}</span>{message.kind === "error" && hasDraftChanges && <button type="button" className="text-button" disabled={saving} onClick={() => void saveChanges()}>Retry save</button>}</div>}
      <form className="my-notes-form" onSubmit={saveNewNotes}>
        <label className="my-notes-date-field">Date<input type="date" value={formDate} onChange={(event) => setFormDate(event.target.value)} required disabled={saving} /></label>
        <fieldset className="my-notes-task-entry">
          <legend>Tasks</legend>
          <p id="my-notes-create-reorder-hint" className="my-notes-reorder-hint">Drag the grip to rearrange tasks, or focus a grip and press Alt + Up or Alt + Down.</p>
          <div className="my-notes-create-list">{formTasks.map((task, index) => <div className={`my-notes-create-row${draggedCreateIndex === index ? " is-dragging" : ""}${dropCreateIndex === index ? " is-drop-target" : ""}`} key={index} onDragOver={(event) => { event.preventDefault(); setDropCreateIndex(index); }} onDragLeave={() => setDropCreateIndex((current) => current === index ? null : current)} onDrop={(event) => { dropReordered(event, index, formTasks.length, (source, target) => setFormTasks((current) => reorder(current, source, target))); setDraggedCreateIndex(null); setDropCreateIndex(null); }}>
            <DragGrip index={index} hintId="my-notes-create-reorder-hint" onMove={(source, target) => setFormTasks((current) => reorder(current, source, target))} onDragStart={setDraggedCreateIndex} onDragEnd={() => { setDraggedCreateIndex(null); setDropCreateIndex(null); }} disabled={saving} />
            <label htmlFor={`my-notes-create-task-${index}`}>Task {index + 1}<textarea id={`my-notes-create-task-${index}`} value={task} maxLength={MAX_TEXT_LENGTH} rows={2} onChange={(event) => setFormTasks((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder="Describe the task" required disabled={saving} /></label>
            {formTasks.length > 1 && <button type="button" className="my-notes-remove-task" aria-label={`Delete task ${index + 1}`} disabled={saving} onClick={() => setFormTasks((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Delete</button>}
          </div>)}</div>
          {formTasks.length < MAX_TASKS && <button type="button" className="text-button plain-action add-item-text-button my-notes-add-task" disabled={saving} onClick={() => setFormTasks((current) => [...current, ""])}>+ Add task</button>}
        </fieldset>
        <div className="form-actions my-notes-form-actions"><button className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save"}</button></div>
      </form>
    </section>}

    {!showForm && <section className="content-section my-notes-records-section">
      <div className="section-heading my-notes-records-header"><p className="eyebrow">myNoted · Your records</p><div className="my-notes-record-toolbar"><label className="my-notes-filter-date">Date<input aria-label="Filter notes by date" type="date" value={selectedDate} onChange={(event) => { if (hasDraftChanges && !savingDraftRef.current && !window.confirm("Discard unsaved changes to this date's notes?")) return; setDateFilterTouched(true); setSelectedDate(event.target.value); }} /></label><div className="my-notes-progress" role="progressbar" aria-label="Tasks done" aria-valuemin={0} aria-valuemax={100} aria-valuenow={donePercentage}><span className="my-notes-progress-fill" style={{ width: `${donePercentage}%` }} /><span className="my-notes-progress-label">{donePercentage}%</span></div><button type="button" className="primary-button my-notes-add-button" onClick={startNewNotes}>Add</button></div></div>
      {message && <p className={`auth-message auth-message-${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
      {loading ? <p className="muted my-notes-loading-state" role="status">Loading your notes...</p> : loadError ? <div className="auth-message auth-message-error my-notes-load-error" role="alert"><span>{loadError}</span><button type="button" className="text-button" onClick={() => { setLoading(true); setReloadNotesKey((current) => current + 1); }}>Try Again</button></div> : records.length === 0 ? <div className="empty-state my-notes-empty-state"><span className="empty-number">00</span><h3>No notes for this date</h3><p>Tasks you add for {formatNoteDate(selectedDate)} will appear here.</p></div> : <>
        {saving && <p className="muted my-notes-saving-status" role="status">Saving changes...</p>}
        <div className="my-notes-editor" ref={editorRef} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void saveChanges(); }}>
        <p id="my-notes-edit-reorder-hint" className="my-notes-reorder-hint">Edit task descriptions, status, and remarks here. Drag the grip to reorder, or focus a grip and press Alt + Up or Alt + Down. Changes save automatically when you click outside the records.</p>
        <div className="my-notes-table-scroll"><div className="my-notes-table permit-table" role="table" aria-label={`Notes for ${formatNoteDate(selectedDate)}`}>
          <div className="my-notes-table-head table-head" role="row"><span aria-hidden="true" /><span role="columnheader">Task Description</span><span role="columnheader">Status</span><span role="columnheader">Remarks</span></div>
          {draftNotes.map((note, index) => <div className={`my-notes-table-row table-row${note.status === "Done" ? " is-done" : ""}${draggedEditIndex === index ? " is-dragging" : ""}${dropEditIndex === index ? " is-drop-target" : ""}`} role="row" key={note.id} onDragOver={(event) => { event.preventDefault(); setDropEditIndex(index); }} onDragLeave={() => setDropEditIndex((current) => current === index ? null : current)} onDrop={(event) => { dropReordered(event, index, draftNotes.length, moveDraft); setDraggedEditIndex(null); setDropEditIndex(null); }}>
            <div className="my-notes-row-number" role="cell"><DragGrip index={index} hintId="my-notes-edit-reorder-hint" onMove={moveDraft} onDragStart={setDraggedEditIndex} onDragEnd={() => { setDraggedEditIndex(null); setDropEditIndex(null); }} disabled={saving} /></div>
            <div role="cell" data-label="Task Description" className="my-notes-text-cell"><span className={`my-notes-text-preview${note.task ? "" : " is-placeholder"}`} aria-hidden="true">{note.task || "Describe the task"}</span><textarea aria-label={`Task description ${index + 1}`} maxLength={MAX_TEXT_LENGTH} rows={2} value={note.task} onChange={(event) => updateDraft(note.id, "task", event.target.value)} disabled={saving} /></div>
            <div role="cell" data-label="Status"><select className="status-select" data-status={note.status} aria-label={`Status for task ${index + 1}`} value={note.status} onChange={(event) => updateDraft(note.id, "status", event.target.value as NoteStatus)} disabled={saving}><option value="Pending">Pending</option><option value="Done">Done</option></select></div>
            <div role="cell" data-label="Remarks" className="my-notes-text-cell"><span className={`my-notes-text-preview${note.remarks ? "" : " is-placeholder"}`} aria-hidden="true">{note.remarks || "Add remarks"}</span><textarea aria-label={`Remarks for task ${index + 1}`} maxLength={MAX_TEXT_LENGTH} rows={2} value={note.remarks} onChange={(event) => updateDraft(note.id, "remarks", event.target.value)} placeholder="Add remarks" disabled={saving} /></div>
          </div>)}
        </div></div>
        </div>
      </>}
    </section>}
  </div>;
}
