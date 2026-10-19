"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  reload,
  sendPasswordResetEmail,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  updateProfile,
  type User,
} from "firebase/auth";
import {
  addDoc,
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type QuerySnapshot,
} from "firebase/firestore";
import { auth, db, isFirebaseConfigured } from "@/lib/firebase";
import { filterPersonnelForAccount, filterPersonnelForDivision, loadPersonnel as loadAccountPersonnel, loadPermitAdminSignatories, personnelDisplayName, type PersonnelEntry, type PermitAdminSignatory } from "@/lib/personnel";
import { isFieldOperationsChiefPermitSignatory, isFieldOperationsPermitOwner, isFieldOperationsProjectLeaderPermitOwner, isFieldOperationsProjectLeaderPermitSignatory } from "@/lib/permit-signatory";
import { accountRoleForEmail, normalizeAccountRole, normalizeAccountStatus, SUPERADMIN_EMAIL, type AccountRole, type AccountStatus } from "@/lib/user-roles";
import { accountOffice, accountAssignment, accountDesignation, accountDesignationOptions, accountOfficeOptions, accountPositionOptions, accountProfileSelection, assignmentsForOffice, divisionsForOffice, unitsForOfficeDivision, fieldOperationsAssignments, fieldOperationsCombinedAssignment } from "@/lib/account-profile";
import { isFieldOperationsAppearanceApprover } from "@/lib/certificate-signatory";
import RecordPagination, { useRecordPagination } from "./RecordPagination";
import type { CalendarOfActivitiesApprovalNotification, CalendarOfActivitiesNotification } from "./CalendarOfActivities";
import { calendarOfActivitiesApprovalNotificationsCollection, calendarOfActivitiesNotificationsCollection } from "@/lib/calendar-of-activities-storage";
import { MessengerButton } from "./Messenger";
import ProfilePhotoUpload from "./ProfilePhotoUpload";
import DeleteConfirmation from "./DeleteConfirmation";
import NameSearchSelect from "./NameSearchSelect";
import type { AdminPermit } from "./PermitSlipAdmin";
import { normalizeWorkflowStatus } from "./workflow-status";
import "./special-order.css";
import { assignApprovedPermitNumbers, displayPermitNumber } from "./permit-number";
import { divisionSignatory, formatTaxIdentificationNo, formatTevAmount, tevDivisions } from "@/lib/mytev";
import { getDocumentNotificationReferences, makeDocumentNotification, type DocumentNotification } from "@/lib/document-notifications";
import { documentRemindersCollection, type DocumentReminder } from "@/lib/document-reminders";
import { loadPdfTools } from "@/lib/pdf-tools";
import { loadUnitSharedRecords } from "@/lib/unit-shared-records";
import { canAccessCleaningTaskNavigation, canViewCleaningTaskLanding } from "./CleaningTask";

const NtaModule = dynamic(() => import("./Nta"));
const TravelOrderModule = dynamic(() => import("./TravelOrder"));
const CalendarOfActivitiesModule = dynamic(() => import("./CalendarOfActivities"));
const MessengerModule = dynamic(() => import("./Messenger"));
const LeaveApplicationModule = dynamic(() => import("./LeaveApplication"));
const MyNotesModule = dynamic(() => import("./MyNotes"));
const MyTevModule = dynamic(() => import("./MyTev"));
const WhereaboutsCalendarModule = dynamic(() => import("./WhereaboutsCalendar"));
const AccomplishmentReportModule = dynamic(() => import("./AccomplishmentReport"));
const PermitSlipAdmin = dynamic(() => import("./PermitSlipAdmin"));
const CertificateOfAppearance = dynamic(() => import("./CertificateOfAppearance"));
const CompletionCertificate = dynamic(() => import("./CompletionCertificate"));
const AppreciationCertificate = dynamic(() => import("./AppreciationCertificate"));
const ParticipationCertificate = dynamic(() => import("./ParticipationCertificate"));
const CertificateApproval = dynamic(() => import("./CertificateApproval"));
const UserMasterList = dynamic(() => import("./UserMasterList"));
const DocumentNotificationAdmin = dynamic(() => import("./DocumentNotificationAdmin"));
const PendingPermitSlipAdmin = dynamic(() => import("./PendingPermitSlipAdmin"));
const CleaningTaskModule = dynamic(() => import("./CleaningTask").then((module) => module.CleaningTaskBoard));
const CleaningTaskAssignmentAdmin = dynamic(() => import("./CleaningTask").then((module) => module.CleaningTaskAssignmentAdmin));
const MyDriveModule = dynamic(() => import("./MyDrive"));

function isPermitAdmin(email?: string | null, accountRole?: unknown) {
  const role = normalizeAccountRole(accountRole, email);
  return role === "admin" || role === "superadmin";
}

type Unit = string;
type AccountAssignment = string;
type PermitDecision = { status?: "Pending" | "Approved" | "Disapproved"; decidedAt?: unknown; signerName?: string; decidedBy?: string; approvedPermitNo?: string };
type Permit = { id: string; permitNo: string; permitNos?: string[]; date: string; names: string[]; personIds?: string[]; recipientIds?: string[]; personUnits?: Unit[]; unit: Unit; purpose: string; ownerId?: string; ownerRole?: AccountRole; ownerOffice?: string; ownerDivision?: string; ownerUnit?: string; ownerDesignation?: string; ownerAssignment?: string; personStatuses?: Record<string, PermitDecision>; createdAt?: unknown };
type SpecialOrder = { id: string; subject: string; activityTitle: string; organizer: string; dateFrom: string; dateTo: string; timeFrom?: string; timeTo?: string; venue: string; participants: string[]; participantPositions?: string[]; participantUnits?: string[]; participantOffices?: string[]; participantUserIds?: string[]; participantIds?: string[]; recipientIds?: string[]; signatoryName?: string; signatoryDesignation?: string; ownerId: string; ownerUnit?: string; createdAt?: unknown };

const specialOrderSignatories = [
  { name: "ENGR. RICARDO M. OÑATE JR.", designation: "Regional Executive Director" },
  { name: "REBECCA R. ATEGA", designation: "RTD for Operations" },
  { name: "MARCO ANTONIO C. MORIDO", designation: "RTD for Research and Regulation" },
  { name: "MELODY M. GUIMARY", designation: "Chief, Field Operations Division" },
] as const;
const specialOrderSignatoryOptions = [
  ...tevDivisions.map((division) => {
    const signatory = divisionSignatory(division);
    return {
      value: `division:${division}`,
      label: division,
      name: signatory.name,
      position: `${signatory.position}, ${division}`,
    };
  }),
  ...specialOrderSignatories
    .filter((signatory) => signatory.designation !== "Chief, Field Operations Division")
    .map((signatory) => ({
      value: `role:${signatory.designation}`,
      label: signatory.designation,
      name: signatory.name,
      position: signatory.designation,
    })),
].sort((first, second) => first.label.localeCompare(second.label));

const units: Unit[] = ["AMIA", "AGRISTAT", "DRRM"];
const amiaDocumentTrackingLinks = [
  { label: "Status of Funds", href: "https://docs.google.com/spreadsheets/d/1wSNta-v-unsP5EvxZe5q1oA2YG0lF-xa/edit?gid=800892725" },
  { label: "Acknowledgement Receipt", href: "https://docs.google.com/spreadsheets/d/1u7k481x6vKfyV9btnCIOrBHAociNwZBy/edit?gid=1914856634" },
  { label: "Minimum Requirements", href: "https://docs.google.com/spreadsheets/d/1ZkedGbBjqZkJ0UEohZGBoPL3oafdbNlpsRNizUJ9bQY/edit?gid=1817634266" },
  { label: "Properties Under GBA", href: "https://docs.google.com/spreadsheets/d/1jJULlezndneDggyPKiX4C7nWeANdHeMZ/edit?gid=937100823" },
  { label: "Staff Directory", href: "https://docs.google.com/spreadsheets/d/1SMIOH-UvvM-edpCBfDO3FfWk7pEFhaKy/edit?gid=16567296" },
  { label: "AWS Update", href: "https://docs.google.com/spreadsheets/d/11FouwYOU4J1Z6hDMdjg8HGIwQteHBx4o/edit?gid=1735388733" },
  { label: "Calamity Updates Per Village", href: "https://docs.google.com/spreadsheets/d/1xsYWEK37-Wsaojr0c4viN2iXqIuCr9IN/edit?gid=1833610696" },
  { label: "Calendar of Activities", href: "https://docs.google.com/spreadsheets/d/1IMPltjcxMqNq4B4ebTYxLCjLYWPiCIA1/edit?gid=1167988669" },
  { label: "Drafts", href: "https://docs.google.com/spreadsheets/d/1KvwH2K6Fcx9yKKhI-TBPFYmymwU6i3VU/edit?gid=595053097" },
  { label: "Incoming and Outgoing Basic Correspondence", href: "https://docs.google.com/spreadsheets/d/1xmisHO1IMWiyFQZ6BDrS2Qotbymu5h0b/edit?gid=1840005247" },
  { label: "IPCRs", href: "https://docs.google.com/spreadsheets/d/19noRNTZNuiqK2Qt5HoKx9Y1t4oajJuPF/edit?gid=1505714350" },
  { label: "Others", href: "https://docs.google.com/spreadsheets/d/1C0iXV1Z3TIsAxB62c2jB25yfnhjMV3By/edit?gid=1490275197" },
  { label: "Philip Tracking", href: "https://docs.google.com/spreadsheets/d/1sGCV91KQfms2yuTF2iwuEz5o0SACouTTJKfRyZ1VrKA/edit?usp=sharing" },
  { label: "Physical Accomplishment Updates", href: "https://docs.google.com/spreadsheets/d/1o5hXhVjfOLbMP2KXvbxbF2OgArBMiSU0/edit?gid=328484245" },
  { label: "Procument Updates", href: "https://docs.google.com/spreadsheets/d/1rnl2NxgAXdhwLki0zFFEf4kGYiOcCqnL/edit?gid=387609537" },
  { label: "Photo Documentation", href: "https://darfoxiii-my.sharepoint.com/my?id=%2Fpersonal%2Famia%5Fcaraga%5Fda%5Fgov%5Fph%2FDocuments%2FAMIA%20Communications%2FPhoto%20Documentation%2FAMIA%20Photo%20Documentation&ga=1" },
  { label: "Recieved Documents via QR", href: "https://docs.google.com/spreadsheets/d/108R25W_RgTp3Mpgkuz2QmpqdriOg_P6J5Aemu68Db90/edit?gid=115756846" },
  { label: "Scanned Documents", href: "https://darfoxiii-my.sharepoint.com/my?id=%2Fpersonal%2Famia%5Fcaraga%5Fda%5Fgov%5Fph%2FDocuments%2F2026%20WORKING%20FILES%2FSCANNED%20DOCUMENTS%2DAPPROVED&viewid=a922d1ac%2Da10a%2D4277%2D80dc%2Dd5261e478759" },
  { label: "Special Tasks", href: "https://docs.google.com/spreadsheets/d/1Yc8lndKZSgNwWrbvBUycgDXX27l2SED5/edit?gid=2098609058" },
  { label: "Travel Order Maker 2026", href: "https://docs.google.com/spreadsheets/d/16xng3LBmgNAlBtB115t8ZWzPoPOxXUUQ/edit?gid=8330880" },
  { label: "Travel Orders and Post Travel Reports", href: "https://docs.google.com/spreadsheets/d/1hniVoqkTFN7WmouP2NrFzmfQ4bNWg5sK/edit?gid=1841021416" },
];
const calendarOfActivitiesUnitLabel = (unit: string) => unit === "Field Operations Division" ? unit : `FOD-${unit}`;
const publicAsset = (path: string) => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
function tinCaretPosition(value: string, digitsBeforeCaret: number) {
  let position = 0;
  let digitsSeen = 0;
  while (position < value.length && digitsSeen < digitsBeforeCaret) {
    if (/\d/.test(value[position])) digitsSeen += 1;
    position += 1;
  }
  if (digitsSeen === digitsBeforeCaret && value[position] === "-") position += 1;
  return position;
}

function updateTaxIdentificationNo(event: ChangeEvent<HTMLInputElement>, setValue: (value: string) => void) {
  const input = event.currentTarget;
  const caret = input.selectionStart ?? input.value.length;
  const digitsBeforeCaret = input.value.slice(0, caret).replace(/\D/g, "").length;
  const formatted = formatTaxIdentificationNo(input.value);
  setValue(formatted);
  requestAnimationFrame(() => {
    const nextCaret = tinCaretPosition(formatted, digitsBeforeCaret);
    input.setSelectionRange(nextCaret, nextCaret);
  });
}

function handleTaxIdentificationNoKeyDown(event: ReactKeyboardEvent<HTMLInputElement>, setValue: (value: string) => void) {
  const input = event.currentTarget;
  const caret = input.selectionStart;
  if (caret === null || caret !== input.selectionEnd) return;
  const isBackspaceAtDash = event.key === "Backspace" && input.value[caret - 1] === "-";
  const isDeleteAtDash = event.key === "Delete" && input.value[caret] === "-";
  if (!isBackspaceAtDash && !isDeleteAtDash) return;

  const digits = input.value.replace(/\D/g, "");
  const digitsBeforeCaret = input.value.slice(0, caret).replace(/\D/g, "").length;
  const removeIndex = isBackspaceAtDash ? digitsBeforeCaret - 1 : digitsBeforeCaret;
  if (removeIndex < 0 || removeIndex >= digits.length) return;

  event.preventDefault();
  const formatted = formatTaxIdentificationNo(`${digits.slice(0, removeIndex)}${digits.slice(removeIndex + 1)}`);
  setValue(formatted);
  requestAnimationFrame(() => {
    const nextCaret = tinCaretPosition(formatted, removeIndex);
    input.setSelectionRange(nextCaret, nextCaret);
  });
}

function permitUnitForPersonnel(person?: PersonnelEntry): Unit | "" {
  const value = person?.unit.trim() ?? "";
  if (value.toUpperCase() === "AGRICULTURAL STATISTICS") return "AGRISTAT";
  return value;
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium" }).format(new Date(`${date}T00:00:00`));
}

function assignedDocumentSummary(notification: DocumentNotification) {
  if (notification.activityTitle?.trim()) return notification.activityTitle.trim();
  switch (notification.documentType) {
    case "Special Order": return "You have been designated to attend an activity.";
    case "Notice to Attend": return "You have been invited to attend an activity.";
    case "Permit Slip": return "A Permit Slip has been assigned to you.";
    case "Travel Order": return "A Travel Order has been assigned to you.";
    default: return "An assigned document is available.";
  }
}

async function migrateAccountProfileFieldsForSuperAdmin() {
  if (!db) return;
  const snapshot = await getDocs(collection(db, "users"));
  const legacyProfiles = snapshot.docs.filter((item) => item.data().profileFieldsVersion !== 4
    && item.data().registrationStage !== "detailsRequired");
  for (let offset = 0; offset < legacyProfiles.length; offset += 450) {
    const batch = writeBatch(db);
    legacyProfiles.slice(offset, offset + 450).forEach((item) => {
      batch.set(item.ref, {
        office: "",
        division: "",
        unit: "",
        profileFieldsVersion: 4,
        assignment: deleteField(),
        projectProgram: deleteField(),
      }, { merge: true });
    });
    await batch.commit();
  }
}

function formatCertificateNotificationSchedule(from?: string, to?: string) {
  if (!from) return "Not specified";
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to || from}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "Not specified";
  const month = (date: Date) => new Intl.DateTimeFormat("en-PH", { month: "long" }).format(date);
  const year = (date: Date) => date.getFullYear();
  if (start.getTime() === end.getTime()) return `${month(start)} ${start.getDate()}, ${year(start)}`;
  if (start.getMonth() === end.getMonth() && year(start) === year(end)) return `${month(start)} ${start.getDate()}-${end.getDate()}, ${year(end)}`;
  if (year(start) === year(end)) return `${month(start)} ${start.getDate()}-${month(end)} ${end.getDate()}, ${year(end)}`;
  return `${month(start)} ${start.getDate()}, ${year(start)}-${month(end)} ${end.getDate()}, ${year(end)}`;
}

function formatTravelMonth(value?: string) {
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return value || "the selected month";
  return new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}-01T00:00:00Z`));
}

function formatPhilippineDateTime(date: Date) {
  const dateText = new Intl.DateTimeFormat("en-PH", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "Asia/Manila" }).format(date);
  const timeParts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hourCycle: "h12", timeZone: "Asia/Manila" }).formatToParts(date);
  const timePart = (type: string) => timeParts.find((part) => part.type === type)?.value ?? "";
  const timeText = `${timePart("hour")}:${timePart("minute")} ${timePart("dayPeriod").toUpperCase()}`;
  return `${dateText} | ${timeText}`;
}

function getPhilippineBiometricsGreeting(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Manila" }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  if (["Sat", "Sun"].includes(part("weekday"))) return "Enjoy Your Weekend";
  if (!["Mon", "Tue", "Wed", "Thu", "Fri"].includes(part("weekday"))) return null;
  const minutes = Number(part("hour")) * 60 + Number(part("minute"));
  if (minutes >= 3 * 60 && minutes <= 7 * 60 + 30) return "Masaganang Buntag";
  if (minutes >= 12 * 60 && minutes <= 12 * 60 + 29) return "BIOMETRICS Break-out";
  if (minutes >= 12 * 60 + 31 && minutes <= 12 * 60 + 59) return "BIOMETRICS Break-in";
  if (minutes >= 17 * 60 && minutes <= 17 * 60 + 15) return "BIOMETRICS Check-out";
  return null;
}

function formatTime(value?: string) {
  if (!value) return "";
  const [hours, minutes] = value.split(":").map(Number);
  const date = new Date(2000, 0, 1, hours, minutes);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-PH", { hour: "numeric", minute: "2-digit", hour12: true }).format(date);
}

function formatTimeRange(from?: string, to?: string) {
  const start = formatTime(from);
  const end = formatTime(to);
  return start && end ? `${start} to ${end}` : "—";
}

function signatureDate(value: unknown) {
  const date = value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function"
    ? value.toDate() as Date
    : value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}.${part("month")}.${part("day")}`;
}

function signatureTime(value: unknown) {
  const date = value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function"
    ? value.toDate() as Date
    : value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const time = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
  return `${time} +0800`;
}

function Login({ onError }: { onError: (message: string) => void }) {
  const [registering, setRegistering] = useState(false);
  const [forgotPasswordOpen, setForgotPasswordOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth) return;
    setAuthMessage(null);
    if (registering && password !== confirmPassword) {
      setAuthMessage({ kind: "error", text: "The passwords do not match." });
      return;
    }
    setBusy(true);
    onError("");
    try {
      if (registering) {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        if (!db) throw new Error("Profile storage is unavailable.");
        const isRootSuperAdmin = credential.user.email?.trim().toLowerCase() === SUPERADMIN_EMAIL;
        await setDoc(doc(db, "users", credential.user.uid), {
          registrationStage: "detailsRequired",
          emailVerified: false,
          accountRole: accountRoleForEmail(credential.user.email),
          accountStatus: "Pending",
          isRootSuperAdmin,
        });
        await sendEmailVerification(credential.user);
        await signOut(auth);
        setRegistering(false);
        setPassword("");
        setConfirmPassword("");
        setAuthMessage({ kind: "success", text: `A verification link was sent to ${credential.user.email}. Verify your email, then sign in with your email and password to complete your account details.` });
      } else {
        const credential = await signInWithEmailAndPassword(auth, email, password);
        await reload(credential.user);
        if (!credential.user.emailVerified) {
          await sendEmailVerification(credential.user);
          await signOut(auth);
          setAuthMessage({ kind: "error", text: "Your email is not verified yet. We sent another verification link; verify your email before signing in." });
        }
      }
    } catch (error) {
      if (auth.currentUser && !auth.currentUser.emailVerified) await signOut(auth).catch(() => undefined);
      const firebaseError = error as { code?: string; message?: string };
      const code = firebaseError.code?.replace("auth/", "");
      const invalidSignInCodes = ["invalid-credential", "invalid-login-credentials", "user-not-found", "wrong-password"];
      const message = !registering && invalidSignInCodes.includes(code ?? "")
        ? "Email or password is incorrect. Please check your details and try again."
        : registering
          ? code === "email-already-in-use"
            ? "An account already exists for this email. Sign in, verify the email if requested, and complete your account details."
            : code ? `Unable to create your account (${code}). Check that the latest Firestore rules are deployed, then try again.`
              : "Unable to create your account. Please check your details and try again."
          : "Unable to sign in. Please check your details and try again.";
      setAuthMessage({ kind: "error", text: message });
      onError(message);
    } finally { setBusy(false); }
  }

  async function sendLoginReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth) return;
    const resetEmail = email.trim();
    setAuthMessage(null);
    setBusy(true);
    try {
      await sendPasswordResetEmail(auth, resetEmail);
      setAuthMessage({ kind: "success", text: `A password reset link was sent to ${resetEmail}. Check your inbox.` });
    } catch (error) {
      const firebaseError = error as { code?: string; message?: string };
      const code = firebaseError.code?.replace("auth/", "");
      const message = code === "user-not-found"
        ? "The email is not registered."
        : code ? `${code}: ${firebaseError.message ?? "Could not send a password reset link."}` : "Could not send a password reset link. Try again.";
      setAuthMessage({ kind: "error", text: message });
    } finally { setBusy(false); }
  }

  return <main className="auth-shell">
    <section className="auth-intro"><video className="auth-intro-image" src={publicAsset("/left.mp4")} aria-label="My Desk portal for managing documents" role="img" autoPlay loop muted playsInline controls={false} disablePictureInPicture disableRemotePlayback onContextMenu={(event) => event.preventDefault()} /></section>
    <section className="auth-panel"><div className={`auth-form-wrap${registering ? " auth-register-wrap" : ""}`}><div className="mobile-brand"><img className="brand-mark brand-logo" src="/my%20desk%20logo.png" alt="My Desk logo" draggable={false} onDragStart={(event) => event.preventDefault()} onContextMenu={(event) => event.preventDefault()} /><span>My Desk</span></div><p className="eyebrow">{forgotPasswordOpen ? "Password reset" : registering ? "New account" : "Welcome back"}</p><h2>{forgotPasswordOpen ? "Reset your password" : registering ? "Create your account" : <>Sign in to <img className="auth-title-logo" src="/my%20desk%20logo.png" alt="My Desk" draggable={false} onDragStart={(event) => event.preventDefault()} onContextMenu={(event) => event.preventDefault()} /></>}</h2>{(forgotPasswordOpen || registering) && <p className="muted">{forgotPasswordOpen ? "Enter your account email and we will send a password reset link." : "Create an account, verify your email, then complete your profile for Super Admin approval."}</p>}
      {authMessage && <div className={`auth-message auth-message-${authMessage.kind}`} role={authMessage.kind === "error" ? "alert" : "status"}>{authMessage.text}</div>}
      {forgotPasswordOpen ? <form className="auth-reset-form" onSubmit={sendLoginReset}>
        <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="your email here" required /></label>
        <button className="primary-button" disabled={busy}>{busy ? "Sending..." : "Reset"}</button>
        <button type="button" className="text-button plain-action" onClick={() => { setForgotPasswordOpen(false); setAuthMessage(null); }}>Back to Sign In</button>
      </form> : <>
        <form className={registering ? "auth-registration-form auth-credential-registration-form" : undefined} onSubmit={submit}>
          {(registering || !forgotPasswordOpen) && <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="your email here" required /></label>}
          {registering ? <div className="auth-password-fields"><label>Password<div className="password-field"><input type={showPassword ? "text" : "password"} autoComplete="new-password" minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 6 characters" required /><button type="button" className="password-toggle" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword(!showPassword)}>{showPassword ? "Hide" : "Show"}</button></div></label><label>Password Confirmation<div className="password-field"><input type={showConfirmPassword ? "text" : "password"} autoComplete="new-password" minLength={6} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Confirm your password" required /><button type="button" className="password-toggle" aria-label={showConfirmPassword ? "Hide confirmation password" : "Show confirmation password"} onClick={() => setShowConfirmPassword(!showConfirmPassword)}>{showConfirmPassword ? "Hide" : "Show"}</button></div></label></div> : !forgotPasswordOpen && <label>Password<div className="password-field"><input type={showPassword ? "text" : "password"} autoComplete="current-password" minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 6 characters" required /><button type="button" className="password-toggle" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword(!showPassword)}>{showPassword ? "Hide" : "Show"}</button></div></label>}
          {registering && confirmPassword && confirmPassword !== password && <p className="auth-validation-message" role="alert">Passwords do not match.</p>}
          <button className="primary-button" disabled={busy}>{busy ? "Please wait..." : registering ? "Create account" : "Sign in"}</button>
        </form>
        <div className="auth-footer-actions">
          {!registering && !forgotPasswordOpen && <button type="button" className="text-button plain-action auth-forgot-password" onClick={() => { setForgotPasswordOpen(true); setAuthMessage(null); }}>Forgot Password?</button>}
          <button type="button" className="text-button plain-action" onClick={() => { setRegistering(!registering); setForgotPasswordOpen(false); setConfirmPassword(""); setShowConfirmPassword(false); setAuthMessage(null); onError(""); }}>{registering ? "Already have an account? Sign in" : "Need an account? Register here"}</button>
        </div>
      </>}
    </div></section>
  </main>;
}

