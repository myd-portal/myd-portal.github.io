"use client";

import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { Timestamp } from "firebase/firestore";
import { generateReactHelpers } from "@uploadthing/react";
import { db } from "@/lib/firebase";
import type { AccountRole } from "@/lib/user-roles";
import DeleteConfirmation from "./DeleteConfirmation";
import {
  cleaningTaskCalendarWeeks,
  cleaningTaskUnits,
  cleaningWeekTimestamps,
  currentCleaningWeekStart,
  displayCleaningDate,
  displayCleaningDateTime,
  isCleaningTaskImageOutdated,
  isCleaningTaskUnit,
  manilaDateKey,
  shiftCleaningMonth,
  type CleaningTaskAssignment,
  type CleaningTaskImage,
  type CleaningTaskUnit,
} from "@/lib/cleaning-task";
import "./cleaning-task.css";

const uploadThingUrl = process.env.NEXT_PUBLIC_UPLOADTHING_URL || "/api/uploadthing";
const uploadThingConfigured = Boolean(process.env.NEXT_PUBLIC_UPLOADTHING_URL);
const maxCleaningImageBytes = 32 * 1024 * 1024;
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const currentCleaningTaskImageId = "current";
const { useUploadThing } = generateReactHelpers<any>({ url: uploadThingUrl });

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function cleaningWeekDateRange(weekStart: string) {
  const startDate = new Date(`${weekStart}T00:00:00+08:00`);
  const endDate = new Date(startDate.getTime() + 4 * 24 * 60 * 60 * 1000);
  const formatter = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" });
  const parts = (date: Date) => Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value] as const));
  const start = parts(startDate);
  const end = parts(endDate);

  if (start.year === end.year && start.month === end.month) return `${start.month} ${start.day}–${end.day}, ${end.year}`;
  if (start.year === end.year) return `${start.month} ${start.day}–${end.month} ${end.day}, ${end.year}`;
  return `${start.month} ${start.day}, ${start.year}–${end.month} ${end.day}, ${end.year}`;
}

async function loadCollagePhoto(file: File) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      image: bitmap as CanvasImageSource,
      width: bitmap.width,
      height: bitmap.height,
      cleanup: () => bitmap.close(),
    };
  }

  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch (cause) {
    URL.revokeObjectURL(url);
    throw cause;
  }
  return {
    image: image as CanvasImageSource,
    width: image.naturalWidth,
    height: image.naturalHeight,
    cleanup: () => URL.revokeObjectURL(url),
  };
}

