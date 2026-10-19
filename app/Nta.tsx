"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { collection, doc, getDoc, getDocs, query, serverTimestamp, where, writeBatch } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "@/lib/firebase";
import NameSearchSelect from "./NameSearchSelect";
import { divisionSignatory, tevDivisions } from "@/lib/mytev";
import { loadPdfTools } from "@/lib/pdf-tools";
import { filterPersonnelForAccount, filterPersonnelForDivision, loadPersonnel as loadAccountPersonnel, personnelDisplayName, type PersonnelEntry } from "@/lib/personnel";
import { getDocumentNotificationReferences, makeDocumentNotification } from "@/lib/document-notifications";
import { loadUnitSharedRecords } from "@/lib/unit-shared-records";
import DeleteConfirmation from "./DeleteConfirmation";
import RecordPagination, { useRecordPagination } from "./RecordPagination";
import "./nta.css";

type NtaMode = "individual" | "batch" | "multiple";
const isGroupMode = (mode: NtaMode): mode is "batch" | "multiple" => mode !== "individual";
type NtaAttendee = { name: string; position?: string; office?: string; unit?: string; userId?: string; manual?: boolean };
type NtaBatch = {
  number: string;
  dateFrom: string;
  dateTo: string;
  timeFrom: string;
  timeTo: string;
  venueType: "physical" | "virtual";
  venue: string;
  link: string;
  attendees: NtaAttendee[];
};
type NtaRecord = {
  id: string;
  mode: NtaMode;
  to?: string;
  toUserId?: string;
  positionDesignation?: string;
  subject: string;
  activityTitle: string;
  organizer: string;
  signatoryName?: string;
  signatoryDesignation?: string;
  dateFrom?: string;
  dateTo?: string;
  timeFrom?: string;
  timeTo?: string;
  venueType?: "physical" | "virtual";
  venue?: string;
  link?: string;
  batches?: NtaBatch[];
  recipientIds?: string[];
  ownerId: string;
  ownerUnit?: string;
  createdAt?: unknown;
};