function RegistrationDetails({ user, onSubmitted }: { user: User; onSubmitted: (user: User) => void }) {
  const [firstName, setFirstName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [lastName, setLastName] = useState("");
  const [gender, setGender] = useState("");
  const [position, setPosition] = useState("");
  const [customPosition, setCustomPosition] = useState(false);
  const [office, setOffice] = useState("");
  const [division, setDivision] = useState("");
  const [unit, setUnit] = useState("");
  const [designation, setDesignation] = useState("");
  const [address, setAddress] = useState("");
  const [taxIdentificationNo, setTaxIdentificationNo] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth || !db) {
      setMessage({ kind: "error", text: "Account storage is unavailable. Please try again later." });
      return;
    }
    const clean = (value: string) => value.trim().replace(/\s+/g, " ");
    const normalizedFirstName = clean(firstName);
    const normalizedMiddleName = clean(middleName);
    const normalizedLastName = clean(lastName);
    const normalizedPosition = clean(position);
    const normalizedOffice = clean(office);
    const normalizedDivision = clean(division);
    const normalizedUnit = clean(unit);
    const normalizedDesignation = clean(accountDesignation(designation));
    const normalizedAddress = clean(address);
    const normalizedTin = formatTaxIdentificationNo(taxIdentificationNo);
    if (!user.emailVerified) {
      setMessage({ kind: "error", text: "Verify your email address before completing your account." });
      return;
    }
    if (!normalizedFirstName || !normalizedLastName || !gender || !normalizedPosition || !normalizedOffice || !normalizedDivision || !normalizedUnit || !normalizedDesignation || !normalizedAddress || !normalizedTin) {
      setMessage({ kind: "error", text: "Complete all required fields before submitting your account for approval." });
      return;
    }
    if ([normalizedFirstName, normalizedMiddleName, normalizedLastName].some((namePart) => namePart.length > 60)
      || [normalizedFirstName, normalizedMiddleName, normalizedLastName].filter(Boolean).join(" ").length > 120
      || normalizedPosition.length > 120
      || normalizedDesignation.length > 120) {
      setMessage({ kind: "error", text: "Check the length of your name, position, and designation, then try again." });
      return;
    }
    if (!/^\d{3}-\d{3}-\d{3}$/.test(normalizedTin)) {
      setMessage({ kind: "error", text: "Enter a 9-digit tax identification number in 123-123-123 format." });
      return;
    }
    if (!(divisionsForOffice(normalizedOffice) as readonly string[]).includes(normalizedDivision)) {
      setMessage({ kind: "error", text: "Choose a Division that belongs to the selected Office." });
      return;
    }
    if (!(unitsForOfficeDivision(normalizedOffice, normalizedDivision) as readonly string[]).includes(normalizedUnit)) {
      setMessage({ kind: "error", text: "Choose a Unit / Program / Project that belongs to the selected Division." });
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      await reload(user);
      if (!user.emailVerified) throw new Error("Verify your email address before completing your account.");
      const name = [normalizedFirstName, normalizedMiddleName, normalizedLastName].filter(Boolean).join(" ");
      const isRootSuperAdmin = user.email?.trim().toLowerCase() === SUPERADMIN_EMAIL;
      await updateProfile(user, { displayName: name });
      await setDoc(doc(db, "users", user.uid), {
        name,
        firstName: normalizedFirstName,
        middleName: normalizedMiddleName,
        lastName: normalizedLastName,
        gender,
        position: normalizedPosition,
        office: normalizedOffice,
        division: normalizedDivision,
        unit: normalizedUnit,
        designation: normalizedDesignation,
        profileFieldsVersion: 4,
        address: normalizedAddress,
        taxIdentificationNo: normalizedTin,
        emailVerified: true,
        registrationStage: "complete",
        accountRole: accountRoleForEmail(user.email),
        accountStatus: isRootSuperAdmin ? "Approved" : "Pending",
        isRootSuperAdmin,
        createdAt: serverTimestamp(),
      }, { merge: true });
      onSubmitted(user);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      const reason = cause instanceof Error ? cause.message : "Could not save your account details.";
      setMessage({ kind: "error", text: code ? `Could not submit your account (${code}).` : reason });
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-shell">
    <section className="auth-intro"><video className="auth-intro-image" src={publicAsset("/left.mp4")} aria-label="My Desk portal for managing documents" role="img" autoPlay loop muted playsInline controls={false} disablePictureInPicture disableRemotePlayback onContextMenu={(event) => event.preventDefault()} /></section>
    <section className="auth-panel"><div className="auth-form-wrap auth-register-wrap"><div className="mobile-brand"><img className="brand-mark brand-logo" src="/my%20desk%20logo.png" alt="My Desk logo" draggable={false} onDragStart={(event) => event.preventDefault()} onContextMenu={(event) => event.preventDefault()} /><span>My Desk</span></div>
      <p className="eyebrow">Verified email</p><h2>Complete your account</h2>
      <p className="muted">Your email is verified. Add your work details and submit them for Super Admin approval.</p>
      <p className="registration-verified-email"><strong>Email</strong><span>{user.email}</span></p>
      {message && <div className={`auth-message auth-message-${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</div>}
      <form className="registration-details-form" onSubmit={submit} aria-busy={busy}>
        <div className="registration-name-fields">
          <label>First Name<input autoComplete="given-name" maxLength={60} value={firstName} onChange={(event) => setFirstName(event.target.value)} required disabled={busy} /></label>
          <label>Middle Name<input autoComplete="additional-name" maxLength={60} value={middleName} onChange={(event) => setMiddleName(event.target.value)} disabled={busy} /></label>
          <label>Last Name<input autoComplete="family-name" maxLength={60} value={lastName} onChange={(event) => setLastName(event.target.value)} required disabled={busy} /></label>
        </div>
        <div className="registration-demographic-fields">
          <label>Gender<select autoComplete="sex" value={gender} onChange={(event) => setGender(event.target.value)} required disabled={busy}><option value="">Select gender</option><option value="Female">Female</option><option value="Male">Male</option></select></label>
          <label>Position{customPosition ? <div className="password-field"><input autoComplete="organization-title" maxLength={120} list="registration-position-options" value={position} onChange={(event) => setPosition(event.target.value)} placeholder="Enter your Position" required disabled={busy} /><datalist id="registration-position-options">{accountPositionOptions.map((option) => <option key={option} value={option} />)}</datalist><button type="button" className="password-toggle plain-action position-list-toggle" aria-label="Choose a Position from the list" disabled={busy} onClick={() => { setPosition(""); setCustomPosition(false); }}>List</button></div> : <select autoComplete="organization-title" value={position} onChange={(event) => { const nextPosition = event.target.value; if (nextPosition === "__other__") { setPosition(""); setCustomPosition(true); } else setPosition(nextPosition); }} required disabled={busy}><option value="">Select your Position</option>{accountPositionOptions.map((option) => <option key={option} value={option}>{option}</option>)}<option value="__other__">Others</option></select>}</label>
          <label>Designation<DesignationPicker id="registration-designation" value={designation} onChange={setDesignation} disabled={busy} required /></label>
        </div>
        <div className="registration-account-fields">
          <label>Office<select value={office} onChange={(event) => { setOffice(event.target.value); setDivision(""); setUnit(""); }} required disabled={busy}><option value="">Select your Office</option>{accountOfficeOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
          <label>Division<select value={division} onChange={(event) => { setDivision(event.target.value); setUnit(""); }} required disabled={busy || !office}><option value="">{office ? "Select your Division" : "Select an Office first"}</option>{divisionsForOffice(office).map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
          <label>Unit / Program / Project<select value={unit} onChange={(event) => setUnit(event.target.value)} required disabled={busy || !division}><option value="">{division ? "Select your Unit / Program / Project" : "Select a Division first"}</option>{unitsForOfficeDivision(office, division).map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
        </div>
        <label className="registration-details-wide">Address<input autoComplete="street-address" maxLength={200} value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Street, Building, City, Province" required disabled={busy} /></label>
        <label className="registration-details-wide">Tax Identification No.<input type="text" inputMode="numeric" autoComplete="off" maxLength={11} value={taxIdentificationNo} onChange={(event) => updateTaxIdentificationNo(event, setTaxIdentificationNo)} onKeyDown={(event) => handleTaxIdentificationNoKeyDown(event, setTaxIdentificationNo)} required disabled={busy} /></label>
        <button className="primary-button registration-details-wide" disabled={busy}>{busy ? "Submitting..." : "Submit"}</button>
      </form>
    </div></section>
  </main>;
}

function DesignationPicker({ value, onChange, disabled, id = "profile-designation-toggle", required = false }: { value: string; onChange: (value: string) => void; disabled?: boolean; id?: string; required?: boolean }) {
  const designation = accountDesignation(value);
  const sortedDesignationOptions = [...accountDesignationOptions].sort((first, second) => first.localeCompare(second, "en", { sensitivity: "base" }));
  const isListedDesignation = accountDesignationOptions.some((option) => option === designation);
  const [customDesignation, setCustomDesignation] = useState(Boolean(designation && !isListedDesignation));

  useEffect(() => {
    if (designation) setCustomDesignation(!isListedDesignation);
  }, [designation, isListedDesignation]);

  return customDesignation
    ? <div className="password-field"><input id={id} type="text" maxLength={120} value={designation} placeholder="Enter your Designation" aria-label="Designation" disabled={disabled} required={required} onChange={(event) => onChange(event.target.value)} /><button type="button" className="password-toggle plain-action position-list-toggle" aria-label="Choose a Designation from the list" disabled={disabled} onClick={() => { onChange(""); setCustomDesignation(false); }}>List</button></div>
    : <select id={id} value={designation} onChange={(event) => {
      if (event.target.value === "__other__") {
        onChange("");
        setCustomDesignation(true);
      } else onChange(event.target.value);
    }} disabled={disabled} required={required}>
      <option value="">Select your Designation</option>
      {sortedDesignationOptions.map((option) => <option key={option} value={option}>{option}</option>)}
      <option value="__other__">Others</option>
    </select>;
}
function PermitForm({ user, office, assignment, division = "", unit = "", designation = "", onSaved, onCancel, onError }: { user: User; office: string; assignment: string; division?: string; unit?: string; designation?: string; onSaved: (permit: Permit) => void; onCancel: () => void; onError: (message: string) => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [people, setPeople] = useState<{ name: string; userId: string }[]>([{ name: "", userId: "" }]);
  const [purpose, setPurpose] = useState(""); // Purpose of the permit
  const [personnel, setPersonnel] = useState<PersonnelEntry[]>([]);
  const [personnelStatus, setPersonnelStatus] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadPersonnel() {
      try {
        const entries = await loadAccountPersonnel({ includeAllAccounts: true, deduplicateByName: false });
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
  }, []);

  function selectPerson(index: number, userId: string) {
    const selectedPerson = personnel.find((person) => person.userId === userId);
    setPeople((current) => current.map((person, currentIndex) => currentIndex === index
      ? { name: selectedPerson?.name ?? "", userId }
      : person));
  }

  function removePerson(index: number) {
    setPeople((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }

  const selectedPermitPersonnelIds = new Set(people.flatMap((person) => person.userId ? [person.userId] : []));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!db) return;
    const selectedPeople = people.map((person) => ({ ...person, name: person.name.trim(), unit: permitUnitForPersonnel(personnel.find((candidate) => candidate.userId === person.userId)) })).filter((person) => person.name);
    if (!selectedPeople.length) { onError("Select at least one personnel name."); return; }
    const missingUnit = selectedPeople.find((person) => !person.unit);
    if (missingUnit) { onError(`Update ${missingUnit.name}'s Office, Division, and Unit / Program / Project in Profile before creating this Permit Slip.`); return; }
    const nameList = selectedPeople.map((person) => person.name);
    const personIds = selectedPeople.map((person) => person.userId);
    const personUnits = selectedPeople.map((person) => person.unit as Unit);
    const firestore = db;
    setBusy(true); onError("");
    try {
      const submitterSnapshot = await getDoc(doc(firestore, "users", user.uid));
      if (!submitterSnapshot.exists()) throw new Error("Complete your Office, Division, and Unit / Program / Project in Profile before creating this Permit Slip.");
      const submitterData = submitterSnapshot.data();
      const savedProfile = accountProfileSelection(submitterData);
      const ownerOffice = savedProfile.office || office;
      const ownerDivision = savedProfile.division || division;
      const ownerUnit = savedProfile.unit || unit || assignment;
      const ownerDesignation = accountDesignation(submitterData.designation) || designation;
      if (!ownerOffice || !ownerDivision || !ownerUnit || !ownerDesignation) {
        throw new Error("Complete your Office, Division, Unit / Program / Project, and Designation in Profile before creating this Permit Slip.");
      }
      const year = new Date(`${date}T00:00:00`).getFullYear();
      const permit = await runTransaction(firestore, async (transaction) => {
        const unitCounterRefs = units.map((counterUnit) => doc(firestore, "permitCounters", `${counterUnit}-${year}`));
        const yearCounterRef = doc(firestore, "permitCounters", `year-${year}`);
        const counterSnapshots = await Promise.all([...unitCounterRefs, yearCounterRef].map((counterRef) => transaction.get(counterRef)));
        const firstNumber = Math.max(0, ...counterSnapshots.map((snapshot) => Number(snapshot.exists() ? snapshot.data().lastNumber : 0) || 0)) + 1;
        const permitNos = nameList.map((_, index) => `${year}-${String(firstNumber + index).padStart(4, "0")}`);
        const lastNumber = firstNumber + nameList.length - 1;
        const permitRef = doc(collection(firestore, "permits"));
        const record = { permitNo: permitNos[0], permitNos, date, names: nameList, personIds, recipientIds: [...new Set(personIds.filter((id) => id && id !== user.uid))], personUnits, unit: personUnits[0], purpose: purpose.trim(), ownerId: user.uid, ownerRole: normalizeAccountRole(submitterData.accountRole, user.email), ownerOffice, ownerDivision, ownerUnit, ownerDesignation, ownerAssignment: savedProfile.assignment || ownerUnit, createdAt: serverTimestamp() };
        unitCounterRefs.forEach((counterRef, index) => transaction.set(counterRef, { lastNumber, unit: units[index], year }));
        transaction.set(yearCounterRef, { lastNumber, year });
        transaction.set(permitRef, record);
        [...new Set(personIds.filter((id) => id && id !== user.uid))].forEach((recipientId) => {
          const notification = makeDocumentNotification(firestore, { recipientId, ownerId: user.uid, documentId: permitRef.id, documentType: "Permit Slip", date, purpose: purpose.trim() });
          transaction.set(notification.reference, notification.data);
        });
        return { id: permitRef.id, ...record } as Permit;
      });
      onSaved(permit);
    } catch (error) { onError(error instanceof Error ? error.message : "Unable to save permit."); }
    finally { setBusy(false); }
  }

  return <section className="content-section form-section permit-slip-form-section"><div className="section-heading"><div><p className="eyebrow">New record</p><h2>Enter permit details</h2><p className="muted">The PS No. is assigned when the Permit Slip is approved.</p></div><button className="ghost-button" onClick={onCancel}>Cancel</button></div><form className="permit-form permit-slip-create-form" onSubmit={save}><label className="permit-date-field">Date<input className="permit-date-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label><div className="permit-person-fields wide-field">{people.map((person, index) => <div className={`permit-person-entry${people.length > 1 ? " permit-person-entry-multiple" : ""}`} key={index}><div className="name-search-field"><span>Personnel</span><NameSearchSelect aria-label={`Personnel ${index + 1}`} value={person.userId} onChange={(userId) => selectPerson(index, userId)} required={index === 0} disabled={personnelStatus !== "ready"}><option value="" disabled>{personnelStatus === "loading" ? "Loading personnel..." : personnelStatus === "error" ? "Personnel list unavailable" : "Select a personnel"}</option>{personnel.filter((candidate) => candidate.userId === person.userId || !selectedPermitPersonnelIds.has(candidate.userId)).map((candidate) => <option key={candidate.userId} value={candidate.userId}>{personnelDisplayName(candidate)}</option>)}</NameSearchSelect></div>{people.length > 1 && <button type="button" className="remove-participant" aria-label={`Delete person ${index + 1}`} onClick={() => removePerson(index)}>Delete</button>}</div>)}<button type="button" className="text-button plain-action add-item-text-button add-participant" onClick={() => setPeople((current) => [...current, { name: "", userId: "" }])}>+ Add personnel</button>{personnelStatus === "error" && <span className="auth-message auth-message-error" role="alert">Unable to load personnel from user accounts. Reload the page to try again.</span>}</div><label className="wide-field permit-purpose-field">Purpose<textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="Why is this permit being requested?" rows={1} required /></label><div className="form-actions"><button className="primary-button" disabled={busy}>{busy ? "Saving..." : "Save"}</button></div></form></section>;
}

function hasFinalPermitStatus(permit: Permit) {
  return permit.names.some((_, index) => {
    const status = normalizeWorkflowStatus(permit.personStatuses?.[permitDecisionKey(permit, index)]?.status);
    return status === "Approved" || status === "Disapproved";
  });
}

function PermitList({ permits, approvedPermitNumbers, ownerId, preparedByNames, fallbackPreparedBy, deletingId, onNew, onPrint, onDelete }: { permits: Permit[]; approvedPermitNumbers: Record<string, string>; ownerId: string; preparedByNames: Record<string, string>; fallbackPreparedBy: string; deletingId: string | null; onNew: () => void; onPrint: (permit: Permit) => void; onDelete: (permit: Permit) => void }) {
  const { currentPage, pageCount, visibleRecords, setPage } = useRecordPagination(permits);
  return <section className="content-section"><div className="section-heading"><div><p className="eyebrow">Your records</p><h2>Permit Slips</h2><p className="muted">{permits.length} {permits.length === 1 ? "slip" : "slips"} available to your account.</p></div><button className="primary-button" onClick={onNew}>Add</button></div>{permits.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No permit slips yet</h3><p>Create your first record to see it here.</p><button className="text-button plain-action document-create-action" onClick={onNew}>Create a Permit Slip</button></div> : <div className="permit-table"><RecordPagination totalRecords={permits.length} currentPage={currentPage} pageCount={pageCount} onPageChange={setPage} label="Permit Slip" /><div className="table-head permit-list-head"><span>Permit no.</span><span>Date</span><span>Name</span><span>Prepared By</span><span>Office</span><span aria-hidden="true" /></div>{visibleRecords.map((permit) => <div className="table-row permit-list-row" key={permit.id}><strong data-label="Permit no.">{permit.names.map((_, index) => {
    const originalNumber = permit.permitNos?.[index] ?? permit.permitNo;
    const decision = permit.personStatuses?.[permitDecisionKey(permit, index)];
    if (normalizeWorkflowStatus(decision?.status) !== "Approved") return "Pending";
    const key = displayPermitNumber(originalNumber);
    return (decision?.approvedPermitNo ?? approvedPermitNumbers[key] ?? key) || "—";
  }).join(", ")}</strong><span data-label="Date">{formatDate(permit.date)}</span><span data-label="Name"><span className="permit-person-name-list">{permit.names.map((name, index) => <span key={`${permit.id}-name-${index}`}>{name}</span>)}</span></span><span data-label="Prepared By">{(permit.ownerId === ownerId ? fallbackPreparedBy : "") || preparedByNames[permit.ownerId ?? ""] || "—"}</span><span data-label="Office"><span className="permit-person-unit-list">{permit.names.map((_, index) => <b className="unit-tag" key={`${permit.id}-unit-${index}`}>{permit.personUnits?.[index] ?? permit.unit}</b>)}</span></span><span className="permit-row-actions"><button type="button" className="row-action" onClick={() => onPrint(permit)}>View</button>{permit.ownerId === ownerId && !hasFinalPermitStatus(permit) && <button type="button" className="delete-button" disabled={deletingId !== null} onClick={() => onDelete(permit)}>{deletingId === permit.id ? "Deleting..." : "Delete"}</button>}</span></div>)}</div>}</section>;
}

function chunkNames(names: string[], size: number) {
  const chunks: string[][] = [];
  for (let index = 0; index < names.length; index += size) chunks.push(names.slice(index, index + size));
  return chunks;
}

function permitDecisionKey(permit: Permit, index: number) {
  const personNumber = permit.permitNos?.[index];
  if (typeof personNumber === "string" && personNumber) return personNumber;
  const permitNo = typeof permit.permitNo === "string" ? permit.permitNo : "";
  const keyBase = permitNo || permit.id;
  return permit.names.length > 1 ? `${keyBase}__person_${index + 1}` : keyBase;
}

function permitPersonNumber(permit: Pick<Permit, "id" | "permitNo" | "permitNos" | "names">, index: number) {
  const personNumber = permit.permitNos?.[index];
  if (typeof personNumber === "string" && personNumber) return personNumber;
  const permitNo = typeof permit.permitNo === "string" ? permit.permitNo : "";
  const keyBase = permitNo || permit.id;
  return permit.names.length > 1 ? `${keyBase}__person_${index + 1}` : keyBase;
}

function timestampMillis(value: unknown) {
  const date = value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function"
    ? value.toDate() as Date
    : value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  const milliseconds = date?.getTime();
  return typeof milliseconds === "number" && Number.isFinite(milliseconds) ? milliseconds : 0;
}

type PermitNotification = { permit: Permit; personIndex: number; permitNo: string; name: string; date: string; status: "Approved" | "Disapproved"; decidedAt?: unknown };
type PendingPermitNotification = { permitId: string; statusKey: string; permitNo: string; name: string; date: string; purpose: string; submittedAt: number };
type PermitNotificationAccount = { office: string; division: string; unit: string; assignment: string; designation: string; accountRole: AccountRole };
type PendingAccountApprovalNotification = { userId: string; name: string; office: string; division: string; unit: string };
type NotificationFocus =
  | { kind: "document"; id: string; documentType: DocumentNotification["documentType"]; certificateCollection?: DocumentNotification["certificateCollection"] }
  | { kind: "reminder"; id?: string; reminderKind: DocumentReminder["kind"]; month?: string; cycle?: 1 | 2 }
  | { kind: "calendar"; id: string; mode: "prepared" | "approved-records" };
const permitNotificationVisibilityMs = 4 * 60 * 60 * 1000;

function permitApprovalRoute(ownerOffice: string, ownerDivision: string, ownerUnit: string): "fod" | null {
  if (ownerOffice === "Division" && ownerDivision === "Field Operations Division"
    && fieldOperationsAssignments.includes(ownerUnit as (typeof fieldOperationsAssignments)[number])) return "fod";
  if (ownerOffice === "Field Operations Division" && assignmentsForOffice(ownerOffice).some((unit) => unit === ownerUnit)) return "fod";
  return null;
}

function permitNotificationAccountMatches(owner: PermitNotificationAccount, reviewer: PermitNotificationAccount) {
  if (owner.accountRole !== "regular" || reviewer.accountRole !== "admin") return false;
  const ownerProfile = { ownerRole: owner.accountRole, ownerOffice: owner.office, ownerDivision: owner.division, ownerUnit: owner.unit };
  const isChiefScopeOwner = isFieldOperationsPermitOwner(ownerProfile);
  const isProjectLeaderScopeOwner = isFieldOperationsProjectLeaderPermitOwner(ownerProfile);
  if (isChiefScopeOwner || isProjectLeaderScopeOwner) {
    return (isChiefScopeOwner && isFieldOperationsChiefPermitSignatory(reviewer))
      || (isProjectLeaderScopeOwner && isFieldOperationsProjectLeaderPermitSignatory(reviewer));
  }
  return permitApprovalRoute(owner.office, owner.division, owner.unit) === "fod"
    && isFieldOperationsChiefPermitSignatory(reviewer);
}

function permitNotificationKey(notification: PermitNotification) {
  return `${notification.permit.id}:${notification.permitNo}:${notification.status}:${timestampMillis(notification.decidedAt)}`;
}

function timestampIdentity(value: unknown) {
  if (value && typeof value === "object" && "seconds" in value && "nanoseconds" in value) {
    const timestamp = value as { seconds: number; nanoseconds: number };
    return `${timestamp.seconds}:${timestamp.nanoseconds}`;
  }
  return String(timestampMillis(value));
}

type NotificationSnapshotState = { initialized: boolean; ids: Set<string> };

function hasNewNotificationDocuments(snapshot: QuerySnapshot, state: NotificationSnapshotState) {
  if (!state.initialized) {
    state.ids.clear();
    snapshot.docs.forEach((item) => state.ids.add(item.id));
    if (!snapshot.metadata.fromCache) state.initialized = true;
    return false;
  }
  if (snapshot.metadata.fromCache) return false;

  let hasNewNotification = false;
  snapshot.docChanges().forEach((change) => {
    if (change.type === "removed") {
      state.ids.delete(change.doc.id);
      return;
    }
    if (change.type === "added" && !state.ids.has(change.doc.id) && !change.doc.metadata.hasPendingWrites) {
      hasNewNotification = true;
    }
    state.ids.add(change.doc.id);
  });
  return hasNewNotification;
}

function singlePersonPermitPreview(permit: Permit | AdminPermit, personIndex: number): Permit {
  const personNumber = permitPersonNumber(permit, personIndex);
  const personUnit = permit.personUnits?.[personIndex] ?? permit.unit ?? "AGRISTAT";
  return {
    ...permit,
    permitNo: personNumber,
    permitNos: [personNumber],
    names: [permit.names[personIndex] ?? ""],
    personUnits: [personUnit],
    unit: personUnit,
  } as Permit;
}

function reminderDate(value: string) {
  if (!value) return "Date not provided";
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function reminderTitle(reminder: DocumentReminder) {
  if (reminder.kind === "travel-order-status") return "Travel Order still Pending";
  if (reminder.kind === "leave-application-status") return "Leave Application still Pending";
  if (reminder.kind === "permit-slip-expiry") return "Permit Slip pending deletion";
  return "Draft your accomplishment report";
}

function reminderPeriod(reminder: DocumentReminder) {
  if (reminder.periodLabel) return reminder.periodLabel;
  if (!reminder.month || !reminder.startDay || !reminder.endDay) return "Half-month cycle";
  const [year, month] = reminder.month.split("-").map(Number);
  const monthName = new Intl.DateTimeFormat("en-PH", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
  return `${monthName} ${reminder.startDay}-${reminder.endDay}, ${year}`;
}

function PermitNotificationCenter({ isAdmin, isSuperAdmin, userId, notifications, pendingNotifications, pendingAccountApprovals, documentNotifications, documentReminders, calendarOfActivitiesNotifications, calendarOfActivitiesApprovalNotifications, onAdminOpen, onOpenAccountApprovals, onViewPermit, onReadDocument, onOpenDocumentNotification, onReadDocumentReminder, onOpenDocumentReminder, onReadCalendarOfActivities, onOpenCalendarOfActivities, onReadCalendarOfActivitiesApproval, onOpenCalendarOfActivitiesApproval }: {
  isAdmin: boolean;
  isSuperAdmin: boolean;
  userId: string;
  notifications: PermitNotification[];
  pendingNotifications: PendingPermitNotification[];
  pendingAccountApprovals: PendingAccountApprovalNotification[];
  documentNotifications: DocumentNotification[];
  documentReminders: DocumentReminder[];
  calendarOfActivitiesNotifications: CalendarOfActivitiesNotification[];
  calendarOfActivitiesApprovalNotifications: CalendarOfActivitiesApprovalNotification[];
  onAdminOpen: (notification: PendingPermitNotification) => void;
  onOpenAccountApprovals: (notification: PendingAccountApprovalNotification) => void;
  onViewPermit: (notification: PermitNotification) => void;
  onReadDocument: (notification: DocumentNotification) => void;
  onOpenDocumentNotification: (notification: DocumentNotification) => void;
  onReadDocumentReminder: (notification: DocumentReminder) => void;
  onOpenDocumentReminder: (notification: DocumentReminder) => void;
  onReadCalendarOfActivities: (notification: CalendarOfActivitiesNotification) => void;
  onOpenCalendarOfActivities: (notification: CalendarOfActivitiesNotification) => void;
  onReadCalendarOfActivitiesApproval: (notification: CalendarOfActivitiesApprovalNotification) => void;
  onOpenCalendarOfActivitiesApproval: (notification: CalendarOfActivitiesApprovalNotification) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hiddenReadIds, setHiddenReadIds] = useState<string[]>([]);
  const [readNotificationState, setReadNotificationState] = useState<{ userId: string; keys: string[] } | null>(null);
  const [currentTime, setCurrentTime] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 15_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(`my-desk:read-permit-notifications:${userId}`);
      const keys = stored ? JSON.parse(stored) : [];
      setReadNotificationState({ userId, keys: Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [] });
    } catch {
      setReadNotificationState({ userId, keys: [] });
    }
  }, [userId]);

  const readNotificationKeys = readNotificationState?.userId === userId ? readNotificationState.keys : [];
  const readNotificationKeySet = new Set(readNotificationKeys);
  const unreadNotifications = notifications.filter((notification) => !readNotificationKeySet.has(permitNotificationKey(notification)));
  const visiblePendingAccountApprovals = pendingAccountApprovals.filter((notification) => !readNotificationKeySet.has(`account-approval:${notification.userId}`));
  const visiblePendingNotifications = pendingNotifications.filter((notification) => !notification.submittedAt || currentTime - notification.submittedAt < permitNotificationVisibilityMs);
  const unreadDocumentNotifications = documentNotifications.filter((notification) => !notification.read);
  const unreadDocumentReminders = documentReminders.filter((notification) => !notification.read);
  const unreadCalendarOfActivitiesNotifications = calendarOfActivitiesNotifications.filter((notification) => !notification.read);
  const unreadCalendarOfActivitiesApprovalNotifications = isAdmin ? calendarOfActivitiesApprovalNotifications.filter((notification) => !notification.readBy.includes(userId)) : [];
  const visibleCount = (isAdmin ? visiblePendingNotifications.length : unreadNotifications.length) + (isSuperAdmin ? visiblePendingAccountApprovals.length : 0) + unreadDocumentNotifications.length + unreadDocumentReminders.length + unreadCalendarOfActivitiesNotifications.length + unreadCalendarOfActivitiesApprovalNotifications.length;

  function toggleOpen() {
    // Permit Slip reminders keep their existing dismiss-on-close behavior.
    if (!open) setHiddenReadIds([
      ...documentNotifications.filter((notification) => notification.documentType === "Permit Slip" && notification.read).map((notification) => notification.id),
      ...documentReminders.filter((notification) => notification.kind === "permit-slip-expiry" && notification.read).map((notification) => notification.id),
    ]);
    setOpen(!open);
  }
  const shownCalendarOfActivitiesNotifications = calendarOfActivitiesNotifications.filter((notification) => !notification.read);
  const shownDocumentNotifications = documentNotifications.filter((notification) => notification.documentType === "Permit Slip" ? !hiddenReadIds.includes(notification.id) : !notification.read);
  const shownDocumentReminders = documentReminders.filter((notification) => notification.kind === "permit-slip-expiry" ? !hiddenReadIds.includes(notification.id) : !notification.read);
  const shownCalendarOfActivitiesApprovalNotifications = calendarOfActivitiesApprovalNotifications.filter((notification) => !notification.readBy.includes(userId));

  function markNotificationKeyAsRead(key: string) {
    const keys = [...new Set([...readNotificationKeys, key])];
    setReadNotificationState({ userId, keys });
    try {
      window.localStorage.setItem(`my-desk:read-permit-notifications:${userId}`, JSON.stringify(keys));
    } catch {
      // Dismiss for this session if browser storage is unavailable.
    }
  }

  function markAsRead(notification: PermitNotification) {
    markNotificationKeyAsRead(permitNotificationKey(notification));
  }

  return <div className="notification-center" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
    <button type="button" className="notification-button" aria-label={`${visibleCount} unread notifications`} title={`${visibleCount} unread notifications`} aria-haspopup="dialog" aria-expanded={open} onClick={toggleOpen}>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></svg>
      {visibleCount > 0 && <span className="notification-badge" aria-hidden="true">{visibleCount > 99 ? "99+" : visibleCount}</span>}
    </button>
    {open && <div className="notification-dropdown" role="dialog" aria-label="Notifications">
      <div className="notification-dropdown-heading"><strong>Notifications</strong><button type="button" onClick={() => setOpen(false)} aria-label="Close notifications">×</button></div>
      {isSuperAdmin && visiblePendingAccountApprovals.length > 0 && <><p className="notification-section-title">Awaiting User Approval</p><ul>{visiblePendingAccountApprovals.map((notification) => <li key={notification.userId}><button type="button" className="notification-item calendar-of-activities-notification" onClick={() => { markNotificationKeyAsRead(`account-approval:${notification.userId}`); setOpen(false); onOpenAccountApprovals(notification); }}>
        <span className="notification-status notification-status-pending">Awaiting review</span>
        <strong>{notification.name}</strong>
        <span className="notification-detail"><span className="notification-detail-label">Office</span><span>{notification.office || "Not provided"}</span></span>
        <span className="notification-detail"><span className="notification-detail-label">Division</span><span>{notification.division || "Not provided"}</span></span>
        <span className="notification-detail"><span className="notification-detail-label">Unit / Program / Project</span><span>{notification.unit || "Not provided"}</span></span>
        <span className="notification-view-label">Open User Approval</span>
      </button></li>)}</ul></>}
      {isAdmin ? visiblePendingNotifications.length === 0 ? null : <><p className="notification-section-title">Filed Permit Slips</p><ul>{visiblePendingNotifications.map((notification) => <li key={`${notification.permitId}-${notification.permitNo}`}><button type="button" className="notification-item" onClick={() => { setOpen(false); onAdminOpen(notification); }}>
        <span className="notification-status notification-status-pending">Awaiting review</span>
        <strong>{notification.name}</strong>
        <span className="notification-permit-number">Pending</span>
        {notification.purpose && <span className="notification-permit-number">{notification.purpose}</span>}
        <small>{notification.date ? formatDate(notification.date) : "Date not provided"}</small>
        <span className="notification-view-label">Open in Permit Slip Status</span>
      </button></li>)}</ul></> : unreadNotifications.length === 0 ? null : <><p className="notification-section-title">Permit Slip updates</p><ul>{unreadNotifications.map((notification) => <li key={permitNotificationKey(notification)}><button type="button" className="notification-item" onClick={() => { markAsRead(notification); setOpen(false); onViewPermit(notification); }}>
        <span className="notification-detail"><span className="notification-detail-label">Name</span><strong>{notification.name}</strong></span>
        <span className="notification-detail"><span className="notification-detail-label">Date</span><span>{notification.date ? formatDate(notification.date) : "Date not provided"}</span></span>
        <span className="notification-detail"><span className="notification-detail-label">Status</span><strong className={`notification-status notification-status-${notification.status.toLowerCase()}`}>{notification.status}</strong></span>
      </button></li>)}</ul></>}
      {shownDocumentReminders.length > 0 && <><p className="notification-section-title">Status reminders</p><ul>{shownDocumentReminders.map((notification) => {
        const isRead = notification.read;
        return <li key={notification.id}><button type="button" className={`notification-item calendar-of-activities-notification${isRead ? " is-read" : ""}`} onClick={() => {
          if (!isRead) onReadDocumentReminder(notification);
          setOpen(false);
          onOpenDocumentReminder(notification);
        }}>
          <span className="notification-status notification-status-pending">{reminderTitle(notification)}</span>
          {notification.kind === "travel-order-status" && <>
            <span className="notification-detail"><span className="notification-detail-label">Date</span><span>{reminderDate(notification.date ?? "")}</span></span>
            <span className="notification-detail"><span className="notification-detail-label">Purpose</span><span>{notification.purpose}</span></span>
            <span className="notification-detail"><span className="notification-detail-label">Destination</span><span>{notification.destination}</span></span>
            <span className="notification-detail"><span className="notification-detail-label">Return Date</span><span>{reminderDate(notification.returnDate ?? "")}</span></span>
          </>}
          {notification.kind === "leave-application-status" && <>
            <span className="notification-detail"><span className="notification-detail-label">Type of Leave</span><span>{notification.leaveType}</span></span>
            <span className="notification-detail"><span className="notification-detail-label">Inclusive Dates</span><span>{reminderDate(notification.inclusiveDateFrom ?? "")}{notification.inclusiveDateTo !== notification.inclusiveDateFrom && ` – ${reminderDate(notification.inclusiveDateTo ?? "")}`}</span></span>
            <span className="notification-detail"><span className="notification-detail-label">Date Filed</span><span>{reminderDate(notification.date ?? "")}</span></span>
          </>}
          {notification.kind === "permit-slip-expiry" && <>
            <span className="notification-detail"><span className="notification-detail-label">Date</span><span>{reminderDate(notification.date ?? "")}</span></span>
            <span className="notification-detail"><span className="notification-detail-label">Purpose</span><span>{notification.purpose}</span></span>
            <small>Your permit slip on {reminderDate(notification.date ?? "")} for {notification.purpose || "the stated purpose"} will be automatically deleted after 30 minutes.</small>
          </>}
          {notification.kind === "accomplishment-report" && <span className="notification-detail"><span className="notification-detail-label">Month · Half-month Cycle</span><strong>{reminderPeriod(notification)}</strong></span>}
          <span className="notification-view-label">{notification.kind === "permit-slip-expiry" ? "Open Permit Slips" : notification.kind === "accomplishment-report" ? "Open myAR" : "Open record"}</span>
          <small>{isRead ? "Read" : "New · Select to open"}</small>
        </button></li>;
      })}</ul></>}
      {shownDocumentNotifications.some((notification) => notification.documentType === "Leave Application") && <><p className="notification-section-title">Filed Leave Applications</p><ul>{shownDocumentNotifications.filter((notification) => notification.documentType === "Leave Application").map((notification) => <li key={notification.id}><button type="button" className={`notification-item calendar-of-activities-notification${notification.read ? " is-read" : ""}`} onClick={() => { onReadDocument(notification); setOpen(false); onOpenDocumentNotification(notification); }}>
        <span className="notification-status notification-status-pending">New Leave Application</span>
        <span className="notification-detail"><span className="notification-detail-label">Name</span><strong>{notification.applicantName}</strong></span>
        <span className="notification-detail"><span className="notification-detail-label">Type of Leave</span><span>{notification.leaveType}</span></span>
        <span className="notification-detail"><span className="notification-detail-label">Inclusive Dates</span><span>{formatDate(notification.inclusiveDateFrom ?? "")}{notification.inclusiveDateTo !== notification.inclusiveDateFrom && ` – ${formatDate(notification.inclusiveDateTo ?? "")}`}</span></span>
        <span className="notification-view-label">Open Leave Application</span><small>New · Select to open</small>
      </button></li>)}</ul></>}
      {shownDocumentNotifications.some((notification) => notification.documentType === "Travel Expense Voucher") && <><p className="notification-section-title">TEV Assignments</p><ul>{shownDocumentNotifications.filter((notification) => notification.documentType === "Travel Expense Voucher").map((notification) => <li key={notification.id}><button type="button" className={`notification-item calendar-of-activities-notification${notification.read ? " is-read" : ""}`} onClick={() => { onReadDocument(notification); setOpen(false); onOpenDocumentNotification(notification); }}>
        <span className="notification-status notification-status-pending">Travel Expense Voucher</span>
        <strong>You have been added to the TEV of {formatTravelMonth(notification.travelMonth)}, with total amount &#8369;{formatTevAmount(notification.totalAmount ?? 0)}.</strong>
        <span className="notification-view-label">Open myTEV</span><small>New · Select to open</small>
      </button></li>)}</ul></>}
      {shownDocumentNotifications.some((notification) => notification.documentType === "Certificate Approval") && <><p className="notification-section-title">Certificate Approval</p><ul>{shownDocumentNotifications.filter((notification) => notification.documentType === "Certificate Approval").map((notification) => <li key={notification.id}><button type="button" className={`notification-item calendar-of-activities-notification${notification.read ? " is-read" : ""}`} onClick={() => { onReadDocument(notification); setOpen(false); onOpenDocumentNotification(notification); }}>
        <span className="notification-status notification-status-pending">Awaiting approval</span>
        <span className="notification-detail"><span className="notification-detail-label">Type of Certificate</span><strong>{notification.certificateType || "Appearance"}</strong></span>
        <span className="notification-detail"><span className="notification-detail-label">Title</span><strong>{notification.activityTitle || "Untitled certificate"}</strong></span>
        <span className="notification-detail"><span className="notification-detail-label">Schedule</span><span>{formatCertificateNotificationSchedule(notification.dateFrom, notification.dateTo)}</span></span>
        <span className="notification-detail"><span className="notification-detail-label">Destination</span><span>{notification.destination || "Not specified"}</span></span>
        {notification.purpose && <span className="notification-detail"><span className="notification-detail-label">Purpose</span><strong>{notification.purpose}</strong></span>}
        <span className="notification-view-label">Open Certificate Approval</span>
        <small>{notification.read ? "Read" : "New · Select to review"}</small>
      </button></li>)}</ul></>}
      {shownDocumentNotifications.some((notification) => notification.documentType === "Certificate Decision") && <><p className="notification-section-title">Certificate Updates</p><ul>{shownDocumentNotifications.filter((notification) => notification.documentType === "Certificate Decision").map((notification) => <li key={notification.id}><button type="button" className={`notification-item calendar-of-activities-notification${notification.read ? " is-read" : ""}`} onClick={() => { onReadDocument(notification); setOpen(false); onOpenDocumentNotification(notification); }}>
        <span className={`notification-status notification-status-${notification.decisionStatus === "Approved" ? "approved" : "disapproved"}`}>{notification.decisionStatus}</span>
        <strong>{notification.decisionStatus === "Approved" ? <>Your certificate is ready. <span className="notification-view-label">View here!</span></> : "Your certificate has been rejected!"}</strong>
        {notification.certificateType && <span className="notification-detail"><span className="notification-detail-label">Type of Certificate</span><span>{notification.certificateType}</span></span>}
        {notification.activityTitle && <span className="notification-detail"><span className="notification-detail-label">Title</span><span>{notification.activityTitle}</span></span>}
        <small>{notification.read ? "Read" : "New · Select to view"}</small>
      </button></li>)}</ul></>}
      {shownDocumentNotifications.some((notification) => notification.documentType !== "Leave Application" && notification.documentType !== "Travel Expense Voucher" && notification.documentType !== "Certificate Approval" && notification.documentType !== "Certificate Decision") && <><p className="notification-section-title">Assigned Documents</p><ul>{shownDocumentNotifications.filter((notification) => notification.documentType !== "Leave Application" && notification.documentType !== "Travel Expense Voucher" && notification.documentType !== "Certificate Approval" && notification.documentType !== "Certificate Decision").map((notification) => <li key={notification.id}><button type="button" className={`notification-item calendar-of-activities-notification${notification.read ? " is-read" : ""}`} onClick={() => { onReadDocument(notification); if (notification.documentType !== "Permit Slip") { setOpen(false); onOpenDocumentNotification(notification); } }}>
        <span className="notification-status notification-status-pending">{notification.documentType || "Assigned document"}</span>
        <strong>{assignedDocumentSummary(notification)}</strong>
        {notification.documentType === "Special Order" && <><span className="notification-detail"><span className="notification-detail-label">Date</span><span>{notification.dateFrom === notification.dateTo ? formatDate(notification.dateFrom ?? "") : `${formatDate(notification.dateFrom ?? "")} – ${formatDate(notification.dateTo ?? "")}`}</span></span><span className="notification-detail"><span className="notification-detail-label">Venue</span><span>{notification.venue}</span></span></>}
        {notification.documentType === "Notice to Attend" && notification.schedules?.map((schedule, index) => <span className="calendar-of-activities-notification-activity" key={`${notification.id}-schedule-${index}`}><b>{schedule.dateFrom === schedule.dateTo ? formatDate(schedule.dateFrom) : `${formatDate(schedule.dateFrom)} – ${formatDate(schedule.dateTo)}`}</b><span>{schedule.venue}</span></span>)}
        {notification.documentType === "Permit Slip" && <><span className="notification-detail"><span className="notification-detail-label">Date</span><span>{formatDate(notification.date ?? "")}</span></span><span className="notification-detail"><span className="notification-detail-label">Purpose</span><span>{notification.purpose}</span></span></>}
        {notification.documentType === "Travel Order" && <><span className="notification-detail"><span className="notification-detail-label">Departure Date to Return Date</span><strong>{formatDate(notification.departureDate ?? "")} – {formatDate(notification.returnDate ?? "")}</strong></span><span className="notification-detail"><span className="notification-detail-label">Place of Travel</span><span>{notification.placeOfTravel}</span></span><span className="notification-detail"><span className="notification-detail-label">Specific Purpose of the Trip</span><strong>{notification.purpose}</strong></span></>}
        <small>{notification.documentType === "Permit Slip" ? "New · Select to mark as read" : "New · Select to open"}</small>
      </button></li>)}</ul></>}
      {shownCalendarOfActivitiesNotifications.length > 0 && <><p className="notification-section-title">Calendar of Activities</p><ul>{shownCalendarOfActivitiesNotifications.map((notification) => <li key={notification.id}><button type="button" className={`notification-item calendar-of-activities-notification${notification.read ? " is-read" : ""}`} onClick={() => { onReadCalendarOfActivities(notification); setOpen(false); onOpenCalendarOfActivities(notification); }}>
        <strong>{notification.month ? new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${notification.month}-01T00:00:00Z`)) : "Activity schedule"}</strong>
        {notification.activities.map((activity, index) => <span className="calendar-of-activities-notification-activity" key={`${notification.id}-${index}`}><b>{activity.activity}</b><span>{activity.dateFrom === activity.dateTo ? formatDate(activity.dateFrom) : `${formatDate(activity.dateFrom)} – ${formatDate(activity.dateTo)}`}</span><span>{activity.location}</span></span>)}
        <small>{notification.read ? "Read" : "New · Select to open"}</small>
      </button></li>)}</ul></>}
      {isAdmin && shownCalendarOfActivitiesApprovalNotifications.length > 0 && <><p className="notification-section-title">Approved Calendar of Activities Records</p><ul>{shownCalendarOfActivitiesApprovalNotifications.map((notification) => {
        const isRead = notification.readBy.includes(userId);
        const month = /^\d{4}-\d{2}$/.test(notification.month) ? new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${notification.month}-01T00:00:00Z`)) : notification.month;
        return <li key={notification.id}><button type="button" className={`notification-item calendar-of-activities-notification${isRead ? " is-read" : ""}`} onClick={() => { onReadCalendarOfActivitiesApproval(notification); setOpen(false); onOpenCalendarOfActivitiesApproval(notification); }}><strong>Calendar of Activities for {calendarOfActivitiesUnitLabel(notification.unit)}, {month} is Approved</strong><small>Prepared by {notification.preparedName}</small><span className="notification-view-label">Open Calendar of Activities Records</span><small>New · Select to view</small></button></li>;
       })}</ul></>}
      {(isAdmin ? !pendingNotifications.length : !unreadNotifications.length) && (!isSuperAdmin || !visiblePendingAccountApprovals.length) && !shownDocumentReminders.length && !shownDocumentNotifications.length && !shownCalendarOfActivitiesNotifications.length && !shownCalendarOfActivitiesApprovalNotifications.length && <p className="notification-empty">You’re all caught up.</p>}
    </div>}
  </div>;
}