async function mergeCleaningPhotos(files: File[]) {
  const columns = 2;
  const cellWidth = 1200;
  const cellHeight = 900;
  const inset = 24;
  const photoWidth = cellWidth - inset * 2;
  const photoHeight = cellHeight - inset * 2;
  const targetRatio = photoWidth / photoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = columns * cellWidth;
  canvas.height = 2 * cellHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser could not prepare the four-photo collage.");
  context.fillStyle = "#f8faf8";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  for (const [index, file] of files.entries()) {
    const photo = await loadCollagePhoto(file);
    try {
      let sourceX = 0;
      let sourceY = 0;
      let sourceWidth = photo.width;
      let sourceHeight = photo.height;
      if (photo.width / photo.height > targetRatio) {
        sourceWidth = photo.height * targetRatio;
        sourceX = (photo.width - sourceWidth) / 2;
      } else {
        sourceHeight = photo.width / targetRatio;
        sourceY = (photo.height - sourceHeight) / 2;
      }
      const cellX = (index % columns) * cellWidth;
      const cellY = Math.floor(index / columns) * cellHeight;
      context.drawImage(photo.image, sourceX, sourceY, sourceWidth, sourceHeight, cellX + inset, cellY + inset, photoWidth, photoHeight);
    } finally {
      photo.cleanup();
    }
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error("The four-photo collage could not be encoded.")), "image/jpeg", .9);
  });
  if (blob.size > maxCleaningImageBytes) throw new Error("The merged collage is too large to upload. Choose smaller source photos.");
  return new File([blob], `cleaning-task-${Date.now()}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
}

function isOngoing(assignment: CleaningTaskAssignment, now: Date) {
  const start = assignment.startAt?.toDate?.().getTime();
  const end = assignment.endAt?.toDate?.().getTime();
  return typeof start === "number" && typeof end === "number" && now.getTime() >= start && now.getTime() < end;
}

function isUpcoming(assignment: CleaningTaskAssignment, now: Date) {
  return Boolean(assignment.startAt?.toDate?.() && now.getTime() < assignment.startAt.toDate().getTime());
}

function taskStatus(assignment: CleaningTaskAssignment, now: Date) {
  if (isOngoing(assignment, now)) return "Ongoing";
  if (isUpcoming(assignment, now)) return "Up next";
  return "Completed";
}

export function canAccessCleaningTaskNavigation(role: AccountRole, _unit: string, _designation: string) {
  return role === "regular" || role === "admin" || role === "superadmin";
}

export function canViewCleaningTaskLanding(role: AccountRole, _unit: string) {
  return role === "regular" || role === "admin" || role === "superadmin";
}

export function CleaningTaskBoard({ user, role, unit, name, canUpload = false, mode = "landing" }: {
  user: User;
  role: AccountRole;
  unit: string;
  name: string;
  canUpload?: boolean;
  mode?: "landing" | "workspace";
}) {
  const [assignments, setAssignments] = useState<CleaningTaskAssignment[]>([]);
  const [images, setImages] = useState<CleaningTaskImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingPhotos, setPendingPhotos] = useState<File[] | null>(null);
  const [currentBarangay, setCurrentBarangay] = useState("");
  const [currentCity, setCurrentCity] = useState("");
  const [month, setMonth] = useState(() => manilaDateKey().slice(0, 7));
  const [now, setNow] = useState(() => new Date());
  const { startUpload } = useUploadThing("cleaningTaskImage", {
    headers: async () => ({ Authorization: `Bearer ${await user.getIdToken()}` }),
    onUploadError: (uploadError) => setError(uploadError.message || "The Cleaning Task image could not be uploaded."),
  });

  useEffect(() => {
    if (!db) {
      setError("Cleaning Task storage is unavailable.");
      setLoading(false);
      return;
    }
    const stopAssignments = onSnapshot(query(collection(db, "cleaningTaskAssignments"), orderBy("startAt", "desc"), limit(100)), (snapshot) => {
      setAssignments(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as CleaningTaskAssignment)));
      setLoading(false);
    }, (cause) => {
      setError(errorMessage(cause, "Could not load cleaning assignments."));
      setLoading(false);
    });
    const stopImages = onSnapshot(query(collection(db, "cleaningTaskImages"), orderBy("uploadedAt", "desc"), limit(10)), (snapshot) => {
      setImages(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as CleaningTaskImage)));
    }, (cause) => setError(errorMessage(cause, "Could not load cleaning photos.")));
    return () => { stopAssignments(); stopImages(); };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const currentWeekStart = currentCleaningWeekStart(now);
  const currentAssignment = assignments.find((assignment) => assignment.weekStart === currentWeekStart) ?? null;
  const currentImage = images.find((image) => image.id === currentCleaningTaskImageId) ?? null;
  const visibleImages = currentImage ? [currentImage] : images.slice(0, 1);
  const selectedWeeks = useMemo(() => cleaningTaskCalendarWeeks(month), [month]);

  async function uploadCleaningPhotos(files: File[], location: string) {
    setBusy(true);
    try {
      const collageFile = await mergeCleaningPhotos(files);
      const assignmentUnit = currentAssignment?.unit;
      if (!currentAssignment || !isCleaningTaskUnit(assignmentUnit) || !isOngoing(currentAssignment, new Date())) {
        throw new Error("There is no active Cleaning Task assignment for the current work week.");
      }
      const existing = currentImage;
      if (existing?.previousFileKey) {
        const cleanedPendingFile = await fetch(uploadThingUrl.replace(/\/api\/uploadthing\/?$/, "/api/delete-cleaning-task-image"), {
          method: "POST",
          headers: { Authorization: `Bearer ${await user.getIdToken()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ unit: existing.unit, imageId: currentCleaningTaskImageId, fileKey: existing.previousFileKey }),
        });
        if (!cleanedPendingFile.ok) throw new Error("The prior photo cleanup is still pending. Try the replacement again in a moment.");
        if (!db) throw new Error("Cleaning Task storage is unavailable.");
        await updateDoc(doc(db, "cleaningTaskImages", currentCleaningTaskImageId), { previousFileKey: "", previousFileOwnerId: "" });
      }
      const uploadedFiles = await startUpload([collageFile]);
      const uploaded = uploadedFiles?.[0] as {
        key?: string;
        ufsUrl?: string;
        url?: string;
        serverData?: { imageURL?: string; fileKey?: string };
      } | undefined;
      const imageURL = uploaded?.serverData?.imageURL ?? uploaded?.ufsUrl ?? uploaded?.url;
      const fileKey = uploaded?.serverData?.fileKey ?? uploaded?.key;
      if (!uploadedFiles || !imageURL || !fileKey) throw new Error("The photo uploaded, but its storage link was not returned.");
      if (!db) throw new Error("Cleaning Task storage is unavailable.");

      const imageData = {
        unit: assignmentUnit,
        imageURL,
        fileKey,
        previousFileKey: existing?.fileKey ?? "",
        previousFileOwnerId: existing?.uploaderId ?? "",
        uploaderId: user.uid,
        uploaderName: name.trim() || user.displayName?.trim() || "My Desk user",
        submittedWeekStart: currentWeekStart,
        location,
        uploadedAt: serverTimestamp(),
      };
      const imageReference = doc(db, "cleaningTaskImages", currentCleaningTaskImageId);
      if (existing) await setDoc(imageReference, imageData, { merge: true });
      else await setDoc(imageReference, imageData);

      let oldPhotoRemoved = !existing?.fileKey;
      if (existing?.fileKey) {
        try {
          const cleaned = await fetch(uploadThingUrl.replace(/\/api\/uploadthing\/?$/, "/api/delete-cleaning-task-image"), {
            method: "POST",
            headers: { Authorization: `Bearer ${await user.getIdToken()}`, "Content-Type": "application/json" },
            body: JSON.stringify({ unit: existing.unit, imageId: currentCleaningTaskImageId, fileKey: existing.fileKey }),
          });
          if (cleaned.ok) {
            await updateDoc(imageReference, { previousFileKey: "", previousFileOwnerId: "" });
            oldPhotoRemoved = true;
          }
        } catch {
          // Keep the prior key on the record so a future replacement can retry its cleanup.
        }
      }
      setSuccess(!existing?.fileKey
        ? "The Cleaning Task verification post is now published."
        : oldPhotoRemoved
          ? "The Cleaning Task verification post is updated; the previous photo has been removed."
          : "The Cleaning Task verification post is updated. The previous photo cleanup will retry after a future replacement.");
    } catch (cause) {
      setError(errorMessage(cause, "Could not save your Cleaning Task image."));
    } finally {
      setBusy(false);
    }
  }

  async function handleImageSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0) return;
    setError("");
    setSuccess("");
    if (!canUpload) {
      setError("This account cannot upload Cleaning Task images.");
      return;
    }
    if (!currentAssignment || !isOngoing(currentAssignment, now)) {
      setError("There is no active Cleaning Task assignment for the current work week.");
      return;
    }
    if (files.length !== 4) {
      setError("Select exactly 4 images to create the Cleaning Task collage.");
      return;
    }
    if (files.some((file) => !allowedImageTypes.has(file.type))) {
      setError("All 4 photos must be JPEG, PNG, or WebP images.");
      return;
    }
    if (files.some((file) => file.size > maxCleaningImageBytes)) {
      setError("Each source photo must be 32 MB or smaller.");
      return;
    }
    if (!uploadThingConfigured) {
      setError("Cleaning Task image uploads are not configured yet.");
      return;
    }
    setCurrentBarangay("");
    setCurrentCity("");
    setPendingPhotos(files);
  }

  if (mode === "landing" && !canViewCleaningTaskLanding(role, unit)) return null;

  return <section className={`cleaning-task-board${mode === "workspace" ? " is-workspace" : " is-landing"}`}>
    <header className="cleaning-task-heading">
      <div className="cleaning-task-heading-copy">
        <p className="eyebrow">Weekly office upkeep</p>
        <div className="cleaning-task-title-row">
          <h2>{mode === "workspace" ? "Cleaning Task" : "Cleaning Task Updates"}</h2>
          {mode === "workspace" && canUpload && <label className={`cleaning-task-upload-button${busy ? " is-busy" : ""}`}><span>{visibleImages.length > 0 ? "Replace photos" : "Upload"}</span><input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Choose exactly 4 photos to upload as one collage" multiple onChange={(event) => void handleImageSelection(event)} disabled={busy || !currentAssignment || !isOngoing(currentAssignment, now)} /></label>}
        </div>
        <p className="muted">{mode === "workspace" ? "Post or replace the shared verification during the active weekly assignment." : "Latest photo verification and the AGRISTAT, AMIA, and DRRM weekly cleaning schedule."}</p>
      </div>
    </header>
    {error && <p className="cleaning-task-message is-error" role="alert">{error}</p>}
    {success && <p className="cleaning-task-message is-success" role="status">{success}</p>}
    <div className="cleaning-task-layout">
      <section className="cleaning-task-photos" aria-label="Latest cleaning task photos">
        {loading ? <p className="muted">Loading Cleaning Task posts...</p> : visibleImages.length === 0 ? <div className="cleaning-task-empty"><strong>No photos posted yet</strong><span>The first assigned team photo will appear here.</span></div> : visibleImages.map((image) => {
          const outdated = !loading && isCleaningTaskImageOutdated(image, currentWeekStart);
          return <article className={`cleaning-task-photo${outdated ? " has-outdated-warning" : ""}`} key={image.id}>
            <header className="cleaning-task-photo-heading"><h3>Cleaning Task Photo Verification</h3></header>
            {outdated && <div className="cleaning-task-outdated" role="status"><span aria-hidden="true">!</span> Means of Verification is outdated!</div>}
            <div className="cleaning-task-photo-visual">
              <img src={image.imageURL} alt={`Four-photo ${image.unit} Cleaning Task collage uploaded by ${image.uploaderName}`} loading="lazy" />
            </div>
            <footer className="cleaning-task-photo-meta">
              <div><strong>Uploader:</strong><span>{image.uploaderName} - {image.unit}</span></div>
              <div><strong>Timestamp:</strong><span>{displayCleaningDateTime(image.uploadedAt)}</span></div>
              <div><strong>Location:</strong><span>{image.location}</span></div>
            </footer>
          </article>;
        })}
      </section>
      <section className="cleaning-task-calendar" aria-label="Cleaning Task assignment calendar">
        <header className="cleaning-calendar-header">
          <button type="button" className="cleaning-calendar-nav is-previous" aria-label="Previous month" onClick={() => setMonth((value) => shiftCleaningMonth(value, -1))}>‹</button>
          <h3>{new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric", timeZone: "Asia/Manila" }).format(new Date(`${month}-15T12:00:00+08:00`))}</h3>
          <div className="cleaning-calendar-controls"><button type="button" className="cleaning-calendar-nav" aria-label="Next month" onClick={() => setMonth((value) => shiftCleaningMonth(value, 1))}>›</button><button type="button" className="cleaning-calendar-today" onClick={() => setMonth(manilaDateKey().slice(0, 7))}>Today</button></div>
        </header>
        <div className="cleaning-calendar-grid cleaning-calendar-weekdays" aria-hidden="true">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day}>{day}</span>)}</div>
        <div className="cleaning-calendar-month">
          {selectedWeeks.map((week) => {
            const assignment = assignments.find((item) => item.weekStart === week.weekStart);
            const status = assignment ? taskStatus(assignment, now) : "";
            const friday = new Date(`${week.weekStart}T00:00:00Z`);
            friday.setUTCDate(friday.getUTCDate() + 4);
            const finalWeekday = friday.toISOString().slice(0, 10);
            const visibleAssignmentDays = week.days.map((day, index) => ({ ...day, index }))
              .filter((day) => day.inMonth && day.date >= week.weekStart && day.date <= finalWeekday);
            const assignmentStartColumn = visibleAssignmentDays[0]?.index;
            const assignmentEndColumn = visibleAssignmentDays[visibleAssignmentDays.length - 1]?.index;
            return <div className="cleaning-calendar-week" key={week.weekStart}>
              <div className="cleaning-calendar-grid cleaning-calendar-days">{week.days.map((day) => <div className={`cleaning-calendar-day${day.inMonth ? "" : " is-outside"}${day.date === manilaDateKey(now) ? " is-today" : ""}`} key={day.date}><span>{Number(day.date.slice(-2))}</span></div>)}</div>
              {assignment && assignmentStartColumn !== undefined && assignmentEndColumn !== undefined && <div className={`cleaning-calendar-assignment is-${status.toLowerCase().replaceAll(" ", "-")}`} style={{ gridColumn: `${assignmentStartColumn + 1} / ${assignmentEndColumn + 2}` }} title={`${assignment.unit} weekly cleaning task - ${status}`}><span>Office Cleaning Assignment - <strong>{assignment.unit}</strong></span></div>}
            </div>;
          })}
        </div>
        <div className="cleaning-task-legend" aria-label="Assignment status legend">
          <span><i className="is-completed" aria-hidden="true" />Completed</span>
          <span><i className="is-ongoing" aria-hidden="true" />Ongoing</span>
          <span><i className="is-upnext" aria-hidden="true" />Up Next</span>
        </div>
      </section>
    </div>
    <DeleteConfirmation
      open={pendingPhotos !== null}
      title="Current Location for this upload"
      description="Enter your current barangay and city. This location will be saved with the photo as Current Barangay, Current City."
      confirmLabel="Upload photos"
      confirmDisabled={!currentBarangay.trim() || !currentCity.trim()}
      onCancel={() => { setPendingPhotos(null); setCurrentBarangay(""); setCurrentCity(""); }}
      onConfirm={() => {
        if (!pendingPhotos) return;
        const selectedPhotos = pendingPhotos;
        const location = `${currentBarangay.trim()}, ${currentCity.trim()}`;
        setPendingPhotos(null);
        void uploadCleaningPhotos(selectedPhotos, location);
      }}
    >
      <div className="cleaning-task-location-fields">
        <label>Current Barangay<input autoComplete="address-level3" maxLength={88} required value={currentBarangay} onChange={(event) => setCurrentBarangay(event.target.value)} placeholder="Enter your current barangay" /></label>
        <label>Current City<input autoComplete="address-level2" maxLength={88} required value={currentCity} onChange={(event) => setCurrentCity(event.target.value)} placeholder="Enter your current city" /></label>
      </div>
    </DeleteConfirmation>
  </section>;
}