const asset = (path: string) => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
const ntaSignatories = [
  { name: "ENGR. RICARDO M. OÑATE JR.", designation: "Regional Executive Director" },
  { name: "REBECCA R. ATEGA", designation: "RTD for Operations" },
  { name: "MARCO ANTONIO C. MORIDO", designation: "RTD for Research and Regulation" },
  { name: "MELODY M. GUIMARY", designation: "Chief, Field Operations Division" },
] as const;
const legacySignatoryName = "MELODY M. GUIMARY";
const legacySignatoryDesignation = "Chief, Field Operations Division";
const ntaSignatoryOptions = [
  ...tevDivisions.map((division) => {
    const signatory = divisionSignatory(division);
    return {
      value: `division:${division}`,
      label: division,
      name: signatory.name,
      position: `${signatory.position}, ${division}`,
    };
  }),
  ...ntaSignatories
    .filter((signatory) => signatory.designation !== legacySignatoryDesignation)
    .map((signatory) => ({
      value: `role:${signatory.designation}`,
      label: signatory.designation,
      name: signatory.name,
      position: signatory.designation,
    })),
].sort((first, second) => first.label.localeCompare(second.label));
const formatDate = (date: string) => date ? new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeZone: "Asia/Manila" }).format(new Date(`${date}T12:00:00+08:00`)) : "";
const formatDateRange = (from: string, to: string) => from === to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`;
const ntaFormHelpText = "Choose an individual notice, group schedule, or multiple personnel notice.";
const ntaLegacyHelpText = "Update the activity information, schedule, venue, and designated personnel.";
const ntaGuidanceText = new Set([ntaFormHelpText, ntaLegacyHelpText, "Add the activity details and designated personnel."]);
const isNtaGuidanceText = (value?: string) => Boolean(value && ntaGuidanceText.has(value.trim()));
const cleanNtaField = (value?: string) => isNtaGuidanceText(value) ? "" : value ?? "";
const normalizePersonnelName = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
const initialBatch = (): NtaBatch => ({ number: "1", dateFrom: "", dateTo: "", timeFrom: "08:00", timeTo: "17:00", venueType: "physical", venue: "", link: "", attendees: [{ name: "", position: "", office: "", unit: "", userId: "", manual: false }] });

function NtaForm({ user, office, division, unit, onSaved, onCancel }: { user: User; office: string; division?: string | null; unit: string | null; onSaved: (record: NtaRecord) => void; onCancel: () => void }) {
  const [mode, setMode] = useState<NtaMode>("individual");
  const [to, setTo] = useState("");
  const [toUserId, setToUserId] = useState("");
  const [positionDesignation, setPositionDesignation] = useState("");
  const [manualRecipient, setManualRecipient] = useState(false);
  const [subject, setSubject] = useState("");
  const [activityTitle, setActivityTitle] = useState("");
  const [organizer, setOrganizer] = useState("");
  const [signatorySelection, setSignatorySelection] = useState("");
  const selectedSignatory = ntaSignatoryOptions.find((option) => option.value === signatorySelection);
  const signatoryField = (wide = false) => <label className={wide ? "wide-field" : undefined}>Signatory<select value={signatorySelection} onChange={(event) => setSignatorySelection(event.target.value)} required><option value="" disabled>Select a signatory</option>{ntaSignatoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [timeFrom, setTimeFrom] = useState("08:00");
  const [timeTo, setTimeTo] = useState("17:00");
  const [venueType, setVenueType] = useState<"physical" | "virtual">("physical");
  const [venue, setVenue] = useState("");
  const [link, setLink] = useState("");
  const [batches, setBatches] = useState<NtaBatch[]>([initialBatch()]);
  const [personnel, setPersonnel] = useState<PersonnelEntry[]>([]);
  const [personnelStatus, setPersonnelStatus] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadPersonnel() {
      try {
        const loadedPersonnel = filterPersonnelForDivision(await loadAccountPersonnel({ deduplicateByName: false }), office, division ?? "");
        if (!cancelled) {
          setPersonnel(loadedPersonnel);
          setPersonnelStatus("ready");
        }
      } catch {
        if (!cancelled) setPersonnelStatus("error");
      }
    }
    void loadPersonnel();
    return () => { cancelled = true; };
  }, [office, division, unit]);

  function updateBatch(index: number, update: Partial<NtaBatch>) {
    setBatches((current) => current.map((batch, itemIndex) => itemIndex === index ? { ...batch, ...update } : batch));
  }
  function updateAttendee(batchIndex: number, attendeeIndex: number, update: Partial<NtaAttendee>) {
    setBatches((current) => current.map((batch, index) => index === batchIndex ? { ...batch, attendees: batch.attendees.map((attendee, row) => row === attendeeIndex ? { ...attendee, ...update } : attendee) } : batch));
  }

  const selectedAttendeeUserIds = new Set(batches.flatMap((batch) => batch.attendees.flatMap((attendee) => !attendee.manual && attendee.userId ? [attendee.userId] : [])));
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db) { setError("Database is not configured."); return; }
    if (!unit) { setError("Your Unit / Program / Project is still loading. Try saving again in a moment."); return; }
    if (!selectedSignatory) { setError("Select a signatory."); return; }
    const formData = new FormData(event.currentTarget);
    const readField = (name: string, fallback: string) => {
      const submitted = formData.get(name);
      const value = typeof submitted === "string" ? submitted.trim() || fallback.trim() : fallback.trim();
      return cleanNtaField(value).trim();
    };
    const submittedSubject = readField("subject", subject);
    const submittedActivityTitle = readField("activityTitle", activityTitle);
    const submittedOrganizer = readField("organizer", organizer);
    const submittedDateFrom = mode === "individual" ? readField("dateFrom", dateFrom) : dateFrom;
    const submittedDateTo = mode === "individual" ? readField("dateTo", dateTo) : dateTo;
    const submittedTimeFrom = mode === "individual" ? readField("timeFrom", timeFrom) : timeFrom;
    const submittedTimeTo = mode === "individual" ? readField("timeTo", timeTo) : timeTo;
    const submittedVenue = mode === "individual" ? readField("venue", venue) : venue;
    if ([submittedSubject, submittedActivityTitle, submittedOrganizer].some((value) => !value)
      || (mode === "individual" && [submittedDateFrom, submittedDateTo, submittedVenue].some((value) => !value))) {
      setError("Enter the subject, activity title, organizer, date, and venue before saving.");
      return;
    }
    if (isGroupMode(mode) && batches.some((batch) => batch.attendees.some((attendee) => {
      const selectedPerson = attendee.manual ? undefined : personnel.find((person) => person.userId === attendee.userId);
      return !(attendee.manual ? attendee.unit?.trim() : selectedPerson?.unit?.trim() || attendee.unit?.trim());
    }))) {
      setError("Enter a Unit / Program / Project for every participant before saving.");
      return;
    }
    setBusy(true); setError("");
    const schedulesByRecipient = new Map<string, Array<{ dateFrom: string; dateTo: string; venue: string }>>();
    if (mode === "individual" && !manualRecipient && toUserId) schedulesByRecipient.set(toUserId, [{ dateFrom: submittedDateFrom, dateTo: submittedDateTo, venue: submittedVenue }]);
    if (isGroupMode(mode)) batches.forEach((batch) => batch.attendees.forEach((attendee) => {
      if (!attendee.userId) return;
      schedulesByRecipient.set(attendee.userId, [...(schedulesByRecipient.get(attendee.userId) ?? []), { dateFrom: batch.dateFrom, dateTo: batch.dateTo, venue: batch.venue.trim() }]);
    }));
    const recipientIds = [...schedulesByRecipient.keys()].filter((id) => id !== user.uid);
    const common = { mode, subject: submittedSubject, activityTitle: submittedActivityTitle, organizer: submittedOrganizer, signatoryName: selectedSignatory.name, signatoryDesignation: selectedSignatory.position, recipientIds, ownerId: user.uid, ownerUnit: unit, createdAt: serverTimestamp() };
    try {
      const data = mode === "individual"
        ? { ...common, to: to.trim(), toUserId: manualRecipient ? "" : toUserId, positionDesignation: positionDesignation.trim(), dateFrom: submittedDateFrom, dateTo: submittedDateTo, timeFrom: submittedTimeFrom, timeTo: submittedTimeTo, venueType, venue: submittedVenue, link: venueType === "virtual" ? link.trim() : "" }
        : { ...common, batches: batches.map((batch) => ({ ...batch, venue: batch.venue.trim(), link: batch.venueType === "virtual" ? batch.link.trim() : "", attendees: batch.attendees.map((attendee) => { const selectedPerson = attendee.manual ? undefined : personnel.find((person) => person.userId === attendee.userId); return { ...attendee, userId: attendee.manual ? "" : attendee.userId ?? "", name: attendee.manual ? attendee.name.trim() : selectedPerson?.name ?? attendee.name.trim(), position: attendee.manual ? attendee.position?.trim() ?? "" : selectedPerson?.position ?? attendee.position?.trim() ?? "", unit: attendee.manual ? attendee.unit?.trim() ?? "" : selectedPerson?.unit ?? attendee.unit?.trim() ?? "" }; }) })) };
      const firestore = db;
      const recordRef = doc(collection(firestore, "ntaRecords"));
      const batch = writeBatch(firestore);
      batch.set(recordRef, data);
      recipientIds.forEach((recipientId) => {
        const schedules = schedulesByRecipient.get(recipientId) ?? [];
        const notification = makeDocumentNotification(firestore, { recipientId, ownerId: user.uid, documentId: recordRef.id, documentType: "Notice to Attend", activityTitle: data.activityTitle, schedules });
        batch.set(notification.reference, notification.data);
      });
      await batch.commit();
      onSaved({ id: recordRef.id, ...data, createdAt: undefined } as NtaRecord);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save Notice to Attend.");
    } finally { setBusy(false); }
  }

  return <section className="content-section form-section nta-form-section">
    <div className="section-heading"><div><p className="eyebrow">New record</p><h2>Create Notice to Attend</h2><p className="muted">{ntaFormHelpText}</p></div><button type="button" className="ghost-button" onClick={onCancel}>Cancel</button></div>
    {error && <p className="error-message nta-error">{error}</p>}
    <form className="permit-form" onSubmit={save} autoComplete="off">
      <label className="wide-field">Notice type<select value={mode} onChange={(event) => setMode(event.target.value as NtaMode)}><option value="individual">Individual</option><option value="batch">Group</option><option value="multiple">Multiple Personnel</option></select></label>
      {mode === "individual" ? <>
        <div className="wide-field nta-recipient-fields"><div className={`nta-recipient-field-grid${manualRecipient ? "" : " nta-recipient-dropdown-grid"}`}>{manualRecipient ? <>
          <label>Personnel Name<input value={to} onChange={(event) => setTo(event.target.value)} required /></label>
          <label>Personnel Position<input value={positionDesignation} onChange={(event) => setPositionDesignation(event.target.value)} required /></label>
        </> : <div className="name-search-field"><span>Personnel Name</span><NameSearchSelect aria-label="Personnel Name" value={toUserId} onChange={(selectedId) => { const selectedPerson = personnel.find((person) => person.userId === selectedId); setToUserId(selectedId); setTo(selectedPerson?.name ?? ""); setPositionDesignation(selectedPerson?.position ?? ""); }} required disabled={personnelStatus !== "ready"}><option value="" disabled>{personnelStatus === "loading" ? "Loading personnel..." : personnelStatus === "error" ? "Personnel list unavailable" : "Select a personnel"}</option>{personnel.map((person) => <option key={person.userId} value={person.userId}>{personnelDisplayName(person)}</option>)}</NameSearchSelect>{personnelStatus === "error" && <span className="nta-personnel-error" role="alert">Unable to load personnel from user accounts. Use manual input or reload to try again.</span>}</div>}<label className="nta-manual-recipient-toggle"><input type="checkbox" aria-label="Enter personnel and position manually" checked={manualRecipient} onChange={(event) => { const enabled = event.target.checked; setManualRecipient(enabled); setToUserId(""); if (!enabled) { setTo(""); setPositionDesignation(""); } }} />Manual</label></div></div>
        <div className="wide-field nta-activity-fields">
          <label>Subject<input name="subject" value={subject} onChange={(event) => setSubject(cleanNtaField(event.target.value))} required /></label>
          <label>Title of Activity<input name="activityTitle" value={activityTitle} onChange={(event) => setActivityTitle(cleanNtaField(event.target.value))} required /></label>
          <label>Organizer / Host<input name="organizer" value={organizer} onChange={(event) => setOrganizer(cleanNtaField(event.target.value))} required /></label>
        </div>
        <div className="wide-field nta-schedule-fields">
        <div className="date-range-field"><span>Date (From – To)</span><div><input name="dateFrom" aria-label="Date from" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} required /><span>to</span><input name="dateTo" aria-label="Date to" type="date" min={dateFrom} value={dateTo} onChange={(event) => setDateTo(event.target.value)} required /></div></div>
        <div className="date-range-field"><span>Time</span><div><input name="timeFrom" aria-label="Time from" type="time" value={timeFrom} onChange={(event) => setTimeFrom(event.target.value)} required /><span>to</span><input name="timeTo" aria-label="Time to" type="time" value={timeTo} onChange={(event) => setTimeTo(event.target.value)} required /></div></div>
        </div>
        <div className={`wide-field nta-venue-fields${venueType === "virtual" ? " is-virtual" : ""}`}>
          <label>Venue type<select value={venueType} onChange={(event) => setVenueType(event.target.value as "physical" | "virtual")}><option value="physical">Physical venue</option><option value="virtual">Virtual platform</option></select></label>
        <label>{venueType === "virtual" ? "Platform name" : "Venue address"}<input name="venue" value={venue} onChange={(event) => setVenue(cleanNtaField(event.target.value))} placeholder={venueType === "virtual" ? "Google Meet, Zoom, etc." : "Street, Building, City, Province"} required /></label>
        {venueType === "virtual" && <label>Meeting link<input type="url" value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://" required /></label>}
        </div>
        {signatoryField(true)}
      </> : <>
        <div className="wide-field nta-activity-fields">
          <label>Subject<input name="subject" value={subject} onChange={(event) => setSubject(cleanNtaField(event.target.value))} required /></label>
          <label>Title of Activity<input name="activityTitle" value={activityTitle} onChange={(event) => setActivityTitle(cleanNtaField(event.target.value))} required /></label>
          <label>Organizer / Host<input name="organizer" value={organizer} onChange={(event) => setOrganizer(cleanNtaField(event.target.value))} required /></label>
        </div>
        <div className="wide-field nta-batches">{batches.map((batch, batchIndex) => <fieldset className="nta-batch-fieldset" key={batchIndex}><legend>Group {batch.number || batchIndex + 1}</legend>
          <div className="date-range-field"><span>Date (From – To)</span><div><input aria-label={`Group ${batchIndex + 1} date from`} type="date" value={batch.dateFrom} onChange={(event) => updateBatch(batchIndex, { dateFrom: event.target.value })} required /><span>to</span><input aria-label={`Group ${batchIndex + 1} date to`} type="date" min={batch.dateFrom} value={batch.dateTo} onChange={(event) => updateBatch(batchIndex, { dateTo: event.target.value })} required /></div></div>
          <div className="date-range-field"><span>Time</span><div><input aria-label={`Group ${batchIndex + 1} time from`} type="time" value={batch.timeFrom} onChange={(event) => updateBatch(batchIndex, { timeFrom: event.target.value })} required /><span>to</span><input aria-label={`Group ${batchIndex + 1} time to`} type="time" value={batch.timeTo} onChange={(event) => updateBatch(batchIndex, { timeTo: event.target.value })} required /></div></div>
          <label>Venue type<select value={batch.venueType} onChange={(event) => updateBatch(batchIndex, { venueType: event.target.value as "physical" | "virtual" })}><option value="physical">Physical venue</option><option value="virtual">Virtual meeting</option></select></label>
          <label>{batch.venueType === "virtual" ? "Platform" : "Place"}<input value={batch.venue} onChange={(event) => updateBatch(batchIndex, { venue: cleanNtaField(event.target.value) })} placeholder={batch.venueType === "virtual" ? "Google Meet, Zoom, etc." : "Street, Building, City, Province"} required /></label>
          {batch.venueType === "virtual" && <label className="wide-field">Meeting link<input type="url" value={batch.link} onChange={(event) => updateBatch(batchIndex, { link: event.target.value })} placeholder="https://" required /></label>}
          <div className="nta-attendee-fields"><span>Personnel attending this</span>{batch.attendees.map((attendee, attendeeIndex) => <div className={attendee.manual ? "nta-attendee-input nta-attendee-input-manual" : "nta-attendee-input nta-attendee-input-dropdown"} key={attendeeIndex}>{attendee.manual ? <div className="nta-attendee-manual-fields"><input aria-label={`Group ${batch.number} person ${attendeeIndex + 1} personnel name`} placeholder="Personnel Name" value={attendee.name} onChange={(event) => updateAttendee(batchIndex, attendeeIndex, { name: event.target.value })} required /><input aria-label={`Group ${batch.number} person ${attendeeIndex + 1} personnel position`} placeholder="Personnel Position" value={attendee.position ?? ""} onChange={(event) => updateAttendee(batchIndex, attendeeIndex, { position: event.target.value })} required /><input aria-label={`Group ${batch.number} person ${attendeeIndex + 1} personnel Unit / Program / Project`} placeholder="Unit / Program / Project" value={attendee.unit ?? ""} onChange={(event) => updateAttendee(batchIndex, attendeeIndex, { unit: event.target.value })} required /></div> : <><NameSearchSelect aria-label={`Group ${batch.number} person ${attendeeIndex + 1} personnel name`} value={attendee.userId ?? ""} onChange={(selectedId) => { const selected = personnel.find((person) => person.userId === selectedId); updateAttendee(batchIndex, attendeeIndex, { userId: selectedId, name: selected?.name ?? "", position: selected?.position ?? "", office: selected?.office ?? "", unit: selected?.unit ?? "" }); }} required disabled={personnelStatus !== "ready"}><option value="" disabled>{personnelStatus === "loading" ? "Loading personnel..." : personnelStatus === "error" ? "Personnel list unavailable" : "Select a personnel"}</option>{personnel.filter((person) => person.userId === attendee.userId || !selectedAttendeeUserIds.has(person.userId)).map((person) => <option key={person.userId} value={person.userId}>{personnelDisplayName(person)}</option>)}</NameSearchSelect></>}<label className="nta-manual-attendee-toggle"><input type="checkbox" aria-label={`Enter group ${batch.number} personnel details manually`} checked={Boolean(attendee.manual)} onChange={(event) => { const enabled = event.target.checked; updateAttendee(batchIndex, attendeeIndex, enabled ? { manual: true, userId: "" } : { manual: false, userId: "", name: "", position: "", office: "", unit: "" }); }} />Manual</label>{batch.attendees.length > 1 && <button type="button" className="remove-participant" aria-label={`Delete attendee ${attendeeIndex + 1} from group ${batch.number}`} onClick={() => updateBatch(batchIndex, { attendees: batch.attendees.filter((_, index) => index !== attendeeIndex) })}>Delete</button>}</div>)}{personnelStatus === "error" && <span className="nta-personnel-error" role="alert">Unable to load personnel from user accounts. Use manual input or reload to try again.</span>}<button type="button" className="text-button plain-action add-item-text-button" onClick={() => updateBatch(batchIndex, { attendees: [...batch.attendees, { name: "", position: "", office: "", unit: "", userId: "", manual: false }] })}>+ Add personnel</button></div>
          {batches.length > 1 && <button type="button" className="remove-participant nta-remove-batch" aria-label={`Delete group ${batch.number}`} onClick={() => setBatches((current) => current.filter((_, index) => index !== batchIndex))}>Delete</button>}
        </fieldset>)}<button type="button" className="text-button plain-action add-item-text-button" onClick={() => setBatches((current) => [...current, { ...initialBatch(), number: String(current.length + 1) }])}>+ Add group</button></div>
        {signatoryField(true)}
      </>}
      <div className="form-actions"><button className="primary-button" disabled={busy}>{busy ? "Saving..." : "Save"}</button></div>
    </form>
  </section>;
}

function NtaEditor({ record, userId, office, division, unit, onCancel, onSaved, onRemove }: { record: NtaRecord; userId: string; office: string; division?: string | null; unit: string | null; onCancel: () => void; onSaved: (record: NtaRecord) => void; onRemove: () => void }) {
  const [to, setTo] = useState(record.to ?? "");
  const [toUserId, setToUserId] = useState(record.toUserId ?? record.recipientIds?.[0] ?? "");
  const [positionDesignation, setPositionDesignation] = useState(record.positionDesignation ?? "");
  const [manualRecipient, setManualRecipient] = useState(!(record.toUserId ?? record.recipientIds?.[0]));
  const [subject, setSubject] = useState(cleanNtaField(record.subject));
  const [activityTitle, setActivityTitle] = useState(cleanNtaField(record.activityTitle));
  const [organizer, setOrganizer] = useState(cleanNtaField(record.organizer));
  const [dateFrom, setDateFrom] = useState(record.dateFrom ?? "");
  const [dateTo, setDateTo] = useState(record.dateTo ?? record.dateFrom ?? "");
  const [timeFrom, setTimeFrom] = useState(record.timeFrom ?? "");
  const [timeTo, setTimeTo] = useState(record.timeTo ?? "");
  const [venueType, setVenueType] = useState<"physical" | "virtual">(record.venueType ?? "physical");
  const [venue, setVenue] = useState(cleanNtaField(record.venue));
  const [link, setLink] = useState(record.link ?? "");
  const [batches, setBatches] = useState<NtaBatch[]>(() => (record.batches ?? []).map((batch) => ({ ...batch, timeFrom: batch.timeFrom ?? "", timeTo: batch.timeTo ?? "", venueType: batch.venueType ?? "physical", venue: cleanNtaField(batch.venue), link: batch.link ?? "", attendees: batch.attendees.map((attendee) => ({ ...attendee, manual: attendee.manual ?? !attendee.userId })) })));
  const hasLegacyPlaceholder = [record.subject, record.activityTitle, record.organizer, record.mode === "individual" ? record.venue : undefined, ...(record.batches ?? []).map((batch) => batch.venue)].some(isNtaGuidanceText);
  const [personnel, setPersonnel] = useState<PersonnelEntry[]>([]);
  const [personnelStatus, setPersonnelStatus] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadPersonnel() {
      try {
        const entries = filterPersonnelForAccount(await loadAccountPersonnel(), office, unit ?? "", { includeAdminAccounts: true, division: division ?? undefined });
        if (!cancelled) {
          setPersonnel(entries);
          setPersonnelStatus("ready");
        }
      } catch {
        if (!cancelled) setPersonnelStatus("error");
      }
    }
    void loadPersonnel();
    return () => { cancelled = true; };
  }, [office, division, unit]);

  function updateBatch(index: number, update: Partial<NtaBatch>) {
    setBatches((current) => current.map((batch, itemIndex) => itemIndex === index ? { ...batch, ...update } : batch));
  }

  function updateAttendee(batchIndex: number, attendeeIndex: number, update: Partial<NtaAttendee>) {
    setBatches((current) => current.map((batch, index) => index === batchIndex ? { ...batch, attendees: batch.attendees.map((attendee, row) => row === attendeeIndex ? { ...attendee, ...update } : attendee) } : batch));
  }

  const selectedAttendeeUserIds = new Set(batches.flatMap((batch) => batch.attendees.flatMap((attendee) => !attendee.manual && attendee.userId ? [attendee.userId] : [])));
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!db) { setError("Database is not configured."); return; }
    if ([subject, activityTitle, organizer].some((value) => !cleanNtaField(value.trim()))) { setError("Enter a subject, activity title, and organizer before saving."); return; }
    if (record.mode === "individual" && (!dateFrom || !dateTo || !venue.trim())) { setError("Enter the date and venue before saving."); return; }
    const cleanedBatches = batches.map((batch) => ({ ...batch, attendees: batch.attendees.map((attendee) => { const selected = attendee.manual ? undefined : personnel.find((person) => person.userId === attendee.userId); return { ...attendee, userId: attendee.manual ? "" : attendee.userId ?? "", name: attendee.manual ? attendee.name.trim() : selected?.name ?? attendee.name.trim(), position: attendee.manual ? attendee.position?.trim() ?? "" : selected?.position ?? attendee.position?.trim() ?? "", unit: attendee.manual ? attendee.unit?.trim() ?? "" : selected?.unit ?? attendee.unit?.trim() ?? "" }; }) }));
    const selectedPerson = !manualRecipient ? personnel.find((person) => person.userId === toUserId) : undefined;
    const individualName = manualRecipient ? to.trim() : selectedPerson?.name ?? to.trim();
    const individualPosition = manualRecipient ? positionDesignation.trim() : selectedPerson?.position ?? positionDesignation.trim();
    if (record.mode === "individual" && (manualRecipient ? (!individualName || !individualPosition) : (!toUserId || !individualName))) { setError("Select a personnel or enter a personnel name and position."); return; }
    if (isGroupMode(record.mode) && (!cleanedBatches.length || cleanedBatches.some((batch) => batch.attendees.length === 0 || batch.attendees.some((attendee) => !attendee.name || !attendee.unit || (attendee.manual && !attendee.position))))) { setError("Each group needs a personnel name and Unit / Program / Project; manual entries also need a position."); return; }
    setBusy(true); setError("");
    try {
      const schedulesByRecipient = new Map<string, Array<{ dateFrom: string; dateTo: string; venue: string }>>();
      if (record.mode === "individual") {
        const recipientId = manualRecipient ? "" : toUserId;
        if (recipientId && recipientId !== userId) schedulesByRecipient.set(recipientId, [{ dateFrom, dateTo: dateTo || dateFrom, venue: venue.trim() }]);
      } else {
        cleanedBatches.forEach((batch) => batch.attendees.forEach((attendee) => {
          if (!attendee.userId || attendee.userId === userId) return;
          schedulesByRecipient.set(attendee.userId, [...(schedulesByRecipient.get(attendee.userId) ?? []), { dateFrom: batch.dateFrom, dateTo: batch.dateTo, venue: batch.venue }]);
        }));
      }
      const recipientIds = [...schedulesByRecipient.keys()];
      const notificationDrafts = new Map<string, Parameters<typeof makeDocumentNotification>[1]>();
      schedulesByRecipient.forEach((schedules, recipientId) => {
        notificationDrafts.set(recipientId, { recipientId, ownerId: userId, documentId: record.id, documentType: "Notice to Attend", activityTitle: activityTitle.trim(), schedules });
      });
      const sharedUpdates = { subject: subject.trim(), activityTitle: activityTitle.trim(), organizer: organizer.trim() };
      const updates = record.mode === "individual"
        ? { ...sharedUpdates, to: individualName, toUserId: manualRecipient ? "" : toUserId, positionDesignation: individualPosition, dateFrom, dateTo: dateTo || dateFrom, timeFrom, timeTo, venueType, venue: venue.trim(), link: venueType === "virtual" ? link.trim() : "", recipientIds }
        : { ...sharedUpdates, batches: cleanedBatches, recipientIds };
      const firestore = db;
      const batch = writeBatch(firestore);
      batch.update(doc(firestore, "ntaRecords", record.id), updates);
      const existingNotifications = await getDocs(query(collection(firestore, "documentNotifications"), where("ownerId", "==", userId), where("documentId", "==", record.id)));
      const matchingRecipients = new Set<string>();
      existingNotifications.docs.forEach((notification) => {
        const data = notification.data();
        const recipientId = data.recipientId as string;
        const draft = notificationDrafts.get(recipientId);
        const sameSchedules = JSON.stringify(data.schedules ?? []) === JSON.stringify(draft?.schedules ?? []);
        const matchesDraft = Boolean(draft)
          && data.documentType === draft?.documentType
          && data.activityTitle === draft?.activityTitle
          && data.dateFrom === draft?.dateFrom
          && data.dateTo === draft?.dateTo
          && data.venue === draft?.venue
          && sameSchedules;
        if (draft && matchesDraft && !matchingRecipients.has(recipientId)) matchingRecipients.add(recipientId);
        else batch.delete(notification.ref);
      });
      notificationDrafts.forEach((draft, recipientId) => {
        if (matchingRecipients.has(recipientId)) return;
        const notification = makeDocumentNotification(firestore, draft);
        batch.set(notification.reference, notification.data);
      });
      await batch.commit();
      onSaved({ ...record, ...updates } as NtaRecord);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save Notice to Attend changes.");
    } finally { setBusy(false); }
  }

  return <section className="content-section form-section nta-form-section nta-edit-section">
    <div className="section-heading">
      <div><p className="eyebrow">Edit record</p><h2>Edit {record.mode === "individual" ? "individual notice" : record.mode === "multiple" ? "multiple personnel notice" : "group notice"}</h2><p className="muted">Update the activity information, schedule, venue, and designated personnel.</p></div>
      <button type="button" className="ghost-button" onClick={onCancel}>Cancel</button>
    </div>
    {hasLegacyPlaceholder && <p className="error-message nta-error" role="alert">Some saved activity details contained form guidance text and were cleared. Enter the missing subject, title, organizer, or venue before saving.</p>}
    {error && <p className="error-message nta-error">{error}</p>}
    <form className="permit-form" onSubmit={save} autoComplete="off">
      <div className="wide-field nta-edit-activity-fields">
        <label>Subject<input value={subject} onChange={(event) => setSubject(cleanNtaField(event.target.value))} required /></label>
        <label>Title of Activity<input value={activityTitle} onChange={(event) => setActivityTitle(cleanNtaField(event.target.value))} required /></label>
        <label>Organizer / Host<input value={organizer} onChange={(event) => setOrganizer(cleanNtaField(event.target.value))} required /></label>
      </div>
      {record.mode === "individual" ? <>
        <div className="wide-field nta-recipient-fields">
          <div className={`nta-recipient-field-grid${manualRecipient ? "" : " nta-recipient-dropdown-grid"}`}>
            {manualRecipient ? <>
              <label>Personnel Name<input value={to} onChange={(event) => setTo(event.target.value)} required /></label>
              <label>Personnel Position<input value={positionDesignation} onChange={(event) => setPositionDesignation(event.target.value)} required /></label>
            </> : <div className="name-search-field"><span>Personnel Name</span><NameSearchSelect aria-label="Personnel Name" value={toUserId} onChange={(selectedId) => { const selected = personnel.find((person) => person.userId === selectedId); setToUserId(selectedId); setTo(selected?.name ?? ""); setPositionDesignation(selected?.position ?? ""); }} required disabled={personnelStatus !== "ready"}><option value="" disabled>{personnelStatus === "loading" ? "Loading personnel..." : personnelStatus === "error" ? "Personnel list unavailable" : "Select a personnel"}</option>{personnel.map((person) => <option key={person.userId} value={person.userId}>{personnelDisplayName(person)}</option>)}</NameSearchSelect>{personnelStatus === "error" && <span className="nta-personnel-error" role="alert">Unable to load personnel from user accounts. Use manual input or reload to try again.</span>}</div>}
            <label className="nta-manual-recipient-toggle"><input type="checkbox" aria-label="Enter personnel and position manually" checked={manualRecipient} onChange={(event) => { const enabled = event.target.checked; setManualRecipient(enabled); setToUserId(""); if (!enabled) { setTo(""); setPositionDesignation(""); } }} />Manual</label>
          </div>
        </div>
        <div className="date-range-field"><span>Date (From – To)</span><div><input aria-label="Date from" type="date" value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); if (dateTo && event.target.value > dateTo) setDateTo(event.target.value); }} required /><span>to</span><input aria-label="Date to" type="date" min={dateFrom} value={dateTo} onChange={(event) => setDateTo(event.target.value)} required /></div></div>
        <div className="date-range-field"><span>Time</span><div><input aria-label="Time from" type="time" value={timeFrom} onChange={(event) => setTimeFrom(event.target.value)} /><span>to</span><input aria-label="Time to" type="time" value={timeTo} onChange={(event) => setTimeTo(event.target.value)} /></div></div>
        <div className={`wide-field nta-edit-venue-fields${venueType === "virtual" ? " is-virtual" : ""}`}>
          <label className="nta-edit-venue-type-field">Venue type<select value={venueType} onChange={(event) => setVenueType(event.target.value as "physical" | "virtual")}><option value="physical">Physical venue</option><option value="virtual">Virtual platform</option></select></label>
          <label>{venueType === "virtual" ? "Platform name" : "Venue address"}<input value={venue} onChange={(event) => setVenue(cleanNtaField(event.target.value))} placeholder={venueType === "virtual" ? "Google Meet, Zoom, etc." : "Street, Building, City, Province"} required /></label>
          {venueType === "virtual" && <label>Meeting link<input type="url" value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://" required /></label>}
        </div>
      </> : <div className="wide-field nta-batches">
        {batches.map((batch, batchIndex) => <fieldset className="nta-batch-fieldset" key={batchIndex}>
          <legend>Group {batch.number || batchIndex + 1}</legend>
          <div className="date-range-field"><span>Date (From – To)</span><div><input aria-label={`Group ${batch.number} date from`} type="date" value={batch.dateFrom} onChange={(event) => { const nextDateFrom = event.target.value; updateBatch(batchIndex, { dateFrom: nextDateFrom, dateTo: batch.dateTo && nextDateFrom > batch.dateTo ? nextDateFrom : batch.dateTo }); }} required /><span>to</span><input aria-label={`Group ${batch.number} date to`} type="date" min={batch.dateFrom} value={batch.dateTo} onChange={(event) => updateBatch(batchIndex, { dateTo: event.target.value })} required /></div></div>
          <div className="date-range-field"><span>Time</span><div><input aria-label={`Group ${batch.number} time from`} type="time" value={batch.timeFrom} onChange={(event) => updateBatch(batchIndex, { timeFrom: event.target.value })} required /><span>to</span><input aria-label={`Group ${batch.number} time to`} type="time" value={batch.timeTo} onChange={(event) => updateBatch(batchIndex, { timeTo: event.target.value })} required /></div></div>
          <label>Venue type<select value={batch.venueType} onChange={(event) => updateBatch(batchIndex, { venueType: event.target.value as "physical" | "virtual" })}><option value="physical">Physical venue</option><option value="virtual">Virtual platform</option></select></label>
          <label>{batch.venueType === "virtual" ? "Platform name" : "Venue address"}<input value={batch.venue} onChange={(event) => updateBatch(batchIndex, { venue: event.target.value })} placeholder={batch.venueType === "virtual" ? "Google Meet, Zoom, etc." : "Street, Building, City, Province"} required /></label>
          {batch.venueType === "virtual" && <label className="wide-field">Meeting link<input type="url" value={batch.link} onChange={(event) => updateBatch(batchIndex, { link: event.target.value })} placeholder="https://" required /></label>}
          <div className="nta-attendee-fields"><span>Personnel attending this group</span>{batch.attendees.map((attendee, attendeeIndex) => <div className={attendee.manual ? "nta-attendee-input nta-attendee-input-manual" : "nta-attendee-input nta-attendee-input-dropdown"} key={attendeeIndex}>
            {attendee.manual ? <div className="nta-attendee-manual-fields"><input aria-label={`Group ${batch.number} person ${attendeeIndex + 1} personnel name`} placeholder="Personnel Name" value={attendee.name} onChange={(event) => updateAttendee(batchIndex, attendeeIndex, { name: event.target.value })} required /><input aria-label={`Group ${batch.number} person ${attendeeIndex + 1} personnel position`} placeholder="Personnel Position" value={attendee.position ?? ""} onChange={(event) => updateAttendee(batchIndex, attendeeIndex, { position: event.target.value })} required /><input aria-label={`Group ${batch.number} person ${attendeeIndex + 1} personnel Unit / Program / Project`} placeholder="Unit / Program / Project" value={attendee.unit ?? ""} onChange={(event) => updateAttendee(batchIndex, attendeeIndex, { unit: event.target.value })} required /></div> : <NameSearchSelect aria-label={`Group ${batch.number} person ${attendeeIndex + 1} personnel name`} value={attendee.userId ?? ""} onChange={(selectedId) => { const selected = personnel.find((person) => person.userId === selectedId); updateAttendee(batchIndex, attendeeIndex, { userId: selectedId, name: selected?.name ?? "", position: selected?.position ?? "", office: selected?.office ?? "", unit: selected?.unit ?? "" }); }} required disabled={personnelStatus !== "ready"}><option value="" disabled>{personnelStatus === "loading" ? "Loading personnel..." : personnelStatus === "error" ? "Personnel list unavailable" : "Select a personnel"}</option>{personnel.filter((person) => person.userId === attendee.userId || !selectedAttendeeUserIds.has(person.userId)).map((person) => <option key={person.userId} value={person.userId}>{personnelDisplayName(person)}</option>)}</NameSearchSelect>}
            <label className="nta-manual-attendee-toggle"><input type="checkbox" aria-label={`Enter group ${batch.number} personnel details manually`} checked={Boolean(attendee.manual)} onChange={(event) => { const enabled = event.target.checked; updateAttendee(batchIndex, attendeeIndex, enabled ? { manual: true, userId: "" } : { manual: false, userId: "", name: "", position: "", office: "", unit: "" }); }} />Manual</label>
            {batch.attendees.length > 1 && <button type="button" className="remove-participant remove-action" aria-label={`Remove personnel ${attendeeIndex + 1} from group ${batch.number}`} onClick={() => updateBatch(batchIndex, { attendees: batch.attendees.filter((_, index) => index !== attendeeIndex) })}>Remove</button>}
          </div>)}{personnelStatus === "error" && <span className="nta-personnel-error" role="alert">Unable to load personnel from user accounts. Use manual input or reload to try again.</span>}<button type="button" className="text-button plain-action add-item-text-button" onClick={() => updateBatch(batchIndex, { attendees: [...batch.attendees, { name: "", position: "", office: "", unit: "", userId: "", manual: false }] })}>+ Add personnel</button></div>
          {batches.length > 1 && <button type="button" className="remove-participant nta-remove-batch" aria-label={`Remove group ${batch.number}`} onClick={() => setBatches((current) => current.filter((_, index) => index !== batchIndex))}>Remove group</button>}
        </fieldset>)}
      </div>}
      <div className="form-actions nta-edit-actions">{record.mode === "individual" && <button type="button" className="remove-participant nta-remove-notice remove-action" onClick={onRemove}>Remove notice</button>}<button className="primary-button" disabled={busy}>{busy ? "Saving..." : "Save changes"}</button></div>
    </form>
  </section>;
}

function NtaList({ records, ownerId, preparedByNames, fallbackPreparedBy, deletingId, copyingId, onNew, onEdit, onPreview, onCopy, onDelete }: { records: NtaRecord[]; ownerId: string; preparedByNames: Record<string, string>; fallbackPreparedBy: string; deletingId: string | null; copyingId: string | null; onNew: () => void; onEdit: (record: NtaRecord) => void; onPreview: (record: NtaRecord) => void; onCopy: (record: NtaRecord) => void; onDelete: (record: NtaRecord) => void }) {
  const { currentPage, pageCount, visibleRecords, setPage } = useRecordPagination(records);
  return <section className="content-section"><div className="section-heading"><div><p className="eyebrow">Your records</p><h2>Notices to Attend</h2><p className="muted">{records.length} {records.length === 1 ? "notice" : "notices"} available to your Unit / Program / Project.</p></div><button className="primary-button" onClick={onNew}>Add</button></div>{records.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No notices to attend yet</h3><p>Create an individual, group, or multiple personnel notice.</p><button className="text-button plain-action document-create-action" onClick={onNew}>Add a Notice To Attend</button></div> : <div className="permit-table"><RecordPagination totalRecords={records.length} currentPage={currentPage} pageCount={pageCount} onPageChange={setPage} label="Notice to Attend" /><div className="table-head nta-list-head"><span>Subject</span><span>Activity</span><span>Schedule</span><span>Prepared By</span><span></span></div>{visibleRecords.map((record) => {
    const isOwner = record.ownerId === ownerId;
    const schedules = record.mode === "individual"
      ? [[formatDateRange(record.dateFrom ?? "", record.dateTo ?? ""), record.timeFrom && record.timeTo ? `${formatTime(record.timeFrom)} – ${formatTime(record.timeTo)}` : ""].filter(Boolean).join(" · ")]
      : (record.batches ?? []).map((batch) => {
        const date = formatDateRange(batch.dateFrom, batch.dateTo);
        const start = formatTime(batch.timeFrom);
        const end = formatTime(batch.timeTo);
        const time = start || end ? `${start}${start && end ? " – " : ""}${end}` : "";
        return [date, time].filter(Boolean).join(" · ");
      }).filter(Boolean);
    return <div className="table-row nta-list-row" key={record.id}><span data-label="Subject">{cleanNtaField(record.subject) || "—"}</span><span data-label="Activity">{cleanNtaField(record.activityTitle) || "—"}</span><span className="nta-list-schedules" data-label="Schedule">{schedules.length ? schedules.map((schedule, index) => <span key={`${record.id}-schedule-${index}`}>{schedule}</span>) : <span>—</span>}</span><span data-label="Prepared By">{preparedByNames[record.ownerId] || (isOwner ? fallbackPreparedBy : "") || "—"}</span><span className="nta-list-actions">{isOwner && <button type="button" className="row-action" onClick={() => onEdit(record)}>Edit</button>}<button type="button" className="row-action" onClick={() => onPreview(record)}>View</button><button type="button" className="row-action" disabled={copyingId !== null || deletingId !== null} onClick={() => onCopy(record)}>{copyingId === record.id ? "Copying..." : "Copy"}</button>{isOwner && <button type="button" className="delete-button" disabled={deletingId !== null || copyingId !== null} onClick={() => onDelete(record)}>{deletingId === record.id ? "Deleting..." : "Delete"}</button>}</span></div>;
  })}</div>}</section>;
}

type NtaRosterSection = { batch: NtaBatch; batchIndex: number; attendees: NtaAttendee[]; startIndex: number; continued: boolean };
type NtaRosterPageSetting = { capacity: number; saturated: boolean };
type NtaIndividualClosingUnit = "feedback" | "expenses" | "issued" | "signatory";
const ntaIndividualClosingUnits: NtaIndividualClosingUnit[] = ["feedback", "expenses", "issued", "signatory"];

function buildRosterPages(batches: NtaBatch[], firstPageRows: number, pageSettings: NtaRosterPageSetting[]): NtaRosterSection[][] {
  const remaining = batches.flatMap((batch, batchIndex) => batch.attendees.slice(batchIndex === 0 ? firstPageRows : 0).map((attendee, index) => ({ batch, batchIndex, attendee, attendeeIndex: index + (batchIndex === 0 ? firstPageRows : 0) })));
  const pageRows: typeof remaining[] = [];
  let pageIndex = 0;
  while (remaining.length) {
    const pageCapacity = Math.max(1, pageSettings[pageIndex]?.capacity ?? 10);
    pageRows.push(remaining.splice(0, pageCapacity));
    pageIndex += 1;
  }
  return pageRows.map((rows) => rows.reduce<NtaRosterSection[]>((sections, row) => {
    const last = sections[sections.length - 1];
    if (last?.batchIndex === row.batchIndex) last.attendees.push(row.attendee);
    else sections.push({ batch: row.batch, batchIndex: row.batchIndex, attendees: [row.attendee], startIndex: row.attendeeIndex, continued: row.attendeeIndex > 0 });
    return sections;
  }, []));
}

function NtaSignatoryPosition({ designation }: { designation: string }) {
  const separator = designation.indexOf(", ");
  if (separator < 0) return <i>{designation}</i>;

  const position = designation.slice(0, separator + 1);
  const division = designation.slice(separator + 2);
  return division.endsWith("Division") ? <><i>{position}</i> {division}</> : <i>{designation}</i>;
}

function NtaPage({ record, page, rosterSections = [], showFixedCopy = false, firstPageRows = 0, individualClosingUnits = [], individualSignatoryPulledBack = false, individualClosingCompacted = false }: { record: NtaRecord; page: "individual" | "individual-continuation" | "batch-overview" | "batch-attendees" | "batch-copy"; rosterSections?: NtaRosterSection[]; showFixedCopy?: boolean; firstPageRows?: number; individualClosingUnits?: NtaIndividualClosingUnit[]; individualSignatoryPulledBack?: boolean; individualClosingCompacted?: boolean }) {
  const batches = record.batches ?? [];
  const individual = page === "individual";
  const batchOverview = page === "batch-overview";
  const signatoryName = record.signatoryName || legacySignatoryName;
  const signatoryDesignation = record.signatoryDesignation || legacySignatoryDesignation;
  return <article className="nta-document-page"><img className="nta-letterhead" src={asset("/Document-Header-Footer.jpg")} alt="" /><div className={`nta-document-content ${page}${showFixedCopy ? " nta-roster-copy-page" : ""}${record.mode === "multiple" ? " nta-multiple-personnel" : record.mode === "batch" ? " nta-group-notice" : ""}`}>
    {(individual || batchOverview) && <header className="nta-doc-title"><h1>NOTICE TO ATTEND</h1><p>No. ____________________</p><p>Series of {new Date().getFullYear()}</p></header>}
    {page === "batch-copy" ? <NtaFixedCopy /> : page === "individual-continuation" ? <NtaIndividualClosing units={individualClosingUnits} signatoryName={signatoryName} signatoryDesignation={signatoryDesignation} continuation compacted={individualClosingCompacted} /> : individual ? <>
      <section className="nta-to-subject"><div className="nta-to-recipient"><p><b>TO</b><strong>:</strong><strong>{record.to?.toUpperCase()}</strong></p>{record.positionDesignation && <p className="nta-position-line"><span aria-hidden="true" /><span aria-hidden="true" /><span>{record.positionDesignation}</span></p>}</div><p><b>SUBJECT</b><strong>:</strong><strong>{cleanNtaField(record.subject).toUpperCase() || "—"}</strong></p></section>
      <hr className="nta-rule" />
      <p className="nta-directed">You are hereby directed to attend the activity with the following details:</p>
      <dl className="nta-details"><div><dt>Title of Activity</dt><b>:</b><dd>{cleanNtaField(record.activityTitle) || "—"}</dd></div><div><dt>Organizer / Host</dt><b>:</b><dd>{cleanNtaField(record.organizer) || "—"}</dd></div><div><dt>Date(s)</dt><b>:</b><dd>{formatDateRange(record.dateFrom ?? "", record.dateTo ?? "")}</dd></div>{(record.timeFrom || record.timeTo) && <div><dt>Time</dt><b>:</b><dd>{record.timeFrom ? formatTime(record.timeFrom) : ""}{record.timeFrom && record.timeTo ? " – " : ""}{record.timeTo ? formatTime(record.timeTo) : ""}</dd></div>}<div><dt>Venue / Platform</dt><b>:</b><dd>{cleanNtaField(record.venue) || "—"}</dd></div>{record.venueType === "virtual" && <div><dt>Link</dt><b>:</b><dd className="nta-link">{record.link}</dd></div>}</dl>
      <NtaIndividualClosing units={individualClosingUnits} signatoryName={signatoryName} signatoryDesignation={signatoryDesignation} signatoryPulledBack={individualSignatoryPulledBack} compacted={individualClosingCompacted} />
    </> : batchOverview ? <>
      <section className="nta-to-subject"><p><b>TO</b><strong>:</strong><strong>ALL CONCERNED PERSONNEL</strong></p><p className="nta-office-line"><span /> <strong>This Office</strong></p><p><b>SUBJECT</b><strong>:</strong><strong>{cleanNtaField(record.subject).toUpperCase() || "—"}</strong></p></section>
      <hr className="nta-rule" />
      <p className="nta-directed">You are hereby directed to attend the activity with the following details:</p>
      <dl className="nta-details nta-batch-overview">{[
        ["Title", <strong key="title">{cleanNtaField(record.activityTitle) || "—"}</strong>],
        ["Organizer / Host", <strong key="organizer">{cleanNtaField(record.organizer) || "—"}</strong>],
        ["Date", batches.map((batch) => <strong key={batch.number}>{formatDateRange(batch.dateFrom, batch.dateTo)}</strong>)],
        ["Time", batches.map((batch) => <strong key={batch.number}>{formatTime(batch.timeFrom)} – {formatTime(batch.timeTo)}</strong>)],
        ["Venue / Platform", batches.map((batch) => <strong key={batch.number}>{cleanNtaField(batch.venue) || "—"}{batch.venueType === "virtual" && batch.link ? ` (${batch.link})` : ""}</strong>)],
      ].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><b>:</b><dd>{value}</dd></div>)}</dl>
      <p className="nta-attendance-intro">{record.mode === "multiple" ? "Designated Participant(s):" : "The said concerned personnel are as follows:"}</p><div className="nta-batch-tables nta-first-page-attendees">{firstPageRows > 0 && batches.slice(0, 1).map((batch) => <NtaBatchParticipants batch={{ ...batch, attendees: batch.attendees.slice(0, firstPageRows) }} key={batch.number} multiplePersonnel={record.mode === "multiple"} showCaption={record.mode === "batch" || (record.mode === "multiple" && batches.length > 1)} />)}</div>{showFixedCopy && <NtaFixedCopy />}
    </> : <>
      <div className="nta-batch-tables">{rosterSections.map((section) => <NtaBatchParticipants batch={{ ...section.batch, attendees: section.attendees }} startIndex={section.startIndex} showCaption={record.mode === "batch" || !section.continued} multiplePersonnel={record.mode === "multiple"} key={`${section.batchIndex}-${section.startIndex}`} />)}</div>{showFixedCopy && <NtaFixedCopy />}
    </>}
    {(showFixedCopy && (page === "batch-overview" || page === "batch-attendees" || page === "batch-copy")) && <footer className="nta-signatory"><strong>{signatoryName}</strong><span><NtaSignatoryPosition designation={signatoryDesignation} /></span></footer>}
  </div></article>;
}

function NtaIndividualClosing({ units, signatoryName, signatoryDesignation, signatoryPulledBack = false, continuation = false, compacted = false }: { units: NtaIndividualClosingUnit[]; signatoryName: string; signatoryDesignation: string; signatoryPulledBack?: boolean; continuation?: boolean; compacted?: boolean }) {
  if (units.length === 0) return null;
  return <div className={`nta-individual-closing${continuation ? " nta-individual-closing-continuation" : ""}${compacted ? " nta-individual-closing-compact" : ""}${signatoryPulledBack ? " nta-individual-closing-pulled" : ""}`}>
    {units.map((unit) => {
      if (unit === "signatory") return <footer className="nta-signatory nta-individual-closing-unit" data-nta-individual-closing-unit key={unit}><strong>{signatoryName}</strong><span><NtaSignatoryPosition designation={signatoryDesignation} /></span></footer>;
      const copy = {
        feedback: "As a representative, you are expected to actively participate and note key discussions and agreements. A brief report of feedback shall be submitted within ____ days after the activity.",
        expenses: "Travel and other incidental expenses, if any, shall be subject to existing accounting and auditing rules and regulations.",
        issued: `Issued this ____ day of ______________, ${new Date().getFullYear()}.`,
      }[unit];
      return <p className={`nta-individual-closing-unit${unit === "issued" ? " nta-individual-issued" : ""}`} data-nta-individual-closing-unit key={unit}>{copy}</p>;
    })}
  </div>;
}

function formatBatchCaption(batch: NtaBatch, includeLink: boolean) {
  const place = `${batch.venue}${includeLink && batch.venueType === "virtual" && batch.link ? ` – ${batch.link}` : ""}`;
  return `${place} (${formatDateRange(batch.dateFrom, batch.dateTo)} | ${formatTime(batch.timeFrom)} – ${formatTime(batch.timeTo)})`;
}

function NtaBatchTable({ batch, startIndex = 0, showCaption = true }: { batch: NtaBatch; startIndex?: number; showCaption?: boolean }) {
  return <section className="nta-attendance-batch">{showCaption && <p className="nta-batch-caption">{formatBatchCaption(batch, false)}</p>}<table><thead><tr><th>No.</th><th>Personnel</th><th>Position</th><th>Unit / Program / Project</th></tr></thead><tbody>{batch.attendees.map((attendee, index) => <tr data-nta-attendee-row key={`${attendee.name}-${index}`}><td>{startIndex + index + 1}</td><td><strong>{attendee.name}</strong></td><td>{attendee.position && <em>{attendee.position}</em>}</td><td>{attendee.unit}</td></tr>)}</tbody></table></section>;
}

function NtaBatchParticipants({ batch, startIndex = 0, showCaption = true, multiplePersonnel = false }: { batch: NtaBatch; startIndex?: number; showCaption?: boolean; multiplePersonnel?: boolean }) {
  if (!multiplePersonnel) return <NtaBatchTable batch={batch} startIndex={startIndex} showCaption={showCaption} />;
  return <section className="nta-attendance-batch">{showCaption && <p className="nta-batch-caption">{formatBatchCaption(batch, true)}</p>}<ol className="nta-participant-list" start={startIndex + 1}>{batch.attendees.map((attendee, index) => <li data-nta-attendee-row key={`${attendee.name}-${index}`}><strong>{attendee.name}</strong>{(attendee.position || attendee.unit) && <>{", "}{attendee.position && <em>{attendee.position}</em>}{attendee.position && attendee.unit && " - "}{attendee.unit}</>}</li>)}</ol></section>;
}

function formatTime(value: string) {
  if (!value) return "";
  const [hourText, minute] = value.split(":");
  const hour = Number(hourText);
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:${minute} ${suffix}`;
}