type PermitFooterSignatory = { kind: "fod" | "shared-program"; userId: string; name: string; designation: string; assignment: string };

function permitFooterSignatory(ownerOffice: string, ownerDivision: string, ownerUnit: string, ownerRole: AccountRole | undefined, admins: PermitAdminSignatory[], preferredSignerId = "", preferredSignerName = ""): PermitFooterSignatory | null {
  if (permitApprovalRoute(ownerOffice, ownerDivision, ownerUnit) !== "fod") return null;
  const projectLeaderDesignation = "AGRISTAT/DRRM/AMIA Project Leader";
  const allowsProjectLeaderSignatory = ownerRole === "regular" && ["AGRISTAT", "AMIA", "DRRM"].includes(ownerUnit);
  const allowsChiefSignatory = ownerRole !== "regular" || isFieldOperationsPermitOwner({
    ownerRole,
    ownerOffice,
    ownerDivision,
    ownerUnit,
  });
  const allowedDesignations = [
    ...(allowsChiefSignatory ? ["Chief"] : []),
    ...(allowsProjectLeaderSignatory ? [projectLeaderDesignation] : []),
  ];
  const matchesFieldOperationsProfile = (profile: PermitAdminSignatory, designation: string) => profile.office === "Division"
    && profile.division === "Field Operations Division"
    && profile.unit === "Field Operations Division"
    && profile.designation === designation;
  const preferredSignerById = preferredSignerId.trim()
    ? admins.find((profile) => allowedDesignations.some((designation) => matchesFieldOperationsProfile(profile, designation)) && profile.userId === preferredSignerId.trim())
    : undefined;
  const canUseNameFallback = !preferredSignerId.trim() || preferredSignerId.includes("@");
  const preferredSignerByName = canUseNameFallback && preferredSignerName.trim()
    ? admins.find((profile) => allowedDesignations.some((designation) => matchesFieldOperationsProfile(profile, designation))
      && profile.name.trim().toLocaleUpperCase("en") === preferredSignerName.trim().toLocaleUpperCase("en"))
    : undefined;
  const preferredSigner = preferredSignerById ?? preferredSignerByName;
  const defaultSigner = allowsProjectLeaderSignatory && !allowsChiefSignatory
    ? admins.find((profile) => matchesFieldOperationsProfile(profile, projectLeaderDesignation))
    : undefined;
  const admin = preferredSigner ?? defaultSigner ?? admins.find((profile) => matchesFieldOperationsProfile(profile, "Chief"));
  return admin ? {
    kind: admin.designation === projectLeaderDesignation ? "shared-program" : "fod",
    userId: admin.userId,
    name: admin.name,
    designation: admin.designation,
    assignment: admin.unit,
  } : null;
}

function PermitCard({ permit, name, permitNo, decisionKey, approvedPermitNumbers, ownerOffice, ownerAssignment, adminSignatories }: { permit: Permit; name: string; permitNo: string; decisionKey: string; approvedPermitNumbers: Record<string, string>; ownerOffice: string; ownerAssignment: string; adminSignatories: PermitAdminSignatory[] }) {
  const decision = permit.personStatuses?.[decisionKey];
  const decisionTime = signatureTime(decision?.decidedAt);
  const isApproved = normalizeWorkflowStatus(decision?.status) === "Approved";
  const displayNumber = isApproved ? (decision?.approvedPermitNo ?? approvedPermitNumbers[displayPermitNumber(permitNo)] ?? displayPermitNumber(permitNo)) || "—" : "Pending";
  const permitOwnerOffice = permit.ownerOffice ?? ownerOffice;
  const permitOwnerAssignment = permit.ownerAssignment ?? ownerAssignment;
  const hasVersionFourOwner = typeof permit.ownerDivision === "string" && typeof permit.ownerUnit === "string";
  const ownerProfile = hasVersionFourOwner
    ? accountProfileSelection({ office: permitOwnerOffice, division: permit.ownerDivision, unit: permit.ownerUnit, profileFieldsVersion: 4 })
    : accountProfileSelection({ office: permitOwnerOffice, assignment: permitOwnerAssignment, profileFieldsVersion: 3 });
  const permitOwnerDivision = ownerProfile.division;
  const permitOwnerUnit = ownerProfile.unit || permitOwnerAssignment;
  const approvalRoute = permitApprovalRoute(ownerProfile.office, permitOwnerDivision, permitOwnerUnit);
  const isFieldOperationsProgramOwner = isFieldOperationsPermitOwner({
    ownerRole: permit.ownerRole,
    ownerOffice: ownerProfile.office,
    ownerDivision: permitOwnerDivision,
    ownerUnit: permitOwnerUnit,
  });
  const isFieldOperationsProjectLeaderOwner = isFieldOperationsProjectLeaderPermitOwner({
    ownerRole: permit.ownerRole,
    ownerOffice: ownerProfile.office,
    ownerDivision: permitOwnerDivision,
    ownerUnit: permitOwnerUnit,
  });
  const signatory = permitFooterSignatory(
    ownerProfile.office,
    permitOwnerDivision,
    permitOwnerUnit,
    permit.ownerRole,
    adminSignatories,
    (isFieldOperationsProgramOwner || isFieldOperationsProjectLeaderOwner) && isApproved ? decision?.decidedBy ?? "" : "",
    (isFieldOperationsProgramOwner || isFieldOperationsProjectLeaderOwner) && isApproved ? decision?.signerName ?? "" : "",
  );
  const decisionSignerId = decision?.decidedBy?.trim() ?? "";
  const signerNameMatches = Boolean(decision?.signerName?.trim())
    && decision?.signerName?.trim().toLocaleUpperCase("en") === signatory?.name.trim().toLocaleUpperCase("en");
  const wasApprovedByFieldOperationsChief = isApproved
    && signatory?.designation === "Chief"
    && (signatory.userId === decisionSignerId || (decisionSignerId.includes("@") && signerNameMatches));
  const wasApprovedByFieldOperationsProjectLeader = isApproved
    && signatory?.designation === "AGRISTAT/DRRM/AMIA Project Leader"
    && (signatory.userId === decisionSignerId || (decisionSignerId.includes("@") && signerNameMatches));
  const legacySignatureAsset = signatory?.designation === "AGRISTAT/DRRM/AMIA Project Leader"
    ? "/agristat_and_drrm_focal_persons_amia_project_leader.png"
    : signatory?.designation === "Chief" ? "/field_operations_division_chief_signature.png" : "";
  const signatureAsset = isFieldOperationsProgramOwner && wasApprovedByFieldOperationsChief
    ? "/field_operations_division_chief_signature.png"
    : isFieldOperationsProjectLeaderOwner && wasApprovedByFieldOperationsProjectLeader
      ? "/agristat_and_drrm_focal_persons_amia_project_leader.png"
      : isFieldOperationsProgramOwner || isFieldOperationsProjectLeaderOwner
        ? ""
        : legacySignatureAsset;
  const requiresConfiguredSignatory = approvalRoute !== null;
  return <article className="permit-document">
    <header className="permit-header">
      <div className="permit-logos">
        <img src={publicAsset("/bagong-pilipinas-logo.webp")} alt="Bagong Pilipinas" className="permit-logo-left" />
        <div className="permit-seal-wrap">
          <img src={publicAsset("/da-caraga-logo.jpg")} alt="Department of Agriculture Caraga Region" className="permit-logo-right" />
        </div>
      </div>
      <h1 className="permit-heading">PERMIT SLIP</h1>
      <img src={publicAsset("/maunlad_na_ekonomiya_logo.jpg")} alt="Masaganang Agrikultura, Maunlad na Ekonomiya" className="permit-logo-economy" />
    </header>

    <section className="permit-metadata">
      <div className="permit-meta-row">
        <span className="permit-label">PS No.</span>
        <span className="permit-colon">:</span>
        <span className="permit-input-line">{displayNumber}</span>
      </div>
      <div className="permit-meta-row">
        <span className="permit-label">Date</span>
        <span className="permit-colon">:</span>
        <span className="permit-input-line">{formatDate(permit.date)}</span>
      </div>
    </section>

    <div className="permit-body-watermarked">
      <img className="permit-body-watermark" src={publicAsset("/maunlad_na_ekonomiya_logo.jpg")} alt="" aria-hidden="true" />
      <h3 className="permit-banner">PERMIT TO LEAVE THE OFFICE IS GRANTED TO:</h3>
      <p className="permit-blank-line permit-blank-line-lg permit-name-line">{name}</p>

      <section className="permit-purpose-block">
        <h3>PURPOSE:</h3>
        <p className="permit-blank-line permit-filled-line">{permit.purpose}</p>
        <div className="permit-blank-line" />
      </section>

      <div className="permit-grid-wrap">
        <table className="permit-grid">
          <thead>
            <tr>
              <th>PLACES TO BE VISITED</th>
              <th>CERTIFYING OFFICER</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>1.)</td><td /></tr>
            <tr><td>2.)</td><td /></tr>
            <tr><td>3.)</td><td /></tr>
            <tr><td>4.)</td><td /></tr>
            <tr><td>5.)</td><td /></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div className="permit-signature-row">
      <div className="permit-guard-signature">GUARD'S SIGNATURE</div>
      <div className="permit-time-block">
        <div className="permit-time-row">
          <span className="permit-time-label">TIME OUT</span>
          <span className="permit-colon">:</span>
          <span className="permit-time-line" />
          <span className="permit-colon">:</span>
          <span className="permit-time-line" />
        </div>
        <div className="permit-time-row">
          <span className="permit-time-label">TIME IN</span>
          <span className="permit-colon">:</span>
          <span className="permit-time-line" />
          <span className="permit-colon">:</span>
          <span className="permit-time-line" />
        </div>
        <div className="permit-time-row">
          <span className="permit-time-label">TIME OUT</span>
          <span className="permit-colon">:</span>
          <span className="permit-time-line" />
          <span className="permit-colon">:</span>
          <span className="permit-time-line" />
        </div>
        <div className="permit-time-row">
          <span className="permit-time-label">TIME IN</span>
          <span className="permit-colon">:</span>
          <span className="permit-time-line" />
          <span className="permit-colon">:</span>
          <span className="permit-time-line" />
        </div>
      </div>
    </div>

    <div className="permit-approval">
      <div className="permit-approved-label">Approved:</div>
      {isApproved && <div className="permit-digital-signature">{signatureAsset && <img src={publicAsset(signatureAsset)} alt="Permit Slip approval signature" />}<div><span>Digitally Signed By</span><strong>{decision?.signerName?.trim().toLocaleUpperCase("en") || "ADMIN"}</strong><span>Date: {signatureDate(decision?.decidedAt)}</span><span>Time: {decisionTime}</span></div></div>}
      {decision?.status === "Disapproved" && <div className="permit-disapproved-stamp"><strong>Disapproved</strong><span>By {decision.signerName?.trim().toLocaleUpperCase("en") || "ADMIN"}</span><span>Date: {signatureDate(decision.decidedAt)}</span><span>Time: {decisionTime}</span></div>}
      <div className="permit-approved-name">{signatory?.name.toLocaleUpperCase("en") || (requiresConfiguredSignatory ? "" : "GERLIE B. ANTIPASO")}</div>
      {signatory?.kind === "fod"
        ? <div className="permit-approved-role"><em>{signatory.designation}</em><span style={{ fontStyle: "normal" }}>, {signatory.assignment}</span></div>
        : <div className="permit-approved-role">{signatory?.designation === "AGRISTAT/DRRM/AMIA Project Leader" ? signatory.designation : "DRRM/AMIA/AGRISTAT Head/Agriculturist II"}</div>}
    </div>

  </article>;
}