export function CleaningTaskAssignmentAdmin({ user }: { user: User }) {
  const [assignments, setAssignments] = useState<CleaningTaskAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [month, setMonth] = useState(() => manilaDateKey().slice(0, 7));
  const [year, setYear] = useState(() => manilaDateKey().slice(0, 4));
  const [weekStart, setWeekStart] = useState("");
  const [unit, setUnit] = useState<CleaningTaskUnit>("AGRISTAT");
  const weeks = useMemo(() => cleaningTaskCalendarWeeks(month), [month]);

  useEffect(() => {
    setWeekStart((current) => weeks.some((week) => week.weekStart === current) ? current : weeks[0]?.weekStart ?? "");
  }, [weeks]);

  useEffect(() => {
    const savedAssignment = assignments.find((assignment) => assignment.weekStart === weekStart);
    if (savedAssignment) setUnit(savedAssignment.unit);
  }, [assignments, weekStart]);

  useEffect(() => {
    if (!db) {
      setError("Cleaning Task storage is unavailable.");
      setLoading(false);
      return;
    }
    return onSnapshot(query(collection(db, "cleaningTaskAssignments"), orderBy("startAt", "desc"), limit(100)), (snapshot) => {
      setAssignments(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as CleaningTaskAssignment)));
      setLoading(false);
    }, (cause) => {
      setError(errorMessage(cause, "Could not load Cleaning Task assignments."));
      setLoading(false);
    });
  }, []);

  const selectedWeek = weeks.find((week) => week.weekStart === weekStart);
  const currentAssignment = assignments.find((assignment) => assignment.weekStart === weekStart);

  async function saveAssignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db || !selectedWeek) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const { startAt, endAt } = cleaningWeekTimestamps(selectedWeek.weekStart);
      await setDoc(doc(db, "cleaningTaskAssignments", selectedWeek.weekStart), {
        weekStart: selectedWeek.weekStart,
        month,
        weekNumber: selectedWeek.weekNumber,
        unit,
        startAt: Timestamp.fromDate(startAt),
        endAt: Timestamp.fromDate(endAt),
        assignedBy: user.uid,
        assignedAt: serverTimestamp(),
      });
      setMessage(`Week ${selectedWeek.weekNumber} is assigned to ${unit}.`);
    } catch (cause) {
      setError(errorMessage(cause, "Could not save the Cleaning Task assignment."));
    } finally {
      setSaving(false);
    }
  }

  return <section className="cleaning-assignment-admin content-section">
    <div className="section-heading cleaning-assignment-heading"><div><p className="eyebrow">Superadmin schedule</p><h2>Cleaning Task Assignment</h2><p className="muted">Assign one AGRISTAT, AMIA, or DRRM team to each Monday–Friday work week.</p></div><button className="primary-button cleaning-assignment-submit" type="submit" form="cleaning-assignment-form" disabled={saving || !selectedWeek}>{saving ? "Saving assignment..." : currentAssignment ? "Update assignment" : "Assign unit"}</button></div>
    {error && <p className="cleaning-task-message is-error" role="alert">{error}</p>}
    {message && <p className="cleaning-task-message is-success" role="status">{message}</p>}
    <form id="cleaning-assignment-form" className="cleaning-assignment-form" onSubmit={(event) => void saveAssignment(event)}>
      <label>Month<select value={month.slice(5, 7)} onChange={(event) => { setMonth(`${year}-${event.target.value}`); setMessage(""); }} required>{Array.from({ length: 12 }, (_, index) => { const value = String(index + 1).padStart(2, "0"); const label = new Intl.DateTimeFormat("en-PH", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, index, 1))); return <option value={value} key={value}>{label}</option>; })}</select></label>
      <label>Year<input type="number" value={year} min="2020" max="2100" aria-label="Year" onChange={(event) => { const nextYear = event.target.value; setYear(nextYear); if (/^\d{4}$/.test(nextYear)) setMonth(`${nextYear}-${month.slice(5, 7) || "01"}`); }} required /></label>
      <label>Week<select value={weekStart} onChange={(event) => setWeekStart(event.target.value)} required>{weeks.map((week) => <option value={week.weekStart} key={week.weekStart}>Week {week.weekNumber} · {week.weekStart}</option>)}</select></label>
      <label>Cleaning Assignment for<select value={unit} onChange={(event) => setUnit(event.target.value as CleaningTaskUnit)}>{cleaningTaskUnits.map((taskUnit) => <option value={taskUnit} key={taskUnit}>{taskUnit}</option>)}</select></label>
    </form>
    <div className="cleaning-admin-calendar">{loading ? <p className="muted">Loading weekly assignments...</p> : <div className="cleaning-admin-assignment-list">{weeks.map((week) => {
      const assignment = assignments.find((item) => item.weekStart === week.weekStart);
      return <button type="button" className={`cleaning-admin-week${week.weekStart === weekStart ? " is-selected" : ""}`} key={week.weekStart} onClick={() => { setWeekStart(week.weekStart); if (assignment) setUnit(assignment.unit); }}><span>Week {week.weekNumber}<small>{cleaningWeekDateRange(week.weekStart)}</small></span><strong>{assignment?.unit ?? "Not assigned"}</strong></button>;
    })}</div>}</div>
  </section>;
}