function NtaFixedCopy() {
  return <div className="nta-fixed-copy"><p>As a representative, you are expected to actively participate and note key discussions and agreements. A brief report of feedback shall be submitted within ____ days after the activity.</p><p>Travel and other incidental expenses, if any, shall be subject to existing accounting and auditing rules and regulations.</p><p className="nta-issued-date">Issued this ____ day of ______________, {new Date().getFullYear()}.</p></div>;
}

function NtaPreview({ record, onClose }: { record: NtaRecord; onClose: () => void }) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState("");
  const [measuredFirstPageRows, setMeasuredFirstPageRows] = useState<number | null>(null);
  const [rosterPageSettings, setRosterPageSettings] = useState<NtaRosterPageSetting[]>([{ capacity: 10, saturated: false }]);
  const [batchSinglePage, setBatchSinglePage] = useState(isGroupMode(record.mode) && record.batches?.length === 1);
  const [closingOnRosterPage, setClosingOnRosterPage] = useState(true);
  const [individualClosingCount, setIndividualClosingCount] = useState(ntaIndividualClosingUnits.length);
  const [individualClosingSaturated, setIndividualClosingSaturated] = useState(false);
  const [individualSignatoryPulledBack, setIndividualSignatoryPulledBack] = useState(false);
  const [individualClosingCompacted, setIndividualClosingCompacted] = useState(false);
  const rawBatches = record.batches ?? [];
  const [resolvedParticipantUnits, setResolvedParticipantUnits] = useState<Record<string, string>>({});
  useEffect(() => {
    const attendeesMissingUnits = rawBatches.flatMap((batch) => batch.attendees
      .filter((attendee) => !attendee.unit?.trim() && (attendee.userId || attendee.name.trim())));
    if (attendeesMissingUnits.length === 0) return;
    let cancelled = false;
    void loadAccountPersonnel({ deduplicateByName: false }).then((entries) => {
      if (cancelled) return;
      const resolvedUnits = Object.fromEntries(entries
        .filter((person) => person.unit)
        .map((person) => [person.userId, person.unit]));
      const unitsByName = new Map<string, Set<string>>();
      entries.forEach((person) => {
        const name = normalizePersonnelName(person.name);
        if (!name || !person.unit) return;
        const units = unitsByName.get(name) ?? new Set<string>();
        units.add(person.unit);
        unitsByName.set(name, units);
      });
      attendeesMissingUnits.forEach((attendee) => {
        const name = normalizePersonnelName(attendee.name);
        const matchingUnits = unitsByName.get(name);
        if (name && matchingUnits?.size === 1) resolvedUnits[`name:${name}`] = [...matchingUnits][0];
      });
      setResolvedParticipantUnits(resolvedUnits);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [record.id, rawBatches]);
  const batches = rawBatches.map((batch) => ({
    ...batch,
    attendees: batch.attendees.map((attendee) => ({
      ...attendee,
      unit: attendee.unit || (attendee.userId ? resolvedParticipantUnits[attendee.userId] : "") || resolvedParticipantUnits[`name:${normalizePersonnelName(attendee.name)}`] || "",
    })),
  }));
  const firstPageRows = measuredFirstPageRows ?? batches[0]?.attendees.length ?? 0;
  const rosterPages = isGroupMode(record.mode) ? buildRosterPages(batches, firstPageRows, rosterPageSettings) : [];
  let safeIndividualClosingCount = individualClosingCount;
  if (ntaIndividualClosingUnits.length - safeIndividualClosingCount === 1 && ntaIndividualClosingUnits[safeIndividualClosingCount] === "signatory") safeIndividualClosingCount = Math.max(0, safeIndividualClosingCount - 1);
  const individualFirstPageClosing = ntaIndividualClosingUnits.slice(0, safeIndividualClosingCount);
  const individualContinuationClosing = ntaIndividualClosingUnits.slice(safeIndividualClosingCount);
  useEffect(() => {
    const recalculateClosingLayout = () => {
      setIndividualClosingCount(ntaIndividualClosingUnits.length);
      setIndividualClosingSaturated(false);
      setIndividualSignatoryPulledBack(false);
      setIndividualClosingCompacted(false);
      if (isGroupMode(record.mode)) {
        setMeasuredFirstPageRows(null);
        setRosterPageSettings([{ capacity: 10, saturated: false }]);
        setBatchSinglePage(record.batches?.length === 1);
        setClosingOnRosterPage(true);
      }
    };
    recalculateClosingLayout();
    window.addEventListener("resize", recalculateClosingLayout);
    return () => window.removeEventListener("resize", recalculateClosingLayout);
  }, [record.id, record.mode]);
  useLayoutEffect(() => {
    if (!pagesRef.current) return;
    const pageLimit = (page: HTMLElement) => {
      const rect = page.getBoundingClientRect();
      // Reserve the NTA's 0.2in bottom margin when fitting page content.
      return rect.bottom - rect.width * .0242;
    };
    if (record.mode === "individual") {
      const firstPageContent = pagesRef.current.querySelector<HTMLElement>(".nta-document-content.individual");
      const firstPage = firstPageContent?.closest<HTMLElement>(".nta-document-page");
      if (!firstPage || !firstPageContent) return;
      if (safeIndividualClosingCount !== individualClosingCount) {
        setIndividualClosingCount(safeIndividualClosingCount);
        setIndividualClosingSaturated(true);
        return;
      }
      const units = Array.from(firstPageContent.querySelectorAll<HTMLElement>("[data-nta-individual-closing-unit]"));
      const fitCount = units.filter((unit) => unit.getBoundingClientRect().bottom <= pageLimit(firstPage)).length;
      const signatureOnlyOverflows = units[units.length - 1]?.classList.contains("nta-signatory") && fitCount === units.length - 1;
      if (fitCount < units.length && !individualClosingCompacted) {
        setIndividualClosingCompacted(true);
        return;
      }
      if (signatureOnlyOverflows && individualClosingCount === ntaIndividualClosingUnits.length && !individualSignatoryPulledBack) {
        setIndividualSignatoryPulledBack(true);
        return;
      }
      if (signatureOnlyOverflows && individualSignatoryPulledBack) {
        setIndividualClosingCount(Math.max(0, fitCount - 2));
        setIndividualClosingSaturated(true);
        setIndividualSignatoryPulledBack(false);
        return;
      }
      if (fitCount < units.length) {
        const wouldLeaveOnlyDateAndSignatory = ntaIndividualClosingUnits.slice(fitCount).length === 2
          && ntaIndividualClosingUnits[fitCount] === "issued"
          && ntaIndividualClosingUnits[fitCount + 1] === "signatory";
        const nextClosingCount = wouldLeaveOnlyDateAndSignatory ? Math.max(0, fitCount - 1) : fitCount;
        if (nextClosingCount !== safeIndividualClosingCount) setIndividualClosingCount(nextClosingCount);
        setIndividualClosingSaturated(true);
        if (individualSignatoryPulledBack) setIndividualSignatoryPulledBack(false);
        return;
      }
      if (safeIndividualClosingCount < ntaIndividualClosingUnits.length && !individualClosingSaturated) {
        const nextCount = safeIndividualClosingCount + 1;
        if (ntaIndividualClosingUnits.length - nextCount === 1 && ntaIndividualClosingUnits[nextCount] === "signatory") {
          setIndividualClosingSaturated(true);
          return;
        }
        setIndividualClosingCount(nextCount);
      }
      return;
    }
    if (!isGroupMode(record.mode)) return;
    const firstPageContent = pagesRef.current.querySelector<HTMLElement>(".nta-document-content.batch-overview");
    const firstPage = firstPageContent?.closest<HTMLElement>(".nta-document-page");
    if (!firstPage) return;
    const bottomLimit = pageLimit(firstPage);
    const rows = Array.from(firstPage.querySelectorAll<HTMLElement>(".nta-first-page-attendees [data-nta-attendee-row]"));
    if (batchSinglePage) {
      const allRowsFit = rows.length === (batches[0]?.attendees.length ?? 0) && rows.every((row) => row.getBoundingClientRect().bottom <= bottomLimit);
      const trailingBlocks = Array.from(firstPage.querySelectorAll<HTMLElement>(".nta-fixed-copy, .nta-signatory"));
      const trailingContentFits = trailingBlocks.every((block) => block.getBoundingClientRect().bottom <= bottomLimit);
      if (allRowsFit && trailingContentFits) {
        if (measuredFirstPageRows !== rows.length) setMeasuredFirstPageRows(rows.length);
        return;
      }
      setBatchSinglePage(false);
      setMeasuredFirstPageRows(allRowsFit ? rows.length : null);
      return;
    }
    const rowsThatFit = rows.filter((row) => row.getBoundingClientRect().bottom <= bottomLimit).length;
    setMeasuredFirstPageRows(rowsThatFit);
    const continuationPages = Array.from(pagesRef.current.querySelectorAll<HTMLElement>(".nta-document-content.batch-attendees"));
    const nextSettings = [...rosterPageSettings];
    let settingsChanged = false;
    for (let pageIndex = 0; pageIndex < continuationPages.length; pageIndex += 1) {
      const content = continuationPages[pageIndex];
      const currentSetting = nextSettings[pageIndex] ?? { capacity: 10, saturated: false };
      const page = content.closest<HTMLElement>(".nta-document-page");
      if (!page) continue;
      const limit = pageLimit(page);
      const tableRows = Array.from(content.querySelectorAll<HTMLElement>("[data-nta-attendee-row]"));
      const fitCount = tableRows.filter((row) => row.getBoundingClientRect().bottom <= limit).length;
      if (fitCount < tableRows.length) {
        const fittedCapacity = Math.max(1, fitCount);
        if (fittedCapacity !== currentSetting.capacity || !currentSetting.saturated) {
          nextSettings[pageIndex] = { capacity: fittedCapacity, saturated: true };
          for (let laterPage = pageIndex + 1; laterPage < nextSettings.length; laterPage += 1) {
            const laterSetting = nextSettings[laterPage] ?? { capacity: 10, saturated: false };
            nextSettings[laterPage] = { ...laterSetting, saturated: false };
          }
          settingsChanged = true;
          break;
        }
      } else if (pageIndex < continuationPages.length - 1 && tableRows.length === currentSetting.capacity && !currentSetting.saturated) {
        nextSettings[pageIndex] = { capacity: currentSetting.capacity + 1, saturated: false };
        for (let laterPage = pageIndex + 1; laterPage < nextSettings.length; laterPage += 1) {
          const laterSetting = nextSettings[laterPage] ?? { capacity: 10, saturated: false };
          nextSettings[laterPage] = { ...laterSetting, saturated: false };
        }
        settingsChanged = true;
        break;
      }
    }
    if (!settingsChanged && closingOnRosterPage && continuationPages.length) {
      const lastPageIndex = continuationPages.length - 1;
      const lastContent = continuationPages[lastPageIndex];
      const lastPage = lastContent.closest<HTMLElement>(".nta-document-page");
      const lastRows = Array.from(lastContent.querySelectorAll<HTMLElement>("[data-nta-attendee-row]"));
      const closingBlocks = Array.from(lastContent.querySelectorAll<HTMLElement>(".nta-fixed-copy, .nta-signatory"));
      if (lastPage && closingBlocks.some((block) => block.getBoundingClientRect().bottom > pageLimit(lastPage))) {
        if (lastRows.length > 1) {
          nextSettings[lastPageIndex] = { capacity: lastRows.length - 1, saturated: true };
          settingsChanged = true;
        } else {
          setClosingOnRosterPage(false);
          return;
        }
      }
    }
    if (settingsChanged) setRosterPageSettings(nextSettings);
  }, [record, firstPageRows, rosterPageSettings, rosterPages.length, individualClosingCount, individualClosingSaturated, individualSignatoryPulledBack, individualClosingCompacted, safeIndividualClosingCount, batchSinglePage, measuredFirstPageRows, closingOnRosterPage, resolvedParticipantUnits]);
  async function downloadPdf() {
    if (!pagesRef.current) return;
    setDownloading(true); setError("");
    try {
      const { html2canvas, jsPDF } = await loadPdfTools();
      await Promise.all(Array.from(pagesRef.current.querySelectorAll("img")).map(async (img) => { if (!img.complete) await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("The notice letterhead could not be loaded.")); }); if (img.decode) await img.decode(); }));
      const pageElements = Array.from(pagesRef.current.querySelectorAll<HTMLElement>(".nta-document-page"));
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      for (let index = 0; index < pageElements.length; index += 1) {
        const canvas = await html2canvas(pageElements[index], { backgroundColor: "#fff", logging: false, scale: 3, useCORS: true });
        if (index) pdf.addPage();
        pdf.addImage(canvas.toDataURL("image/jpeg", .95), "JPEG", 0, 0, 210, 297);
      }
      pdf.save(`notice-to-attend-${record.mode}-${record.id}.pdf`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create the PDF."); }
    finally { setDownloading(false); }
  }

  async function printPreview() {
    if (!pagesRef.current) return;
    setPrinting(true);
    setPrintError("");
    try {
      await Promise.all(Array.from(pagesRef.current.querySelectorAll("img")).map(async (image) => {
        if (!image.complete) await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("The notice letterhead could not be loaded."));
        });
        if (image.naturalWidth === 0) throw new Error("The notice letterhead could not be loaded.");
        if (image.decode) await image.decode();
      }));
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      window.print();
    } catch (cause) {
      setPrintError(cause instanceof Error ? cause.message : "Unable to prepare the NTA for printing.");
    } finally {
      setPrinting(false);
    }
  }

  return <div className="preview-backdrop nta-preview-backdrop"><div className="preview-toolbar"><span>NTA preview</span><button type="button" className="ghost-button" onClick={onClose}>Close</button><button type="button" className="pdf-button" disabled={downloading} onClick={downloadPdf}>{downloading ? "Preparing PDF..." : "Download PDF"}</button><button type="button" className="pdf-button" disabled={printing} onClick={printPreview}>{printing ? "Preparing print..." : "Print"}</button>{error && <small className="download-error">{error}</small>}{printError && <small className="download-error" role="alert">{printError}</small>}</div><div ref={pagesRef} className="nta-preview-pages">{record.mode === "individual" ? <><NtaPage record={record} page="individual" individualClosingUnits={individualFirstPageClosing} individualSignatoryPulledBack={individualSignatoryPulledBack} individualClosingCompacted={individualClosingCompacted} />{individualContinuationClosing.length > 0 && <NtaPage record={record} page="individual-continuation" individualClosingUnits={individualContinuationClosing} individualClosingCompacted={individualClosingCompacted} />}</> : <><NtaPage record={record} page="batch-overview" firstPageRows={firstPageRows} showFixedCopy={batchSinglePage} />{!batchSinglePage && <>{rosterPages.map((sections, index) => <NtaPage key={`batch-attendees-${index}`} record={record} page="batch-attendees" rosterSections={sections} showFixedCopy={index === rosterPages.length - 1 && closingOnRosterPage} />)}{(!rosterPages.length || !closingOnRosterPage) && <NtaPage record={record} page="batch-copy" showFixedCopy />}</>}</>}</div></div>;
}