function PrintPreview({ permit, approvedPermitNumbers, onClose, ownerOffice, ownerAssignment, singleSlip = false }: { permit: Permit; approvedPermitNumbers: Record<string, string>; onClose: () => void; ownerOffice: string; ownerAssignment: string; singleSlip?: boolean }) {
  const sheetsRef = useRef<HTMLDivElement>(null);
  const [adminSignatories, setAdminSignatories] = useState<PermitAdminSignatory[]>([]);
  const [ownerRoleLookup, setOwnerRoleLookup] = useState<{ ownerId: string; role: AccountRole | null } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState("");
  const sheets = chunkNames(permit.names, 4);
  const standaloneView = singleSlip || permit.names.length === 1;
  const ownerRoleLookupMatches = Boolean(permit.ownerId && ownerRoleLookup?.ownerId === permit.ownerId);
  const hasOwnerRoleLookup = Boolean(permit.ownerRole) || ownerRoleLookupMatches;
  const ownerRoleLoading = Boolean(permit.ownerId && db) && !hasOwnerRoleLookup;
  const ownerRole = permit.ownerRole ?? (ownerRoleLookupMatches ? ownerRoleLookup?.role ?? undefined : undefined);
  const previewPermit = ownerRole && !permit.ownerRole ? { ...permit, ownerRole } : permit;

  useEffect(() => {
    let current = true;
    void loadPermitAdminSignatories().then((signatories) => {
      if (current) setAdminSignatories(signatories);
    }).catch(() => {
      if (current) setAdminSignatories([]);
    });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    const firestore = db;
    const ownerId = permit.ownerId;
    if (permit.ownerRole || !ownerId || !firestore) return;
    let current = true;
    void getDoc(doc(firestore, "users", ownerId)).then((snapshot) => {
      if (!current) return;
      if (!snapshot.exists()) {
        setOwnerRoleLookup({ ownerId, role: null });
        return;
      }
      const data = snapshot.data();
      setOwnerRoleLookup({
        ownerId,
        role: normalizeAccountRole(data.accountRole, typeof data.email === "string" ? data.email : null),
      });
    }).catch(() => {
      if (current) setOwnerRoleLookup({ ownerId, role: null });
    });
    return () => { current = false; };
  }, [permit.ownerId, permit.ownerRole]);

  async function waitForImages(container: HTMLElement) {
    await Promise.all(Array.from(container.querySelectorAll("img")).map(async (image) => {
      if (!image.complete) await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("The Special Order letterhead could not be loaded.")); });
      if (image.naturalWidth === 0) throw new Error("The Special Order letterhead could not be loaded.");
      if (image.decode) await image.decode();
    }));
  }

  async function downloadPdf() {
    if (!sheetsRef.current) return;
    setDownloading(true);
    setDownloadError("");
    try {
      const { html2canvas, jsPDF } = await loadPdfTools();
      await waitForImages(sheetsRef.current);
      if (singleSlip) {
        const slip = sheetsRef.current.querySelector<HTMLElement>(".permit-document");
        if (!slip) throw new Error("The Permit Slip preview could not be found.");
        const canvas = await html2canvas(slip, { backgroundColor: "#fff", logging: false, scale: 3, useCORS: true });
        const slipBounds = slip.getBoundingClientRect();
        const pdfWidth = slipBounds.width * 25.4 / 96;
        const pdfHeight = pdfWidth * canvas.height / canvas.width;
        const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: [pdfWidth, pdfHeight] });
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, pdfWidth, pdfHeight);
        pdf.save(`permit-${displayPermitNumber(permit.permitNo)}.pdf`);
        return;
      }
      if (permit.names.length === 1) {
        const slip = sheetsRef.current.querySelector<HTMLElement>(".permit-document");
        if (!slip) throw new Error("The Permit Slip preview could not be found.");
        const canvas = await html2canvas(slip, { backgroundColor: "#fff", logging: false, scale: 3, useCORS: true });
        const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, 105, 148.5);
        pdf.save(`permit-${displayPermitNumber(permit.permitNo)}.pdf`);
        return;
      }
      const sheetElements = Array.from(sheetsRef.current.querySelectorAll<HTMLElement>(".permit-sheet"));
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      for (let index = 0; index < sheetElements.length; index += 1) {
        const canvas = await html2canvas(sheetElements[index], { backgroundColor: "#fff", logging: false, scale: 3, useCORS: true });
        if (index > 0) pdf.addPage();
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, 210, 297);
      }
      pdf.save(`permit-${displayPermitNumber(permit.permitNo)}.pdf`);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "Unable to create the PDF.");
    } finally {
      setDownloading(false);
    }
  }

  async function printPreview() {
    if (!sheetsRef.current) return;
    setPrinting(true);
    setPrintError("");
    try {
      await waitForImages(sheetsRef.current);
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      window.print();
    } catch (error) {
      setPrintError(error instanceof Error ? error.message : "Unable to prepare the Permit Slip for printing.");
    } finally {
      setPrinting(false);
    }
  }

  return <div className={standaloneView ? "preview-backdrop preview-backdrop-single" : "preview-backdrop"}>
    <div className={singleSlip ? "preview-toolbar preview-toolbar-single" : "preview-toolbar"}>
      {!singleSlip && <span>Permit preview</span>}
      <button type="button" className="ghost-button" onClick={onClose}>Close</button>
      {!singleSlip && <>
        <button type="button" className="pdf-button" disabled={downloading || ownerRoleLoading} onClick={downloadPdf}>{downloading ? "Preparing PDF..." : "Download PDF"}</button>
        <button type="button" className="pdf-button" disabled={printing || ownerRoleLoading} onClick={printPreview}>{printing ? "Preparing print..." : "Print"}</button>
        {downloadError && <small className="download-error">{downloadError}</small>}
        {printError && <small className="download-error" role="alert">{printError}</small>}
      </>}
    </div>
    <div ref={sheetsRef} className={standaloneView ? "permit-sheets permit-sheets-single" : "permit-sheets"}>
      {standaloneView
        ? <div className="permit-sheets-single-scale"><PermitCard permit={previewPermit} name={permit.names[0] ?? ""} permitNo={permit.permitNos?.[0] ?? permit.permitNo} decisionKey={permitDecisionKey(permit, 0)} approvedPermitNumbers={approvedPermitNumbers} ownerOffice={ownerOffice} ownerAssignment={ownerAssignment} adminSignatories={adminSignatories} /></div>
        : sheets.map((sheetNames, sheetIndex) => <div className="permit-sheet" key={sheetIndex}>
          {sheetNames.map((name, nameIndex) => { const personIndex = sheetIndex * 4 + nameIndex; return <PermitCard permit={previewPermit} name={name} permitNo={permit.permitNos?.[personIndex] ?? permit.permitNo} decisionKey={permitDecisionKey(permit, personIndex)} approvedPermitNumbers={approvedPermitNumbers} ownerOffice={ownerOffice} ownerAssignment={ownerAssignment} adminSignatories={adminSignatories} key={nameIndex} />; })}
        </div>)}
    </div>
  </div>;
}

