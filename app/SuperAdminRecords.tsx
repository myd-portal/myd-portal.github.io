"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { sendPasswordResetEmail, type User } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { auth, db, functions } from "@/lib/firebase";
import { accountProfileSelection } from "@/lib/account-profile";
import { tevDivisions } from "@/lib/mytev";
import DeleteConfirmation from "./DeleteConfirmation";
import RecordPagination, { useRecordPagination } from "./RecordPagination";
import "./super-admin-records.css";

export type SuperAdminRecordsKind = "users-profile" | "users-nta" | "users-so" | "users-to" | "users-appearances";

type RecordBase = { id: string; [key: string]: unknown };
type ProfileRecord = RecordBase & {
  name?: string; firstName?: string; middleName?: string; lastName?: string; address?: string;
  position?: string; designation?: string; office?: string; division?: string; unit?: string;
  taxIdentificationNo?: string; email?: string;
  assignment?: string; projectProgram?: string; profileFieldsVersion?: number; isRootSuperAdmin?: boolean;
};
type TravelPerson = { name: string; userId?: string; position?: string; salary?: string; toNumber?: string };
type TravelOrderRecord = RecordBase & {
  date?: string; people?: TravelPerson[]; officeStation?: string; departureDate?: string; returnDate?: string;
  placeOfTravel?: string; purpose?: string; objective?: string; perDiemsAllowed?: string;
  assistantLaborersAllowed?: string; transportation?: string; chargeTo?: string; remarks?: string;
  status?: string; ownerId?: string; ownerUnit?: string; recipientId?: string; recipientIds?: string[];
};
type SpecialOrderRecord = RecordBase & {
  subject?: string; activityTitle?: string; organizer?: string; dateFrom?: string; dateTo?: string;
  timeFrom?: string; timeTo?: string; venue?: string; participants?: string[]; participantPositions?: string[];
  participantOffices?: string[]; participantUnits?: string[]; participantUserIds?: string[];
  participantIds?: string[]; recipientIds?: string[]; signatoryName?: string; signatoryDesignation?: string;
  ownerId?: string; ownerUnit?: string;
};
type NtaAttendee = { name: string; office?: string; position?: string; unit?: string; userId?: string; manual?: boolean };
type NtaBatch = {
  number?: string; dateFrom?: string; dateTo?: string; timeFrom?: string; timeTo?: string;
  venueType?: "physical" | "virtual"; venue?: string; link?: string; attendees?: NtaAttendee[];
};
type NtaRecord = RecordBase & {
  mode?: "individual" | "batch" | "multiple"; to?: string; toUserId?: string; toUnit?: string;
  positionDesignation?: string; subject?: string; activityTitle?: string; organizer?: string;
  signatoryName?: string; signatoryDesignation?: string; signatoryDivision?: string; dateFrom?: string; dateTo?: string;
  timeFrom?: string; timeTo?: string; venueType?: "physical" | "virtual"; venue?: string; link?: string;
  batches?: NtaBatch[]; recipientIds?: string[]; ownerId?: string; ownerUnit?: string;
};
type AppearancePerson = { name: string; gender?: string; office?: string; unit?: string };
type AppearanceRecord = RecordBase & {
  eventTitle?: string; destination?: string; eventDateFrom?: string; eventDateTo?: string; eventDate?: string;
  certificateOffice?: string; certificateDivision?: string; certificateUnit?: string; people?: AppearancePerson[];
  signatoryName?: string; designation?: string; division?: string; status?: string; ownerId?: string;
  ownerRole?: string; ownerOffice?: string; ownerDivision?: string; ownerUnit?: string; unit?: string; recordType?: string;
};

type Column<T> = { label: string; render: (record: T) => ReactNode };