export default function NtaModule({ user, office, division, unit, focusRecordId, onFocusHandled }: { user: User; office: string; division?: string | null; unit: string | null; focusRecordId?: string; onFocusHandled?: () => void }) {
  const [records, setRecords] = useState<NtaRecord[]>([]);
  const [preparedByNames, setPreparedByNames] = useState<Record<string, string>>({});
  const [view, setView] = useState<"list" | "new">("list");
  const [editingRecord, setEditingRecord] = useState<NtaRecord | null>(null);
  const [preview, setPreview] = useState<NtaRecord | null>(null);
  const [loadError, setLoadError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<NtaRecord | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const handledFocusIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!db) return;
    let cancelled = false;
    const firestore = db;
    loadUnitSharedRecords<NtaRecord>(firestore, "ntaRecords", user.uid, unit).then(async (rows) => {
      rows.sort((a, b) => ((b.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0) - ((a.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0));
      const ownerIds = [...new Set(rows.map((record) => record.ownerId).filter(Boolean))];
      const profiles = await Promise.all(ownerIds.map(async (ownerId) => {
        try {
          const profile = await getDoc(doc(firestore, "users", ownerId));
          const name = profile.exists() && typeof profile.data().name === "string" ? profile.data().name.trim() : "";
          return [ownerId, name] as const;
        } catch {
          return [ownerId, ""] as const;
        }
      }));
      if (cancelled) return;
      setPreparedByNames(Object.fromEntries(profiles));
      setRecords(rows);
    }).catch(() => { if (!cancelled) setLoadError("Could not load Notices to Attend. Refresh and try again."); });
    return () => { cancelled = true; };
  }, [user.uid, unit]);
  useEffect(() => {
    if (!focusRecordId) { handledFocusIdRef.current = null; return; }
    if (handledFocusIdRef.current === focusRecordId) return;
    const record = records.find((item) => item.id === focusRecordId);
    if (!record) return;
    handledFocusIdRef.current = focusRecordId;
    setPreview(record);
    onFocusHandled?.();
  }, [focusRecordId, records, onFocusHandled]);
  async function deleteRecord(record: NtaRecord) {
    if (!db || record.ownerId !== user.uid) return;
    setDeletingId(record.id);
    setLoadError("");
    try {
      const firestore = db;
      const notificationReferences = await getDocumentNotificationReferences(firestore, user.uid, record.id);
      const batch = writeBatch(firestore);
      notificationReferences.forEach((reference) => batch.delete(reference));
      batch.delete(doc(firestore, "ntaRecords", record.id));
      await batch.commit();
      setRecords((current) => current.filter((item) => item.id !== record.id));
      setPreview((current) => current?.id === record.id ? null : current);
      setEditingRecord((current) => current?.id === record.id ? null : current);
      setPendingDelete(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setLoadError(code ? `Could not delete the NTA (${code}).` : "Could not delete the NTA.");
      setPendingDelete(null);
    } finally {
      setDeletingId(null);
    }
  }
  async function copyRecord(record: NtaRecord) {
    if (!db || !unit) { setLoadError("Your Unit / Program / Project is still loading. Try copying again in a moment."); return; }
    setCopyingId(record.id);
    setLoadError("");
    try {
      const firestore = db;
      const schedulesByRecipient = new Map<string, Array<{ dateFrom: string; dateTo: string; venue: string }>>();
      if (record.mode === "individual" && record.toUserId) schedulesByRecipient.set(record.toUserId, [{ dateFrom: record.dateFrom ?? "", dateTo: record.dateTo ?? record.dateFrom ?? "", venue: record.venue ?? "" }]);
      if (isGroupMode(record.mode)) record.batches?.forEach((batch) => batch.attendees.forEach((attendee) => {
        if (!attendee.userId) return;
        schedulesByRecipient.set(attendee.userId, [...(schedulesByRecipient.get(attendee.userId) ?? []), { dateFrom: batch.dateFrom, dateTo: batch.dateTo, venue: batch.venue }]);
      }));
      const recipientIds = [...new Set((record.recipientIds ?? [...schedulesByRecipient.keys()]).filter((id) => Boolean(id) && id !== user.uid))];
      const common = {
        mode: record.mode,
        subject: record.subject,
        activityTitle: record.activityTitle,
        organizer: record.organizer,
        ...(record.signatoryName !== undefined ? { signatoryName: record.signatoryName } : {}),
        ...(record.signatoryDesignation !== undefined ? { signatoryDesignation: record.signatoryDesignation } : {}),
        recipientIds,
        ownerId: user.uid,
        ownerUnit: unit,
        createdAt: serverTimestamp(),
      };
      const data = record.mode === "individual"
        ? { ...common, to: record.to ?? "", toUserId: record.toUserId ?? "", positionDesignation: record.positionDesignation ?? "", dateFrom: record.dateFrom ?? "", dateTo: record.dateTo ?? record.dateFrom ?? "", timeFrom: record.timeFrom ?? "", timeTo: record.timeTo ?? "", venueType: record.venueType ?? "physical", venue: record.venue ?? "", link: record.link ?? "" }
        : { ...common, batches: (record.batches ?? []).map((batch) => ({ ...batch, attendees: batch.attendees.map((attendee) => ({ ...attendee })) })) };
      const recordRef = doc(collection(firestore, "ntaRecords"));
      const batch = writeBatch(firestore);
      batch.set(recordRef, data);
      recipientIds.forEach((recipientId) => {
        const notification = makeDocumentNotification(firestore, { recipientId, ownerId: user.uid, documentId: recordRef.id, documentType: "Notice to Attend", activityTitle: record.activityTitle, schedules: schedulesByRecipient.get(recipientId) ?? [] });
        batch.set(notification.reference, notification.data);
      });
      await batch.commit();
      setRecords((current) => [{ id: recordRef.id, ...data, createdAt: undefined } as NtaRecord, ...current]);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setLoadError(code ? `Could not copy the NTA (${code}).` : "Could not copy the NTA.");
    } finally {
      setCopyingId(null);
    }
  }
  return <>{loadError && <div className="error-message">{loadError}</div>}{editingRecord ? <NtaEditor record={editingRecord} userId={user.uid} office={office} division={division} unit={unit} onCancel={() => setEditingRecord(null)} onSaved={(updatedRecord) => { setRecords((current) => current.map((item) => item.id === updatedRecord.id ? updatedRecord : item)); setEditingRecord(null); }} onRemove={() => { if (editingRecord) setPendingDelete(editingRecord); }} /> : view === "new" ? <NtaForm user={user} office={office} division={division} unit={unit} onSaved={(record) => { setRecords((current) => [record, ...current]); setView("list"); }} onCancel={() => setView("list")} /> : <NtaList records={records} ownerId={user.uid} preparedByNames={preparedByNames} fallbackPreparedBy={user.displayName ?? ""} deletingId={deletingId} copyingId={copyingId} onNew={() => setView("new")} onEdit={setEditingRecord} onPreview={setPreview} onCopy={(record) => void copyRecord(record)} onDelete={setPendingDelete} />}{preview && <NtaPreview key={preview.id} record={preview} onClose={() => setPreview(null)} />}<DeleteConfirmation open={Boolean(pendingDelete && pendingDelete.ownerId === user.uid)} title="Confirm NTA Deletion?" description="Are you sure you want to delete this Notice to Attend? This action cannot be undone." busy={Boolean(pendingDelete && deletingId === pendingDelete.id)} onCancel={() => setPendingDelete(null)} onConfirm={() => { if (pendingDelete) void deleteRecord(pendingDelete); }} /></>;
}