function SpecialOrderForm({ user, ownerOffice, ownerDivision, ownerUnit, onSaved, onCancel, onError }: { user: User; ownerOffice: string; ownerDivision?: string; ownerUnit: string | null; onSaved: (order: SpecialOrder) => void; onCancel: () => void; onError: (message: string) => void }) {
  const [subject, setSubject] = useState("");
  const [activityTitle, setActivityTitle] = useState("");
  const [organizer, setOrganizer] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [timeFrom, setTimeFrom] = useState("08:00");
  const [timeTo, setTimeTo] = useState("17:00");
  const [venue, setVenue] = useState("");
  const [signatorySelection, setSignatorySelection] = useState("");
  const selectedSignatory = specialOrderSignatoryOptions.find((option) => option.value === signatorySelection);
  const [participants, setParticipants] = useState([{ userId: "", manual: false, name: "", position: "", unit: "" }]);
  const [personnel, setPersonnel] = useState<PersonnelEntry[]>([]);
  const [personnelStatus, setPersonnelStatus] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadPersonnel() {
      try {
        const entries = filterPersonnelForDivision(await loadAccountPersonnel({ deduplicateByName: false }), ownerOffice, ownerDivision ?? "");
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
  }, [ownerOffice, ownerDivision, ownerUnit]);

  function updateParticipant(index: number, updates: Partial<(typeof participants)[number]>) {
    setParticipants((current) => current.map((participant, participantIndex) => participantIndex === index ? { ...participant, ...updates } : participant));
  }

  const selectedParticipantUserIds = new Set(participants.flatMap((participant) => !participant.manual && participant.userId ? [participant.userId] : []));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!db) return;
    if (!ownerUnit) { onError("Your Unit / Program / Project is still loading. Try saving again in a moment."); return; }
    const participantRecords = participants.map((participant) => {
      const selectedPerson = participant.manual ? undefined : personnel.find((person) => person.userId === participant.userId);
      return {
        userId: participant.manual ? "" : participant.userId,
        name: participant.manual ? participant.name.trim() : selectedPerson?.name ?? "",
        position: participant.manual ? participant.position.trim() : selectedPerson?.position ?? "",
        unit: participant.manual ? participant.unit.trim() : selectedPerson?.unit ?? "",
      };
    }).filter((participant) => Boolean(participant.name)).filter((participant, index, all) => !participant.userId || all.findIndex((candidate) => candidate.userId === participant.userId) === index);
    const participantIds = [...new Set(participantRecords.map((participant) => participant.userId).filter(Boolean))];
    const participantList = participantRecords.map((participant) => participant.name);
    const participantPositions = participantRecords.map((participant) => participant.position);
    const participantUnits = participantRecords.map((participant) => participant.unit);
    const participantUserIds = participantRecords.map((participant) => participant.userId);
    if (!participantList.length) { onError("Select at least one designated personnel."); return; }
    if (!selectedSignatory) { onError("Select a signatory."); return; }
    setBusy(true); onError("");
    try {
      const signatory = { signatoryName: selectedSignatory.name, signatoryDesignation: selectedSignatory.position };
      const firestore = db;
      const orderRef = doc(collection(firestore, "specialOrders"));
      const record = { subject: subject.trim(), activityTitle: activityTitle.trim(), organizer: organizer.trim(), dateFrom, dateTo: dateTo || dateFrom, timeFrom, timeTo, venue: venue.trim(), participants: participantList, participantPositions, participantUnits, participantUserIds, participantIds, recipientIds: participantIds.filter((id) => id !== user.uid), ...signatory, ownerId: user.uid, ownerUnit, createdAt: serverTimestamp() };
      const batch = writeBatch(firestore);
      batch.set(orderRef, record);
      [...new Set(record.recipientIds)].forEach((recipientId) => {
        const notification = makeDocumentNotification(firestore, { recipientId, ownerId: user.uid, documentId: orderRef.id, documentType: "Special Order", activityTitle: record.activityTitle, dateFrom, dateTo: dateTo || dateFrom, venue: record.venue });
        batch.set(notification.reference, notification.data);
      });
      await batch.commit();
      onSaved({ id: orderRef.id, ...record });
    } catch (error) { onError(error instanceof Error ? error.message : "Unable to save special order."); }
    finally { setBusy(false); }
  }

  return <section className="content-section form-section special-order-form-section"><div className="section-heading"><div><p className="eyebrow">New record</p><h2>Create special order</h2><p className="muted">Add the activity details and designated personnel.</p></div><button className="ghost-button" onClick={onCancel}>Cancel</button></div><form className="permit-form" onSubmit={save}><div className="wide-field special-order-activity-fields"><label>Subject<input value={subject} onChange={(event) => setSubject(event.target.value)} required /></label><label>Title of the Activity<input value={activityTitle} onChange={(event) => setActivityTitle(event.target.value)} required /></label><label>Organizer or Host<input value={organizer} onChange={(event) => setOrganizer(event.target.value)} required /></label></div><div className="special-order-schedule-fields"><div className="date-range-field"><span>Date</span><div><input aria-label="Date from" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} required /><span>to</span><input aria-label="Date to" type="date" min={dateFrom} value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></div></div><div className="date-range-field"><span>Time</span><div><input aria-label="Time from" type="time" value={timeFrom} onChange={(event) => setTimeFrom(event.target.value)} required /><span>to</span><input aria-label="Time to" type="time" value={timeTo} onChange={(event) => setTimeTo(event.target.value)} required /></div></div></div><label className="wide-field">Venue<input value={venue} onChange={(event) => setVenue(event.target.value)} placeholder="Street, Building, City, Province" required /></label><div className="participant-fields wide-field"><span>Designated Personnel</span>{participants.map((participant, index) => { return <div className="participant-input" key={index}>{participant.manual ? <div className="participant-manual-fields"><label>Personnel Name<input aria-label={`Personnel ${index + 1} name`} value={participant.name} onChange={(event) => updateParticipant(index, { name: event.target.value })} required /></label><label>Personnel Position<input aria-label={`Personnel ${index + 1} position`} value={participant.position} onChange={(event) => updateParticipant(index, { position: event.target.value })} required /></label><label>Personnel Unit / Program / Project<input aria-label={`Personnel ${index + 1} Unit / Program / Project`} value={participant.unit} onChange={(event) => updateParticipant(index, { unit: event.target.value })} required /></label></div> : <NameSearchSelect aria-label={`Designated personnel ${index + 1}`} value={participant.userId} onChange={(selectedId) => { const selectedPerson = personnel.find((person) => person.userId === selectedId); updateParticipant(index, { userId: selectedId, name: selectedPerson?.name ?? "", position: selectedPerson?.position ?? "", unit: selectedPerson?.unit ?? "" }); }} required={index === 0} disabled={personnelStatus !== "ready"}><option value="" disabled>{personnelStatus === "loading" ? "Loading personnel..." : personnelStatus === "error" ? "Personnel list unavailable" : "Select a personnel"}</option>{personnel.filter((person) => person.userId === participant.userId || !selectedParticipantUserIds.has(person.userId)).map((person) => <option key={person.userId} value={person.userId}>{personnelDisplayName(person)}</option>)}</NameSearchSelect>}<label className="participant-manual-toggle"><input type="checkbox" checked={participant.manual} onChange={(event) => { const enabled = event.target.checked; updateParticipant(index, enabled ? { manual: true, userId: "" } : { manual: false, userId: "", name: "", position: "", unit: "" }); }} />Manual</label>{participants.length > 1 && <button type="button" className="remove-participant remove-action" aria-label={`Remove personnel ${index + 1}`} onClick={() => setParticipants((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>}
      </div>;
    })}<button type="button" className="text-button plain-action add-item-text-button add-participant" onClick={() => setParticipants((current) => [...current, { name: "", position: "", unit: "", userId: "", manual: false }])}>+ Add personnel</button>{personnelStatus === "error" && <span className="auth-message auth-message-error" role="alert">Unable to load personnel from user accounts. Use manual input or reload the page to try again.</span>}</div>
    <label className="wide-field">Signatory<select aria-label="Signatory" value={signatorySelection} onChange={(event) => { setSignatorySelection(event.target.value); onError(""); }} required><option value="" disabled>Select a signatory</option>{specialOrderSignatoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    <div className="form-actions"><button className="primary-button" disabled={busy}>{busy ? "Saving..." : "Save"}</button></div>
  </form></section>;
}

function SpecialOrderList({ orders, ownerId, preparedByNames, fallbackPreparedBy, deletingId, copyingId, onNew, onEdit, onPrint, onCopy, onDelete }: { orders: SpecialOrder[]; ownerId: string; preparedByNames: Record<string, string>; fallbackPreparedBy: string; deletingId: string | null; copyingId: string | null; onNew: () => void; onEdit: (order: SpecialOrder) => void; onPrint: (order: SpecialOrder) => void; onCopy: (order: SpecialOrder) => void; onDelete: (order: SpecialOrder) => void }) {
  const { currentPage, pageCount, visibleRecords, setPage } = useRecordPagination(orders);
  return <section className="content-section"><div className="section-heading"><div><p className="eyebrow">Your records</p><h2>Special Orders</h2><p className="muted">{orders.length} {orders.length === 1 ? "order" : "orders"} available to your Unit / Program / Project.</p></div><button className="primary-button" onClick={onNew}>Add</button></div>{orders.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No special orders yet</h3><p>Create your first order to see it here.</p><button className="text-button plain-action document-create-action" onClick={onNew}>Create a Special Order</button></div> : <div className="permit-table"><RecordPagination totalRecords={orders.length} currentPage={currentPage} pageCount={pageCount} onPageChange={setPage} label="Special Order" /><div className="table-head special-order-list-head"><span>Subject</span><span>Activity</span><span>Schedule</span><span>Prepared By</span><span></span></div>{visibleRecords.map((order) => { const isOwner = order.ownerId === ownerId; return <div className="table-row special-order-list-row" key={order.id}><strong data-label="Subject">{order.subject}</strong><span data-label="Activity">{order.activityTitle}</span><span data-label="Schedule">{formatDate(order.dateFrom)}{order.dateTo !== order.dateFrom && ` - ${formatDate(order.dateTo)}`}</span><span data-label="Prepared By">{preparedByNames[order.ownerId] || (isOwner ? fallbackPreparedBy : "") || "—"}</span><span className="permit-row-actions">{isOwner && <button type="button" className="row-action" onClick={() => onEdit(order)}>Edit</button>}<button type="button" className="row-action" onClick={() => onPrint(order)}>View</button><button type="button" className="row-action" disabled={copyingId !== null || deletingId !== null} onClick={() => onCopy(order)}>{copyingId === order.id ? "Copying..." : "Copy"}</button>{isOwner && <button type="button" className="delete-button" disabled={deletingId !== null || copyingId !== null} onClick={() => onDelete(order)}>{deletingId === order.id ? "Deleting..." : "Delete"}</button>}</span></div>; })}</div>}</section>;
}

type EditableSpecialOrderParticipant = { name: string; position: string; unit: string; userId: string; manual: boolean };
const normalizeSpecialOrderPersonnelName = (name: string) => name.trim().replace(/\s+/g, " ").toLocaleLowerCase();

function SpecialOrderParticipantEditor({ order, userId, office, division, assignment, onCancel, onSaved }: { order: SpecialOrder; userId: string; office: string; division?: string; assignment: string; onCancel: () => void; onSaved: (order: SpecialOrder) => void }) {
  const [activityTitle, setActivityTitle] = useState(order.activityTitle ?? "");
  const [organizer, setOrganizer] = useState(order.organizer ?? "");
  const [dateFrom, setDateFrom] = useState(order.dateFrom ?? "");
  const [dateTo, setDateTo] = useState(order.dateTo ?? order.dateFrom ?? "");
  const [timeFrom, setTimeFrom] = useState(order.timeFrom ?? "");
  const [timeTo, setTimeTo] = useState(order.timeTo ?? "");
  const [venue, setVenue] = useState(order.venue ?? "");
  const alignedUserIds: string[] | null = order.participantUserIds && order.participantUserIds.length === order.participants.length
    ? order.participantUserIds
    : order.participantIds && order.participantIds.length === order.participants.length ? order.participantIds : null;
  const [participants, setParticipants] = useState<EditableSpecialOrderParticipant[]>(() => order.participants.map((name, index) => ({
    name,
    position: order.participantPositions?.[index] ?? "",
    unit: order.participantUnits?.[index] ?? order.participantOffices?.[index] ?? "",
    userId: alignedUserIds?.[index] ?? "",
    manual: !alignedUserIds?.[index],
  })));
  const [personnel, setPersonnel] = useState<PersonnelEntry[]>([]);
  const [personnelStatus, setPersonnelStatus] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadPersonnel() {
      try {
        const entries = filterPersonnelForAccount(await loadAccountPersonnel(), office, assignment, { includeAdminAccounts: true, division });
        if (!cancelled) {
          setPersonnel(entries);
          setParticipants((current) => current.map((participant) => {
            if (!participant.manual || participant.userId) return participant;
            const normalizedName = normalizeSpecialOrderPersonnelName(participant.name);
            const nameMatches = entries.filter((person) => normalizeSpecialOrderPersonnelName(person.name) === normalizedName);
            const metadataMatches = nameMatches.filter((person) =>
              (!participant.position || normalizeSpecialOrderPersonnelName(person.position) === normalizeSpecialOrderPersonnelName(participant.position))
              && (!participant.unit || normalizeSpecialOrderPersonnelName(person.unit) === normalizeSpecialOrderPersonnelName(participant.unit) || normalizeSpecialOrderPersonnelName(person.office) === normalizeSpecialOrderPersonnelName(participant.unit)));
            const person = nameMatches.length === 1 ? nameMatches[0] : metadataMatches.length === 1 ? metadataMatches[0] : undefined;
            if (!person) return participant;
            return { ...participant, name: person.name, position: person.position, unit: person.unit, userId: person.userId, manual: false };
          }));
          setPersonnelStatus("ready");
        }
      } catch {
        if (!cancelled) setPersonnelStatus("error");
      }
    }
    void loadPersonnel();
    return () => { cancelled = true; };
  }, [office, division, assignment]);

  function updateParticipant(index: number, update: Partial<EditableSpecialOrderParticipant>) {
    setParticipants((current) => current.map((participant, participantIndex) => participantIndex === index ? { ...participant, ...update } : participant));
  }

  const selectedParticipantUserIds = new Set(participants.flatMap((participant) => !participant.manual && participant.userId ? [participant.userId] : []));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!db) { setError("Database is not configured."); return; }
    const cleaned = participants.map((participant) => {
      const selectedPerson = participant.manual ? undefined : personnel.find((person) => person.userId === participant.userId);
      return {
        userId: participant.manual ? "" : participant.userId,
        name: participant.manual ? participant.name.trim() : selectedPerson?.name ?? participant.name.trim(),
        position: participant.manual ? participant.position.trim() : selectedPerson?.position ?? participant.position.trim(),
        unit: participant.manual ? participant.unit.trim() : selectedPerson?.unit ?? participant.unit.trim(),
      };
    }).filter((participant) => Boolean(participant.name)).filter((participant, index, all) => !participant.userId || all.findIndex((candidate) => candidate.userId === participant.userId) === index);
    if (!cleaned.length) { setError("Keep at least one personnel name in the Special Order."); return; }
    setBusy(true); setError("");
    try {
      const names = cleaned.map((participant) => participant.name);
      const positions = cleaned.map((participant) => participant.position);
      const participantUnits = cleaned.map((participant) => participant.unit);
      const participantUserIds = cleaned.map((participant) => participant.userId);
      const participantIds = [...new Set(participantUserIds.filter(Boolean))];
      const recipientIds = participantIds.filter((id) => id !== userId);
      const updates = {
        activityTitle: activityTitle.trim(),
        organizer: organizer.trim(),
        dateFrom,
        dateTo: dateTo || dateFrom,
        timeFrom,
        timeTo,
        venue: venue.trim(),
        participants: names,
        participantPositions: positions,
        participantUnits,
        participantUserIds,
        participantIds,
        recipientIds,
      };
      const firestore = db;
      const batch = writeBatch(firestore);
      batch.update(doc(firestore, "specialOrders", order.id), updates);
      const notifications = await getDocs(query(collection(firestore, "documentNotifications"), where("ownerId", "==", userId), where("documentId", "==", order.id)));
      const desiredRecipients = new Set(recipientIds);
      const retainedRecipients = new Set<string>();
      const notificationDetailsChanged = updates.activityTitle !== order.activityTitle
        || updates.dateFrom !== order.dateFrom
        || updates.dateTo !== order.dateTo
        || updates.venue !== order.venue;
      notifications.docs.forEach((notification) => {
        if (notificationDetailsChanged) {
          batch.delete(notification.ref);
          return;
        }
        const recipientId = notification.data().recipientId as string;
        if (!desiredRecipients.has(recipientId) || retainedRecipients.has(recipientId)) batch.delete(notification.ref);
        else retainedRecipients.add(recipientId);
      });
      recipientIds.forEach((recipientId) => {
        if (!notificationDetailsChanged && retainedRecipients.has(recipientId)) return;
        const notification = makeDocumentNotification(firestore, { recipientId, ownerId: userId, documentId: order.id, documentType: "Special Order", activityTitle: updates.activityTitle, dateFrom: updates.dateFrom, dateTo: updates.dateTo, venue: updates.venue });
        batch.set(notification.reference, notification.data);
      });
      await batch.commit();
      onSaved({ ...order, ...updates });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save Special Order changes.");
    } finally { setBusy(false); }
  }

  return <section className="content-section form-section special-order-form-section special-order-edit-section"><div className="section-heading"><div><p className="eyebrow">Edit record</p><h2>Edit Special Order</h2><p className="muted">Update the activity information and designated personnel for {order.subject}.</p></div><button type="button" className="ghost-button" onClick={onCancel}>Cancel</button></div>{error && <p className="error-message">{error}</p>}<form className="permit-form" onSubmit={save}>
    <label>Title of the Activity<input value={activityTitle} onChange={(event) => setActivityTitle(event.target.value)} required /></label>
    <label>Organizer/ Host<input value={organizer} onChange={(event) => setOrganizer(event.target.value)} required /></label>
    <div className="date-range-field"><span>Date</span><div><input aria-label="Date from" type="date" value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); if (dateTo && event.target.value > dateTo) setDateTo(event.target.value); }} required /><span>to</span><input aria-label="Date to" type="date" min={dateFrom} value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></div></div>
    <div className="date-range-field"><span>Time</span><div><input aria-label="Time from" type="time" value={timeFrom} onChange={(event) => setTimeFrom(event.target.value)} required /><span>to</span><input aria-label="Time to" type="time" value={timeTo} onChange={(event) => setTimeTo(event.target.value)} required /></div></div>
    <label className="wide-field">Venue<input value={venue} onChange={(event) => setVenue(event.target.value)} placeholder="Street, Building, City, Province" required /></label>
    <div className="participant-fields wide-field"><span>Designated Personnel</span>{participants.map((participant, index) => {
      const systemPerson = personnel.find((person) => person.userId === participant.userId);
      return <div className="participant-input" key={index}>
        {participant.manual ? <div className="participant-manual-fields">
          <label>Personnel Name<input aria-label={`Personnel ${index + 1} name`} value={participant.name} onChange={(event) => updateParticipant(index, { name: event.target.value })} required /></label>
          <label>Personnel Position<input aria-label={`Personnel ${index + 1} position`} value={participant.position} onChange={(event) => updateParticipant(index, { position: event.target.value })} required /></label>
          <label>Personnel Unit / Program / Project<input aria-label={`Personnel ${index + 1} Unit / Program / Project`} value={participant.unit} onChange={(event) => updateParticipant(index, { unit: event.target.value })} required /></label>
        </div> : <div className="participant-manual-fields">
          <div className="name-search-field"><span>Personnel Name</span><NameSearchSelect aria-label={`Designated personnel ${index + 1}`} value={participant.userId} onChange={(selectedId) => { const selectedPerson = personnel.find((person) => person.userId === selectedId); updateParticipant(index, { userId: selectedId, name: selectedPerson?.name ?? "", position: selectedPerson?.position ?? "", unit: selectedPerson?.unit ?? "" }); }} required={index === 0} disabled={personnelStatus !== "ready"}><option value="" disabled>{personnelStatus === "loading" ? "Loading personnel..." : personnelStatus === "error" ? "Personnel list unavailable" : "Select a personnel"}</option>{personnel.filter((person) => person.userId === participant.userId || !selectedParticipantUserIds.has(person.userId)).map((person) => <option key={person.userId} value={person.userId}>{personnelDisplayName(person)}</option>)}</NameSearchSelect></div>
          <label>Personnel Position<input aria-label={`Personnel ${index + 1} position`} value={systemPerson?.position ?? participant.position} readOnly /></label>
          <label>Personnel Unit / Program / Project<input aria-label={`Personnel ${index + 1} Unit / Program / Project`} value={systemPerson?.unit ?? participant.unit} readOnly /></label>
        </div>}
        <label className="participant-manual-toggle"><input type="checkbox" checked={participant.manual} onChange={(event) => {
          const enabled = event.target.checked;
          if (enabled) { updateParticipant(index, { manual: true, userId: "" }); return; }
          const matchingPeople = personnel.filter((person) => normalizeSpecialOrderPersonnelName(person.name) === normalizeSpecialOrderPersonnelName(participant.name));
          const matchedPerson = matchingPeople.length === 1 ? matchingPeople[0] : undefined;
          updateParticipant(index, matchedPerson
            ? { manual: false, userId: matchedPerson.userId, name: matchedPerson.name, position: matchedPerson.position, unit: matchedPerson.unit }
            : { manual: false, userId: "", name: "", position: "", unit: "" });
        }} />Manual</label>
        {participants.length > 1 && <button type="button" className="remove-participant remove-action" aria-label={`Remove personnel ${index + 1}`} onClick={() => setParticipants((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>}
      </div>;
    })}<button type="button" className="text-button plain-action add-item-text-button add-participant" onClick={() => setParticipants((current) => [...current, { name: "", position: "", unit: "", userId: "", manual: false }])}>+ Add personnel</button>{personnelStatus === "error" && <span className="auth-message auth-message-error" role="alert">Unable to load personnel from user accounts. Use manual input or reload the page to try again.</span>}</div>
    <div className="form-actions"><button className="primary-button" disabled={busy}>{busy ? "Saving..." : "Save changes"}</button></div>
  </form></section>;
}

function SpecialOrderSignatoryPosition({ designation }: { designation: string }) {
  const separator = designation.indexOf(", ");
  if (separator < 0) return <em>{designation}</em>;

  const position = designation.slice(0, separator + 1);
  const division = designation.slice(separator + 2);
  return division.endsWith("Division") ? <><em>{position}</em> {division}</> : <em>{designation}</em>;
}

function specialOrderSignatoryDesignation(name: string, designation: string) {
  return name.trim().toUpperCase() === "REBECCA R. ATEGA" ? "RTD for Operations" : designation;
}

function SpecialOrderPreview({ order, onClose }: { order: SpecialOrder; onClose: () => void }) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const [personnel, setPersonnel] = useState<PersonnelEntry[]>([]);
  const [personnelStatus, setPersonnelStatus] = useState<"loading" | "ready" | "error">("loading");
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState("");
  const [firstPageCount, setFirstPageCount] = useState(order.participants.length);
  const [firstPageSaturated, setFirstPageSaturated] = useState(false);
  const [continuationSettings, setContinuationSettings] = useState<{ capacity: number; saturated: boolean }[]>([]);
  const [closingUnitsOnLastAttendeePage, setClosingUnitsOnLastAttendeePage] = useState(7);
  const [closingPageSettings, setClosingPageSettings] = useState<{ capacity: number; saturated: boolean }[]>([]);
  const [signatoryPulledBack, setSignatoryPulledBack] = useState(false);
  const [closingSpacingTightened, setClosingSpacingTightened] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadPersonnel() {
      try {
        const entries = await loadAccountPersonnel();
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
  }, []);

  useEffect(() => {
    setFirstPageCount(order.participants.length);
    setFirstPageSaturated(false);
    setContinuationSettings([]);
    setClosingUnitsOnLastAttendeePage(7);
    setClosingPageSettings([]);
    setSignatoryPulledBack(false);
    setClosingSpacingTightened(false);
  }, [order.id]);

  const continuationPages: string[][] = [];
  const remainingParticipants = order.participants.slice(firstPageCount);
  let continuationOffset = 0;
  while (continuationOffset < remainingParticipants.length) {
    const pageIndex = continuationPages.length;
    const capacity = Math.max(1, continuationSettings[pageIndex]?.capacity ?? 24);
    continuationPages.push(remainingParticipants.slice(continuationOffset, continuationOffset + capacity));
    continuationOffset += capacity;
  }

  const closingUnits = [
    <p className="special-order-obligations special-order-closing-unit" data-special-order-closing-unit key="obligations">The above-named personnel shall actively participate in the said activity and are expected to:</p>,
    <ul className="special-order-obligation-list special-order-closing-unit" data-special-order-closing-unit key="represent"><li>Represent the office professionally;</li></ul>,
    <ul className="special-order-obligation-list special-order-closing-unit" data-special-order-closing-unit key="discussions"><li>Take note of important discussions, agreements, and action items;</li></ul>,
    <ul className="special-order-obligation-list special-order-closing-unit" data-special-order-closing-unit key="report"><li>Submit a brief written report and/or feedback within ____ days after the activity.</li></ul>,
    <p className="special-order-expenses special-order-closing-unit" data-special-order-closing-unit key="expenses">Travel and other incidental expenses, if any, shall be charged against available funds subject to existing accounting and auditing rules and regulations.</p>,
    <p className="special-order-done special-order-closing-unit" data-special-order-closing-unit key="done">Done this ____ day of ____________, {new Date().getFullYear()}</p>,
    <footer className="special-order-signatory special-order-closing-unit" data-special-order-closing-unit key="signatory"><strong>{order.signatoryName || specialOrderSignatories[0].name}</strong><span><SpecialOrderSignatoryPosition designation={specialOrderSignatoryDesignation(order.signatoryName || specialOrderSignatories[0].name, order.signatoryDesignation || specialOrderSignatories[0].designation)} /></span></footer>,
  ];
  const closingContinuationPages: (typeof closingUnits)[] = [];
  const remainingClosingUnits = closingUnits.slice(closingUnitsOnLastAttendeePage);
  let closingOffset = 0;
  while (closingOffset < remainingClosingUnits.length) {
    const pageIndex = closingContinuationPages.length;
    const capacity = Math.max(1, closingPageSettings[pageIndex]?.capacity ?? 7);
    closingContinuationPages.push(remainingClosingUnits.slice(closingOffset, closingOffset + capacity));
    closingOffset += capacity;
  }
  if (closingContinuationPages.length > 1) {
    const lastPage = closingContinuationPages[closingContinuationPages.length - 1];
    const previousPage = closingContinuationPages[closingContinuationPages.length - 2];
    const lastPageHasOnlyDateAndSignatory = lastPage.length === 2 && lastPage[0] === closingUnits[5] && lastPage[1] === closingUnits[6];
    if ((lastPage.length === 1 && lastPage[0] === closingUnits[closingUnits.length - 1] || lastPageHasOnlyDateAndSignatory) && previousPage.length > 0) {
      const precedingUnit = previousPage.pop();
      if (precedingUnit) lastPage.unshift(precedingUnit);
      if (previousPage.length === 0) closingContinuationPages.splice(closingContinuationPages.length - 2, 1);
    }
  }
  const renderClosingUnits = (units: typeof closingUnits) => units.length > 0
    ? <div className={`special-order-closing${closingSpacingTightened ? " special-order-closing-tight" : ""}${signatoryPulledBack && units.includes(closingUnits[closingUnits.length - 1]) ? " special-order-closing-pulled" : ""}`}>{units}</div>
    : null;

  useLayoutEffect(() => {
    const pages = pagesRef.current;
    if (!pages) return;

    const pageLimit = (page: HTMLElement) => {
      const rect = page.getBoundingClientRect();
      return rect.bottom - rect.width * 0.0242;
    };

    const firstPage = pages.querySelector<HTMLElement>(".special-order-paper");
    if (!firstPage) return;

    const firstRows = Array.from(firstPage.querySelectorAll<HTMLElement>(".special-order-first-participants li"));
    const firstFitCount = firstRows.filter((row) => row.getBoundingClientRect().bottom <= pageLimit(firstPage)).length;
    if (firstFitCount < firstRows.length) {
      if (firstFitCount !== firstPageCount) setFirstPageCount(firstFitCount);
      if (!firstPageSaturated) setFirstPageSaturated(true);
      return;
    }
    if (firstPageCount < order.participants.length && !firstPageSaturated) {
      setFirstPageCount(firstPageCount + 1);
      return;
    }

    const continuationElements = Array.from(pages.querySelectorAll<HTMLElement>(".special-order-continuation-page"));
    const nextSettings = [...continuationSettings];
    for (let pageIndex = 0; pageIndex < continuationElements.length; pageIndex += 1) {
      const page = continuationElements[pageIndex];
      const rows = Array.from(page.querySelectorAll<HTMLElement>(".special-order-continuation-participants li"));
      const fitCount = rows.filter((row) => row.getBoundingClientRect().bottom <= pageLimit(page)).length;
      const current = nextSettings[pageIndex] ?? { capacity: 24, saturated: false };
      if (fitCount < rows.length) {
        const capacity = Math.max(1, fitCount);
        if (capacity !== current.capacity || !current.saturated) {
          nextSettings[pageIndex] = { capacity, saturated: true };
          setContinuationSettings(nextSettings);
          return;
        }
      } else if (pageIndex < continuationElements.length - 1 && rows.length === current.capacity && !current.saturated) {
        nextSettings[pageIndex] = { capacity: current.capacity + 1, saturated: false };
        setContinuationSettings(nextSettings);
        return;
      }
    }

    const lastAttendeePage = continuationElements[continuationElements.length - 1] ?? firstPage;
    const visibleClosingUnits = Array.from(lastAttendeePage.querySelectorAll<HTMLElement>(".special-order-closing-unit"));
    const closingFitCount = visibleClosingUnits.filter((unit) => unit.getBoundingClientRect().bottom <= pageLimit(lastAttendeePage)).length;
    if (closingFitCount < visibleClosingUnits.length) {
      if (!closingSpacingTightened) {
        setClosingSpacingTightened(true);
        return;
      }
      const signatoryWouldBeTheOnlyOverflow = visibleClosingUnits[visibleClosingUnits.length - 1]?.classList.contains("special-order-signatory") && closingFitCount === visibleClosingUnits.length - 1;
      if (signatoryWouldBeTheOnlyOverflow && !signatoryPulledBack && closingUnitsOnLastAttendeePage === closingUnits.length) {
        setSignatoryPulledBack(true);
        return;
      }
      if (signatoryWouldBeTheOnlyOverflow && signatoryPulledBack) {
        setClosingUnitsOnLastAttendeePage(Math.max(0, visibleClosingUnits.length - 3));
        setSignatoryPulledBack(false);
        return;
      }
      const dateAndSignatoryWouldBeTheOnlyOverflow = visibleClosingUnits.length - closingFitCount === 2
        && visibleClosingUnits[visibleClosingUnits.length - 2]?.classList.contains("special-order-done")
        && visibleClosingUnits[visibleClosingUnits.length - 1]?.classList.contains("special-order-signatory");
      if (dateAndSignatoryWouldBeTheOnlyOverflow) {
        setClosingUnitsOnLastAttendeePage(Math.max(0, closingFitCount - 1));
        return;
      }
      if (closingFitCount !== closingUnitsOnLastAttendeePage) setClosingUnitsOnLastAttendeePage(closingFitCount);
      if (signatoryPulledBack) setSignatoryPulledBack(false);
      return;
    }

    const dateAndSignatoryAloneOnClosingPage = closingContinuationPages.length === 1
      && closingContinuationPages[0].length === 2
      && closingContinuationPages[0][0] === closingUnits[5]
      && closingContinuationPages[0][1] === closingUnits[6];
    if (dateAndSignatoryAloneOnClosingPage && closingUnitsOnLastAttendeePage > 0) {
      setClosingUnitsOnLastAttendeePage(closingUnitsOnLastAttendeePage - 1);
      return;
    }

    const closingContinuationElements = Array.from(pages.querySelectorAll<HTMLElement>(".special-order-closing-page"));
    const lastClosingPage = closingContinuationElements[closingContinuationElements.length - 1];
    const lastClosingUnits = lastClosingPage ? Array.from(lastClosingPage.querySelectorAll<HTMLElement>(".special-order-closing-unit")) : [];
    if (closingContinuationElements.length === 1 && lastClosingUnits.length === 1 && lastClosingUnits[0].classList.contains("special-order-signatory")) {
      setClosingUnitsOnLastAttendeePage(closingUnits.length);
      return;
    }
    const nextClosingSettings = [...closingPageSettings];
    for (let pageIndex = 0; pageIndex < closingContinuationElements.length; pageIndex += 1) {
      const page = closingContinuationElements[pageIndex];
      const units = Array.from(page.querySelectorAll<HTMLElement>(".special-order-closing-unit"));
      const fitCount = units.filter((unit) => unit.getBoundingClientRect().bottom <= pageLimit(page)).length;
      const current = nextClosingSettings[pageIndex] ?? { capacity: 7, saturated: false };
      if (fitCount < units.length) {
        const capacity = Math.max(1, fitCount);
        if (capacity !== current.capacity || !current.saturated) {
          nextClosingSettings[pageIndex] = { capacity, saturated: true };
          setClosingPageSettings(nextClosingSettings);
          return;
        }
      } else if (pageIndex < closingContinuationElements.length - 1 && units.length === current.capacity && !current.saturated) {
        nextClosingSettings[pageIndex] = { capacity: current.capacity + 1, saturated: false };
        setClosingPageSettings(nextClosingSettings);
        return;
      }
    }
  }, [closingContinuationPages.length, closingPageSettings, closingSpacingTightened, closingUnitsOnLastAttendeePage, continuationPages.length, continuationSettings, firstPageCount, firstPageSaturated, order.participants, personnel, signatoryPulledBack]);

  async function downloadPdf() {
    if (!pagesRef.current) return;
    setDownloading(true); setDownloadError("");
    try {
      const { html2canvas, jsPDF } = await loadPdfTools();
      await Promise.all(Array.from(pagesRef.current.querySelectorAll("img")).map(async (image) => {
        if (!image.complete) await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("The Special Order letterhead could not be loaded.")); });
        if (image.decode) await image.decode();
      }));
      const pageElements = Array.from(pagesRef.current.querySelectorAll<HTMLElement>(".special-order-paper"));
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      for (let index = 0; index < pageElements.length; index += 1) {
        const canvas = await html2canvas(pageElements[index], { backgroundColor: "#fff", logging: false, scale: 3, useCORS: true });
        if (index > 0) pdf.addPage();
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, 210, 297);
      }
      pdf.save(`special-order-${order.dateFrom}.pdf`);
    } catch (error) { setDownloadError(error instanceof Error ? error.message : "Unable to create the PDF."); }
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
          image.onerror = () => reject(new Error("The Special Order letterhead could not be loaded."));
        });
        if (image.naturalWidth === 0) throw new Error("The Special Order letterhead could not be loaded.");
        if (image.decode) await image.decode();
      }));
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      window.print();
    } catch (error) {
      setPrintError(error instanceof Error ? error.message : "Unable to prepare the Special Order for printing.");
    } finally {
      setPrinting(false);
    }
  }

  const pageParticipants = (participants: string[], participantOffset: number, continued: boolean, pageKey: string, className: string, includeClosing: boolean) => <>
    <section className={`special-order-participants ${className}`}>
      {!continued && <div className="special-order-spacer" aria-hidden="true" />}
      <h2>{continued ? "Designated Personnel (continued):" : "Designated Personnel:"}</h2>
      <ol>{participants.map((participant, index) => { const participantIndex = participantOffset + index; const participantRecord = order.participantUserIds?.[participantIndex] ? personnel.find((person) => person.userId === order.participantUserIds?.[participantIndex]) : personnel.find((person) => person.name === participant); const position = order.participantPositions?.[participantIndex] || participantRecord?.position; const savedUnit = order.participantUnits?.[participantIndex] || participantRecord?.unit; const legacyUnit = order.participantOffices?.[participantIndex]; const unit = savedUnit || (legacyUnit && legacyUnit !== "Division" ? legacyUnit : ""); return <li key={`${pageKey}-${index}`}><strong>{participant}</strong>{position && <> - <em>{position}</em></>}{unit && <>, {unit}</>}</li>; })}</ol>
    </section>
    {includeClosing && renderClosingUnits(closingUnits.slice(0, closingUnitsOnLastAttendeePage))}
  </>;

  const firstPageHasAllParticipants = continuationPages.length === 0;
  return <div className="preview-backdrop"><div className="preview-toolbar"><span>Special Order preview</span><button type="button" className="ghost-button" onClick={onClose}>Close</button><button type="button" className="pdf-button" disabled={downloading || personnelStatus === "loading"} onClick={downloadPdf}>{personnelStatus === "loading" ? "Loading personnel..." : downloading ? "Preparing PDF..." : "Download PDF"}</button><button type="button" className="pdf-button" disabled={printing || personnelStatus === "loading"} onClick={printPreview}>{personnelStatus === "loading" ? "Loading personnel..." : printing ? "Preparing print..." : "Print"}</button>{personnelStatus === "error" && <small className="download-error" role="status">Personnel details could not be loaded.</small>}{downloadError && <small className="download-error">{downloadError}</small>}{printError && <small className="download-error" role="alert">{printError}</small>}</div>
    <div ref={pagesRef} className="special-order-preview-pages">
      <article className="special-order-paper"><img className="special-order-letterhead" src={publicAsset("/Document-Header-Footer.jpg")} alt="" /><div className="special-order-content"><header className="special-order-heading"><h1>SPECIAL ORDER</h1><p>No. <span /></p><p>Series of {new Date().getFullYear()}</p></header><div className="special-order-flow"><section className="special-order-subject"><p><b>SUBJECT :</b><span>{order.subject.toUpperCase()}</span></p></section><p className="special-order-intro">In view of the unavailability of the undersigned and/or the absence of specified participants on the received communications, the following personnel is/are hereby designated to attend and represent this Office in the activity detailed below:</p><div className="special-order-body"><section className="special-order-details"><p><b>Title of the Activity :</b><span>{order.activityTitle}</span></p><p><b>Organizer/ Host :</b><span>{order.organizer}</span></p><p><b>Date :</b><span>{formatDate(order.dateFrom)}{order.dateTo !== order.dateFrom && ` to ${formatDate(order.dateTo)}`}</span></p><p><b>Time :</b><span>{formatTimeRange(order.timeFrom, order.timeTo)}</span></p><p><b>Venue :</b><span>{order.venue}</span></p></section>{(firstPageCount > 0 || order.participants.length === 0) && pageParticipants(order.participants.slice(0, firstPageCount), 0, false, "first", "special-order-first-participants", firstPageHasAllParticipants)}</div></div></div></article>
      {continuationPages.map((participants, index) => {
        const isLastPage = index === continuationPages.length - 1;
        const participantOffset = firstPageCount + continuationPages.slice(0, index).reduce((count, page) => count + page.length, 0);
        return <article className="special-order-paper special-order-continuation-page" key={`continuation-${index}`}><img className="special-order-letterhead" src={publicAsset("/Document-Header-Footer.jpg")} alt="" /><div className="special-order-content"><div className="special-order-flow special-order-flow-continued">{pageParticipants(participants, participantOffset, true, `continuation-${index}`, "special-order-continuation-participants", isLastPage)}</div></div></article>;
      })}
      {closingContinuationPages.map((units, index) => <article className="special-order-paper special-order-closing-page" key={`closing-${index}`}><img className="special-order-letterhead" src={publicAsset("/Document-Header-Footer.jpg")} alt="" /><div className="special-order-content"><div className="special-order-flow special-order-flow-continued">{renderClosingUnits(units)}</div></div></article>)}
    </div>
  </div>;
}