function useAdminCollection<T extends RecordBase>(collectionName: string) {
  const [records, setRecords] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!db) { setError("Firebase is not configured."); setLoading(false); return; }
    setLoading(true);
    return onSnapshot(collection(db, collectionName), (snapshot) => {
      setRecords(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as T)));
      setError("");
      setLoading(false);
    }, (cause) => {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not load ${collectionName} (${code}).` : `Could not load ${collectionName}.`);
      setLoading(false);
    });
  }, [collectionName]);
  return { records, setRecords, loading, error, setError };
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function dateLabel(value?: string) {
  if (!value) return "—";
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-PH", { dateStyle: "medium" }).format(date);
}

function dateRange(from?: string, to?: string) {
  const start = dateLabel(from);
  const end = dateLabel(to || from);
  return start === end ? start : `${start} – ${end}`;
}

function AdminFrame({ title, description, count, loading, error, message, children }: {
  title: string; description: string; count: number; loading: boolean; error: string; message: string; children: ReactNode;
}) {
  return <section className="content-section super-admin-records-section">
    <div className="section-heading"><div><p className="eyebrow">Super Admin</p><h2>{title}</h2><p className="muted">{description}</p></div><span className="super-admin-records-count">{count} {count === 1 ? "record" : "records"}</span></div>
    {error && <p className="super-admin-records-message is-error" role="alert">{error}</p>}
    {message && <p className="super-admin-records-message" role="status">{message}</p>}
    {loading ? <p className="muted">Loading {title.toLocaleLowerCase("en")}...</p> : children}
  </section>;
}

function AdminTable<T extends RecordBase>({ rows, columns, label, busy, onEdit, onDelete, onResetPassword, resettingId }: {
  rows: T[]; columns: Column<T>[]; label: string; busy: boolean; onEdit: (row: T) => void; onDelete: (row: T) => void;
  onResetPassword?: (row: T) => void; resettingId?: string;
}) {
  const { currentPage, pageCount, visibleRecords, setPage } = useRecordPagination(rows);
  if (!rows.length) return <div className="empty-state"><span className="empty-number">00</span><h3>No {label.toLocaleLowerCase("en")} yet</h3><p>Records will appear here when they are available.</p></div>;
  return <>
    <div className="super-admin-records-table-wrap"><table className="super-admin-records-table"><thead><tr>{columns.map((column) => <th key={column.label}>{column.label}</th>)}<th>Actions</th></tr></thead><tbody>
      {visibleRecords.map((row) => <tr key={row.id}>{columns.map((column) => <td key={column.label} data-label={column.label}>{column.render(row) || "—"}</td>)}<td className="super-admin-records-actions" data-label="Actions"><button type="button" className="row-action" disabled={busy || resettingId === row.id} onClick={() => onEdit(row)}>Edit</button>{onResetPassword && <button type="button" className="row-action" disabled={busy || Boolean(resettingId)} onClick={() => onResetPassword(row)}>{resettingId === row.id ? "Sending..." : "Reset Password"}</button>}<button type="button" className="delete-button" disabled={busy || resettingId === row.id} onClick={() => onDelete(row)}>Delete</button></td></tr>)}
    </tbody></table></div>
    <RecordPagination totalRecords={rows.length} currentPage={currentPage} pageCount={pageCount} onPageChange={setPage} label={label} />
  </>;
}

function AdminEditForm({ title, busy, error, message, className, onCancel, onSubmit, children }: {
  title: string; busy: boolean; error: string; message: string; className?: string; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; children: ReactNode;
}) {
  return <section className="content-section form-section super-admin-edit-section">
    <div className="section-heading"><div><p className="eyebrow">Super Admin · Edit record</p><h2>{title}</h2><p className="muted">Update the saved record details.</p></div><button type="button" className="ghost-button" disabled={busy} onClick={onCancel}>Cancel</button></div>
    {error && <p className="super-admin-records-message is-error" role="alert">{error}</p>}
    {message && <p className="super-admin-records-message" role="status">{message}</p>}
    <form className={`permit-form super-admin-edit-form ${className ?? ""}`} onSubmit={onSubmit}>
      {children}
      <div className="form-actions"><button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving..." : "Save changes"}</button></div>
    </form>
  </section>;
}

function accountNameParts(account: ProfileRecord) {
  const existingName = text(account.name).trim().split(/\s+/).filter(Boolean);
  const firstName = text(account.firstName) || existingName[0] || "";
  const lastName = text(account.lastName) || existingName.at(-1) || "";
  const middleName = text(account.middleName) || (existingName.length > 2 ? existingName.slice(1, -1).join(" ") : "");
  return { firstName, middleName, lastName };
}

async function deleteWithNotifications(collectionName: string, record: RecordBase & { ownerId?: string }) {
  if (!db) throw new Error("Firebase is not configured.");
  const batch = writeBatch(db);
  batch.delete(doc(db, collectionName, record.id));
  if (record.ownerId) {
    const notifications = await getDocs(query(collection(db, "documentNotifications"), where("ownerId", "==", record.ownerId), where("documentId", "==", record.id)));
    notifications.docs.forEach((notification) => batch.delete(notification.ref));
  }
  await batch.commit();
}

function UserProfilesManager({ user }: { user: User }) {
  const { records, loading, error, setError } = useAdminCollection<ProfileRecord>("users");
  const [editing, setEditing] = useState<ProfileRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProfileRecord | null>(null);
  const [busyId, setBusyId] = useState("");
  const [resettingId, setResettingId] = useState("");
  const [message, setMessage] = useState("");
  const [values, setValues] = useState({ firstName: "", middleName: "", lastName: "", taxIdentificationNo: "", address: "", position: "", designation: "", office: "", division: "", unit: "" });
  const [emailAddress, setEmailAddress] = useState("");
  const [emailLoading, setEmailLoading] = useState(false);
  const emailRequestId = useRef(0);
  const profiles = useMemo(() => records.filter((record) => record.emailVerified === true), [records]);

  function edit(record: ProfileRecord) {
    const names = accountNameParts(record);
    const scope = accountProfileSelection(record);
    setValues({ firstName: names.firstName, middleName: names.middleName, lastName: names.lastName, taxIdentificationNo: text(record.taxIdentificationNo), address: text(record.address), position: text(record.position), designation: text(record.designation), office: scope.office, division: scope.division, unit: scope.unit });
    const requestId = ++emailRequestId.current;
    const functionClient = functions;
    setEmailAddress(text(record.email));
    setEmailLoading(Boolean(functionClient));
    setEditing(record);
    setMessage("");
    setError("");
    if (functionClient) {
      void (async () => {
        try {
          const getAccountEmail = httpsCallable<{ userId: string }, { email: string }>(functionClient, "getUserEmailForPasswordReset");
          const { data } = await getAccountEmail({ userId: record.id });
          if (emailRequestId.current === requestId) setEmailAddress(data.email.trim());
        } catch {
          if (emailRequestId.current === requestId && !text(record.email)) setEmailAddress("");
        } finally {
          if (emailRequestId.current === requestId) setEmailLoading(false);
        }
      })();
    }
  }

  function cancelEdit() {
    emailRequestId.current += 1;
    setEditing(null);
    setEmailLoading(false);
    setError("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db || !editing || busyId) return;
    const firstName = values.firstName.trim();
    const middleName = values.middleName.trim();
    const lastName = values.lastName.trim();
    const office = values.office.trim();
    const division = values.division.trim();
    const unit = values.unit.trim();
    if (!firstName || !lastName || !office || !division || !unit) { setError("Enter the first name, last name, office, division, and unit."); return; }
    const middleInitial = middleName ? `${middleName.charAt(0).toLocaleUpperCase("en")}.` : "";
    const name = [firstName, middleInitial, lastName].filter(Boolean).join(" ");
    setBusyId(editing.id); setError(""); setMessage("");
    try {
      await updateDoc(doc(db, "users", editing.id), { name, firstName, middleName, lastName, taxIdentificationNo: values.taxIdentificationNo.trim() || deleteField(), address: values.address.trim(), position: values.position.trim(), designation: values.designation.trim(), office, division, unit, profileFieldsVersion: 4 });
      setMessage(`${name} updated.`);
      emailRequestId.current += 1;
      setEditing(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not update this profile (${code}).` : "Could not update this profile.");
    } finally { setBusyId(""); }
  }

  async function remove() {
    if (!db || !pendingDelete || busyId) return;
    if (pendingDelete.id === user.uid || pendingDelete.isRootSuperAdmin) { setError("The signed-in superadmin and root superadmin profiles are protected."); setPendingDelete(null); return; }
    setBusyId(pendingDelete.id); setError(""); setMessage("");
    try {
      await deleteDoc(doc(db, "users", pendingDelete.id));
      setMessage(`${text(pendingDelete.name) || "User profile"} deleted. Their app profile and access were removed.`);
      setPendingDelete(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete this profile (${code}).` : "Could not delete this profile.");
    } finally { setBusyId(""); }
  }

  async function resetPassword(record: ProfileRecord) {
    setError(""); setMessage("");
    if (resettingId) return;
    if (!auth || !functions) { setError("Firebase Authentication is not configured."); return; }
    setResettingId(record.id);
    try {
      const getAccountEmail = httpsCallable<{ userId: string }, { email: string }>(functions, "getUserEmailForPasswordReset");
      const { data } = await getAccountEmail({ userId: record.id });
      const email = data.email.trim();
      if (!email) throw new Error("The account does not have a verified email address.");
      await sendPasswordResetEmail(auth, email);
      setMessage(`Password reset email sent to ${email}.`);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code === "functions/not-found"
        ? `${text(record.name) || "This user"}'s verified account could not be found.`
        : code === "functions/failed-precondition"
          ? `${text(record.name) || "This user"} does not have a verified email address.`
          : code === "auth/too-many-requests"
          ? "Too many reset requests were made. Wait a while and try again."
          : code ? `Could not request a password reset (${code}).` : "Could not request a password reset.");
    } finally { setResettingId(""); }
  }

  return <>
    {!editing && <AdminFrame title="Users' Profile" description="Review and update saved user profiles." count={profiles.length} loading={loading} error={error} message={message}>
      <AdminTable rows={profiles} label="User Profiles" busy={Boolean(busyId)} resettingId={resettingId} onResetPassword={(record) => void resetPassword(record)} onEdit={edit} onDelete={setPendingDelete} columns={[
        { label: "Name", render: (record) => <strong>{text(record.name) || "—"}</strong> },
        { label: "Designation", render: (record) => text(record.designation) },
        { label: "Unit", render: (record) => accountProfileSelection(record).unit },
      ]} />
    </AdminFrame>}
    {editing && <AdminEditForm title="Edit User Profile" busy={busyId === editing.id} error={error} message={message} className="super-admin-profile-edit-form" onCancel={cancelEdit} onSubmit={(event) => void save(event)}>
      <label className="wide-field">Name<input value={[values.firstName.trim(), values.middleName.trim() ? `${values.middleName.trim().charAt(0).toLocaleUpperCase("en")}.` : "", values.lastName.trim()].filter(Boolean).join(" ")} readOnly /></label>
      <label>First Name<input maxLength={60} value={values.firstName} onChange={(event) => setValues({ ...values, firstName: event.target.value })} required /></label>
      <label>Middle Name<input maxLength={60} value={values.middleName} onChange={(event) => setValues({ ...values, middleName: event.target.value })} /></label>
      <label>Last Name<input maxLength={60} value={values.lastName} onChange={(event) => setValues({ ...values, lastName: event.target.value })} required /></label>
      <label>TIN<input maxLength={30} value={values.taxIdentificationNo} onChange={(event) => setValues({ ...values, taxIdentificationNo: event.target.value })} /></label>
      <label>Address<textarea rows={2} maxLength={200} value={values.address} onChange={(event) => setValues({ ...values, address: event.target.value })} /></label>
      <label>Email Address<input type="email" value={emailAddress} placeholder={emailLoading ? "Loading email address..." : "Email address unavailable"} readOnly /></label>
      <label>Position<input maxLength={120} value={values.position} onChange={(event) => setValues({ ...values, position: event.target.value })} /></label>
      <label>Designation<input maxLength={2000} value={values.designation} onChange={(event) => setValues({ ...values, designation: event.target.value })} /></label>
      <label>Office<input maxLength={120} value={values.office} onChange={(event) => setValues({ ...values, office: event.target.value })} required /></label>
      <div className="super-admin-profile-division-row wide-field">
        <label>Division<input maxLength={120} value={values.division} onChange={(event) => setValues({ ...values, division: event.target.value })} required /></label>
        <label>Unit<input maxLength={120} value={values.unit} onChange={(event) => setValues({ ...values, unit: event.target.value })} required /></label>
      </div>
    </AdminEditForm>}
    <DeleteConfirmation open={Boolean(pendingDelete)} title="Delete this user profile?" description={`Delete ${text(pendingDelete?.name) || "this user profile"} from My Desk? This removes the Firestore profile and disables app access.`} busy={Boolean(pendingDelete && busyId === pendingDelete.id)} onCancel={() => setPendingDelete(null)} onConfirm={() => void remove()} />
  </>;
}