export default function Home() {
  const [philippineDateTime, setPhilippineDateTime] = useState("");
  const [biometricsGreeting, setBiometricsGreeting] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profileSetupUser, setProfileSetupUser] = useState<User | null>(null);
  const [approvalUser, setApprovalUser] = useState<User | null>(null);
  const [approvalStatus, setApprovalStatus] = useState<AccountStatus | "Missing" | null>(null);
  const [approvalError, setApprovalError] = useState("");
  const [permits, setPermits] = useState<Permit[]>([]);
  const [permitPreparedByNames, setPermitPreparedByNames] = useState<Record<string, string>>({});
  const permitPreparedByNameLookups = useRef(new Set<string>());
  const [approvedPermitNumbers, setApprovedPermitNumbers] = useState<Record<string, string>>({});
  const [deletingPermitId, setDeletingPermitId] = useState<string | null>(null);
  const [pendingPermitDelete, setPendingPermitDelete] = useState<Permit | null>(null);
  const [pendingPermitNotifications, setPendingPermitNotifications] = useState<PendingPermitNotification[]>([]);
  const [permitNotificationAccounts, setPermitNotificationAccounts] = useState<Record<string, PermitNotificationAccount> | null>(null);
  const [pendingAccountApprovals, setPendingAccountApprovals] = useState<PendingAccountApprovalNotification[]>([]);
  const [documentNotifications, setDocumentNotifications] = useState<DocumentNotification[]>([]);
  const [documentReminders, setDocumentReminders] = useState<DocumentReminder[]>([]);
  const [calendarOfActivitiesNotifications, setCalendarOfActivitiesNotifications] = useState<CalendarOfActivitiesNotification[]>([]);
  const [calendarOfActivitiesApprovalNotifications, setCalendarOfActivitiesApprovalNotifications] = useState<CalendarOfActivitiesApprovalNotification[]>([]);
  const [focusedPermitNotificationKey, setFocusedPermitNotificationKey] = useState<string | null>(null);
  const [notificationFocus, setNotificationFocus] = useState<NotificationFocus | null>(null);
  const [specialOrders, setSpecialOrders] = useState<SpecialOrder[]>([]);
  const [specialOrderPreparedByNames, setSpecialOrderPreparedByNames] = useState<Record<string, string>>({});
  const [editingSpecialOrder, setEditingSpecialOrder] = useState<SpecialOrder | null>(null);
  const [deletingSpecialOrderId, setDeletingSpecialOrderId] = useState<string | null>(null);
  const [copyingSpecialOrderId, setCopyingSpecialOrderId] = useState<string | null>(null);
  const [pendingSpecialOrderDelete, setPendingSpecialOrderDelete] = useState<SpecialOrder | null>(null);
  const [view, setView] = useState<"list" | "new">("list");
  const [section, setSection] = useState<"permits" | "messenger" | "special-orders" | "nta" | "travel-orders" | "calendar-of-activities" | "calendar-of-activities-records" | "whereabouts-calendar" | "permit-statistics" | "permit-status" | "certificate-approval" | "user-master-list" | "document-notifications" | "pending-permit-slips" | "cleaning-task" | "cleaning-task-assignments" | "my-drive" | "myar" | "my-notes" | "my-tevs" | "leave-application" | "certificate-of-appearance" | "completion" | "appreciation" | "participation">("whereabouts-calendar");
  const [myDocsMenuOpen, setMyDocsMenuOpen] = useState(false);
  const [certificateMenuOpen, setCertificateMenuOpen] = useState(false);
  const [adminPanelMenuOpen, setAdminPanelMenuOpen] = useState(false);
  const [amiaDocumentMenuOpen, setAmiaDocumentMenuOpen] = useState(false);
  const [preview, setPreview] = useState<Permit | null>(null);
  const [singleSlipPreview, setSingleSlipPreview] = useState(false);
  const [specialOrderPreview, setSpecialOrderPreview] = useState<SpecialOrder | null>(null);
  const [error, setError] = useState("");
  const [startupError, setStartupError] = useState("");
  const [loading, setLoading] = useState(true);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileCertificateOpen, setMobileCertificateOpen] = useState(false);
  const [mobileAdminPanelOpen, setMobileAdminPanelOpen] = useState(false);
  const [mobileAmiaDocumentOpen, setMobileAmiaDocumentOpen] = useState(false);
  const [mobileMyDocsOpen, setMobileMyDocsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [changePassword, setChangePassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showConfirmNewPassword, setShowConfirmNewPassword] = useState(false);
  const [resetEmailBusy, setResetEmailBusy] = useState(false);
  const [profileFirstName, setProfileFirstName] = useState("");
  const [profilePhotoURL, setProfilePhotoURL] = useState("");
  const [profileRevision, setProfileRevision] = useState(0);
  const [profileMiddleName, setProfileMiddleName] = useState("");
  const [profileLastName, setProfileLastName] = useState("");
  const [profileGender, setProfileGender] = useState("");
  const [profilePosition, setProfilePosition] = useState("");
  const [profilePositionIsCustom, setProfilePositionIsCustom] = useState(false);
  const [profileDesignation, setProfileDesignation] = useState("");
  const [profileDivision, setProfileDivision] = useState("");
  const [profileUnit, setProfileUnit] = useState("");
  const [profileOffice, setProfileOffice] = useState("");
  const [profileAddress, setProfileAddress] = useState("");
  const [profileTaxIdentificationNo, setProfileTaxIdentificationNo] = useState("");
  const [accountProfile, setAccountProfile] = useState<{ userId: string; office: string | null; division: string | null; unit: string | null; assignment: string | null; name: string; designation: string; accountRole: AccountRole; accountStatus: AccountStatus } | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMessage, setProfileMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const notificationToneRef = useRef<HTMLAudioElement | null>(null);
  const notificationAudioContextRef = useRef<AudioContext | null>(null);
  const notificationAudioBufferRef = useRef<AudioBuffer | null>(null);
  const pendingNotificationToneRef = useRef(false);
  const playBufferedNotificationTone = useCallback(() => {
    const audioContext = notificationAudioContextRef.current;
    const buffer = notificationAudioBufferRef.current;
    if (!audioContext || audioContext.state !== "running" || !buffer) return false;
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start();
    pendingNotificationToneRef.current = false;
    return true;
  }, []);

  useEffect(() => {
    const tone = new Audio(publicAsset("/notif_tone.mp3"));
    tone.preload = "auto";
    notificationToneRef.current = tone;
    let context: AudioContext | null = null;
    let disposed = false;
    try {
      context = new AudioContext();
      notificationAudioContextRef.current = context;
      void fetch(publicAsset("/notif_tone.mp3"))
        .then((response) => {
          if (!response.ok) throw new Error("Could not load the notification sound.");
          return response.arrayBuffer();
        })
        .then((sound) => context?.decodeAudioData(sound))
        .then((buffer) => {
          if (disposed || !buffer) return;
          notificationAudioBufferRef.current = buffer;
          if (pendingNotificationToneRef.current) playBufferedNotificationTone();
        })
        .catch(() => undefined);
    } catch {
      notificationAudioContextRef.current = null;
    }
    const unlockAudio = () => {
      const audioContext = notificationAudioContextRef.current;
      if (audioContext?.state === "suspended") {
        void audioContext.resume().then(() => {
          if (pendingNotificationToneRef.current) playBufferedNotificationTone();
        }).catch(() => undefined);
      } else if (pendingNotificationToneRef.current) playBufferedNotificationTone();
    };
    document.addEventListener("pointerdown", unlockAudio, { once: true });
    document.addEventListener("keydown", unlockAudio, { once: true });
    return () => {
      disposed = true;
      document.removeEventListener("pointerdown", unlockAudio);
      document.removeEventListener("keydown", unlockAudio);
      tone.pause();
      notificationToneRef.current = null;
      notificationAudioBufferRef.current = null;
      notificationAudioContextRef.current = null;
      pendingNotificationToneRef.current = false;
      if (context && context.state !== "closed") void context.close().catch(() => undefined);
    };
  }, [playBufferedNotificationTone]);

  const playNotificationTone = useCallback(() => {
    const audioContext = notificationAudioContextRef.current;
    const buffer = notificationAudioBufferRef.current;
    if (audioContext && buffer) {
      if (playBufferedNotificationTone()) return;
      pendingNotificationToneRef.current = true;
      if (audioContext.state !== "running") {
        void audioContext.resume().then(() => {
          if (pendingNotificationToneRef.current) playBufferedNotificationTone();
        }).catch(() => undefined);
      }
      return;
    }
    const tone = notificationToneRef.current;
    if (!tone) return;
    tone.currentTime = 0;
    void tone.play().catch(() => {
      if (notificationAudioContextRef.current) pendingNotificationToneRef.current = true;
    });
  }, [playBufferedNotificationTone]);

  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      setPhilippineDateTime(formatPhilippineDateTime(now));
      setBiometricsGreeting(getPhilippineBiometricsGreeting(now));
    };
    updateClock();
    let interval = 0;
    const nextMinute = window.setTimeout(() => {
      updateClock();
      interval = window.setInterval(updateClock, 60_000);
    }, 60_000 - (Date.now() % 60_000));
    return () => {
      window.clearTimeout(nextMinute);
      if (interval) window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const preventAssetTransfer = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("img")) event.preventDefault();
    };
    document.addEventListener("dragstart", preventAssetTransfer, true);
    document.addEventListener("contextmenu", preventAssetTransfer, true);
    document.querySelectorAll("img").forEach((image) => { image.draggable = false; });
    return () => {
      document.removeEventListener("dragstart", preventAssetTransfer, true);
      document.removeEventListener("contextmenu", preventAssetTransfer, true);
    };
  }, []);

  function closeProfile() {
    setProfileOpen(false);
    setProfileMessage(null);
    setChangePassword("");
    setConfirmNewPassword("");
    setShowChangePassword(false);
    setShowConfirmNewPassword(false);
  }

  async function openProfile() {
    if (!user || !db) return;
    setProfileMenuOpen(false);
    setProfileOpen(true);
    setProfileLoading(true);
    setProfileMessage(null);
    setProfilePhotoURL("");
    applyProfileName(user.displayName ?? "");
    setProfileGender("");
    setProfilePosition("");
    setProfilePositionIsCustom(false);
    setProfileDesignation("");
    setProfileDivision("");
    setProfileUnit("");
    setProfileOffice("");
    setProfileAddress("");
    setProfileTaxIdentificationNo("");
    try {
      const profileSnapshot = await getDoc(doc(db, "users", user.uid));
      if (profileSnapshot.exists()) {
        const profile = profileSnapshot.data();
        if (typeof profile.photoURL === "string") setProfilePhotoURL(profile.photoURL);
        if (typeof profile.firstName === "string" && typeof profile.lastName === "string") {
          setProfileFirstName(profile.firstName);
          setProfileMiddleName(typeof profile.middleName === "string" ? profile.middleName : "");
          setProfileLastName(profile.lastName);
        } else if (typeof profile.name === "string") applyProfileName(profile.name);
        if (typeof profile.gender === "string") setProfileGender(profile.gender);
        if (typeof profile.position === "string") {
          setProfilePosition(profile.position);
          setProfilePositionIsCustom(Boolean(profile.position) && !accountPositionOptions.some((option) => option === profile.position));
        }
        if (typeof profile.designation === "string") setProfileDesignation(accountDesignation(profile.designation));
        const profileSelection = accountProfileSelection(profile);
        setProfileDivision(profileSelection.division);
        setProfileUnit(profileSelection.unit);
        setProfileOffice(profileSelection.office);
        if (typeof profile.address === "string") setProfileAddress(profile.address);
        if (typeof profile.taxIdentificationNo === "string") setProfileTaxIdentificationNo(formatTaxIdentificationNo(profile.taxIdentificationNo));
      }
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setProfileMessage({ kind: "error", text: code ? `Could not load your profile (${code}).` : "Could not load your profile. Try again." });
    } finally {
      setProfileLoading(false);
    }
  }

  // Best-effort split of a stored full name such as "James E. Rosales".
  function applyProfileName(fullName: string) {
    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    const last = parts.length > 1 ? parts.pop() ?? "" : "";
    const middle = parts.length > 1 && /^[A-Za-z]\.?$/.test(parts[parts.length - 1]) ? parts.pop() ?? "" : "";
    setProfileFirstName(parts.join(" "));
    setProfileMiddleName(middle);
    setProfileLastName(last);
  }

  async function saveChanges(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProfileMessage(null);
    const clean = (value: string) => value.trim().replace(/\s+/g, " ");
    const firstName = clean(profileFirstName);
    const middleName = clean(profileMiddleName);
    const lastName = clean(profileLastName);
    const gender = profileGender;
    const office = clean(profileOffice);
    const division = clean(profileDivision);
    const unit = clean(profileUnit);
    const address = clean(profileAddress);
    const taxIdentificationNo = formatTaxIdentificationNo(profileTaxIdentificationNo);
    const middleInitial = middleName ? `${middleName.charAt(0).toUpperCase()}.` : "";
    const name = [firstName, middleInitial, lastName].filter(Boolean).join(" ");
    const position = profilePosition.trim().replace(/\s+/g, " ");
    const designation = clean(accountDesignation(profileDesignation));
    const wantsPasswordChange = changePassword.length > 0 || confirmNewPassword.length > 0;
    if (!firstName || !lastName) {
      setProfileMessage({ kind: "error", text: "Enter your first and last name." });
      return;
    }
    if (!gender) {
      setProfileMessage({ kind: "error", text: "Select your gender." });
      return;
    }
    if (!address) {
      setProfileMessage({ kind: "error", text: "Enter your address." });
      return;
    }
    if (designation.length > 120) {
      setProfileMessage({ kind: "error", text: "Shorten the custom designation to 120 characters or fewer." });
      return;
    }
    if (!office) {
      setProfileMessage({ kind: "error", text: "Select your Office." });
      return;
    }
    if (!accountOfficeOptions.includes(office as (typeof accountOfficeOptions)[number])) {
      setProfileMessage({ kind: "error", text: "Select your Office." });
      return;
    }
    if (!(divisionsForOffice(office) as readonly string[]).includes(division)) {
      setProfileMessage({ kind: "error", text: "Select a Division for your Office." });
      return;
    }
    if (!(unitsForOfficeDivision(office, division) as readonly string[]).includes(unit)) {
      setProfileMessage({ kind: "error", text: "Select a Unit / Program / Project for your Division." });
      return;
    }
    if (!/^\d{3}-\d{3}-\d{3}$/.test(taxIdentificationNo)) {
      setProfileMessage({ kind: "error", text: "Enter a 9-digit tax identification number in 123-123-123 format." });
      return;
    }
    if (wantsPasswordChange && (!changePassword || !confirmNewPassword)) {
      setProfileMessage({ kind: "error", text: "Enter and confirm the new password, or leave both password fields empty." });
      return;
    }
    if (wantsPasswordChange && changePassword !== confirmNewPassword) {
      setProfileMessage({ kind: "error", text: "The passwords do not match." });
      return;
    }
    if (wantsPasswordChange && changePassword.length < 6) {
      setProfileMessage({ kind: "error", text: "Password must be at least 6 characters." });
      return;
    }
    if (!user || !db) {
      setProfileMessage({ kind: "error", text: "Your account is unavailable. Sign in again and retry." });
      return;
    }
    setProfileSaving(true);
    let profileDataSaved = false;
    let accountNameSaved = false;
    try {
      await setDoc(doc(db, "users", user.uid), { name, firstName, middleName, lastName, gender, position, designation, office, division, unit, profileFieldsVersion: 4, assignment: deleteField(), projectProgram: deleteField(), address, taxIdentificationNo }, { merge: true });
      profileDataSaved = true;
      setProfileRevision((revision) => revision + 1);
      await updateProfile(user, { displayName: name });
      accountNameSaved = true;
      setUser(auth?.currentUser ?? user);
      setProfileFirstName(firstName);
      setProfileMiddleName(middleName);
      setProfileLastName(lastName);
      setProfilePosition(position);
      setProfileDesignation(designation);
      setProfileDivision(division);
      setProfileUnit(unit);
      setProfileOffice(office);
      setProfileAddress(address);
      setProfileTaxIdentificationNo(taxIdentificationNo);
      if (wantsPasswordChange) await updatePassword(user, changePassword);
      setChangePassword("");
      setConfirmNewPassword("");
      setProfileMessage({ kind: "success", text: "Your changes have been saved." });
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      const reason = code === "auth/requires-recent-login"
        ? "Sign in again before changing your password, or choose Reset Password."
        : code ? `Firebase returned ${code}.` : "Try again.";
      const message = !profileDataSaved
        ? `Could not save your changes. ${reason}`
        : !accountNameSaved
          ? `Your profile fields were saved, but the account name was not updated. ${reason}`
          : wantsPasswordChange
            ? `Your profile was saved, but the password was not changed. ${reason}`
            : `Your profile was saved, but the account could not be updated. ${reason}`;
      setProfileMessage({ kind: "error", text: message });
    } finally {
      setProfileSaving(false);
    }
  }

  async function sendResetLink() {
    setProfileMessage(null);
    if (!auth || !user?.email) {
      setProfileMessage({ kind: "error", text: "A verified email address is required to send a reset link." });
      return;
    }
    setResetEmailBusy(true);
    try {
      await sendPasswordResetEmail(auth, user.email);
      setProfileMessage({ kind: "success", text: `A password reset link was sent to ${user.email}.` });
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setProfileMessage({ kind: "error", text: code ? `Could not send the reset link (${code}).` : "Could not send the reset link. Try again." });
    } finally {
      setResetEmailBusy(false);
    }
  }

  useEffect(() => {
    if (!auth) { setLoading(false); return; }
    let authChange = 0;
    let active = true;
    const showStartupTimeout = () => {
      if (!active) return;
      setStartupError("My Desk could not complete its Firebase startup check. Check your internet connection and Firebase project configuration, then reload.");
      setLoading(false);
    };
    let startupTimeout = window.setTimeout(showStartupTimeout, 15000);
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      window.clearTimeout(startupTimeout);
      startupTimeout = window.setTimeout(showStartupTimeout, 15000);
      const thisAuthChange = ++authChange;
      const verifiedUser = currentUser?.emailVerified ? currentUser : null;
      setStartupError("");
      setLoading(true);
      setApprovalError("");
      setApprovalStatus(null);
      setApprovalUser(null);
      setProfileSetupUser(null);
      if (!verifiedUser) {
        setUser(null);
        setAccountProfile(null);
        window.clearTimeout(startupTimeout);
        setLoading(false);
        return;
      }
      void (async () => {
        if (!db) { setUser(verifiedUser); window.clearTimeout(startupTimeout); setLoading(false); return; }
        try {
          const profileRef = doc(db, "users", verifiedUser.uid);
          let profileSnapshot = await getDoc(profileRef);
          if (thisAuthChange !== authChange) return;
          if (!profileSnapshot.exists()) {
            setUser(null);
            setApprovalUser(verifiedUser);
            setApprovalStatus("Missing");
            setLoading(false);
            return;
          }
          let profileData = profileSnapshot.data();
          if (profileData.registrationStage === "detailsRequired") {
            setUser(null);
            setAccountProfile(null);
            setProfileSetupUser(verifiedUser);
            setLoading(false);
            return;
          }
          const isBootstrapSuperAdmin = verifiedUser.email?.trim().toLowerCase() === SUPERADMIN_EMAIL;
          if (isBootstrapSuperAdmin) {
            try {
              await migrateAccountProfileFieldsForSuperAdmin();
              profileSnapshot = await getDoc(profileRef);
              if (profileSnapshot.exists()) profileData = profileSnapshot.data();
            } catch (cause) {
              console.warn("Could not initialize account Division fields during Super Admin sign-in.", cause);
            }
          }
          const accountRole = normalizeAccountRole(profileData.accountRole, verifiedUser.email);
          const accountStatus = isBootstrapSuperAdmin ? "Approved" : normalizeAccountStatus(profileData.accountStatus);
          if (thisAuthChange !== authChange) return;
          const accountPatch: Record<string, unknown> = {};
          const canPatchProfile = profileData.profileFieldsVersion === 4;
          if (canPatchProfile && profileData.emailVerified !== true) accountPatch.emailVerified = true;
          if (canPatchProfile && ((isBootstrapSuperAdmin && profileData.accountRole !== "superadmin") || (!profileData.accountRole && accountRole))) accountPatch.accountRole = accountRole;
          if (canPatchProfile && isBootstrapSuperAdmin && profileData.accountStatus !== "Approved") accountPatch.accountStatus = "Approved";
          if (canPatchProfile && isBootstrapSuperAdmin && profileData.isRootSuperAdmin !== true) accountPatch.isRootSuperAdmin = true;
          if (Object.keys(accountPatch).length) {
            if (isBootstrapSuperAdmin) {
              try {
                await setDoc(profileRef, accountPatch, { merge: true });
              } catch (cause) {
                console.warn("Could not normalize the Super Admin profile during sign-in.", cause);
              }
            } else {
              await setDoc(profileRef, accountPatch, { merge: true });
            }
          }
          if (thisAuthChange !== authChange) return;
          const profileSelection = accountProfileSelection(profileData);
          setAccountProfile({
            userId: verifiedUser.uid,
            office: profileSelection.office || null,
            division: profileSelection.division || null,
            unit: profileSelection.unit || null,
            assignment: profileSelection.assignment || null,
            name: typeof profileData.name === "string" ? profileData.name : verifiedUser.displayName ?? "",
            designation: accountDesignation(profileData.designation),
            accountRole,
            accountStatus,
          });
          if (accountStatus === "Approved") {
            setUser(verifiedUser);
            setApprovalUser(null);
            setApprovalStatus(null);
            setSection("whereabouts-calendar");
            setView("list");
          } else {
            setUser(null);
            setApprovalUser(verifiedUser);
            setApprovalStatus(accountStatus);
          }
        } catch {
          if (thisAuthChange === authChange) {
            setError("Could not check your account approval. Try signing in again.");
            setUser(null);
            setApprovalUser(verifiedUser);
            setApprovalStatus("Missing");
            setApprovalError("We could not check your approval status. Please sign out and try again.");
          }
        } finally {
          if (active && thisAuthChange === authChange) {
            window.clearTimeout(startupTimeout);
            setStartupError("");
            setLoading(false);
          }
        }
      })();
    }, (cause) => {
      if (!active) return;
      const code = (cause as { code?: string }).code;
      window.clearTimeout(startupTimeout);
      setStartupError(code
        ? `Firebase could not restore your sign-in session (${code}). Reload My Desk to try again.`
        : "Firebase could not restore your sign-in session. Reload My Desk to try again.");
      setLoading(false);
    });
    return () => {
      active = false;
      window.clearTimeout(startupTimeout);
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!user || !db) { setAccountProfile(null); return; }
    setAccountProfile((current) => current?.userId === user.uid ? current : null);
    return onSnapshot(doc(db, "users", user.uid), (snapshot) => {
      if (!snapshot.exists()) {
        setAccountProfile(null);
        setUser(null);
        setApprovalUser(user);
        setApprovalStatus("Missing");
        return;
      }
      const data = snapshot.data();
      const accountStatus = user.email?.trim().toLowerCase() === SUPERADMIN_EMAIL ? "Approved" : normalizeAccountStatus(data.accountStatus);
      const profileSelection = accountProfileSelection(data);
      setAccountProfile({ userId: user.uid, office: profileSelection.office || null, division: profileSelection.division || null, unit: profileSelection.unit || null, assignment: profileSelection.assignment || null, name: typeof data.name === "string" ? data.name : user.displayName ?? "", designation: accountDesignation(data.designation), accountRole: normalizeAccountRole(data.accountRole, user.email), accountStatus });
      if (accountStatus !== "Approved") {
        setUser(null);
        setApprovalUser(user);
        setApprovalStatus(accountStatus);
      }
    }, () => {
      setAccountProfile({ userId: user.uid, office: null, division: null, unit: null, assignment: null, name: user.displayName ?? "", designation: "", accountRole: accountRoleForEmail(user.email), accountStatus: "Approved" });
    });
  }, [user]);
  useEffect(() => {
    if (!approvalUser || !db) return;
    return onSnapshot(doc(db, "users", approvalUser.uid), (snapshot) => {
      if (!snapshot.exists()) { setApprovalStatus("Missing"); return; }
      const isBootstrapSuperAdmin = approvalUser.email?.trim().toLowerCase() === SUPERADMIN_EMAIL;
      const status = isBootstrapSuperAdmin ? "Approved" : normalizeAccountStatus(snapshot.data().accountStatus);
      if (status === "Approved") {
        setError("");
        setApprovalError("");
        setApprovalStatus(null);
        setApprovalUser(null);
        setUser(approvalUser);
        setSection("whereabouts-calendar");
        setView("list");
      } else {
        setApprovalStatus(status);
      }
    }, () => setApprovalError("Could not refresh your approval status. Sign out and sign in again to retry."));
  }, [approvalUser]);
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const closeOnEscape = (event: WindowEventMap["keydown"]) => { if (event.key === "Escape") setMobileMenuOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileMenuOpen]);
  useEffect(() => { if (singleSlipPreview) return; setPreview((currentPreview) => { if (!currentPreview) return currentPreview; return permits.find((permit) => permit.id === currentPreview.id) ?? currentPreview; }); }, [permits, singleSlipPreview]);
  useEffect(() => {
    if (!user || !db) { setPermits([]); return; }
    let hasInitialSnapshot = false;
    let previousDecisions = new Map<string, string>();
    const permitSnapshots = new Map<string, Map<string, Permit>>([
      ["owners", new Map()],
      ["recipients", new Map()],
      ["personnel", new Map()],
    ]);
    const publishPermits = () => {
      const byId = new Map<string, Permit>();
      ["personnel", "recipients", "owners"].forEach((key) => permitSnapshots.get(key)?.forEach((permit, id) => byId.set(id, permit)));
      const nextPermits = [...byId.values()].sort((left, right) => timestampMillis(right.createdAt) - timestampMillis(left.createdAt));
      setPermits(nextPermits);
    };
    const mapSnapshot = (snapshot: QuerySnapshot) => snapshot.docs.map((item) => {
      const data = item.data() as Record<string, unknown>;
      const names = Array.isArray(data.names) ? data.names as string[] : typeof data.name === "string" ? [data.name] : [];
      return { id: item.id, ...data, names } as Permit;
    });
    const reportPermitLoadError = (error: unknown) => {
      const code = (error as { code?: string }).code;
      setError(code ? `Could not load permits (${code}).` : "Could not load permits. Refresh and try again.");
    };
    const ownerUnsubscribe = onSnapshot(query(collection(db, "permits"), where("ownerId", "==", user.uid), orderBy("createdAt", "desc")), { includeMetadataChanges: true }, (snapshot) => {
      const currentDecisions = new Map<string, string>();
      let hasNewDecision = false;
      const shouldCheckForNewDecisions = hasInitialSnapshot && !snapshot.metadata.fromCache;
      const ownerPermits = mapSnapshot(snapshot);
      const ownerDocsById = new Map(snapshot.docs.map((item) => [item.id, item] as const));
      ownerPermits.forEach((permit) => {
        const item = ownerDocsById.get(permit.id);
        if (!item) return;
        permit.names.forEach((_, index) => {
          const decision = permit.personStatuses?.[permitDecisionKey(permit, index)];
          if (decision?.status !== "Approved" && decision?.status !== "Disapproved") return;
          const key = `${permit.id}:${permitDecisionKey(permit, index)}`;
          const value = `${decision.status}:${timestampMillis(decision.decidedAt)}`;
          currentDecisions.set(key, value);
          if (shouldCheckForNewDecisions && !item.metadata.hasPendingWrites && previousDecisions.get(key) !== value) {
            hasNewDecision = true;
          }
        });
      });
      if (hasNewDecision) playNotificationTone();
      if (!snapshot.metadata.fromCache) {
        previousDecisions = currentDecisions;
        hasInitialSnapshot = true;
      }
      permitSnapshots.set("owners", new Map(ownerPermits.map((permit) => [permit.id, permit] as const)));
      publishPermits();
    }, reportPermitLoadError);
    const updateSharedPermits = (key: string, snapshot: QuerySnapshot) => {
      const sharedPermits = mapSnapshot(snapshot);
      permitSnapshots.set(key, new Map(sharedPermits.map((permit) => [permit.id, permit] as const)));
      publishPermits();
    };
    const recipientUnsubscribe = onSnapshot(query(collection(db, "permits"), where("recipientIds", "array-contains", user.uid)), (snapshot) => updateSharedPermits("recipients", snapshot), reportPermitLoadError);
    const personnelUnsubscribe = onSnapshot(query(collection(db, "permits"), where("personIds", "array-contains", user.uid)), (snapshot) => updateSharedPermits("personnel", snapshot), reportPermitLoadError);
    return () => { ownerUnsubscribe(); recipientUnsubscribe(); personnelUnsubscribe(); };
  }, [user, playNotificationTone]);
  useEffect(() => {
    if (!user || !db) { setApprovedPermitNumbers({}); return; }
    return onSnapshot(collection(db, "approvedPermitCalendar"), (snapshot) => {
      const approvedNumbers = snapshot.docs
        .map((item) => item.data() as { status?: string; permitNo?: string; approvedPermitNo?: string })
        .filter((permit) => permit.status === "Approved" && (typeof permit.permitNo === "string" || typeof permit.approvedPermitNo === "string"))
        .map((permit) => ({ permitNo: typeof permit.permitNo === "string" ? permit.permitNo : "", approvedPermitNo: permit.approvedPermitNo }));
      setApprovedPermitNumbers(assignApprovedPermitNumbers(approvedNumbers));
    }, () => setApprovedPermitNumbers({}));
  }, [user]);
  useEffect(() => {
    const accountRole = user && accountProfile?.userId === user.uid ? accountProfile.accountRole : undefined;
    if (!user || !db || normalizeAccountRole(accountRole, user.email) !== "admin") {
      setPermitNotificationAccounts(null);
      return;
    }
    setPermitNotificationAccounts(null);
    return onSnapshot(collection(db, "users"), (snapshot) => {
      const accounts: Record<string, PermitNotificationAccount> = {};
      snapshot.docs.forEach((item) => {
        const data = item.data();
        const profile = accountProfileSelection(data);
        accounts[item.id] = {
          office: profile.office,
          division: profile.division,
          unit: profile.unit,
          assignment: profile.assignment,
          designation: accountDesignation(data.designation),
          accountRole: normalizeAccountRole(data.accountRole, typeof data.email === "string" ? data.email : null),
        };
      });
      setPermitNotificationAccounts(accounts);
    }, () => {
      setPermitNotificationAccounts({});
      setError("Could not load Permit Slip reviewer accounts. Refresh and try again.");
    });
  }, [user, accountProfile?.userId, accountProfile?.accountRole]);
  useEffect(() => {
    const accountRole = user && accountProfile?.userId === user.uid ? accountProfile.accountRole : undefined;
    const reviewer: PermitNotificationAccount | null = user && accountProfile?.userId === user.uid ? {
      office: accountProfile.office ?? "",
      division: accountProfile.division ?? "",
      unit: accountProfile.unit ?? "",
      assignment: accountProfile.assignment ?? "",
      designation: accountProfile.designation,
      accountRole: normalizeAccountRole(accountRole, user.email),
    } : null;
    if (!user || !db || !reviewer || !isPermitAdmin(user.email, accountRole) || !permitNotificationAccounts) {
      setPendingPermitNotifications([]);
      return;
    }
    const firestore = db;
    let hasInitialSnapshot = false;
    let previousPendingKeys = new Set<string>();
    return onSnapshot(collection(firestore, "permits"), { includeMetadataChanges: true }, (snapshot) => {
      const pendingWriteKeys = new Set<string>();
      const pending = snapshot.docs.flatMap((item) => {
        const data = item.data() as Record<string, unknown>;
        const ownerId = typeof data.ownerId === "string" ? data.ownerId : "";
        const ownerAccount = permitNotificationAccounts[ownerId];
        if (!ownerAccount) return [];
        const ownerOffice = typeof data.ownerOffice === "string" ? data.ownerOffice : ownerAccount.office;
        const ownerDivision = typeof data.ownerDivision === "string" ? data.ownerDivision : "";
        const ownerUnit = typeof data.ownerUnit === "string" ? data.ownerUnit : "";
        const ownerAssignment = typeof data.ownerAssignment === "string" ? data.ownerAssignment : ownerAccount.assignment;
        const owner: PermitNotificationAccount = {
          ...ownerAccount,
          ...accountProfileSelection(ownerDivision && ownerUnit
            ? { office: ownerOffice, division: ownerDivision, unit: ownerUnit, profileFieldsVersion: 4 }
            : { office: ownerOffice, assignment: ownerAssignment, profileFieldsVersion: 3 }),
          designation: typeof data.ownerDesignation === "string" ? accountDesignation(data.ownerDesignation) : ownerAccount.designation,
        };
        if (!permitNotificationAccountMatches(owner, reviewer)) return [];
        const names = Array.isArray(data.names) ? data.names as string[] : typeof data.name === "string" ? [data.name] : [];
        const permit = { ...data, id: item.id, names } as Permit;
        return names.flatMap((name, index) => {
          if (normalizeWorkflowStatus(permit.personStatuses?.[permitDecisionKey(permit, index)]?.status) !== "Pending") return [];
          const submittedAt = timestampMillis(permit.createdAt);
          if (submittedAt && Date.now() - submittedAt >= permitNotificationVisibilityMs) return [];
          const notification = { permitId: item.id, statusKey: permitDecisionKey(permit, index), permitNo: permitPersonNumber(permit, index), name, date: permit.date, purpose: permit.purpose, submittedAt };
          if (item.metadata.hasPendingWrites) pendingWriteKeys.add(`${notification.permitId}:${notification.statusKey}`);
          return [notification];
        });
      }).sort((left, right) => right.submittedAt - left.submittedAt || right.permitNo.localeCompare(left.permitNo, "en", { numeric: true }));
      if (hasInitialSnapshot && !snapshot.metadata.fromCache && pending.some((notification) => {
        const key = `${notification.permitId}:${notification.statusKey}`;
        return !previousPendingKeys.has(key) && !pendingWriteKeys.has(key);
      })) playNotificationTone();
      if (!snapshot.metadata.fromCache) {
        previousPendingKeys = new Set(pending.map((notification) => `${notification.permitId}:${notification.statusKey}`));
        hasInitialSnapshot = true;
      }
      setPendingPermitNotifications(pending);
    }, () => setError("Could not load Permit Slip notifications. Refresh and try again."));
  }, [user, accountProfile, permitNotificationAccounts, playNotificationTone]);
  useEffect(() => {
    const accountRole = user && accountProfile?.userId === user.uid ? accountProfile.accountRole : undefined;
    if (!user || !db || !isPermitAdmin(user.email, accountRole)) { setPendingAccountApprovals([]); return; }
    let hasInitialSnapshot = false;
    let previousPendingUserIds = new Set<string>();
    return onSnapshot(query(collection(db, "users"), where("emailVerified", "==", true)), { includeMetadataChanges: true }, (snapshot) => {
      const pendingWriteUserIds = new Set<string>();
      const pending = snapshot.docs.flatMap((item) => {
        const data = item.data();
        if (normalizeAccountStatus(data.accountStatus) !== "Pending" || data.registrationStage !== "complete") return [];
        if (item.metadata.hasPendingWrites) pendingWriteUserIds.add(item.id);
        const profile = accountProfileSelection(data);
        return [{
          userId: item.id,
          name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : "New account",
          office: profile.office,
          division: profile.division,
          unit: profile.unit,
        } satisfies PendingAccountApprovalNotification];
      }).sort((first, second) => first.name.localeCompare(second.name, "en", { sensitivity: "base" }));
      if (hasInitialSnapshot && !snapshot.metadata.fromCache && pending.some((notification) => !previousPendingUserIds.has(notification.userId) && !pendingWriteUserIds.has(notification.userId))) {
        playNotificationTone();
      }
      if (!snapshot.metadata.fromCache) {
        previousPendingUserIds = new Set(pending.map((notification) => notification.userId));
        hasInitialSnapshot = true;
      }
      setPendingAccountApprovals(pending);
    }, () => setError("Could not load account approval notifications. Refresh and try again."));
  }, [user, accountProfile, playNotificationTone]);
  useEffect(() => {
    if (!user || !db) { setCalendarOfActivitiesNotifications([]); return; }
    const notificationState = { initialized: false, createdAtById: new Map<string, string>() };
    return onSnapshot(query(collection(db, calendarOfActivitiesNotificationsCollection), where("recipientId", "==", user.uid)), { includeMetadataChanges: true }, (snapshot) => {
      let hasNewNotification = false;
      if (!notificationState.initialized) {
        notificationState.createdAtById.clear();
        snapshot.docs.forEach((item) => notificationState.createdAtById.set(item.id, timestampIdentity(item.data().createdAt)));
        if (!snapshot.metadata.fromCache) notificationState.initialized = true;
      } else if (!snapshot.metadata.fromCache) {
        snapshot.docChanges().forEach((change) => {
          if (change.type === "removed") {
            notificationState.createdAtById.delete(change.doc.id);
            return;
          }
          const data = change.doc.data();
          const createdAt = timestampIdentity(data.createdAt);
          const previousCreatedAt = notificationState.createdAtById.get(change.doc.id);
          if (!change.doc.metadata.hasPendingWrites && (change.type === "added" || (change.type === "modified" && data.read === false && previousCreatedAt !== undefined && previousCreatedAt !== createdAt))) {
            hasNewNotification = true;
          }
          notificationState.createdAtById.set(change.doc.id, createdAt);
        });
      }
      if (hasNewNotification) playNotificationTone();
      const notifications = snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as CalendarOfActivitiesNotification));
      notifications.sort((left, right) => timestampMillis(right.createdAt) - timestampMillis(left.createdAt));
      setCalendarOfActivitiesNotifications(notifications);
    }, () => setError("Could not load Calendar of Activities notifications. Refresh and try again."));
  }, [user, playNotificationTone]);
  useEffect(() => {
    if (!user || !db) { setDocumentNotifications([]); return; }
    const notificationState: NotificationSnapshotState = { initialized: false, ids: new Set() };
    return onSnapshot(query(collection(db, "documentNotifications"), where("recipientId", "==", user.uid)), { includeMetadataChanges: true }, (snapshot) => {
      if (hasNewNotificationDocuments(snapshot, notificationState)) playNotificationTone();
      const notifications = snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as DocumentNotification));
      notifications.sort((left, right) => timestampMillis(right.createdAt) - timestampMillis(left.createdAt));
      setDocumentNotifications(notifications);
    }, () => setError("Could not load assigned document notifications. Refresh and try again."));
  }, [user, playNotificationTone]);
  useEffect(() => {
    if (!user || !db) { setDocumentReminders([]); return; }
    const reminderState: NotificationSnapshotState = { initialized: false, ids: new Set() };
    return onSnapshot(query(collection(db, documentRemindersCollection), where("recipientId", "==", user.uid)), { includeMetadataChanges: true }, (snapshot) => {
      if (hasNewNotificationDocuments(snapshot, reminderState)) playNotificationTone();
      const reminders = snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as DocumentReminder));
      reminders.sort((left, right) => timestampMillis(right.createdAt) - timestampMillis(left.createdAt));
      setDocumentReminders(reminders);
    }, () => setError("Could not load document status reminders. Refresh and try again."));
  }, [user, playNotificationTone]);
  useEffect(() => {
    const accountRole = user && accountProfile?.userId === user.uid ? accountProfile.accountRole : undefined;
    if (!user || !db || !isPermitAdmin(user.email, accountRole)) { setCalendarOfActivitiesApprovalNotifications([]); return; }
    const notificationState: NotificationSnapshotState = { initialized: false, ids: new Set() };
    return onSnapshot(collection(db, calendarOfActivitiesApprovalNotificationsCollection), { includeMetadataChanges: true }, (snapshot) => {
      if (hasNewNotificationDocuments(snapshot, notificationState)) playNotificationTone();
      const notifications = snapshot.docs.map((item) => {
        const data = item.data();
        return { id: item.id, ...data, readBy: Array.isArray(data.readBy) ? data.readBy.filter((id): id is string => typeof id === "string") : [] } as CalendarOfActivitiesApprovalNotification;
      });
      notifications.sort((left, right) => timestampMillis(right.createdAt) - timestampMillis(left.createdAt));
      setCalendarOfActivitiesApprovalNotifications(notifications);
    }, () => setError("Could not load Calendar of Activities approval notifications. Refresh and try again."));
  }, [user, accountProfile, playNotificationTone]);
  useEffect(() => {
    if (!user || !db) return;
    const firestore = db;
    let cancelled = false;
    loadUnitSharedRecords<SpecialOrder>(firestore, "specialOrders", user.uid, accountProfile?.userId === user.uid ? accountProfile.assignment : null).then(async (orders) => {
      orders.sort((left, right) => {
        const leftTime = (left.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
        const rightTime = (right.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
        return rightTime - leftTime;
      });
      const ownerIds = [...new Set(orders.map((order) => order.ownerId).filter(Boolean))];
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
      setSpecialOrderPreparedByNames(Object.fromEntries(profiles));
      setSpecialOrders(orders);
    }).catch((error) => {
      const code = (error as { code?: string }).code;
      if (!cancelled) setError(code ? `Could not load special orders (${code}).` : "Could not load special orders. Refresh and try again.");
    });
    return () => { cancelled = true; };
  }, [user, accountProfile]);

  async function deletePermit(permit: Permit) {
    if (!db || !user) return;
    if (hasFinalPermitStatus(permit)) {
      setError("Approved or Disapproved Permit Slips cannot be deleted.");
      setPendingPermitDelete(null);
      return;
    }
    const ownerId = user.uid;
    setDeletingPermitId(permit.id);
    setError("");
    try {
      const firestore = db;
      const calendarEntries = await getDocs(query(collection(firestore, "approvedPermitCalendar"), where("permitId", "==", permit.id)));
      const notificationReferences = await getDocumentNotificationReferences(firestore, ownerId, permit.id);
      const batch = writeBatch(firestore);
      calendarEntries.docs.forEach((entry) => batch.delete(entry.ref));
      notificationReferences.forEach((reference) => batch.delete(reference));
      batch.delete(doc(firestore, "permits", permit.id));
      await batch.commit();
      setPreview((current) => current?.id === permit.id ? null : current);
      setPendingPermitDelete(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete the Permit Slip (${code}).` : "Could not delete the Permit Slip.");
      setPendingPermitDelete(null);
    } finally {
      setDeletingPermitId(null);
    }
  }

  async function deleteSpecialOrder(order: SpecialOrder) {
    if (!db || !user || order.ownerId !== user.uid) return;
    const ownerId = user.uid;
    setDeletingSpecialOrderId(order.id);
    setError("");
    try {
      const firestore = db;
      const notificationReferences = await getDocumentNotificationReferences(firestore, ownerId, order.id);
      const batch = writeBatch(firestore);
      notificationReferences.forEach((reference) => batch.delete(reference));
      batch.delete(doc(firestore, "specialOrders", order.id));
      await batch.commit();
      setSpecialOrders((current) => current.filter((item) => item.id !== order.id));
      setSpecialOrderPreview((current) => current?.id === order.id ? null : current);
      setPendingSpecialOrderDelete(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete the Special Order (${code}).` : "Could not delete the Special Order.");
      setPendingSpecialOrderDelete(null);
    } finally {
      setDeletingSpecialOrderId(null);
    }
  }

  async function copySpecialOrder(order: SpecialOrder) {
    if (!db || !user) return;
    const ownerUnit = accountProfile && accountProfile.userId === user.uid ? accountProfile.assignment : null;
    if (!ownerUnit) { setError("Your Unit / Program / Project is still loading. Try copying again in a moment."); return; }
    setCopyingSpecialOrderId(order.id);
    setError("");
    try {
      const firestore = db;
      const copyRef = doc(collection(firestore, "specialOrders"));
      const participantUserIds = order.participantUserIds ? [...order.participantUserIds] : order.participantIds ? [...order.participantIds] : [];
      const participantIds = [...new Set((order.participantIds ?? participantUserIds).filter(Boolean))];
      const recipientIds = [...new Set((order.recipientIds ?? participantIds.filter((id) => id !== user.uid)).filter((id) => Boolean(id) && id !== user.uid))];
      const record = {
        subject: order.subject,
        activityTitle: order.activityTitle,
        organizer: order.organizer,
        dateFrom: order.dateFrom,
        dateTo: order.dateTo || order.dateFrom,
        ...(order.timeFrom !== undefined ? { timeFrom: order.timeFrom } : {}),
        ...(order.timeTo !== undefined ? { timeTo: order.timeTo } : {}),
        venue: order.venue,
        participants: [...order.participants],
        ...(order.participantPositions ? { participantPositions: [...order.participantPositions] } : {}),
        ...(order.participantUnits ? { participantUnits: [...order.participantUnits] } : {}),
        ...(order.participantOffices ? { participantOffices: [...order.participantOffices] } : {}),
        participantUserIds,
        participantIds,
        recipientIds,
        ...(order.signatoryName !== undefined ? { signatoryName: order.signatoryName } : {}),
        ...(order.signatoryDesignation !== undefined ? { signatoryDesignation: order.signatoryDesignation } : {}),
        ownerId: user.uid,
        ownerUnit,
        createdAt: serverTimestamp(),
      };
      const batch = writeBatch(firestore);
      batch.set(copyRef, record);
      recipientIds.forEach((recipientId) => {
        const notification = makeDocumentNotification(firestore, { recipientId, ownerId: user.uid, documentId: copyRef.id, documentType: "Special Order", activityTitle: record.activityTitle, dateFrom: record.dateFrom, dateTo: record.dateTo, venue: record.venue });
        batch.set(notification.reference, notification.data);
      });
      await batch.commit();
      setSpecialOrders((current) => [{ id: copyRef.id, ...record }, ...current]);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not copy the Special Order (${code}).` : "Could not copy the Special Order.");
    } finally {
      setCopyingSpecialOrderId(null);
    }
  }

  async function markCalendarOfActivitiesNotificationRead(notification: CalendarOfActivitiesNotification) {
    if (!db) return;
    try {
      await updateDoc(doc(db, calendarOfActivitiesNotificationsCollection, notification.id), { read: true, readAt: serverTimestamp() });
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not mark the activity notification as read (${code}).` : "Could not mark the activity notification as read.");
    }
  }

  async function markDocumentNotificationRead(notification: DocumentNotification) {
    if (!db || notification.read) return;
    try {
      await updateDoc(doc(db, "documentNotifications", notification.id), { read: true, readAt: serverTimestamp() });
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not mark the ${notification.documentType} notification as read (${code}).` : `Could not mark the ${notification.documentType} notification as read.`);
    }
  }

  async function markDocumentReminderRead(notification: DocumentReminder) {
    if (!db || notification.read) return;
    try {
      await updateDoc(doc(db, documentRemindersCollection, notification.id), { read: true, readAt: serverTimestamp() });
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not mark the status reminder as read (${code}).` : "Could not mark the status reminder as read.");
    }
  }

  async function markCalendarOfActivitiesApprovalNotificationRead(notification: CalendarOfActivitiesApprovalNotification) {
    if (!db || !user) return;
    try {
      await updateDoc(doc(db, calendarOfActivitiesApprovalNotificationsCollection, notification.id), { readBy: arrayUnion(user.uid) });
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not mark the approval notification as read (${code}).` : "Could not mark the approval notification as read.");
    }
  }

  const clearNotificationFocus = useCallback(() => setNotificationFocus(null), []);

  function openDocumentNotification(notification: DocumentNotification) {
    closeMobileNavigation();
    setView("list");
    setError("");
    setNotificationFocus(notification.documentType === "Permit Slip" ? null : {
      kind: "document",
      id: notification.documentId,
      documentType: notification.documentType,
      certificateCollection: notification.certificateCollection,
    });
    switch (notification.documentType) {
      case "Special Order": setSection("special-orders"); break;
      case "Notice to Attend": setSection("nta"); break;
      case "Permit Slip": setSection("permits"); break;
      case "Travel Order": setSection("travel-orders"); break;
      case "Leave Application": setSection("leave-application"); break;
      case "Travel Expense Voucher": setSection("my-tevs"); break;
      case "Certificate Approval": setSection("certificate-approval"); break;
      case "Certificate Decision":
        setSection(notification.certificateCollection === "certificatesOfAppearance" ? "certificate-of-appearance"
          : notification.certificateCollection === "completionCertificates" ? "completion"
          : notification.certificateCollection === "appreciationCertificates" ? "appreciation" : "participation");
        break;
    }
  }

  function openDocumentReminder(notification: DocumentReminder) {
    closeMobileNavigation();
    setView("list");
    setError("");
    setNotificationFocus(notification.kind === "permit-slip-expiry" ? null : {
      kind: "reminder",
      id: notification.recordId,
      reminderKind: notification.kind,
      month: notification.month,
      cycle: notification.cycle,
    });
    setSection(notification.kind === "travel-order-status" ? "travel-orders"
      : notification.kind === "leave-application-status" ? "leave-application"
      : notification.kind === "accomplishment-report" ? "myar" : "permits");
  }

  function openCalendarOfActivitiesNotification(notification: CalendarOfActivitiesNotification) {
    closeMobileNavigation();
    setView("list");
    setError("");
    setNotificationFocus({ kind: "calendar", id: notification.calendarId, mode: "prepared" });
    setSection("calendar-of-activities");
  }

  function openCalendarOfActivitiesApprovalNotification(notification: CalendarOfActivitiesApprovalNotification) {
    closeMobileNavigation();
    setView("list");
    setError("");
    setNotificationFocus({ kind: "calendar", id: notification.calendarId, mode: "approved-records" });
    setSection("calendar-of-activities-records");
  }

  useEffect(() => {
    if (notificationFocus?.kind !== "document" || notificationFocus.documentType !== "Special Order") return;
    const order = specialOrders.find((item) => item.id === notificationFocus.id);
    if (!order) return;
    setSpecialOrderPreview(order);
    clearNotificationFocus();
  }, [notificationFocus, specialOrders, clearNotificationFocus]);

  function closeMobileNavigation() {
    setMobileMenuOpen(false);
    setMobileCertificateOpen(false);
    setMobileAdminPanelOpen(false);
    setMobileAmiaDocumentOpen(false);
    setMobileMyDocsOpen(false);
  }

  const isSuperAdmin = normalizeAccountRole(
    user && accountProfile?.userId === user.uid ? accountProfile.accountRole : undefined,
    user?.email,
  ) === "superadmin";

  useEffect(() => {
    if (isSuperAdmin && section !== "user-master-list" && section !== "document-notifications" && section !== "pending-permit-slips") {
      setSection("user-master-list");
      setView("list");
    }
  }, [isSuperAdmin, section]);

  if (loading) return <div className="loading-screen" role="status" aria-label="Loading My Desk"><span>Loading</span><img className="loading-logo" src={publicAsset("/my%20desk%20logo.png")} alt="" draggable={false} onDragStart={(event) => event.preventDefault()} onContextMenu={(event) => event.preventDefault()} /><span aria-hidden="true">...</span></div>;
  if (!isFirebaseConfigured) return <div className="setup-screen"><div className="setup-card"><img className="brand-mark brand-logo" src="/my%20desk%20logo.png" alt="My Desk logo" draggable={false} onDragStart={(event) => event.preventDefault()} onContextMenu={(event) => event.preventDefault()} /><p className="eyebrow">One setup step</p><h1>Connect your Firebase project</h1><p className="muted">Copy <strong>.env.example</strong> to <strong>.env.local</strong>, add your Firebase web app credentials, then restart the dev server.</p><code>NEXT_PUBLIC_FIREBASE_PROJECT_ID=...</code></div></div>;
  if (startupError) return <div className="setup-screen"><section className="setup-card"><p className="eyebrow">Connection issue</p><h1>My Desk could not start</h1><p className="muted" role="alert">{startupError}</p><button className="primary-button" type="button" onClick={() => window.location.reload()}>Reload My Desk</button></section></div>;
  if (!user) return profileSetupUser
    ? <RegistrationDetails user={profileSetupUser} onSubmitted={(submittedUser) => { setProfileSetupUser(null); setApprovalUser(submittedUser); setApprovalStatus(submittedUser.email?.trim().toLowerCase() === SUPERADMIN_EMAIL ? "Approved" : "Pending"); setApprovalError(""); }} />
    : approvalUser ? <div className="setup-screen"><section className="setup-card account-approval-card"><p className="eyebrow">Account approval</p><h1>{approvalStatus === "Disapproved" ? "Account disapproved" : approvalStatus === "Missing" ? "Account profile unavailable" : "Awaiting approval"}</h1><p>{approvalStatus === "Disapproved" ? "Your account was disapproved. Contact the Super Admin if you need help." : approvalStatus === "Missing" ? "Your account profile could not be found. Contact the Super Admin for assistance." : "Your email is verified. Your account will be available after the IT Administrator approves it."}</p>{approvalError && <p className="auth-message auth-message-error" role="alert">{approvalError}</p>}<button type="button" className="primary-button" onClick={() => { if (auth) void signOut(auth); }}>Sign Out</button></section></div> : <Login onError={setError} />;

  const fullName = user.displayName?.trim().replace(/\s+/g, " ") || "";
  const firstName = fullName.split(" ")[0] || "";
  const activeAccountProfile = accountProfile?.userId === user.uid ? accountProfile : null;
  const accountRole = normalizeAccountRole(activeAccountProfile?.accountRole, user.email);
  const certificateOwnerScope = accountProfileSelection({ ...(activeAccountProfile ?? {}), profileFieldsVersion: 4 });
  const isAdmin = isPermitAdmin(user.email, accountRole);
  const canAccessCertificateApproval = isSuperAdmin || (accountRole === "admin" && (activeAccountProfile?.designation === "Chief" || isFieldOperationsAppearanceApprover(activeAccountProfile ?? {})));
  const accountUnit = activeAccountProfile?.unit || activeAccountProfile?.assignment || null;
  const canAccessCleaningTask = canAccessCleaningTaskNavigation(accountRole, accountUnit ?? "", activeAccountProfile?.designation ?? "");
  const canViewCleaningTask = canViewCleaningTaskLanding(accountRole, accountUnit ?? "");
  const canAccessAmiaDocumentTracking = accountRole === "regular"
    ? activeAccountProfile?.office === "Division"
      && activeAccountProfile?.division === "Field Operations Division"
      && activeAccountProfile?.unit === "AMIA"
    : accountRole === "admin"
      && (activeAccountProfile?.designation === "Chief" || activeAccountProfile?.designation === "AGRISTAT/DRRM/AMIA Project Leader")
      && activeAccountProfile?.office === "Division"
      && activeAccountProfile?.division === "Field Operations Division"
      && activeAccountProfile?.unit === "Field Operations Division";
  const userPermitNotifications = permits.flatMap((permit) => permit.names.flatMap((name, personIndex) => {
    const decision = permit.personStatuses?.[permitDecisionKey(permit, personIndex)];
    if (decision?.status !== "Approved" && decision?.status !== "Disapproved") return [];
    return [{ permit, personIndex, permitNo: permitPersonNumber(permit, personIndex), name, date: permit.date, status: decision.status, decidedAt: decision.decidedAt }];
  })).sort((left, right) => timestampMillis(right.decidedAt) - timestampMillis(left.decidedAt));
  return <div className="app-shell"><header className="topbar"><button type="button" className="brand brand-home" aria-label={isSuperAdmin ? "User Approval home" : "My Desk home - Whereabouts Calendar"} onClick={() => { closeMobileNavigation(); setSection(isSuperAdmin ? "user-master-list" : "whereabouts-calendar"); setView("list"); }}><img className="brand-mark brand-logo" src="/my%20desk%20logo.png" alt="" draggable={false} onDragStart={(event) => event.preventDefault()} onContextMenu={(event) => event.preventDefault()} /><span>My Desk</span></button><nav className="main-nav" aria-label="Main navigation">{isSuperAdmin ? <div className="nav-dropdown admin-panel-nav-dropdown" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAdminPanelMenuOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") setAdminPanelMenuOpen(false); }}><button type="button" className={section === "user-master-list" || section === "document-notifications" || section === "pending-permit-slips" ? "nav-button active" : "nav-button"} aria-haspopup="true" aria-expanded={adminPanelMenuOpen} aria-controls="admin-panel-menu" onClick={() => setAdminPanelMenuOpen((open) => !open)}>Admin Panel <span className="nav-dropdown-arrow" aria-hidden="true">&#9662;</span></button>{adminPanelMenuOpen && <div className="nav-dropdown-menu admin-panel-nav-menu" id="admin-panel-menu"><button type="button" className={section === "user-master-list" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("user-master-list"); setView("list"); setAdminPanelMenuOpen(false); }}>Users&apos; Approval</button><button type="button" className={section === "document-notifications" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("document-notifications"); setView("list"); setAdminPanelMenuOpen(false); }}>Document Notifications</button><button type="button" className={section === "pending-permit-slips" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("pending-permit-slips"); setView("list"); setAdminPanelMenuOpen(false); }}>Pending Permit Slips</button></div>}</div> : <>
      <div className="nav-dropdown mydocs-nav-dropdown" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMyDocsMenuOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") setMyDocsMenuOpen(false); }}><button type="button" className={section === "special-orders" || section === "nta" || section === "permits" || section === "travel-orders" || section === "calendar-of-activities" || section === "myar" || section === "my-notes" || section === "my-tevs" || section === "leave-application" ? "nav-button active" : "nav-button"} aria-haspopup="true" aria-expanded={myDocsMenuOpen} aria-controls="mydocs-menu" onClick={() => setMyDocsMenuOpen((open) => !open)}>myDocs <span className="nav-dropdown-arrow" aria-hidden="true">&#9662;</span></button>{myDocsMenuOpen && <div className="nav-dropdown-menu mydocs-nav-menu" id="mydocs-menu">
        <button type="button" className={section === "special-orders" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("special-orders"); setView("list"); setMyDocsMenuOpen(false); }}>Special Order</button>
        <button type="button" className={section === "nta" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("nta"); setView("list"); setMyDocsMenuOpen(false); }}>Notice To Attend</button>
        <button type="button" className={section === "permits" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("permits"); setView("list"); setMyDocsMenuOpen(false); }}>Permit Slip</button>
        <button type="button" className={section === "travel-orders" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("travel-orders"); setView("list"); setMyDocsMenuOpen(false); }}>Travel Order</button>
        <button type="button" className={section === "calendar-of-activities" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("calendar-of-activities"); setView("list"); setMyDocsMenuOpen(false); }}>Calendar of Activities</button>
        <button type="button" className={section === "myar" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("myar"); setView("list"); setMyDocsMenuOpen(false); }}>myAR</button>
        <button type="button" className={section === "my-notes" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("my-notes"); setView("list"); setMyDocsMenuOpen(false); }}>myNotes</button>
        <button type="button" className={section === "my-tevs" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("my-tevs"); setView("list"); setMyDocsMenuOpen(false); }}>myTEV</button>
        <button type="button" className={section === "leave-application" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("leave-application"); setView("list"); setMyDocsMenuOpen(false); }}>myLeave</button>
      </div>}</div>
      {canAccessAmiaDocumentTracking && <div className="nav-dropdown amia-document-nav-dropdown" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAmiaDocumentMenuOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") setAmiaDocumentMenuOpen(false); }}><button type="button" className="nav-button amia-document-nav-button" aria-haspopup="true" aria-expanded={amiaDocumentMenuOpen} aria-controls="amia-document-menu" onClick={() => setAmiaDocumentMenuOpen((open) => !open)}>AMIA Document Tracking <span className="nav-dropdown-arrow" aria-hidden="true">&#9662;</span></button>{amiaDocumentMenuOpen && <div className="nav-dropdown-menu amia-document-nav-menu" id="amia-document-menu">{amiaDocumentTrackingLinks.map((link) => <a className="nav-dropdown-item" href={link.href} key={link.label} target="_blank" rel="noopener noreferrer">{link.label}</a>)}</div>}</div>}
      <div className="nav-dropdown certificate-nav-dropdown" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setCertificateMenuOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") setCertificateMenuOpen(false); }}><button type="button" className={section === "certificate-of-appearance" || section === "completion" || section === "appreciation" || section === "participation" ? "nav-button certificate-nav-button active" : "nav-button certificate-nav-button"} aria-haspopup="true" aria-expanded={certificateMenuOpen} aria-controls="certificate-menu" onClick={() => setCertificateMenuOpen((open) => !open)}>Certificate <span className="nav-dropdown-arrow" aria-hidden="true">&#9662;</span></button>{certificateMenuOpen && <div className="nav-dropdown-menu certificate-nav-menu" id="certificate-menu"><button type="button" className={section === "certificate-of-appearance" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("certificate-of-appearance"); setView("list"); setCertificateMenuOpen(false); }}>Appearance</button><button type="button" className={section === "completion" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("completion"); setView("list"); setCertificateMenuOpen(false); }}>Completion</button><button type="button" className={section === "appreciation" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("appreciation"); setView("list"); setCertificateMenuOpen(false); }}>Appreciation</button><button type="button" className={section === "participation" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("participation"); setView("list"); setCertificateMenuOpen(false); }}>Participation</button></div>}</div>
      {canAccessCleaningTask && <button type="button" className={section === "cleaning-task" ? "nav-button active" : "nav-button"} onClick={() => { setSection("cleaning-task"); setView("list"); }}>Cleaning Task</button>}<button type="button" className={section === "my-drive" ? "nav-button active" : "nav-button"} onClick={() => { setSection("my-drive"); setView("list"); }}>myDrive</button>
      {isAdmin && <div className="nav-dropdown admin-panel-nav-dropdown" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAdminPanelMenuOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") setAdminPanelMenuOpen(false); }}>
        <button type="button" className={section === "permit-status" || section === "permit-statistics" || section === "calendar-of-activities-records" || section === "certificate-approval" || section === "cleaning-task-assignments" || section === "user-master-list" ? "nav-button active" : "nav-button"} aria-haspopup="true" aria-expanded={adminPanelMenuOpen} aria-controls="admin-panel-menu" onClick={() => setAdminPanelMenuOpen((open) => !open)}>Admin Panel <span className="nav-dropdown-arrow" aria-hidden="true">&#9662;</span></button>
        {adminPanelMenuOpen && <div className="nav-dropdown-menu admin-panel-nav-menu" id="admin-panel-menu">
          <button type="button" className={section === "permit-status" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("permit-status"); setView("list"); setAdminPanelMenuOpen(false); }}>Permit Slip Status</button>
          <button type="button" className={section === "permit-statistics" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("permit-statistics"); setView("list"); setAdminPanelMenuOpen(false); }}>Permit Slip Statistics</button>
          <button type="button" className={section === "calendar-of-activities-records" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("calendar-of-activities-records"); setView("list"); setAdminPanelMenuOpen(false); }}>Calendar of Activities Records</button>
          {canAccessCertificateApproval && <button type="button" className={section === "certificate-approval" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("certificate-approval"); setView("list"); setAdminPanelMenuOpen(false); }}>Certificate Approval</button>}
          {isSuperAdmin && <button type="button" className={section === "cleaning-task-assignments" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("cleaning-task-assignments"); setView("list"); setAdminPanelMenuOpen(false); }}>Cleaning Task Assignment</button>}
          {isSuperAdmin && <button type="button" className={section === "user-master-list" ? "nav-dropdown-item active" : "nav-dropdown-item"} onClick={() => { setSection("user-master-list"); setView("list"); setAdminPanelMenuOpen(false); }}>User Approval</button>}
        </div>}
      </div>}
      </>}</nav><div className="user-menu">{!isSuperAdmin && <MessengerButton user={user} active={section === "messenger"} onClick={() => { closeMobileNavigation(); setSection("messenger"); setView("list"); }} />}<PermitNotificationCenter isAdmin={isAdmin} isSuperAdmin={isSuperAdmin} userId={user.uid} notifications={userPermitNotifications} pendingNotifications={pendingPermitNotifications} pendingAccountApprovals={pendingAccountApprovals} documentNotifications={documentNotifications} documentReminders={documentReminders} calendarOfActivitiesNotifications={calendarOfActivitiesNotifications} calendarOfActivitiesApprovalNotifications={calendarOfActivitiesApprovalNotifications} onReadCalendarOfActivitiesApproval={(notification) => void markCalendarOfActivitiesApprovalNotificationRead(notification)} onOpenCalendarOfActivitiesApproval={openCalendarOfActivitiesApprovalNotification} onReadDocument={(notification) => void markDocumentNotificationRead(notification)} onOpenDocumentNotification={openDocumentNotification} onReadDocumentReminder={(notification) => void markDocumentReminderRead(notification)} onOpenDocumentReminder={openDocumentReminder} onReadCalendarOfActivities={(notification) => void markCalendarOfActivitiesNotificationRead(notification)} onOpenCalendarOfActivities={openCalendarOfActivitiesNotification} onAdminOpen={(notification) => { closeMobileNavigation(); setFocusedPermitNotificationKey(`${notification.permitId}:${notification.statusKey}`); setSection("permit-status"); setView("list"); }} onOpenAccountApprovals={() => { closeMobileNavigation(); setSection("user-master-list"); setView("list"); }} onViewPermit={(notification) => { closeMobileNavigation(); setSingleSlipPreview(true); setPreview(singlePersonPermitPreview(notification.permit, notification.personIndex)); }} /><div className="profile-menu" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setProfileMenuOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") setProfileMenuOpen(false); }}><button type="button" className="user-greeting profile-trigger" aria-haspopup="menu" aria-expanded={profileMenuOpen} onClick={() => setProfileMenuOpen((open) => !open)}>{firstName}<span aria-hidden="true">▾</span></button>{profileMenuOpen && <div className="profile-dropdown" role="menu"><button type="button" role="menuitem" onClick={() => { setChangePassword(""); setConfirmNewPassword(""); void openProfile(); }}>Profile</button></div>}</div><button type="button" className="text-button logout-button" aria-label="Log out" title="Log out" onClick={() => auth && signOut(auth)}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5M21 12H9" /></svg></button></div><button type="button" className="mobile-menu-toggle" aria-label={mobileMenuOpen ? "Close navigation" : "Open navigation"} aria-expanded={mobileMenuOpen} aria-controls="mobile-navigation" onClick={() => setMobileMenuOpen((open) => !open)}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M3 5h18M3 12h18M3 19h18" /></svg></button></header>
{mobileMenuOpen && <><button type="button" className="mobile-nav-scrim" aria-label="Close navigation" onClick={closeMobileNavigation} /><nav className="mobile-navigation" id="mobile-navigation" aria-label="Mobile navigation">
<button type="button" className="mobile-profile-link" onClick={() => { closeMobileNavigation(); setChangePassword(""); setConfirmNewPassword(""); void openProfile(); }}>Profile</button>
<div className="mobile-navigation-links">{isSuperAdmin && <><button type="button" className="mobile-nav-link" aria-expanded={mobileAdminPanelOpen} aria-controls="mobile-admin-panel-menu" onClick={() => setMobileAdminPanelOpen((open) => !open)}><span>Admin Panel</span><span className={mobileAdminPanelOpen ? "mobile-nav-chevron is-open" : "mobile-nav-chevron"} aria-hidden="true" /></button>{mobileAdminPanelOpen && <div className="mobile-nav-submenu" id="mobile-admin-panel-menu"><button type="button" onClick={() => { setSection("user-master-list"); setView("list"); closeMobileNavigation(); }}>Users&apos; Approval</button><button type="button" onClick={() => { setSection("document-notifications"); setView("list"); closeMobileNavigation(); }}>Document Notifications</button><button type="button" onClick={() => { setSection("pending-permit-slips"); setView("list"); closeMobileNavigation(); }}>Pending Permit Slips</button></div>}</>}{!isSuperAdmin && <>
<button type="button" className="mobile-nav-link" aria-expanded={mobileMyDocsOpen} aria-controls="mobile-mydocs-menu" onClick={() => setMobileMyDocsOpen((open) => !open)}><span>myDocs</span><span className={mobileMyDocsOpen ? "mobile-nav-chevron is-open" : "mobile-nav-chevron"} aria-hidden="true" /></button>
{mobileMyDocsOpen && <div className="mobile-nav-submenu" id="mobile-mydocs-menu"><button type="button" onClick={() => { setSection("special-orders"); setView("list"); closeMobileNavigation(); }}>Special Order</button><button type="button" onClick={() => { setSection("nta"); setView("list"); closeMobileNavigation(); }}>Notice To Attend</button><button type="button" onClick={() => { setSection("permits"); setView("list"); closeMobileNavigation(); }}>Permit Slip</button><button type="button" onClick={() => { setSection("travel-orders"); setView("list"); closeMobileNavigation(); }}>Travel Order</button><button type="button" onClick={() => { setSection("calendar-of-activities"); setView("list"); closeMobileNavigation(); }}>Calendar of Activities</button><button type="button" onClick={() => { setSection("myar"); setView("list"); closeMobileNavigation(); }}>myAR</button><button type="button" onClick={() => { setSection("my-notes"); setView("list"); closeMobileNavigation(); }}>myNotes</button><button type="button" onClick={() => { setSection("my-tevs"); setView("list"); closeMobileNavigation(); }}>myTEV</button><button type="button" onClick={() => { setSection("leave-application"); setView("list"); closeMobileNavigation(); }}>myLeave</button></div>}
<button type="button" className="mobile-nav-link" aria-expanded={mobileCertificateOpen} aria-controls="mobile-certificate-menu" onClick={() => setMobileCertificateOpen((open) => !open)}><span>Certificate</span><span className={mobileCertificateOpen ? "mobile-nav-chevron is-open" : "mobile-nav-chevron"} aria-hidden="true" /></button>
 {mobileCertificateOpen && <div className="mobile-nav-submenu" id="mobile-certificate-menu"><button type="button" onClick={() => { setSection("certificate-of-appearance"); setView("list"); closeMobileNavigation(); }}>Appearance</button><button type="button" onClick={() => { setSection("completion"); setView("list"); closeMobileNavigation(); }}>Completion</button><button type="button" onClick={() => { setSection("appreciation"); setView("list"); closeMobileNavigation(); }}>Appreciation</button><button type="button" onClick={() => { setSection("participation"); setView("list"); closeMobileNavigation(); }}>Participation</button></div>}
 {canAccessCleaningTask && <button type="button" className={`mobile-nav-link${section === "cleaning-task" ? " active" : ""}`} onClick={() => { setSection("cleaning-task"); setView("list"); closeMobileNavigation(); }}>Cleaning Task</button>}<button type="button" className={`mobile-nav-link${section === "my-drive" ? " active" : ""}`} onClick={() => { setSection("my-drive"); setView("list"); closeMobileNavigation(); }}>myDrive</button>
 {isAdmin && <><button type="button" className="mobile-nav-link" aria-expanded={mobileAdminPanelOpen} aria-controls="mobile-admin-panel-menu" onClick={() => setMobileAdminPanelOpen((open) => !open)}><span>Admin Panel</span><span className={mobileAdminPanelOpen ? "mobile-nav-chevron is-open" : "mobile-nav-chevron"} aria-hidden="true" /></button>{mobileAdminPanelOpen && <div className="mobile-nav-submenu" id="mobile-admin-panel-menu"><button type="button" onClick={() => { setSection("permit-status"); setView("list"); closeMobileNavigation(); }}>Permit Slip Status</button><button type="button" onClick={() => { setSection("permit-statistics"); setView("list"); closeMobileNavigation(); }}>Permit Slip Statistics</button><button type="button" onClick={() => { setSection("calendar-of-activities-records"); setView("list"); closeMobileNavigation(); }}>Calendar of Activities Records</button>{canAccessCertificateApproval && <button type="button" onClick={() => { setSection("certificate-approval"); setView("list"); closeMobileNavigation(); }}>Certificate Approval</button>}{isSuperAdmin && <button type="button" onClick={() => { setSection("cleaning-task-assignments"); setView("list"); closeMobileNavigation(); }}>Cleaning Task Assignment</button>}{isSuperAdmin && <button type="button" onClick={() => { setSection("user-master-list"); setView("list"); closeMobileNavigation(); }}>User Approval</button>}</div>}</>}
{canAccessAmiaDocumentTracking && <><button type="button" className="mobile-nav-link" aria-expanded={mobileAmiaDocumentOpen} aria-controls="mobile-amia-document-menu" onClick={() => setMobileAmiaDocumentOpen((open) => !open)}><span>AMIA Document Tracking</span><span className={mobileAmiaDocumentOpen ? "mobile-nav-chevron is-open" : "mobile-nav-chevron"} aria-hidden="true" /></button>
{mobileAmiaDocumentOpen && <div className="mobile-nav-submenu mobile-amia-document-submenu" id="mobile-amia-document-menu">{amiaDocumentTrackingLinks.map((link) => <a className="mobile-nav-submenu-link" href={link.href} key={link.label} target="_blank" rel="noopener noreferrer" onClick={closeMobileNavigation}>{link.label}</a>)}</div>}</>}
</> }</div><button type="button" className="mobile-sign-out" onClick={() => { closeMobileNavigation(); if (auth) void signOut(auth); }}>Sign Out</button></nav></>}{profileOpen && <div className="profile-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeProfile(); }} onKeyDown={(event) => { if (event.key === "Escape") closeProfile(); }}><section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title"><header className="profile-dialog-header"><div><p className="eyebrow">Account</p><h2 id="profile-title">Profile</h2></div><button type="button" className="ghost-button" onClick={closeProfile}>Close</button></header><form className="profile-form" onSubmit={saveChanges} aria-busy={profileLoading || profileSaving}>
  <ProfilePhotoUpload user={user} photoURL={profilePhotoURL} disabled={profileLoading || profileSaving} onUploaded={setProfilePhotoURL} />
  <label>First Name<input autoComplete="given-name" maxLength={60} value={profileFirstName} onChange={(event) => setProfileFirstName(event.target.value)} required disabled={profileLoading || profileSaving} /></label>
  <label>Middle Name<input autoComplete="additional-name" maxLength={60} value={profileMiddleName} onChange={(event) => setProfileMiddleName(event.target.value)} disabled={profileLoading || profileSaving} /></label>
  <label>Last Name<input autoComplete="family-name" maxLength={60} value={profileLastName} onChange={(event) => setProfileLastName(event.target.value)} required disabled={profileLoading || profileSaving} /></label>
  <label>Gender<select value={profileGender} onChange={(event) => setProfileGender(event.target.value)} required disabled={profileLoading || profileSaving}><option value="" disabled>Select gender</option><option value="Male">Male</option><option value="Female">Female</option></select></label>
  <label>Position{profilePositionIsCustom ? <div className="password-field"><input autoComplete="organization-title" maxLength={120} list="profile-position-options" value={profilePosition} onChange={(event) => { const nextPosition = event.target.value; setProfilePosition(nextPosition); if (accountPositionOptions.some((option) => option === nextPosition)) setProfilePositionIsCustom(false); }} placeholder="Enter your Position" disabled={profileLoading || profileSaving} /><datalist id="profile-position-options">{accountPositionOptions.map((option) => <option key={option} value={option} />)}</datalist><button type="button" className="password-toggle plain-action position-list-toggle" aria-label="Choose a Position from the list" disabled={profileLoading || profileSaving} onClick={() => { setProfilePosition(""); setProfilePositionIsCustom(false); }}>List</button></div> : <select autoComplete="organization-title" value={profilePosition} onChange={(event) => { const nextPosition = event.target.value; if (nextPosition === "__other__") { setProfilePosition(""); setProfilePositionIsCustom(true); } else setProfilePosition(nextPosition); }} disabled={profileLoading || profileSaving}><option value="">Select your Position</option>{accountPositionOptions.map((option) => <option key={option} value={option}>{option}</option>)}<option value="__other__">Others</option></select>}</label>
  <div className="profile-designation-field"><label htmlFor="profile-designation-toggle">Designation</label><DesignationPicker value={profileDesignation} onChange={setProfileDesignation} disabled={profileLoading || profileSaving} /></div>
<label>Office<select value={profileOffice} onChange={(event) => { const nextOffice = event.target.value; setProfileOffice(nextOffice); setProfileDivision(""); setProfileUnit(""); }} required disabled={profileLoading || profileSaving}><option value="" disabled>Select your Office</option>{accountOfficeOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
<label>Division<select value={profileDivision} onChange={(event) => { setProfileDivision(event.target.value); setProfileUnit(""); }} required disabled={profileLoading || profileSaving || !profileOffice}><option value="" disabled>{profileOffice ? "Select your Division" : "Select an Office first"}</option>{divisionsForOffice(profileOffice).map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
<label>Unit / Program / Project<select value={profileUnit} onChange={(event) => setProfileUnit(event.target.value)} required disabled={profileLoading || profileSaving || !profileDivision}><option value="" disabled>{profileDivision ? "Select your Unit / Program / Project" : "Select a Division first"}</option>{unitsForOfficeDivision(profileOffice, profileDivision).map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
  <div className="profile-contact-row">
  <label>Tax Identification No.<input type="text" inputMode="numeric" autoComplete="off" maxLength={11} value={profileTaxIdentificationNo} onChange={(event) => updateTaxIdentificationNo(event, setProfileTaxIdentificationNo)} onKeyDown={(event) => handleTaxIdentificationNoKeyDown(event, setProfileTaxIdentificationNo)} required disabled={profileLoading || profileSaving} /></label>
  <label>Address<input autoComplete="street-address" maxLength={200} value={profileAddress} onChange={(event) => setProfileAddress(event.target.value)} required disabled={profileLoading || profileSaving} /></label>
  <label>Email<input type="email" value={user.email ?? ""} readOnly /></label>
  </div>
  <div className="profile-security-fields">
  <label>Change Password<div className="password-field"><input type={showChangePassword ? "text" : "password"} autoComplete="new-password" value={changePassword} onChange={(event) => setChangePassword(event.target.value)} /><button type="button" className="password-toggle" aria-label={showChangePassword ? "Hide new password" : "Show new password"} onClick={() => setShowChangePassword((show) => !show)}>{showChangePassword ? "Hide" : "Show"}</button></div></label>
  <label>Confirmation Password<div className="password-field"><input type={showConfirmNewPassword ? "text" : "password"} autoComplete="new-password" value={confirmNewPassword} onChange={(event) => setConfirmNewPassword(event.target.value)} /><button type="button" className="password-toggle" aria-label={showConfirmNewPassword ? "Hide confirmation password" : "Show confirmation password"} onClick={() => setShowConfirmNewPassword((show) => !show)}>{showConfirmNewPassword ? "Hide" : "Show"}</button></div></label>
  </div>
  <div className="profile-password-actions"><button type="button" className="ghost-button" disabled={profileSaving || resetEmailBusy} onClick={() => void sendResetLink()}>{resetEmailBusy ? "Sending..." : "Reset Password"}</button><button className="primary-button" disabled={profileLoading || profileSaving || resetEmailBusy}>{profileLoading ? "Loading..." : profileSaving ? "Saving..." : "Save Changes"}</button></div>
  {profileMessage && <p className={`auth-message auth-message-${profileMessage.kind}`} role={profileMessage.kind === "error" ? "alert" : "status"}>{profileMessage.text}</p>}
  </form></section></div>}<main className="dashboard"><div className={`dashboard-header${section === "messenger" ? " hide-on-mobile" : ""}`}><div className="dashboard-header-content"><p className="eyebrow">{philippineDateTime && <>{philippineDateTime.split(" | ")[0]} | <span className="dashboard-time">{philippineDateTime.split(" | ")[1]}</span></>}</p><h1>{biometricsGreeting === "Masaganang Buntag" ? <>Masaganang Buntag{firstName ? <> <span className="dashboard-greeting-name">{firstName}</span>!</> : "!"}</> : <>{biometricsGreeting ?? "Masaganang Agrikultura"}{firstName ? <>, <span className="dashboard-greeting-name">{firstName}!</span></> : "!"}</>}</h1></div><div className="status-pill"><span /> Secure session</div></div>{error && <div className="error-message">{error}</div>}{isSuperAdmin ? (section === "document-notifications" ? <DocumentNotificationAdmin /> : section === "pending-permit-slips" ? <PendingPermitSlipAdmin /> : <UserMasterList user={user} />) : !isAdmin && (section === "permit-status" || section === "permit-statistics" || section === "calendar-of-activities-records" || section === "certificate-approval" || section === "user-master-list") ? <WhereaboutsCalendarModule user={user} accountRole={accountRole} office={activeAccountProfile?.office ?? ""} assignment={accountUnit ?? ""} /> : section === "user-master-list" ? (isSuperAdmin ? <UserMasterList user={user} /> : null) : section === "certificate-approval" ? <CertificateApproval user={user} role={accountRole} office={activeAccountProfile?.office} division={activeAccountProfile?.division} unit={activeAccountProfile?.unit} assignment={activeAccountProfile?.assignment} designation={activeAccountProfile?.designation} accountName={activeAccountProfile?.name} focusRecordId={notificationFocus?.kind === "document" && notificationFocus.documentType === "Certificate Approval" ? notificationFocus.id : undefined} onFocusHandled={clearNotificationFocus} /> : section === "appreciation" ? <AppreciationCertificate user={user} focusRecordId={notificationFocus?.kind === "document" && notificationFocus.documentType === "Certificate Decision" && notificationFocus.certificateCollection === "appreciationCertificates" ? notificationFocus.id : undefined} onFocusHandled={clearNotificationFocus} /> : section === "completion" ? <CompletionCertificate user={user} focusRecordId={notificationFocus?.kind === "document" && notificationFocus.documentType === "Certificate Decision" && notificationFocus.certificateCollection === "completionCertificates" ? notificationFocus.id : undefined} onFocusHandled={clearNotificationFocus} /> : section === "participation" ? <ParticipationCertificate user={user} focusRecordId={notificationFocus?.kind === "document" && notificationFocus.documentType === "Certificate Decision" && notificationFocus.certificateCollection === "participationCertificates" ? notificationFocus.id : undefined} onFocusHandled={clearNotificationFocus} /> : section === "certificate-of-appearance" ? <CertificateOfAppearance user={user} ownerOffice={certificateOwnerScope.office} ownerDivision={certificateOwnerScope.division} ownerUnit={certificateOwnerScope.unit} role={accountRole} focusRecordId={notificationFocus?.kind === "document" && notificationFocus.documentType === "Certificate Decision" && notificationFocus.certificateCollection === "certificatesOfAppearance" ? notificationFocus.id : undefined} onFocusHandled={clearNotificationFocus} /> : section === "leave-application" ? <LeaveApplicationModule user={user} focusRecordId={notificationFocus?.kind === "document" && notificationFocus.documentType === "Leave Application" ? notificationFocus.id : notificationFocus?.kind === "reminder" && notificationFocus.reminderKind === "leave-application-status" ? notificationFocus.id : undefined} onFocusHandled={clearNotificationFocus} /> : section === "myar" ? <AccomplishmentReportModule user={user} focusMonth={notificationFocus?.kind === "reminder" && notificationFocus.reminderKind === "accomplishment-report" ? notificationFocus.month : undefined} focusCycle={notificationFocus?.kind === "reminder" && notificationFocus.reminderKind === "accomplishment-report" ? notificationFocus.cycle : undefined} onFocusHandled={clearNotificationFocus} /> : section === "my-notes" ? <MyNotesModule user={user} /> : section === "my-tevs" ? <MyTevModule user={user} focusRecordId={notificationFocus?.kind === "document" && notificationFocus.documentType === "Travel Expense Voucher" ? notificationFocus.id : undefined} onFocusHandled={clearNotificationFocus} /> : section === "nta" ? <NtaModule user={user} office={activeAccountProfile?.office ?? ""} division={activeAccountProfile?.division ?? ""} unit={accountUnit} focusRecordId={notificationFocus?.kind === "document" && notificationFocus.documentType === "Notice to Attend" ? notificationFocus.id : undefined} onFocusHandled={clearNotificationFocus} /> : section === "travel-orders" ? <TravelOrderModule user={user} office={activeAccountProfile?.office ?? ""} unit={accountUnit} focusRecordId={notificationFocus?.kind === "document" && notificationFocus.documentType === "Travel Order" ? notificationFocus.id : notificationFocus?.kind === "reminder" && notificationFocus.reminderKind === "travel-order-status" ? notificationFocus.id : undefined} onFocusHandled={clearNotificationFocus} /> : section === "calendar-of-activities" ? <CalendarOfActivitiesModule user={user} profileRevision={profileRevision} focusCalendarId={notificationFocus?.kind === "calendar" && notificationFocus.mode === "prepared" ? notificationFocus.id : undefined} onFocusHandled={clearNotificationFocus} /> : section === "calendar-of-activities-records" ? <CalendarOfActivitiesModule user={user} mode="approved-records" focusCalendarId={notificationFocus?.kind === "calendar" && notificationFocus.mode === "approved-records" ? notificationFocus.id : undefined} onFocusHandled={clearNotificationFocus} /> : section === "messenger" ? <MessengerModule user={user} profileOffice={activeAccountProfile?.office} profileAssignment={accountUnit} /> : section === "whereabouts-calendar" ? <><WhereaboutsCalendarModule user={user} accountRole={accountRole} office={activeAccountProfile?.office ?? ""} assignment={accountUnit ?? ""} />{canViewCleaningTask && <CleaningTaskModule user={user} role={accountRole} unit={accountUnit ?? ""} name={activeAccountProfile?.name ?? fullName} mode="landing" />}</> : section === "cleaning-task" ? (canAccessCleaningTask ? <CleaningTaskModule user={user} role={accountRole} unit={accountUnit ?? ""} name={activeAccountProfile?.name ?? fullName} canUpload mode="workspace" /> : null) : section === "my-drive" ? <MyDriveModule user={user} /> : section === "cleaning-task-assignments" ? (isSuperAdmin ? <CleaningTaskAssignmentAdmin user={user} /> : null) : section === "permit-statistics" ? <PermitSlipAdmin user={user} mode="statistics" canManagePermits={isAdmin} accountRole={accountRole} office={activeAccountProfile?.office ?? ""} division={activeAccountProfile?.division ?? ""} unit={activeAccountProfile?.unit ?? ""} designation={activeAccountProfile?.designation ?? ""} /> : section === "permit-status" ? <PermitSlipAdmin user={user} mode="status" focusNotificationKey={focusedPermitNotificationKey} canManagePermits={isAdmin} accountRole={accountRole} office={activeAccountProfile?.office ?? ""} division={activeAccountProfile?.division ?? ""} unit={activeAccountProfile?.unit ?? ""} designation={activeAccountProfile?.designation ?? ""} /> : section === "permits" ? (view === "new" ? <PermitForm user={user} office={activeAccountProfile?.office ?? ""} assignment={accountUnit ?? ""} onSaved={(permit) => { setPermits([permit, ...permits]); setView("list"); }} onCancel={() => setView("list")} onError={setError} /> : <PermitList permits={permits} approvedPermitNumbers={approvedPermitNumbers} ownerId={user.uid} preparedByNames={permitPreparedByNames} fallbackPreparedBy={activeAccountProfile?.name || user.displayName || ""} deletingId={deletingPermitId} onNew={() => { setError(""); setView("new"); }} onPrint={(permit) => { setSingleSlipPreview(false); setPreview(permit); }} onDelete={setPendingPermitDelete} />) : editingSpecialOrder ? <SpecialOrderParticipantEditor order={editingSpecialOrder} userId={user.uid} office={activeAccountProfile?.office ?? ""} assignment={accountUnit ?? ""} onCancel={() => setEditingSpecialOrder(null)} onSaved={(updatedOrder) => { setSpecialOrders((current) => current.map((order) => order.id === updatedOrder.id ? updatedOrder : order)); setEditingSpecialOrder(null); }} /> : (view === "new" ? <SpecialOrderForm user={user} ownerOffice={activeAccountProfile?.office ?? ""} ownerDivision={activeAccountProfile?.division ?? ""} ownerUnit={accountUnit} onSaved={(order) => { setSpecialOrders([order, ...specialOrders]); setView("list"); }} onCancel={() => setView("list")} onError={setError} /> : <SpecialOrderList orders={specialOrders} ownerId={user.uid} preparedByNames={specialOrderPreparedByNames} fallbackPreparedBy={activeAccountProfile?.name || user.displayName || ""} deletingId={deletingSpecialOrderId} onNew={() => { setError(""); setView("new"); }} onEdit={setEditingSpecialOrder} onPrint={setSpecialOrderPreview} copyingId={copyingSpecialOrderId} onCopy={(order) => void copySpecialOrder(order)} onDelete={setPendingSpecialOrderDelete} />)}</main><DeleteConfirmation open={Boolean(pendingPermitDelete)} title="Confirm Permit Slip Deletion?" description="Are you sure you want to delete this Permit Slip? This action cannot be undone." busy={Boolean(pendingPermitDelete && deletingPermitId === pendingPermitDelete.id)} onCancel={() => setPendingPermitDelete(null)} onConfirm={() => { if (pendingPermitDelete) void deletePermit(pendingPermitDelete); }} /><DeleteConfirmation open={Boolean(pendingSpecialOrderDelete)} title="Confirm Special Order Deletion?" description="Are you sure you want to delete this Special Order? This action cannot be undone." busy={Boolean(pendingSpecialOrderDelete && deletingSpecialOrderId === pendingSpecialOrderDelete.id)} onCancel={() => setPendingSpecialOrderDelete(null)} onConfirm={() => { if (pendingSpecialOrderDelete) void deleteSpecialOrder(pendingSpecialOrderDelete); }} />{preview && <PrintPreview permit={preview} approvedPermitNumbers={approvedPermitNumbers} singleSlip={singleSlipPreview} ownerOffice={activeAccountProfile?.office ?? ""} ownerAssignment={accountUnit ?? ""} onClose={() => { setPreview(null); setSingleSlipPreview(false); }} />}{specialOrderPreview && <SpecialOrderPreview order={specialOrderPreview} onClose={() => setSpecialOrderPreview(null)} />}</div>;
}