type ParticipantEdit = { name: string; position: string; office: string; unit: string; userId: string };

function SpecialOrdersManager() {
  const { records, loading, error, setError } = useAdminCollection<SpecialOrderRecord>("specialOrders");
  const [editing, setEditing] = useState<SpecialOrderRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SpecialOrderRecord | null>(null);
  const [participants, setParticipants] = useState<ParticipantEdit[]>([]);
  const [values, setValues] = useState({ subject: "", activityTitle: "", organizer: "", dateFrom: "", dateTo: "", venue: "", signatoryName: "", signatoryDesignation: "" });
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");

  function edit(record: SpecialOrderRecord) {
    setValues({ subject: text(record.subject), activityTitle: text(record.activityTitle), organizer: text(record.organizer), dateFrom: text(record.dateFrom), dateTo: text(record.dateTo), venue: text(record.venue), signatoryName: text(record.signatoryName), signatoryDesignation: text(record.signatoryDesignation) });
    setParticipants((record.participants ?? []).map((name, index) => ({ name, position: record.participantPositions?.[index] ?? "", office: record.participantOffices?.[index] ?? "", unit: record.participantUnits?.[index] ?? "", userId: record.participantUserIds?.[index] ?? "" })));
    setEditing(record); setMessage(""); setError("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db || !editing || busyId) return;
    const people = participants.map((person) => ({ ...person, name: person.name.trim(), position: person.position.trim(), office: person.office.trim(), unit: person.unit.trim() })).filter((person) => person.name);
    if (!values.subject.trim() || !values.activityTitle.trim() || !people.length) { setError("Enter a subject, activity title, and at least one participant."); return; }
    setBusyId(editing.id); setError(""); setMessage("");
    const participantIds = people.map((person) => person.userId).filter(Boolean);
    try {
      await updateDoc(doc(db, "specialOrders", editing.id), {
        subject: values.subject.trim(), activityTitle: values.activityTitle.trim(), organizer: values.organizer.trim(),
        dateFrom: values.dateFrom, dateTo: values.dateTo || values.dateFrom, venue: values.venue.trim(),
        participants: people.map((person) => person.name), participantPositions: people.map((person) => person.position),
        participantOffices: people.map((person) => person.office), participantUnits: people.map((person) => person.unit),
        participantUserIds: people.map((person) => person.userId), participantIds,
        recipientIds: participantIds.filter((id) => id !== editing.ownerId),
        signatoryName: values.signatoryName.trim(), signatoryDesignation: values.signatoryDesignation.trim(), updatedAt: serverTimestamp(),
      });
      setMessage(`${values.activityTitle.trim()} updated.`); setEditing(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not update this Special Order (${code}).` : "Could not update this Special Order.");
    } finally { setBusyId(""); }
  }

  async function remove() {
    if (!pendingDelete || busyId) return;
    setBusyId(pendingDelete.id); setError(""); setMessage("");
    try { await deleteWithNotifications("specialOrders", pendingDelete); setMessage(`${text(pendingDelete.activityTitle) || "Special Order"} deleted.`); setPendingDelete(null); }
    catch (cause) { const code = (cause as { code?: string }).code; setError(code ? `Could not delete this Special Order (${code}).` : "Could not delete this Special Order."); }
    finally { setBusyId(""); }
  }

  return <>
    {!editing && <AdminFrame title="Users' SO" description="Edit or remove saved Special Orders." count={records.length} loading={loading} error={error} message={message}>
      <AdminTable rows={records} label="Special Orders" busy={Boolean(busyId)} onEdit={edit} onDelete={setPendingDelete} columns={[
        { label: "Activity Title", render: (record) => <strong>{text(record.activityTitle) || "—"}</strong> },
        { label: "Date From – Date To", render: (record) => dateRange(record.dateFrom, record.dateTo) },
        { label: "Participants", render: (record) => (record.participants ?? []).join(", ") },
      ]} />
    </AdminFrame>}
    {editing && <AdminEditForm title="Edit Special Order" busy={busyId === editing.id} error={error} message={message} className="super-admin-so-edit-form" onCancel={() => { setEditing(null); setError(""); }} onSubmit={(event) => void save(event)}>
      <label>Subject<input maxLength={240} value={values.subject} onChange={(event) => setValues({ ...values, subject: event.target.value })} required /></label>
      <label>Activity Title<input maxLength={240} value={values.activityTitle} onChange={(event) => setValues({ ...values, activityTitle: event.target.value })} required /></label>
      <label>Venue<input value={values.venue} onChange={(event) => setValues({ ...values, venue: event.target.value })} /></label>
      <label>Date From<input type="date" value={values.dateFrom} onChange={(event) => setValues({ ...values, dateFrom: event.target.value })} /></label>
      <label>Date To<input type="date" min={values.dateFrom} value={values.dateTo} onChange={(event) => setValues({ ...values, dateTo: event.target.value })} /></label>
      <label>Organizer<input value={values.organizer} onChange={(event) => setValues({ ...values, organizer: event.target.value })} /></label>
      <div className="super-admin-dynamic-list wide-field"><div className="super-admin-dynamic-list-heading"><strong>Participants</strong><button type="button" className="text-button plain-action add-item-text-button" onClick={() => setParticipants((current) => [...current, { name: "", position: "", office: "", unit: "", userId: "" }])}>+ Add participant</button></div>
        {participants.map((person, index) => <fieldset className="super-admin-dynamic-row" key={index}><legend>Participant {index + 1}</legend><label>Participant<input value={person.name} onChange={(event) => setParticipants((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} required /></label><label>Participant Position<input value={person.position} onChange={(event) => setParticipants((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, position: event.target.value } : item))} /></label><label>Participant Office<input value={person.office} onChange={(event) => setParticipants((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, office: event.target.value } : item))} /></label><label>Participant Unit<input value={person.unit} onChange={(event) => setParticipants((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, unit: event.target.value } : item))} /></label>{participants.length > 1 && <button type="button" className="delete-button" onClick={() => setParticipants((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove participant</button>}</fieldset>)}
      </div>
      <label>Signatory Name<input value={values.signatoryName} onChange={(event) => setValues({ ...values, signatoryName: event.target.value })} /></label>
      <label>Signatory Designation<input value={values.signatoryDesignation} onChange={(event) => setValues({ ...values, signatoryDesignation: event.target.value })} /></label>
    </AdminEditForm>}
    <DeleteConfirmation open={Boolean(pendingDelete)} title="Delete this Special Order?" description={`Delete “${text(pendingDelete?.activityTitle) || "this Special Order"}”? Linked document notifications will also be removed.`} busy={Boolean(pendingDelete && busyId === pendingDelete.id)} onCancel={() => setPendingDelete(null)} onConfirm={() => void remove()} />
  </>;
}

function newNtaBatch(): NtaBatch {
  return { number: "1", dateFrom: "", dateTo: "", timeFrom: "08:00", timeTo: "17:00", venueType: "physical", venue: "", link: "", attendees: [{ name: "", office: "", position: "", unit: "", userId: "", manual: true }] };
}

function ntaModeLabel(mode?: NtaRecord["mode"]) {
  return mode === "individual" ? "Individual" : mode === "multiple" ? "Multiple" : "Group";
}

function NtaManager() {
  const { records, loading, error, setError } = useAdminCollection<NtaRecord>("ntaRecords");
  const [editing, setEditing] = useState<NtaRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NtaRecord | null>(null);
  const [values, setValues] = useState({ mode: "individual" as "individual" | "batch" | "multiple", subject: "", activityTitle: "", organizer: "", dateFrom: "", dateTo: "", venueType: "physical" as "physical" | "virtual", venue: "", link: "", to: "", positionDesignation: "", toUnit: "", signatoryName: "", signatoryPosition: "", signatoryDivision: "" });
  const [batches, setBatches] = useState<NtaBatch[]>([newNtaBatch()]);
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");

  function edit(record: NtaRecord) {
    const mode = record.mode ?? "individual";
    const signatoryDesignation = text(record.signatoryDesignation);
    const designationDivision = tevDivisions.find((division) => signatoryDesignation.endsWith(`, ${division}`)) ?? "";
    const signatoryPosition = designationDivision ? signatoryDesignation.slice(0, -(designationDivision.length + 2)).trim() : signatoryDesignation;
    const signatoryDivision = text(record.signatoryDivision) || designationDivision;
    setValues({ mode, subject: text(record.subject), activityTitle: text(record.activityTitle), organizer: text(record.organizer), dateFrom: text(record.dateFrom), dateTo: text(record.dateTo), venueType: record.venueType ?? "physical", venue: text(record.venue), link: text(record.link), to: text(record.to), positionDesignation: text(record.positionDesignation), toUnit: text(record.toUnit), signatoryName: text(record.signatoryName), signatoryPosition, signatoryDivision });
    const savedBatches = (record.batches ?? []).map((batch, index) => ({ ...batch, number: batch.number ?? String(index + 1), attendees: batch.attendees?.map((attendee) => ({ ...attendee })) ?? [] }));
    setBatches(savedBatches.length ? savedBatches : [newNtaBatch()]);
    setEditing(record); setMessage(""); setError("");
  }

  function updateBatch(index: number, changes: Partial<NtaBatch>) {
    setBatches((current) => current.map((batch, batchIndex) => batchIndex === index ? { ...batch, ...changes } : batch));
  }

  function updateAttendee(batchIndex: number, attendeeIndex: number, changes: Partial<NtaAttendee>) {
    setBatches((current) => current.map((batch, index) => index === batchIndex ? { ...batch, attendees: (batch.attendees ?? []).map((attendee, row) => row === attendeeIndex ? { ...attendee, ...changes } : attendee) } : batch));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db || !editing || busyId) return;
    const subject = values.subject.trim();
    const activityTitle = values.activityTitle.trim();
    if (!subject || !activityTitle) { setError("Enter a subject and activity title."); return; }
    const normalizedBatches = batches.map((batch, index) => ({ ...batch, number: String(index + 1), attendees: (batch.attendees ?? []).map((attendee) => ({ ...attendee, name: attendee.name.trim(), office: attendee.office?.trim() ?? "", position: attendee.position?.trim() ?? "", unit: attendee.unit?.trim() ?? "" })).filter((attendee) => attendee.name) }));
    if (values.mode === "individual" && (!values.to.trim() || !values.dateFrom || !values.venue.trim())) { setError("Enter the recipient, date, and venue for an individual notice."); return; }
    if (values.mode !== "individual" && !normalizedBatches.some((batch) => batch.attendees.length)) { setError("Add at least one named attendee to a group schedule."); return; }
    setBusyId(editing.id); setError(""); setMessage("");
    const individual = values.mode === "individual";
    const signatoryPosition = values.signatoryPosition.trim();
    const signatoryDivision = values.signatoryDivision.trim();
    const signatoryDesignation = [signatoryPosition, signatoryDivision].filter(Boolean).join(", ");
    const patch = {
      mode: values.mode, subject, activityTitle, organizer: values.organizer.trim(),
      signatoryName: values.signatoryName.trim(), signatoryDesignation, signatoryDivision,
      ...(individual ? {
        to: values.to.trim(), positionDesignation: values.positionDesignation.trim(), toUnit: values.toUnit.trim(),
        dateFrom: values.dateFrom, dateTo: values.dateTo || values.dateFrom, venueType: values.venueType,
        venue: values.venue.trim(), link: values.link.trim(), batches: deleteField(),
      } : { batches: normalizedBatches }),
      updatedAt: serverTimestamp(),
    };
    try {
      await updateDoc(doc(db, "ntaRecords", editing.id), patch);
      setMessage(`${activityTitle} updated.`); setEditing(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not update this NTA (${code}).` : "Could not update this NTA.");
    } finally { setBusyId(""); }
  }

  async function remove() {
    if (!pendingDelete || busyId) return;
    setBusyId(pendingDelete.id); setError(""); setMessage("");
    try { await deleteWithNotifications("ntaRecords", pendingDelete); setMessage(`${text(pendingDelete.activityTitle) || "NTA"} deleted.`); setPendingDelete(null); }
    catch (cause) { const code = (cause as { code?: string }).code; setError(code ? `Could not delete this NTA (${code}).` : "Could not delete this NTA."); }
    finally { setBusyId(""); }
  }

  const columns: Column<NtaRecord>[] = [
    { label: "Notice Type", render: (record) => ntaModeLabel(record.mode) },
    { label: "Activity Title", render: (record) => <strong>{text(record.activityTitle) || "—"}</strong> },
    { label: "Date From – Date To", render: (record) => record.mode === "individual"
      ? dateRange(record.dateFrom, record.dateTo)
      : dateRange([...(record.batches ?? [])].map((batch) => batch.dateFrom ?? "").filter(Boolean).sort()[0], [...(record.batches ?? [])].map((batch) => batch.dateTo ?? batch.dateFrom ?? "").filter(Boolean).sort().at(-1)) },
    { label: "Participants", render: (record) => record.mode === "individual" ? text(record.to) : (record.batches ?? []).flatMap((batch) => batch.attendees ?? []).map((attendee) => attendee.name).filter(Boolean).join(", ") },
  ];

  return <>
    {!editing && <AdminFrame title="Users' NTA" description="Edit or remove Individual, Group, and Multiple Notices to Attend." count={records.length} loading={loading} error={error} message={message}>
      <AdminTable rows={records} label="Notices to Attend" busy={Boolean(busyId)} onEdit={edit} onDelete={setPendingDelete} columns={columns} />
    </AdminFrame>}
    {editing && <AdminEditForm title="Edit Notice to Attend" busy={busyId === editing.id} error={error} message={message} className="super-admin-nta-edit-form" onCancel={() => { setEditing(null); setError(""); }} onSubmit={(event) => void save(event)}>
      <label>Mode<select value={values.mode} onChange={(event) => setValues({ ...values, mode: event.target.value as typeof values.mode })}><option value="individual">Individual</option><option value="batch">Group</option><option value="multiple">Multiple</option></select></label>
      <label>Subject<input value={values.subject} onChange={(event) => setValues({ ...values, subject: event.target.value })} required /></label>
      <label>Activity Title<input value={values.activityTitle} onChange={(event) => setValues({ ...values, activityTitle: event.target.value })} required /></label>
      {values.mode === "individual" ? <>
        <label>Date From<input type="date" value={values.dateFrom} onChange={(event) => setValues({ ...values, dateFrom: event.target.value })} required /></label>
        <label>Date To<input type="date" min={values.dateFrom} value={values.dateTo} onChange={(event) => setValues({ ...values, dateTo: event.target.value })} /></label>
        <label>Organizer<input value={values.organizer} onChange={(event) => setValues({ ...values, organizer: event.target.value })} /></label>
        <label>Venue Type<select value={values.venueType} onChange={(event) => setValues({ ...values, venueType: event.target.value as typeof values.venueType })}><option value="physical">Physical</option><option value="virtual">Virtual</option></select></label>
        <label>Venue<input value={values.venue} onChange={(event) => setValues({ ...values, venue: event.target.value })} required /></label>
        <label>Link<input type="url" value={values.link} onChange={(event) => setValues({ ...values, link: event.target.value })} /></label>
        <label>To<input value={values.to} onChange={(event) => setValues({ ...values, to: event.target.value })} required /></label>
        <label>Position<input value={values.positionDesignation} onChange={(event) => setValues({ ...values, positionDesignation: event.target.value })} /></label>
        <label>Unit<input value={values.toUnit} onChange={(event) => setValues({ ...values, toUnit: event.target.value })} /></label>
      </> : <><label className="wide-field">Organizer<input value={values.organizer} onChange={(event) => setValues({ ...values, organizer: event.target.value })} /></label><div className="super-admin-dynamic-list wide-field"><div className="super-admin-dynamic-list-heading"><strong>{values.mode === "batch" ? "Group schedules" : "Multiple schedules"}</strong><button type="button" className="text-button plain-action add-item-text-button" onClick={() => setBatches((current) => [...current, { ...newNtaBatch(), number: String(current.length + 1) }])}>+ Add schedule</button></div>
        {batches.map((batch, batchIndex) => <fieldset className="super-admin-dynamic-row" key={batchIndex}><legend>Schedule {batchIndex + 1}</legend>
          <label>Date From<input type="date" value={batch.dateFrom ?? ""} onChange={(event) => updateBatch(batchIndex, { dateFrom: event.target.value })} /></label><label>Date To<input type="date" min={batch.dateFrom} value={batch.dateTo ?? ""} onChange={(event) => updateBatch(batchIndex, { dateTo: event.target.value })} /></label>
          <label>Venue Type<select value={batch.venueType ?? "physical"} onChange={(event) => updateBatch(batchIndex, { venueType: event.target.value as "physical" | "virtual" })}><option value="physical">Physical</option><option value="virtual">Virtual</option></select></label><label>Venue<input value={batch.venue ?? ""} onChange={(event) => updateBatch(batchIndex, { venue: event.target.value })} /></label><label className="wide-field">Link<input type="url" value={batch.link ?? ""} onChange={(event) => updateBatch(batchIndex, { link: event.target.value })} /></label>
          <div className="super-admin-dynamic-list wide-field"><div className="super-admin-dynamic-list-heading"><strong>Attendees</strong><button type="button" className="text-button plain-action add-item-text-button" onClick={() => updateBatch(batchIndex, { attendees: [...(batch.attendees ?? []), { name: "", office: "", position: "", unit: "", manual: true }] })}>+ Add attendee</button></div>
            {(batch.attendees ?? []).map((attendee, attendeeIndex) => <div className="super-admin-attendee-row" key={attendeeIndex}><label>Attendee Name<input value={attendee.name} onChange={(event) => updateAttendee(batchIndex, attendeeIndex, { name: event.target.value })} /></label><label>Attendee Office<input value={attendee.office ?? ""} onChange={(event) => updateAttendee(batchIndex, attendeeIndex, { office: event.target.value })} /></label><label>Attendee Position<input value={attendee.position ?? ""} onChange={(event) => updateAttendee(batchIndex, attendeeIndex, { position: event.target.value })} /></label>{values.mode === "multiple" && <label>Attendee Unit<input value={attendee.unit ?? ""} onChange={(event) => updateAttendee(batchIndex, attendeeIndex, { unit: event.target.value })} /></label>}<button type="button" className="delete-button" onClick={() => updateBatch(batchIndex, { attendees: (batch.attendees ?? []).filter((_, index) => index !== attendeeIndex) })}>Remove attendee</button></div>)}
          </div>
          {batches.length > 1 && <button type="button" className="delete-button" onClick={() => setBatches((current) => current.filter((_, index) => index !== batchIndex))}>Remove schedule</button>}
        </fieldset>)}
      </div></>}
      <div className="super-admin-nta-signatory-row wide-field">
        <label>Signatory Name<input value={values.signatoryName} onChange={(event) => setValues({ ...values, signatoryName: event.target.value })} /></label>
        <label>Signatory Division<input value={values.signatoryDivision} onChange={(event) => setValues({ ...values, signatoryDivision: event.target.value })} /></label>
      </div>
    </AdminEditForm>}
    <DeleteConfirmation open={Boolean(pendingDelete)} title="Delete this Notice to Attend?" description={`Delete “${text(pendingDelete?.activityTitle) || "this Notice to Attend"}”? Linked document notifications will also be removed.`} busy={Boolean(pendingDelete && busyId === pendingDelete.id)} onCancel={() => setPendingDelete(null)} onConfirm={() => void remove()} />
  </>;
}

function travelOrderNumberKey(value: string) {
  return encodeURIComponent(value.trim().toUpperCase());
}

function TravelOrdersManager() {
  const { records, loading, error, setError } = useAdminCollection<TravelOrderRecord>("travelOrders");
  const [editing, setEditing] = useState<TravelOrderRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TravelOrderRecord | null>(null);
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [values, setValues] = useState({ date: "", name: "", position: "", salary: "", placeOfTravel: "", departureDate: "", returnDate: "", purpose: "", objective: "", perDiemsAllowed: "No", assistantLaborersAllowed: "No", transportation: "", chargeTo: "", remarks: "", toNumber: "", status: "Pending" });

  function edit(record: TravelOrderRecord) {
    const person = record.people?.[0];
    setValues({ date: text(record.date), name: text(person?.name), position: text(person?.position), salary: text(person?.salary), placeOfTravel: text(record.placeOfTravel), departureDate: text(record.departureDate), returnDate: text(record.returnDate), purpose: text(record.purpose), objective: text(record.objective), perDiemsAllowed: text(record.perDiemsAllowed) || "No", assistantLaborersAllowed: text(record.assistantLaborersAllowed) || "No", transportation: text(record.transportation), chargeTo: text(record.chargeTo), remarks: text(record.remarks), toNumber: text(person?.toNumber), status: text(record.status) || "Pending" });
    setEditing(record); setMessage(""); setError("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const firestore = db;
    if (!firestore || !editing || busyId) return;
    const toNumber = values.toNumber.trim();
    if (values.status === "Approved" && (!values.date || !toNumber)) { setError("Approved Travel Orders require a date and TO Number."); return; }
    if (!values.name.trim() || !values.placeOfTravel.trim() || !values.purpose.trim()) { setError("Enter the traveler's name, place of travel, and purpose."); return; }
    setBusyId(editing.id); setError(""); setMessage("");
    const existingPerson = editing.people?.[0] ?? { name: "", position: "", salary: "" };
    const nextPerson: TravelPerson = { ...existingPerson, name: values.name.trim(), position: values.position.trim(), salary: values.salary.trim(), toNumber };
    const oldNumber = text(existingPerson.toNumber).trim();
    const activeNumber = values.status === "Approved" ? toNumber : "";
    const indexRefs = new Map<string, ReturnType<typeof doc>>();
    if (oldNumber) indexRefs.set(travelOrderNumberKey(oldNumber), doc(firestore, "travelOrderNumbers", travelOrderNumberKey(oldNumber)));
    if (activeNumber) indexRefs.set(travelOrderNumberKey(activeNumber), doc(firestore, "travelOrderNumbers", travelOrderNumberKey(activeNumber)));
    try {
      await runTransaction(firestore, async (transaction) => {
        const entries = await Promise.all([...indexRefs].map(async ([key, reference]) => [key, await transaction.get(reference)] as const));
        const snapshots = new Map(entries);
        const nextKey = activeNumber ? travelOrderNumberKey(activeNumber) : "";
        const nextSnapshot = nextKey ? snapshots.get(nextKey) : undefined;
        if (nextSnapshot?.exists() && nextSnapshot.data().travelOrderId !== editing.id) throw new Error("This TO Number is already assigned to another Travel Order.");
        transaction.update(doc(firestore, "travelOrders", editing.id), {
          date: values.date, people: [nextPerson], placeOfTravel: values.placeOfTravel.trim(), departureDate: values.departureDate,
          returnDate: values.returnDate, purpose: values.purpose.trim(), objective: values.objective.trim(),
          perDiemsAllowed: values.perDiemsAllowed, assistantLaborersAllowed: values.assistantLaborersAllowed,
          transportation: values.transportation.trim(), chargeTo: values.chargeTo.trim(), remarks: values.remarks.trim(),
          status: values.status, updatedAt: serverTimestamp(),
        });
        const oldKey = oldNumber ? travelOrderNumberKey(oldNumber) : "";
        const oldSnapshot = oldKey ? snapshots.get(oldKey) : undefined;
        if (oldKey && oldKey !== nextKey && oldSnapshot?.exists() && oldSnapshot.data().travelOrderId === editing.id) transaction.delete(doc(firestore, "travelOrderNumbers", oldKey));
        if (nextKey && !nextSnapshot?.exists()) transaction.set(doc(firestore, "travelOrderNumbers", nextKey), { ownerId: editing.ownerId ?? "", travelOrderId: editing.id });
      });
      setMessage(`${values.name.trim()}'s Travel Order updated.`); setEditing(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(cause instanceof Error && cause.message.includes("already assigned") ? cause.message : code ? `Could not update this Travel Order (${code}).` : "Could not update this Travel Order.");
    } finally { setBusyId(""); }
  }

  async function remove() {
    if (!db || !pendingDelete || busyId) return;
    setBusyId(pendingDelete.id); setError(""); setMessage("");
    try {
      const notifications = pendingDelete.ownerId ? await getDocs(query(collection(db, "documentNotifications"), where("ownerId", "==", pendingDelete.ownerId), where("documentId", "==", pendingDelete.id))) : null;
      const numbers = await getDocs(query(collection(db, "travelOrderNumbers"), where("travelOrderId", "==", pendingDelete.id)));
      const batch = writeBatch(db);
      batch.delete(doc(db, "travelOrders", pendingDelete.id));
      notifications?.docs.forEach((notification) => batch.delete(notification.ref));
      numbers.docs.forEach((number) => batch.delete(number.ref));
      await batch.commit();
      setMessage(`${text(pendingDelete.people?.[0]?.name) || "Travel Order"} deleted.`); setPendingDelete(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete this Travel Order (${code}).` : "Could not delete this Travel Order.");
    } finally { setBusyId(""); }
  }

  return <>
    {!editing && <AdminFrame title="Users' TO" description="Edit or remove saved Travel Orders." count={records.length} loading={loading} error={error} message={message}>
      <AdminTable rows={records} label="Travel Orders" busy={Boolean(busyId)} onEdit={edit} onDelete={setPendingDelete} columns={[
        { label: "Name", render: (record) => <strong>{text(record.people?.[0]?.name) || "—"}</strong> },
        { label: "Place of Travel", render: (record) => text(record.placeOfTravel) },
        { label: "Purpose", render: (record) => text(record.purpose) },
      ]} />
    </AdminFrame>}
    {editing && <AdminEditForm title="Edit Travel Order" busy={busyId === editing.id} error={error} message={message} onCancel={() => { setEditing(null); setError(""); }} onSubmit={(event) => void save(event)}>
      <label>Date<input type="date" value={values.date} onChange={(event) => setValues({ ...values, date: event.target.value })} /></label>
      <label>Name<input value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} required /></label>
      <label>Position<input value={values.position} onChange={(event) => setValues({ ...values, position: event.target.value })} /></label>
      <label>Salary<input inputMode="decimal" value={values.salary} onChange={(event) => setValues({ ...values, salary: event.target.value })} /></label>
      <label className="wide-field">Place of Travel<input value={values.placeOfTravel} onChange={(event) => setValues({ ...values, placeOfTravel: event.target.value })} required /></label>
      <label>Departure Date<input type="date" value={values.departureDate} onChange={(event) => setValues({ ...values, departureDate: event.target.value })} /></label>
      <label>Return Date<input type="date" min={values.departureDate} value={values.returnDate} onChange={(event) => setValues({ ...values, returnDate: event.target.value })} /></label>
      <label>Purpose<textarea rows={2} value={values.purpose} onChange={(event) => setValues({ ...values, purpose: event.target.value })} required /></label>
      <label>Objective<textarea rows={2} value={values.objective} onChange={(event) => setValues({ ...values, objective: event.target.value })} /></label>
      <label>Per Diem Allowed<select value={values.perDiemsAllowed} onChange={(event) => setValues({ ...values, perDiemsAllowed: event.target.value })}><option>Yes</option><option>No</option></select></label>
      <label>Assistant Laborers Allowed<select value={values.assistantLaborersAllowed} onChange={(event) => setValues({ ...values, assistantLaborersAllowed: event.target.value })}><option>Yes</option><option>No</option></select></label>
      <label>Transportation<input value={values.transportation} onChange={(event) => setValues({ ...values, transportation: event.target.value })} /></label>
      <label>Charge To<input value={values.chargeTo} onChange={(event) => setValues({ ...values, chargeTo: event.target.value })} /></label>
      <label className="wide-field">Remarks<textarea rows={2} value={values.remarks} onChange={(event) => setValues({ ...values, remarks: event.target.value })} /></label>
      <label>TO Number<input value={values.toNumber} onChange={(event) => setValues({ ...values, toNumber: event.target.value })} /></label>
      <label>Status<select value={values.status} onChange={(event) => setValues({ ...values, status: event.target.value })}>{["Pending", "Processing", "Approved", "Disapproved"].map((status) => <option key={status}>{status}</option>)}</select></label>
    </AdminEditForm>}
    <DeleteConfirmation open={Boolean(pendingDelete)} title="Delete this Travel Order?" description={`Delete the Travel Order for ${text(pendingDelete?.people?.[0]?.name) || "this traveler"}? Linked document notifications and its TO Number registration will also be removed.`} busy={Boolean(pendingDelete && busyId === pendingDelete.id)} onCancel={() => setPendingDelete(null)} onConfirm={() => void remove()} />
  </>;
}

type AppearanceEditPerson = { name: string; gender: string; office: string; unit: string };

function AppearancesManager() {
  const { records, loading, error, setError } = useAdminCollection<AppearanceRecord>("certificatesOfAppearance");
  const [editing, setEditing] = useState<AppearanceRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AppearanceRecord | null>(null);
  const [people, setPeople] = useState<AppearanceEditPerson[]>([]);
  const [values, setValues] = useState({ eventTitle: "", destination: "", eventDateFrom: "", eventDateTo: "", certificateOffice: "", certificateDivision: "", certificateUnit: "", signatoryName: "", designation: "", status: "Pending" });
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");

  function edit(record: AppearanceRecord) {
    setValues({ eventTitle: text(record.eventTitle), destination: text(record.destination), eventDateFrom: text(record.eventDateFrom ?? record.eventDate), eventDateTo: text(record.eventDateTo ?? record.eventDateFrom ?? record.eventDate), certificateOffice: text(record.certificateOffice ?? record.office), certificateDivision: text(record.certificateDivision ?? record.division), certificateUnit: text(record.certificateUnit ?? record.ownerUnit ?? record.unit), signatoryName: text(record.signatoryName), designation: text(record.designation), status: text(record.status) || "Pending" });
    setPeople((record.people ?? []).map((person) => ({ name: person.name ?? "", gender: text(person.gender) || "unspecified", office: text(person.office), unit: text(person.unit) })));
    setEditing(record); setMessage(""); setError("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db || !editing || busyId) return;
    const eventTitle = values.eventTitle.trim();
    const attendees = people.map((person) => ({ name: person.name.trim(), gender: person.gender || "unspecified", office: person.office.trim(), unit: person.unit.trim() })).filter((person) => person.name);
    if (!eventTitle || !attendees.length) { setError("Enter the event title and at least one attendee name."); return; }
    setBusyId(editing.id); setError(""); setMessage("");
    try {
      await updateDoc(doc(db, "certificatesOfAppearance", editing.id), {
        eventTitle, destination: values.destination.trim(), eventDateFrom: values.eventDateFrom,
        eventDateTo: values.eventDateTo || values.eventDateFrom, certificateOffice: values.certificateOffice.trim(),
        certificateDivision: values.certificateDivision.trim(), certificateUnit: values.certificateUnit.trim(),
        people: attendees, signatoryName: values.signatoryName.trim(), designation: values.designation.trim(),
        status: values.status, updatedAt: serverTimestamp(),
      });
      setMessage(`${eventTitle} updated.`); setEditing(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not update this Certificate of Appearance (${code}).` : "Could not update this Certificate of Appearance.");
    } finally { setBusyId(""); }
  }

  async function remove() {
    if (!pendingDelete || busyId) return;
    setBusyId(pendingDelete.id); setError(""); setMessage("");
    try { await deleteWithNotifications("certificatesOfAppearance", pendingDelete); setMessage(`${text(pendingDelete.eventTitle) || "Appearance certificate"} deleted.`); setPendingDelete(null); }
    catch (cause) { const code = (cause as { code?: string }).code; setError(code ? `Could not delete this Appearance certificate (${code}).` : "Could not delete this Appearance certificate."); }
    finally { setBusyId(""); }
  }

  return <>
    {!editing && <AdminFrame title="Users' Appearances" description="Edit or remove Certificates of Appearance." count={records.length} loading={loading} error={error} message={message}>
      <AdminTable rows={records} label="Appearances" busy={Boolean(busyId)} onEdit={edit} onDelete={setPendingDelete} columns={[
        { label: "Certificate Unit", render: (record) => text(record.certificateUnit ?? record.ownerUnit ?? record.unit) },
        { label: "Event's Title", render: (record) => <strong>{text(record.eventTitle) || "—"}</strong> },
        { label: "Date From – Date To", render: (record) => dateRange(record.eventDateFrom ?? record.eventDate, record.eventDateTo ?? record.eventDateFrom ?? record.eventDate) },
        { label: "Names", render: (record) => (record.people ?? []).map((person) => person.name).filter(Boolean).join(", ") },
      ]} />
    </AdminFrame>}
    {editing && <AdminEditForm title="Edit Certificate of Appearance" busy={busyId === editing.id} error={error} message={message} className="super-admin-appearance-edit-form" onCancel={() => { setEditing(null); setError(""); }} onSubmit={(event) => void save(event)}>
      <label>Certificate Unit<input value={values.certificateUnit} onChange={(event) => setValues({ ...values, certificateUnit: event.target.value })} /></label>
      <label>Event's Title<input value={values.eventTitle} onChange={(event) => setValues({ ...values, eventTitle: event.target.value })} required /></label>
      <label>Destination<input value={values.destination} onChange={(event) => setValues({ ...values, destination: event.target.value })} /></label>
      <label>Date From<input type="date" value={values.eventDateFrom} onChange={(event) => setValues({ ...values, eventDateFrom: event.target.value })} /></label>
      <label>Date To<input type="date" min={values.eventDateFrom} value={values.eventDateTo} onChange={(event) => setValues({ ...values, eventDateTo: event.target.value })} /></label>
      <label>Certificate Office<input value={values.certificateOffice} onChange={(event) => setValues({ ...values, certificateOffice: event.target.value })} /></label>
      <label>Certificate Division<input value={values.certificateDivision} onChange={(event) => setValues({ ...values, certificateDivision: event.target.value })} /></label>
      <div className="super-admin-dynamic-list wide-field"><div className="super-admin-dynamic-list-heading"><strong>Attendees</strong><button type="button" className="text-button plain-action add-item-text-button" onClick={() => setPeople((current) => [...current, { name: "", gender: "unspecified", office: "", unit: "" }])}>+ Add name</button></div>
        {people.map((person, index) => <fieldset className="super-admin-dynamic-row" key={index}><legend>Name {index + 1}</legend><label>Name<input value={person.name} onChange={(event) => setPeople((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} required /></label><label>Gender<select value={person.gender} onChange={(event) => setPeople((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, gender: event.target.value } : item))}><option value="female">Female</option><option value="male">Male</option><option value="unspecified">Unspecified</option></select></label><label>Office<input value={person.office} onChange={(event) => setPeople((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, office: event.target.value } : item))} /></label><label>Attendee Unit<input value={person.unit} onChange={(event) => setPeople((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, unit: event.target.value } : item))} /></label>{people.length > 1 && <button type="button" className="delete-button" onClick={() => setPeople((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove name</button>}</fieldset>)}
      </div>
      <label>Signatory Name<input value={values.signatoryName} onChange={(event) => setValues({ ...values, signatoryName: event.target.value })} /></label>
      <label>Designation<input value={values.designation} onChange={(event) => setValues({ ...values, designation: event.target.value })} /></label>
      <label className="wide-field">Status<select value={values.status} onChange={(event) => setValues({ ...values, status: event.target.value })}>{["Pending", "Approved", "Disapproved"].map((status) => <option key={status}>{status}</option>)}</select></label>
    </AdminEditForm>}
    <DeleteConfirmation open={Boolean(pendingDelete)} title="Delete this Appearance certificate?" description={`Delete “${text(pendingDelete?.eventTitle) || "this Appearance certificate"}”? Linked document notifications will also be removed.`} busy={Boolean(pendingDelete && busyId === pendingDelete.id)} onCancel={() => setPendingDelete(null)} onConfirm={() => void remove()} />
  </>;
}

export default function SuperAdminRecordManager({ kind, user }: { kind: SuperAdminRecordsKind; user: User }) {
  if (kind === "users-profile") return <UserProfilesManager user={user} />;
  if (kind === "users-nta") return <NtaManager />;
  if (kind === "users-so") return <SpecialOrdersManager />;
  if (kind === "users-to") return <TravelOrdersManager />;
  return <AppearancesManager />;
}
