"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { collection, deleteField, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "@/lib/firebase";
import NameSearchSelect from "./NameSearchSelect";
import { accountDesignation, accountProfileSelection } from "@/lib/account-profile";
import { isApprovedAdminAccount, personnelMatchesAccountScope } from "@/lib/personnel";
import { loadPdfTools } from "@/lib/pdf-tools";
import { isSuperadminRole } from "@/lib/user-roles";
import { calendarOfActivitiesApprovalNotificationsCollection, calendarOfActivitiesCollection, calendarOfActivitiesNotificationsCollection } from "@/lib/calendar-of-activities-storage";
import DeleteConfirmation from "./DeleteConfirmation";
import RecordPagination, { useRecordPagination } from "./RecordPagination";
import "./calendar-of-activities-large.css";
import "./calendar-of-activities-mobile.css";

export type CalendarOfActivitiesReminder = {
  dateFrom: string;
  dateTo: string;
  activity: string;
  location: string;
};

export type CalendarOfActivitiesNotification = {
  id: string;
  recipientId: string;
  calendarId: string;
  unit: string;
  month: string;
  activities: CalendarOfActivitiesReminder[];
  workflowEvent?: "project-leader-signature" | "chief-signature" | "creator-review" | "final-approval" | "final-disapproval";
  read: boolean;
  createdAt?: unknown;
};

export type CalendarOfActivitiesApprovalNotification = {
  id: string;
  calendarId: string;
  ownerId: string;
  unit: string;
  month: string;
  preparedName: string;
  status: "Approved";
  readBy: string[];
  createdAt?: unknown;
};

type Unit = string;
type CalendarOfActivitiesStatus = "Pending" | "Approved" | "Disapproved";
type CalendarWorkflowStage = "owner-initial" | "project-leader" | "chief" | "returned";
type ResponsiblePerson = { userId: string; name: string };
type ActivityDraft = CalendarOfActivitiesReminder & { responsiblePeople: ResponsiblePerson[]; nextResponsibleId: string };
type CalendarOfActivitiesRow = CalendarOfActivitiesReminder & { responsiblePeople: ResponsiblePerson[] };
type CalendarOfActivities = {
  id: string;
  ownerId: string;
  unit: Unit;
  month: string;
  status?: CalendarOfActivitiesStatus;
  activities: CalendarOfActivitiesRow[];
  preparedName: string;
  preparedPosition: string;
  affixSignature?: "Yes" | "No";
  affixSignatureURL?: string;
  affixSignatureName?: string;
  affixSignatureAt?: unknown;
  approvalWorkflow?: "fod-calendar";
  approvalStage?: CalendarWorkflowStage;
  initialSignerId?: string;
  chiefSignerId?: string;
  affixInitialSignature?: "Yes" | "No";
  affixInitialSignatureURL?: string;
  affixInitialSignatureName?: string;
  affixInitialSignatureAt?: unknown;
  affixCheckedSignature?: "Yes" | "No";
  affixCheckedSignatureURL?: string;
  affixCheckedSignatureName?: string;
  affixCheckedSignatureAt?: unknown;
  affixNotedSignature?: "Yes" | "No";
  affixNotedSignatureURL?: string;
  affixNotedSignatureName?: string;
  affixNotedSignatureAt?: unknown;
  checkedBy?: CalendarOfActivitiesAdminSignatory;
  notedBy?: CalendarOfActivitiesAdminSignatory;
  approvedBy?: CalendarOfActivitiesApprover;
  createdAt?: unknown;
};
type Profile = { name: string; position: string; designation: string; office: string; division: string; unit: Unit; rawAccountRole: string; rawOffice: string; rawDivision: string; rawUnit: string; fullSignatureURL: string };
type CalendarOfActivitiesAdminSignatory = { userId: string; name: string; designation: string; position: string; assignment: string };
type CalendarOfActivitiesApprover = { name: string; designation: "Regional Executive Director" | "RTD for Operations" | "RTD for Research and Regulation" };
type Account = { id: string; name: string; adminAccount: boolean; designation: string; position: string; assignment: string; office: string; division: string; unit: string; storedName: string; storedPosition: string; storedDesignation: string; storedOffice: string; storedDivision: string; storedUnit: string };

const unitLabel = (unit: Unit) => unit === "Field Operations Division" || unit.startsWith("FOD-") ? unit : `FOD-${unit}`;
const calendarOfActivitiesStatus = (plan: CalendarOfActivities): CalendarOfActivitiesStatus => plan.status === "Approved" || plan.status === "Disapproved" ? plan.status : "Pending";
const unitDescription: Record<Unit, string> = {
  AMIA: "FOD - Adaptation Initiative and Mitigation in Agriculture",
  AGRISTAT: "FOD - Agricultural Statistics",
  DRRM: "FOD - Disaster Risk Reduction and Management",
  "Field Operations Division": "Field Operations Division",
};
const checkedRoleByUnit: Record<Unit, string> = {
  AGRISTAT: "Agricultural Statistics Focal Person",
  AMIA: "Regional AMIA Project Leader",
  DRRM: "Regional DRRM Alternate Focal Person",
  "Field Operations Division": "Field Operations Division",
};
const fixedCalendarOfActivitiesSignatories = [
  { label: "Checked:", name: "GERLIE B. ANTIPASO", position: "DRRM Alternate Focal Person / Agriculturist II" },
  { label: "Noted:", name: "MELODY C. GUIMARY", position: "Chief, Field Operations Division" },
  { label: "Approved:", name: "REBECCA R. ATEGA", position: "RTD for Operations" },
];
const calendarOfActivitiesApprovers: CalendarOfActivitiesApprover[] = [
  { name: "ENGR. RICARDO M. OÑATE JR.", designation: "Regional Executive Director" },
  { name: "REBECCA R. ATEGA", designation: "RTD for Operations" },
  { name: "MARCO ANTONIO C. MORIDO", designation: "RTD for Research and Regulation" },
];
const asset = (path: string) => `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
const emptyActivity = (): ActivityDraft => ({ dateFrom: "", dateTo: "", activity: "", location: "", responsiblePeople: [], nextResponsibleId: "" });
const pageSize = 6;
const maximumActivities = 100;
const fodCalendarOwnerUnits = ["AGRISTAT", "DRRM", "AMIA"];

function isFodCalendarOwner(profile: Pick<Profile, "rawAccountRole" | "office" | "division" | "unit">) {
  const accountRole = profile.rawAccountRole.toLowerCase();
  return ["regular", "user"].includes(accountRole)
    && profile.office === "Division"
    && profile.division === "Field Operations Division"
    && fodCalendarOwnerUnits.includes(profile.unit);
}

function isFodCalendarApprover(account: Account | undefined, designation: "AGRISTAT/DRRM/AMIA Project Leader" | "Chief") {
  return Boolean(account?.adminAccount && account.office === "Division" && account.division === "Field Operations Division" && account.unit === "Field Operations Division" && account.designation === designation && account.storedDesignation === designation && account.storedOffice === "Division" && account.storedDivision === "Field Operations Division" && account.storedUnit === "Field Operations Division");
}

function formatDate(value: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-PH", { month: "long", day: "numeric", year: "numeric" }).format(new Date(`${value}T00:00:00`));
}

function formatDateRange(from: string, to: string) {
  if (!from) return "";
  const endValue = to || from;
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${endValue}T00:00:00Z`);
  const formatMonthAndDay = (date: Date) => new Intl.DateTimeFormat("en-PH", { month: "long", day: "numeric", timeZone: "UTC" }).format(date);
  const formatMonthOnly = (date: Date) => new Intl.DateTimeFormat("en-PH", { month: "long", timeZone: "UTC" }).format(date);
  if (from === endValue) return formatMonthAndDay(start);
  if (from.slice(0, 7) === endValue.slice(0, 7)) return `${formatMonthOnly(start)} ${start.getUTCDate()}-${end.getUTCDate()}`;
  return `${formatDate(from)} to ${formatDate(endValue)}`;
}

function formatMonth(month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) return month;
  return new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
}

function monthDateBounds(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) return null;
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const prefix = `${match[1]}-${match[2]}`;
  return { first: `${prefix}-01`, last: `${prefix}-${String(lastDay).padStart(2, "0")}` };
}

function moveDateToMonth(value: string, month: string) {
  if (!value) return "";
  const bounds = monthDateBounds(month);
  if (!bounds) return "";
  const day = Number(value.slice(-2));
  if (!Number.isInteger(day) || day < 1) return "";
  const lastDay = Number(bounds.last.slice(-2));
  return `${month}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

function timestampMillis(value: unknown) {
  if (value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") return value.toMillis() as number;
  if (value instanceof Date) return value.getTime();
  return 0;
}

function signatureDate(value: unknown) {
  const millis = timestampMillis(value);
  if (!millis) return "";
  const dateParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(millis));
  const part = (type: string) => dateParts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}.${part("month")}.${part("day")}`;
}

function signatureTime(value: unknown) {
  const millis = timestampMillis(value);
  return millis ? `${new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(millis))} +0800` : "";
}

const compareActivityDates = (first: CalendarOfActivitiesRow, second: CalendarOfActivitiesRow) => first.dateFrom.localeCompare(second.dateFrom) || first.dateTo.localeCompare(second.dateTo);

function activityPages(activities: CalendarOfActivitiesRow[]) {
  const chronologicalActivities = [...activities].sort(compareActivityDates);
  const pages: CalendarOfActivitiesRow[][] = [];
  for (let index = 0; index < chronologicalActivities.length; index += pageSize) pages.push(chronologicalActivities.slice(index, index + pageSize));
  return pages;
}

function CalendarPaperSignature({ url, name, at, label }: { url?: string; name?: string; at?: unknown; label: string }) {
  if (!url) return null;
  return <div className="calendar-of-activities-paper-digital-signature"><img src={url} crossOrigin="anonymous" alt={`Digital signature of ${name || label}`} /><div><span>Digitally Signed By</span><strong>{(name || label).trim().toLocaleUpperCase("en-PH")}</strong><small>Date: {signatureDate(at)}</small><small>Time: {signatureTime(at)}</small></div></div>;
}

function CalendarOfActivitiesPaper({ plan, activities, pageNumber, pageCount }: { plan: CalendarOfActivities; activities: CalendarOfActivitiesRow[]; pageNumber: number; pageCount: number }) {
  const isLastPage = pageNumber === pageCount;
  const chronologicalActivities = [...activities].sort(compareActivityDates);
  const workflow = plan.approvalWorkflow === "fod-calendar";
  const preparedURL = workflow ? (plan.affixInitialSignature === "Yes" ? plan.affixInitialSignatureURL : undefined) : (plan.affixSignature === "Yes" ? plan.affixSignatureURL : undefined);
  const preparedSigner = workflow ? plan.affixInitialSignatureName || plan.preparedName : plan.affixSignatureName || plan.preparedName;
  const preparedAt = workflow ? plan.affixInitialSignatureAt : plan.affixSignatureAt;
  const checkedURL = workflow && plan.affixCheckedSignature === "Yes" ? plan.affixCheckedSignatureURL : undefined;
  const notedURL = workflow && plan.affixNotedSignature === "Yes" ? plan.affixNotedSignatureURL : undefined;
  return <article className="calendar-of-activities-paper">
    <header className="calendar-of-activities-paper-heading">
      <img src={asset("/da-caraga-logo.jpg")} alt="Department of Agriculture Caraga Region" />
      <div><p>Republic of the Philippines</p><strong>DEPARTMENT OF AGRICULTURE</strong><span>Caraga Region</span><small>Capitol Site, Butuan City 8600</small><small>Tel. No.: (085) 817-9561; Telefax No.: (085) 818-6163</small></div>
    </header>
    <div className="calendar-of-activities-paper-rule" />
    <div className="calendar-of-activities-paper-title"><h1>CALENDAR OF ACTIVITIES</h1><p className="calendar-of-activities-paper-unit">{unitDescription[plan.unit]}</p><p className="calendar-of-activities-paper-month">{formatMonth(plan.month)}</p></div>
    <table className="calendar-of-activities-paper-table"><thead><tr><th>Date</th><th>Activity</th><th>Location</th><th>Responsible Personnel</th></tr></thead><tbody>
      {chronologicalActivities.map((activity, index) => <tr key={`${activity.dateFrom}-${activity.activity}-${index}`}><td className="calendar-of-activities-paper-date">{formatDateRange(activity.dateFrom, activity.dateTo)}</td><td>{activity.activity}</td><td>{activity.location}</td><td><div className="calendar-of-activities-paper-responsible">{activity.responsiblePeople.map((person, personIndex) => <span key={person.userId}>{personIndex + 1}) {person.name}</span>)}</div></td></tr>)}
    </tbody></table>
    <footer className={`calendar-of-activities-paper-footer${preparedURL || checkedURL || notedURL ? " has-affixed-signature" : ""}`}>
      {isLastPage && <>
        <div className={`calendar-of-activities-paper-signatory${preparedURL ? " is-affixed" : ""}`}><span>Prepared:</span><CalendarPaperSignature url={preparedURL} name={preparedSigner} at={preparedAt} label="preparer" /><strong>{plan.preparedName}</strong><em>{plan.preparedPosition}</em></div>
        <div className={`calendar-of-activities-paper-signatory${checkedURL ? " is-affixed" : ""}`}><span>Checked:</span><CalendarPaperSignature url={checkedURL} name={plan.affixCheckedSignatureName} at={plan.affixCheckedSignatureAt} label="Project Leader" />{plan.checkedBy ? <><strong>{plan.checkedBy.name.toLocaleUpperCase("en-PH")}</strong><em>{plan.checkedBy.designation} / {plan.checkedBy.position}</em></> : <><strong>{fixedCalendarOfActivitiesSignatories[0].name}</strong><em>{`${checkedRoleByUnit[plan.unit]}${plan.unit === "Field Operations Division" ? "" : " / Agriculturist II"}`}</em></>}</div>
        <div className={`calendar-of-activities-paper-signatory${notedURL ? " is-affixed" : ""}`}><span>Noted:</span><CalendarPaperSignature url={notedURL} name={plan.affixNotedSignatureName} at={plan.affixNotedSignatureAt} label="Field Operations Chief" />{plan.notedBy ? <><strong>{plan.notedBy.name.toLocaleUpperCase("en-PH")}</strong><div className="calendar-of-activities-paper-signatory-title"><em>{plan.notedBy.designation}</em>{plan.notedBy.designation === "Chief" && plan.notedBy.assignment === "Field Operations Division" ? ", " : " / "}{plan.notedBy.assignment}</div></> : <><strong>{fixedCalendarOfActivitiesSignatories[1].name}</strong><em>{fixedCalendarOfActivitiesSignatories[1].position}</em></>}</div>
        <div className="calendar-of-activities-paper-signatory"><span>Approved:</span>{plan.approvedBy ? <><strong>{plan.approvedBy.name.toLocaleUpperCase("en-PH")}</strong><div className="calendar-of-activities-paper-signatory-title"><em>{plan.approvedBy.designation}</em></div></> : <><strong>{fixedCalendarOfActivitiesSignatories[2].name}</strong><em>{fixedCalendarOfActivitiesSignatories[2].position}</em></>}</div>
      </>}
    </footer>
  </article>;
}

function CalendarOfActivitiesPreview({ plan, onClose, readOnly = false }: { plan: CalendarOfActivities; onClose: () => void; readOnly?: boolean }) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState("");
  const pages = activityPages(plan.activities);

  async function waitForImages() {
    if (!pagesRef.current) throw new Error("The Calendar of Activities preview is unavailable.");
    await Promise.all(Array.from(pagesRef.current.querySelectorAll("img")).map(async (image) => {
      if (!image.complete) await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("The DA Caraga logo could not be loaded."));
      });
      if (!image.naturalWidth) throw new Error("The DA Caraga logo could not be loaded.");
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
      const paperPages = Array.from(pagesRef.current!.querySelectorAll<HTMLElement>(".calendar-of-activities-paper"));
      const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      for (let index = 0; index < paperPages.length; index += 1) {
        const canvas = await html2canvas(paperPages[index], { backgroundColor: "#fff", logging: false, scale: 3, useCORS: true });
        if (index) pdf.addPage("a4", "landscape");
        pdf.addImage(canvas.toDataURL("image/jpeg", .97), "JPEG", 0, 0, 297, 210);
      }
      pdf.save(`calendar-of-activities-${plan.month}.pdf`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the Calendar of Activities PDF.");
    } finally { setDownloading(false); }
  }

  async function printDocument() {
    setPrinting(true);
    setError("");
    let printPageStyle: HTMLStyleElement | null = null;
    try {
      await waitForImages();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      printPageStyle = document.createElement("style");
      printPageStyle.textContent = "@media print{@page{size:A4 landscape;margin:0}}";
      document.head.appendChild(printPageStyle);
      window.print();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to prepare the Calendar of Activities for printing.");
    } finally {
      printPageStyle?.remove();
      setPrinting(false);
    }
  }

  return <div className="calendar-of-activities-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="preview-toolbar calendar-of-activities-preview-toolbar"><span>{formatMonth(plan.month)} · {pages.length} {pages.length === 1 ? "page" : "pages"}</span><button type="button" className="ghost-button" onClick={onClose}>Close</button>{!readOnly && <><button type="button" className="pdf-button" onClick={() => void downloadPdf()} disabled={downloading}>{downloading ? "Preparing PDF…" : "Download PDF"}</button><button type="button" className="pdf-button" onClick={() => void printDocument()} disabled={printing}>{printing ? "Preparing print…" : "Print"}</button>{error && <small role="alert">{error}</small>}</>}</div>
    <div className="calendar-of-activities-preview-pages" ref={pagesRef}>{pages.map((activities, index) => <CalendarOfActivitiesPaper key={`${plan.id}-${index}`} plan={plan} activities={activities} pageNumber={index + 1} pageCount={pages.length} />)}</div>
  </div>;
}

function CalendarOfActivitiesForm({ user, profile, accounts, adminAccounts, plan, onSaved, onCancel, onError }: { user: User; profile: Profile; accounts: Account[]; adminAccounts: Account[]; plan?: CalendarOfActivities; onSaved: (plan: CalendarOfActivities) => void; onCancel: () => void; onError: (message: string) => void }) {
  const [month, setMonth] = useState(() => plan?.month ?? "");
  const [activities, setActivities] = useState<ActivityDraft[]>(() => plan ? plan.activities.map((activity) => ({ ...activity, responsiblePeople: activity.responsiblePeople.map((person) => ({ ...person })), nextResponsibleId: "" })) : [emptyActivity()]);
  const [checkedById, setCheckedById] = useState(() => plan?.checkedBy?.userId ?? "");
  const [notedById, setNotedById] = useState(() => plan?.notedBy?.userId ?? "");
  const [approvedByDesignation, setApprovedByDesignation] = useState(() => plan?.approvedBy?.designation ?? "");
  const [saving, setSaving] = useState(false);
  const dateBounds = monthDateBounds(month);
  const fodWorkflow = isFodCalendarOwner(profile);
  const projectLeaderAccount = adminAccounts.find((account) => isFodCalendarApprover(account, "AGRISTAT/DRRM/AMIA Project Leader"));
  const chiefAccount = adminAccounts.find((account) => isFodCalendarApprover(account, "Chief"));

  function updateMonth(nextMonth: string) {
    setMonth(nextMonth);
    setActivities((current) => current.map((activity) => {
      const dateFrom = moveDateToMonth(activity.dateFrom, nextMonth);
      let dateTo = moveDateToMonth(activity.dateTo, nextMonth);
      if (dateFrom && dateTo && dateTo < dateFrom) dateTo = dateFrom;
      return { ...activity, dateFrom, dateTo };
    }));
  }

  function updateActivity(index: number, update: Partial<ActivityDraft>) {
    setActivities((current) => current.map((activity, row) => row === index ? { ...activity, ...update } : activity));
  }

  function addResponsiblePerson(index: number) {
    const account = accounts.find((entry) => entry.id === activities[index].nextResponsibleId);
    if (!account || activities[index].responsiblePeople.some((entry) => entry.userId === account.id)) return;
    updateActivity(index, { responsiblePeople: [...activities[index].responsiblePeople, { userId: account.id, name: account.name }], nextResponsibleId: "" });
  }

  function removeResponsiblePerson(activityIndex: number, userId: string) {
    updateActivity(activityIndex, { responsiblePeople: activities[activityIndex].responsiblePeople.filter((person) => person.userId !== userId) });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const firestore = db;
    if (!firestore) { onError("Firebase is not configured."); return; }
    if (!month) { onError("Select the calendar month and year."); return; }
    if (activities.length > maximumActivities) { onError(`A calendar can contain up to ${maximumActivities} activities.`); return; }
    if (activities.some((activity) => !activity.dateFrom || !activity.dateTo || !activity.activity.trim() || !activity.location.trim() || !activity.responsiblePeople.length)) {
      onError("Complete every activity row and select at least one responsible person for each activity.");
      return;
    }
    if (activities.some((activity) => activity.dateTo < activity.dateFrom)) {
      onError("Each activity end date must be on or after its start date.");
      return;
    }
    if (!dateBounds || activities.some((activity) => activity.dateFrom < dateBounds.first || activity.dateFrom > dateBounds.last || activity.dateTo < dateBounds.first || activity.dateTo > dateBounds.last)) {
      onError("Each activity date must fall within the selected month and year.");
      return;
    }
    const checkedByAccount = fodWorkflow ? projectLeaderAccount : adminAccounts.find((account) => account.id === checkedById);
    const notedByAccount = fodWorkflow ? chiefAccount : adminAccounts.find((account) => account.id === notedById);
    const approvedBy = calendarOfActivitiesApprovers.find((signatory) => signatory.designation === approvedByDesignation);
    const hasSavedWorkflowSignatories = plan?.approvalWorkflow === "fod-calendar" && Boolean(plan.checkedBy && plan.notedBy);
    if ((!hasSavedWorkflowSignatories && (!checkedByAccount || !notedByAccount)) || !approvedBy) {
      onError(fodWorkflow ? "A matching Field Operations Project Leader and Chief account must be active, and an approver must be selected." : "Select an Admin for Checked By and Noted By, and choose an approver.");
      return;
    }
    const checkedBy = plan?.approvalWorkflow === "fod-calendar" && plan.checkedBy
      ? plan.checkedBy
      : { userId: checkedByAccount!.id, name: fodWorkflow ? checkedByAccount!.storedName : checkedByAccount!.name, designation: checkedByAccount!.designation, position: fodWorkflow ? checkedByAccount!.storedPosition : checkedByAccount!.position, assignment: checkedByAccount!.assignment };
    const notedBy = plan?.approvalWorkflow === "fod-calendar" && plan.notedBy
      ? plan.notedBy
      : { userId: notedByAccount!.id, name: fodWorkflow ? notedByAccount!.storedName : notedByAccount!.name, designation: notedByAccount!.designation, position: fodWorkflow ? notedByAccount!.storedPosition : notedByAccount!.position, assignment: notedByAccount!.assignment };
    const signatories = { checkedBy, notedBy, approvedBy: approvedBy! };
    setSaving(true);
    onError("");
    const rows: CalendarOfActivitiesRow[] = activities.map(({ dateFrom, dateTo, activity, location, responsiblePeople }) => ({ dateFrom, dateTo, activity: activity.trim(), location: location.trim(), responsiblePeople }));
    const planData: Omit<CalendarOfActivities, "id"> = {
      ownerId: user.uid,
      unit: profile.unit,
      month,
      status: "Pending",
      activities: rows,
      preparedName: profile.name.trim(),
      preparedPosition: profile.position.trim(),
      affixSignature: "No",
      ...(fodWorkflow ? {
        approvalWorkflow: "fod-calendar" as const,
        approvalStage: "owner-initial" as const,
        initialSignerId: checkedByAccount!.id,
        chiefSignerId: notedByAccount!.id,
        affixInitialSignature: "No" as const,
      } : {}),
      ...signatories,
      createdAt: serverTimestamp(),
    };
    const activityByAccount = new Map<string, CalendarOfActivitiesReminder[]>();
    rows.forEach((row) => row.responsiblePeople.forEach((person) => {
      const notices = activityByAccount.get(person.userId) ?? [];
      notices.push({ dateFrom: row.dateFrom, dateTo: row.dateTo, activity: row.activity, location: row.location });
      activityByAccount.set(person.userId, notices);
    }));
    let planUpdateCommitted = false;
    try {
      if (plan) {
        const planRef = doc(firestore, calendarOfActivitiesCollection, plan.id);
        const notificationSnapshot = await getDocs(query(collection(firestore, calendarOfActivitiesNotificationsCollection), where("calendarId", "==", plan.id), where("ownerId", "==", plan.ownerId), where("unit", "==", plan.unit)));
        const existingByRecipient = new Map<string, typeof notificationSnapshot.docs>();
        notificationSnapshot.docs.forEach((notification) => {
          const recipientId = String(notification.data().recipientId ?? "");
          if (!recipientId) return;
          existingByRecipient.set(recipientId, [...(existingByRecipient.get(recipientId) ?? []), notification]);
        });
        const notificationChanges: Array<{ kind: "update" | "delete" | "create"; reference: (typeof notificationSnapshot.docs)[number]["ref"]; data?: Record<string, unknown> }> = [];
        for (const [recipientId, notices] of activityByAccount) {
          const existing = existingByRecipient.get(recipientId) ?? [];
          if (existing.length) {
            notificationChanges.push({
              kind: "update",
              reference: existing[0].ref,
              data: { month, activities: notices, read: false, readAt: deleteField(), createdAt: serverTimestamp() },
            });
            existing.slice(1).forEach((notification) => notificationChanges.push({ kind: "delete", reference: notification.ref }));
            existingByRecipient.delete(recipientId);
          } else {
            notificationChanges.push({
              kind: "create",
              reference: doc(collection(firestore, calendarOfActivitiesNotificationsCollection)),
              data: { recipientId, ownerId: plan.ownerId, calendarId: plan.id, unit: plan.unit, month, activities: notices, read: false, createdAt: serverTimestamp() },
            });
          }
        }
        existingByRecipient.forEach((notifications) => notifications.forEach((notification) => notificationChanges.push({ kind: "delete", reference: notification.ref })));

        for (let start = 0; start < Math.max(notificationChanges.length, 1); start += 17) {
          const batch = writeBatch(firestore);
          if (start === 0) batch.update(planRef, { activities: rows, ...signatories });
          notificationChanges.slice(start, start + 17).forEach((change) => {
            if (change.kind === "delete") batch.delete(change.reference);
            else if (change.kind === "update") batch.update(change.reference, change.data!);
            else batch.set(change.reference, change.data!);
          });
          await batch.commit();
          if (start === 0) planUpdateCommitted = true;
        }
        onSaved({ ...plan, activities: rows, ...signatories });
      } else {
        const planRef = doc(collection(firestore, calendarOfActivitiesCollection));
        const planToSave = { ...planData, createdAt: serverTimestamp() };
        await setDoc(planRef, planToSave);
        onSaved({ id: planRef.id, ...planData, activities: rows });

        const notificationDocuments = [...activityByAccount].map(([recipientId, notices]) => ({
          reference: doc(collection(firestore, calendarOfActivitiesNotificationsCollection)),
          data: { recipientId, ownerId: user.uid, calendarId: planRef.id, unit: profile.unit, month, activities: notices, read: false, createdAt: serverTimestamp() },
        }));
        try {
          for (let start = 0; start < notificationDocuments.length; start += 18) {
            const batch = writeBatch(firestore);
            notificationDocuments.slice(start, start + 18).forEach((notification) => batch.set(notification.reference, notification.data));
            await batch.commit();
          }
        } catch (cause) {
          const code = (cause as { code?: string }).code;
          onError(code
            ? `Calendar saved, but activity notifications could not be sent (${code}).`
            : "Calendar saved, but activity notifications could not be sent.");
        }
      }
    } catch (cause) {
      if (plan) {
        const code = (cause as { code?: string }).code;
        if (planUpdateCommitted) onSaved({ ...plan, activities: rows, ...signatories });
        onError(planUpdateCommitted
          ? `Activity details were saved, but some responsible-person notifications could not be updated${code ? ` (${code})` : ""}. Save again to retry the notifications.`
          : code ? `Could not update the Calendar of Activities (${code}).` : "Could not update the Calendar of Activities.");
        setSaving(false);
        return;
      }
      const code = (cause as { code?: string }).code;
      const detail = code ? ` (${code})` : "";
      onError(`Could not create the Calendar of Activities record${detail}.`);
    } finally { setSaving(false); }
  }

  return <section className="content-section form-section calendar-of-activities-form-section">
    <div className="section-heading"><div><p className="eyebrow">{plan ? "Edit record" : "New record"}</p><h2>{plan ? "Edit Calendar of Activities" : "Calendar of Activities"}</h2><p className="muted">{plan ? `Update the date, activity, location, or responsible people for this calendar. The original preparer remains ${plan.preparedName}, ${plan.preparedPosition}.` : `Add one or more activities for ${unitLabel(profile.unit)}. Selected colleagues receive an in-app notification with each activity’s dates, activity, and location.`}</p></div><button type="button" className="ghost-button" onClick={onCancel}>Cancel</button></div>
    <form className="permit-form travel-order-form calendar-of-activities-form" onSubmit={save}>
      <div className="calendar-of-activities-meta wide-field"><label>Month and Year<input type="month" value={month} onChange={(event) => updateMonth(event.target.value)} disabled={Boolean(plan)} required /></label></div>
      <div className="calendar-of-activities-rows wide-field"><div className="calendar-of-activities-rows-heading"><strong>Activities</strong><span>Set one responsible person or add several for each row.</span></div>
        {activities.map((activity, index) => <fieldset className="calendar-of-activities-row" key={index}>
          <legend>Activity {index + 1}</legend>
          <label>Date From<input type="date" min={dateBounds?.first} max={dateBounds?.last} value={activity.dateFrom} disabled={!dateBounds} onChange={(event) => {
            const value = event.target.value;
            if (dateBounds && value && (value < dateBounds.first || value > dateBounds.last)) return;
            updateActivity(index, { dateFrom: value, dateTo: activity.dateTo && value > activity.dateTo ? value : activity.dateTo });
          }} required /></label><label>Date To<input type="date" min={activity.dateFrom || dateBounds?.first} max={dateBounds?.last} value={activity.dateTo} disabled={!dateBounds} onChange={(event) => {
            const value = event.target.value;
            if (dateBounds && value && (value < dateBounds.first || value > dateBounds.last)) return;
            updateActivity(index, { dateTo: value });
          }} required /></label>
          <label className="calendar-of-activities-entry">Activity<textarea rows={1} maxLength={400} value={activity.activity} onChange={(event) => updateActivity(index, { activity: event.target.value })} required /></label>
          <label className="calendar-of-activities-entry calendar-of-activities-location">Location<input maxLength={180} value={activity.location} onChange={(event) => updateActivity(index, { location: event.target.value })} required /></label>
          <div className="calendar-of-activities-responsible-field"><span className="calendar-of-activities-responsible-label">Responsible Personnel</span><div className="calendar-of-activities-responsible-add"><NameSearchSelect aria-label={`Choose responsible personnel for activity ${index + 1}`} value={activity.nextResponsibleId} onChange={(selectedId) => updateActivity(index, { nextResponsibleId: selectedId })} disabled={!accounts.length}><option value="">{accounts.length ? "Select a personnel" : "No other accounts listed under this office"}</option>{accounts.filter((account) => !activity.responsiblePeople.some((person) => person.userId === account.id)).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</NameSearchSelect><button type="button" className="ghost-button" onClick={() => addResponsiblePerson(index)} disabled={!activity.nextResponsibleId}>Add personnel</button></div>
            {activity.responsiblePeople.length > 0 && <ul className="calendar-of-activities-responsible-list">{activity.responsiblePeople.map((person) => <li key={person.userId}><span>{person.name}</span><button type="button" className="remove-action" aria-label={`Remove ${person.name}`} onClick={() => removeResponsiblePerson(index, person.userId)}>Remove</button></li>)}</ul>}
          </div>
          {activities.length > 1 && <button type="button" className="remove-participant remove-action" onClick={() => setActivities((current) => current.filter((_, row) => row !== index))}>Remove activity</button>}
        </fieldset>)}
        <button type="button" className="text-button plain-action add-item-text-button" disabled={activities.length >= maximumActivities} onClick={() => setActivities((current) => current.length < maximumActivities ? [...current, emptyActivity()] : current)}>+ Add another activity</button>
        {activities.length >= maximumActivities && <small className="calendar-of-activities-limit-note">A calendar can contain up to {maximumActivities} activities.</small>}
      </div>
      <div className="calendar-of-activities-signatories wide-field">
        {fodWorkflow ? <><div className="name-search-field"><span>Checked By</span><div className="calendar-of-activities-routed-signatory">{projectLeaderAccount ? `${projectLeaderAccount.name} — ${projectLeaderAccount.designation}` : "Matching Field Operations Project Leader not found"}</div></div><div className="name-search-field"><span>Noted By</span><div className="calendar-of-activities-routed-signatory">{chiefAccount ? `${chiefAccount.name} — Chief` : "Field Operations Chief not found"}</div></div></> : <><div className="name-search-field"><span>Checked By</span><NameSearchSelect aria-label="Checked By" value={checkedById} onChange={(selectedId) => setCheckedById(selectedId)} required disabled={saving || !adminAccounts.length}><option value="">Select a Designated Personnel</option>{adminAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</NameSearchSelect></div>
        <div className="name-search-field"><span>Noted By</span><NameSearchSelect aria-label="Noted By" value={notedById} onChange={(selectedId) => setNotedById(selectedId)} required disabled={saving || !adminAccounts.length}><option value="">Select a Designated Personnel</option>{adminAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</NameSearchSelect></div></>}
        <label>Approved By<select value={approvedByDesignation} onChange={(event) => setApprovedByDesignation(event.target.value as CalendarOfActivitiesApprover["designation"] | "")} required disabled={saving}><option value="">Select a Designated Personnel</option>{calendarOfActivitiesApprovers.map((signatory) => <option key={signatory.designation} value={signatory.designation}>{signatory.designation}</option>)}</select></label>
      </div>
      <div className="form-actions"><button className="primary-button" disabled={saving}>{saving ? "Saving…" : plan ? "Save changes" : "Save"}</button></div>
    </form>
  </section>;
}

function CalendarOfActivitiesList({ plans, currentUserId, onNew, onEdit, onView, onDelete, onStatusChange, onAffixSignatureChange, fullSignatureAvailable, deletingId, updatingStatusId, updatingAffixSignatureId, adminRecordsOnly = false, approvalTasksOnly = false }: { plans: CalendarOfActivities[]; currentUserId: string; onNew: () => void; onEdit: (plan: CalendarOfActivities) => void; onView: (plan: CalendarOfActivities) => void; onDelete: (plan: CalendarOfActivities) => void; onStatusChange: (plan: CalendarOfActivities, status: CalendarOfActivitiesStatus) => void; onAffixSignatureChange: (plan: CalendarOfActivities, value: "Yes" | "No") => void; fullSignatureAvailable: boolean; deletingId: string | null; updatingStatusId: string | null; updatingAffixSignatureId: string | null; adminRecordsOnly?: boolean; approvalTasksOnly?: boolean }) {
  const { currentPage, pageCount, visibleRecords, setPage } = useRecordPagination(plans);
  const heading = adminRecordsOnly ? "Calendar of Activities Records" : approvalTasksOnly ? "Calendar of Activities Approval" : "Calendar of Activities";
  return <section className="content-section calendar-of-activities-list-section">
    <div className="section-heading"><div><p className="eyebrow">{adminRecordsOnly ? "Approved records" : approvalTasksOnly ? "Admin Panel" : "Calendar records and signature tasks"}</p><h2>{heading}</h2><p className="muted">{adminRecordsOnly ? `${plans.length} approved calendar ${plans.length === 1 ? "record" : "records"}.` : approvalTasksOnly ? `${plans.length === 1 ? "1 calendar is" : `${plans.length} calendars are`} awaiting your signature.` : `${plans.length} calendar ${plans.length === 1 ? "record" : "records"} available to your account.`}</p></div>{!adminRecordsOnly && !approvalTasksOnly && <button type="button" className="primary-button" onClick={onNew}>Add</button>}</div>
    {plans.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>{adminRecordsOnly ? "No approved records yet" : approvalTasksOnly ? "No calendars awaiting your signature" : "No calendars of activities yet"}</h3>{approvalTasksOnly ? <p>Calendars assigned to you will appear here when they reach your signature step.</p> : !adminRecordsOnly && <><p>Create a monthly calendar and notify responsible colleagues in your Unit / Program / Project.</p><button className="text-button plain-action document-create-action" onClick={onNew}>Add a Calendar of Activities</button></>}</div> : <div className="permit-table calendar-of-activities-list">
      <div className="table-head calendar-of-activities-list-head"><span>Month and Year</span><span>Activities</span><span>Affix Signature</span><span>Status</span></div>
      {visibleRecords.map((plan) => {
        const status = calendarOfActivitiesStatus(plan);
        const workflow = plan.approvalWorkflow === "fod-calendar";
        const isOwnerInitial = workflow && plan.approvalStage === "owner-initial" && plan.ownerId === currentUserId;
        const isProjectLeader = workflow && plan.approvalStage === "project-leader" && plan.initialSignerId === currentUserId;
        const isChief = workflow && plan.approvalStage === "chief" && plan.chiefSignerId === currentUserId;
        const canEditWorkflow = !workflow || (plan.approvalStage === "owner-initial" && plan.ownerId === currentUserId);
        const canChangeStatus = !workflow || (plan.approvalStage === "returned" && plan.ownerId === currentUserId);
        const canEditAffixSignature = !adminRecordsOnly && status === "Pending" && (workflow ? isOwnerInitial || isProjectLeader || isChief : plan.ownerId === currentUserId);
        const affixSignature = workflow
          ? isOwnerInitial ? (plan.affixInitialSignature === "Yes" ? "Yes" : "No")
            : isProjectLeader ? (plan.affixCheckedSignature === "Yes" ? "Yes" : "No")
              : isChief ? (plan.affixNotedSignature === "Yes" ? "Yes" : "No") : "No"
          : plan.affixSignature === "Yes" ? "Yes" : "No";
        const signatureAvailable = fullSignatureAvailable;
        const signatureAction = workflow
          ? isOwnerInitial ? "Affix Full Signature"
            : isProjectLeader || isChief ? "Affix Full Signature"
              : plan.approvalStage === "returned" ? "Returned to creator"
                : plan.approvalStage === "chief" ? "Awaiting Chief full signature"
                  : plan.approvalStage === "project-leader" ? "Awaiting Project Leader full signature"
                    : "Awaiting creator full signature"
          : "Affix Signature";
        return <div className="table-row calendar-of-activities-list-row" key={plan.id}>
          <strong>{formatMonth(plan.month)}</strong>
          <span className="calendar-of-activities-list-count">{plan.activities.length}</span>
          <label className="calendar-of-activities-list-affix" data-label={signatureAction}>{workflow && !canEditAffixSignature ? <span className="calendar-of-activities-workflow-status">{signatureAction}</span> : <select className="affix-signature-select" aria-label={`${signatureAction} for ${unitLabel(plan.unit)}, ${formatMonth(plan.month)}`} value={affixSignature} disabled={updatingAffixSignatureId !== null || deletingId !== null || updatingStatusId !== null} title={!signatureAvailable ? "Upload your Full Signature in Profile to enable this option." : undefined} onChange={(event) => onAffixSignatureChange(plan, event.target.value as "Yes" | "No")}><option value="Yes" disabled={!signatureAvailable}>Yes</option><option value="No">No</option></select>}</label>
          {adminRecordsOnly || approvalTasksOnly ? <span className="travel-order-status calendar-of-activities-list-status"><strong className={`calendar-of-activities-status-badge ${adminRecordsOnly ? "is-approved" : "is-pending"}`}>{adminRecordsOnly ? "Approved" : status}</strong></span> : <label className={`travel-order-status travel-order-status-${status.toLowerCase()} calendar-of-activities-list-status`}><select aria-label={`Status for ${unitLabel(plan.unit)}, ${formatMonth(plan.month)}`} value={status} disabled={status !== "Pending" || !canChangeStatus || updatingStatusId !== null || deletingId !== null} onChange={(event) => onStatusChange(plan, event.target.value as CalendarOfActivitiesStatus)}><option value="Pending">Pending</option><option value="Approved">Approved</option><option value="Disapproved">Disapproved</option></select></label>}
          <span className="travel-order-row-actions calendar-of-activities-row-actions">{adminRecordsOnly ? <button type="button" className="row-action" onClick={() => onView(plan)}>View</button> : <>{status === "Pending" && canEditWorkflow && plan.ownerId === currentUserId && <button type="button" className="row-action" disabled={updatingStatusId !== null || deletingId !== null} onClick={() => onEdit(plan)}>Edit</button>}<button type="button" className="row-action" disabled={deletingId !== null} onClick={() => onView(plan)}>View</button>{plan.ownerId === currentUserId && status === "Pending" && canEditWorkflow && <button type="button" className="delete-button" disabled={updatingStatusId !== null || deletingId !== null} onClick={() => onDelete(plan)}>{deletingId === plan.id ? "Deleting…" : "Delete"}</button>}</>}</span>
        </div>;
      })}
      <RecordPagination totalRecords={plans.length} currentPage={currentPage} pageCount={pageCount} onPageChange={setPage} label="Calendar of Activities Records" />
    </div>}
  </section>;
}

export default function CalendarOfActivitiesModule({ user, role = "regular", mode = "prepared", profileRevision = 0, focusCalendarId, previewRecord, readOnlyPreview = false, onFocusHandled, onPreviewClose }: { user: User; role?: string; mode?: "prepared" | "approved-records" | "approval"; profileRevision?: number; focusCalendarId?: string; previewRecord?: Record<string, unknown>; readOnlyPreview?: boolean; onFocusHandled?: () => void; onPreviewClose?: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [adminAccounts, setAdminAccounts] = useState<Account[]>([]);
  const [plans, setPlans] = useState<CalendarOfActivities[]>([]);
  const [view, setView] = useState<"list" | "new" | "edit">("list");
  const [editingPlan, setEditingPlan] = useState<CalendarOfActivities | null>(null);
  const [preview, setPreview] = useState<CalendarOfActivities | null>(null);
  useEffect(() => {
    if (!previewRecord || typeof previewRecord.id !== "string") return;
    setPreview({ ...previewRecord, id: previewRecord.id } as unknown as CalendarOfActivities);
  }, [previewRecord]);
  const [pendingDelete, setPendingDelete] = useState<CalendarOfActivities | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [updatingStatusId, setUpdatingStatusId] = useState<string | null>(null);
  const [updatingAffixSignatureId, setUpdatingAffixSignatureId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const handledFocusIdRef = useRef<string | null>(null);
  const repairingOwnerNotificationIdsRef = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const firestore = db;
      if (!firestore) { setError("Firebase is not configured."); setLoading(false); return; }
      setLoading(true);
      setError("");
      setProfile(null);
      try {
        if (mode === "approved-records") {
          const plansSnapshot = await getDocs(query(collection(firestore, calendarOfActivitiesCollection), where("status", "==", "Approved")));
          const rows = plansSnapshot.docs.map((item) => ({ id: item.id, ...item.data() } as CalendarOfActivities));
          rows.sort((first, second) => second.month.localeCompare(first.month) || timestampMillis(second.createdAt) - timestampMillis(first.createdAt));
          if (!cancelled) setPlans(rows);
          return;
        }
        const profileSnapshot = await getDoc(doc(firestore, "users", user.uid));
        if (!profileSnapshot.exists()) throw new Error("Complete your name, position, Office, Division, and Unit / Program / Project in Profile before creating a calendar.");
        const profileData = profileSnapshot.data();
        const selection = accountProfileSelection(profileData);
        const { office, division } = selection;
        const unit = selection.unit || selection.division;
        if (!office || !division || !unit) throw new Error("Set your Office, Division, and Unit / Program / Project in Profile to view its Calendar of Activities.");
        const loadedProfile: Profile = { name: typeof profileData.name === "string" ? profileData.name : "", position: typeof profileData.position === "string" ? profileData.position : "", designation: accountDesignation(profileData.designation), office, division, unit, rawAccountRole: typeof profileData.accountRole === "string" ? profileData.accountRole : "", rawOffice: typeof profileData.office === "string" ? profileData.office : "", rawDivision: typeof profileData.division === "string" ? profileData.division : "", rawUnit: typeof profileData.unit === "string" ? profileData.unit : "", fullSignatureURL: typeof profileData.fullSignatureURL === "string" ? profileData.fullSignatureURL : "" };
        if (!cancelled) setProfile(loadedProfile);
        if (mode === "approval") {
          const canReviewCalendarSignatures = role === "admin"
            && loadedProfile.rawOffice === "Division"
            && loadedProfile.rawDivision === "Field Operations Division"
            && loadedProfile.rawUnit === "Field Operations Division"
            && (loadedProfile.designation === "AGRISTAT/DRRM/AMIA Project Leader" || loadedProfile.designation === "Chief");
          if (!canReviewCalendarSignatures) {
            if (!cancelled) setPlans([]);
            return;
          }
          const [projectLeaderSnapshot, chiefSnapshot] = await Promise.all([
            getDocs(query(collection(firestore, calendarOfActivitiesCollection), where("initialSignerId", "==", user.uid))),
            getDocs(query(collection(firestore, calendarOfActivitiesCollection), where("chiefSignerId", "==", user.uid))),
          ]);
          const rowsById = new Map<string, CalendarOfActivities>([...projectLeaderSnapshot.docs, ...chiefSnapshot.docs].map((item): [string, CalendarOfActivities] => [item.id, { id: item.id, ...item.data() } as CalendarOfActivities]));
          const rows = [...rowsById.values()].filter((plan) => plan.approvalWorkflow === "fod-calendar"
            && plan.status === "Pending"
            && ((plan.approvalStage === "project-leader" && plan.initialSignerId === user.uid)
              || (plan.approvalStage === "chief" && plan.chiefSignerId === user.uid)));
          rows.sort((first, second) => timestampMillis(second.createdAt) - timestampMillis(first.createdAt));
          if (!cancelled) setPlans(rows);
          return;
        }
        const [allAccountsSnapshot, unitPlansSnapshot, ownedPlansSnapshot] = await Promise.all([
          getDocs(collection(firestore, "users")),
          getDocs(query(collection(firestore, calendarOfActivitiesCollection), where("unit", "==", loadedProfile.unit))),
          getDocs(query(collection(firestore, calendarOfActivitiesCollection), where("ownerId", "==", user.uid))),
        ]);
        const [initialSignerPlansSnapshot, chiefSignerPlansSnapshot] = role !== "admin"
          ? [null, null] as const
          : await Promise.all([
            getDocs(query(collection(firestore, calendarOfActivitiesCollection), where("initialSignerId", "==", user.uid))),
            getDocs(query(collection(firestore, calendarOfActivitiesCollection), where("chiefSignerId", "==", user.uid))),
          ]);
        const receivedNotifications = await getDocs(query(collection(firestore, calendarOfActivitiesNotificationsCollection), where("recipientId", "==", user.uid)));
        const receivedPlans = await Promise.all(receivedNotifications.docs.map((notification) => {
          const calendarId = notification.data().calendarId;
          if (typeof calendarId !== "string" || !calendarId) return Promise.resolve(null);
          return getDoc(doc(firestore, calendarOfActivitiesCollection, calendarId)).catch((cause) => {
            // A notification may outlive the recipient's assignment. Keep loading calendars
            // they can still access instead of failing the entire screen on this old link.
            if ((cause as { code?: string }).code === "permission-denied") return null;
            throw cause;
          });
        }));
        const admins = allAccountsSnapshot.docs.filter((item) => isApprovedAdminAccount(item.data().accountRole, item.data().accountStatus, item.data().email)).map((item) => {
          const data = item.data();
          const accountProfile = accountProfileSelection(data);
          return { id: item.id, name: String(data.name ?? "").trim(), adminAccount: true, designation: accountDesignation(data.designation), position: typeof data.position === "string" ? data.position.trim() : "", assignment: accountProfile.unit || accountProfile.division, office: accountProfile.office, division: accountProfile.division, unit: accountProfile.unit || accountProfile.division, storedName: String(data.name ?? ""), storedPosition: typeof data.position === "string" ? data.position : "", storedDesignation: typeof data.designation === "string" ? data.designation : "", storedOffice: typeof data.office === "string" ? data.office : "", storedDivision: typeof data.division === "string" ? data.division : "", storedUnit: typeof data.unit === "string" ? data.unit : "" };
        }).filter((account) => account.name).sort((first, second) => first.name.localeCompare(second.name, "en", { sensitivity: "base" }));
        const colleagues = allAccountsSnapshot.docs.filter((item) => {
          if (item.id === user.uid || isSuperadminRole(item.data().accountRole, item.data().email)) return false;
          const person = item.data();
          const personProfile = accountProfileSelection(person);
          return personnelMatchesAccountScope(personProfile.office, personProfile.unit || personProfile.division, loadedProfile.office, loadedProfile.unit, {
            includeAdminAccounts: true,
            accountRole: person.accountRole,
            accountStatus: person.accountStatus,
            division: loadedProfile.division,
            candidateDivision: personProfile.division,
          });
        }).map((item) => {
          const data = item.data();
          const accountProfile = accountProfileSelection(data);
          return { id: item.id, name: String(data.name ?? "").trim(), adminAccount: isApprovedAdminAccount(data.accountRole, data.accountStatus, data.email), designation: accountDesignation(data.designation), position: typeof data.position === "string" ? data.position.trim() : "", assignment: accountProfile.unit || accountProfile.division, office: accountProfile.office, division: accountProfile.division, unit: accountProfile.unit || accountProfile.division, storedName: String(data.name ?? ""), storedPosition: typeof data.position === "string" ? data.position : "", storedDesignation: typeof data.designation === "string" ? data.designation : "", storedOffice: typeof data.office === "string" ? data.office : "", storedDivision: typeof data.division === "string" ? data.division : "", storedUnit: typeof data.unit === "string" ? data.unit : "" };
        }).filter((account) => account.name).sort((first, second) => first.name.localeCompare(second.name, "en", { sensitivity: "base" }));
        const rowsById = new Map<string, CalendarOfActivities>([...unitPlansSnapshot.docs, ...ownedPlansSnapshot.docs, ...(initialSignerPlansSnapshot?.docs ?? []), ...(chiefSignerPlansSnapshot?.docs ?? [])].map((item): [string, CalendarOfActivities] => [item.id, { id: item.id, ...item.data() } as CalendarOfActivities]));
        receivedPlans.forEach((item) => {
          if (item?.exists()) rowsById.set(item.id, { id: item.id, ...item.data() } as CalendarOfActivities);
        });
        const rows = [...rowsById.values()];
        rows.sort((first, second) => timestampMillis(second.createdAt) - timestampMillis(first.createdAt));
        if (!cancelled) {
          setAccounts(colleagues);
          setAdminAccounts(admins);
          setPlans(rows);
          rows.forEach((plan) => {
            if (plan.ownerId !== user.uid || plan.approvalWorkflow !== "fod-calendar") return;
            const event: CalendarOfActivitiesNotification["workflowEvent"] = plan.approvalStage === "project-leader" && plan.affixInitialSignature === "Yes"
              ? "project-leader-signature"
              : undefined;
            const recipientId = plan.initialSignerId;
            if (!event || !recipientId || repairingOwnerNotificationIdsRef.current.has(`${plan.id}:${event}`)) return;
            const repairKey = `${plan.id}:${event}`;
            repairingOwnerNotificationIdsRef.current.add(repairKey);
            void (async () => {
              try {
                const existingNotifications = await getDocs(query(collection(firestore, calendarOfActivitiesNotificationsCollection), where("calendarId", "==", plan.id), where("ownerId", "==", plan.ownerId), where("unit", "==", plan.unit)));
                if (existingNotifications.docs.some((notification) => notification.data().workflowEvent === event)) return;
                await setDoc(doc(collection(firestore, calendarOfActivitiesNotificationsCollection)), {
                  recipientId,
                  calendarId: plan.id,
                  ownerId: plan.ownerId,
                  unit: plan.unit,
                  month: plan.month,
                  activities: plan.activities.map(({ dateFrom, dateTo, activity, location }) => ({ dateFrom, dateTo, activity, location })),
                  workflowEvent: event,
                  read: false,
                  createdAt: serverTimestamp(),
                });
              } catch (cause) {
                repairingOwnerNotificationIdsRef.current.delete(repairKey);
                const code = (cause as { code?: string }).code;
                if (!cancelled) setError(code ? `The signature is saved, but the Project Leader notification could not be delivered (${code}).` : "The signature is saved, but the Project Leader notification could not be delivered.");
              }
            })();
          });
        }
      } catch (cause) {
        if (!cancelled) {
          const code = (cause as { code?: string }).code;
          setError(cause instanceof Error && !code ? cause.message : code ? `Could not load Calendar of Activities records (${code}).` : "Could not load Calendar of Activities records.");
        }
      } finally { if (!cancelled) setLoading(false); }
    }
    void load();
    return () => { cancelled = true; };
  }, [user.uid, role, mode, profileRevision]);

  useEffect(() => {
    if (!focusCalendarId) { handledFocusIdRef.current = null; return; }
    if (handledFocusIdRef.current === focusCalendarId || loading) return;
    const plan = plans.find((item) => item.id === focusCalendarId);
    if (!plan) return;
    handledFocusIdRef.current = focusCalendarId;
    setPreview(plan);
    onFocusHandled?.();
  }, [focusCalendarId, loading, onFocusHandled, plans]);

  async function updateCalendarOfActivitiesStatus(plan: CalendarOfActivities, status: CalendarOfActivitiesStatus) {
    const currentStatus = calendarOfActivitiesStatus(plan);
    if (currentStatus !== "Pending") {
      if (status !== currentStatus) setError("Approved or disapproved Calendars of Activities cannot change status.");
      return;
    }
    if (plan.approvalWorkflow === "fod-calendar" && (plan.approvalStage !== "returned" || plan.ownerId !== user.uid)) {
      setError("The creator can update this Calendar’s status after the Chief’s full signature is complete.");
      return;
    }
    if (!db || updatingStatusId || currentStatus === status) return;
    setUpdatingStatusId(plan.id);
    setError("");
    try {
      const firestore = db;
      const planRef = doc(firestore, calendarOfActivitiesCollection, plan.id);
      const batch = writeBatch(firestore);
      batch.update(planRef, { status });
      if (status === "Approved") {
        const notificationRef = doc(collection(firestore, calendarOfActivitiesApprovalNotificationsCollection));
        batch.set(notificationRef, {
          calendarId: plan.id,
          ownerId: plan.ownerId,
          unit: plan.unit,
          month: plan.month,
          preparedName: plan.preparedName,
          status,
          readBy: [],
          createdAt: serverTimestamp(),
        });
      }
      if (plan.approvalWorkflow === "fod-calendar" && (status === "Approved" || status === "Disapproved")) {
        const recipients = [...new Set([plan.initialSignerId, plan.chiefSignerId].filter((recipientId): recipientId is string => Boolean(recipientId) && recipientId !== plan.ownerId))];
        recipients.forEach((recipientId) => {
          const notificationRef = doc(collection(firestore, calendarOfActivitiesNotificationsCollection));
          batch.set(notificationRef, {
            recipientId,
            calendarId: plan.id,
            ownerId: plan.ownerId,
            unit: plan.unit,
            month: plan.month,
            activities: plan.activities.map(({ dateFrom, dateTo, activity, location }) => ({ dateFrom, dateTo, activity, location })),
            workflowEvent: status === "Approved" ? "final-approval" : "final-disapproval",
            read: false,
            createdAt: serverTimestamp(),
          });
        });
      }
      await batch.commit();
      setPlans((current) => current.map((item) => item.id === plan.id ? { ...item, status } : item));
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not update the Calendar of Activities status (${code}).` : "Could not update the Calendar of Activities status.");
    } finally { setUpdatingStatusId(null); }
  }

  async function updateCalendarAffixSignature(plan: CalendarOfActivities, value: "Yes" | "No") {
    if (!db || !profile || updatingAffixSignatureId || calendarOfActivitiesStatus(plan) !== "Pending") return;
    const workflow = plan.approvalWorkflow === "fod-calendar";
    const stage = plan.approvalStage;
    const actor = workflow
      ? stage === "owner-initial" && plan.ownerId === user.uid ? "owner"
        : stage === "project-leader" && plan.initialSignerId === user.uid ? "project-leader"
          : stage === "chief" && plan.chiefSignerId === user.uid ? "chief" : null
      : plan.ownerId === user.uid ? "owner" : null;
    if (!actor) return;
    const currentValue = workflow
      ? actor === "owner" ? (plan.affixInitialSignature === "Yes" ? "Yes" : "No")
        : actor === "project-leader" ? (plan.affixCheckedSignature === "Yes" ? "Yes" : "No")
          : (plan.affixNotedSignature === "Yes" ? "Yes" : "No")
      : plan.affixSignature === "Yes" ? "Yes" : "No";
    if (currentValue === value) return;
    const signatureURL = profile.fullSignatureURL.trim();
    if (value === "Yes" && !signatureURL) {
      setError("Upload your Full Signature in Profile before affixing it to a Calendar of Activities.");
      return;
    }
    setUpdatingAffixSignatureId(plan.id);
    setError("");
    const planRef = doc(db, calendarOfActivitiesCollection, plan.id);
    try {
      if (workflow) {
        const stageAfter: CalendarWorkflowStage = actor === "owner" ? "project-leader" : actor === "project-leader" ? "chief" : "returned";
        const suffix = actor === "owner" ? "Initial" : actor === "project-leader" ? "Checked" : "Noted";
        const recipientId = actor === "owner" ? plan.initialSignerId : actor === "project-leader" ? plan.chiefSignerId : plan.ownerId;
        if (value === "Yes" && !recipientId) {
          setError("Could not determine the next Calendar of Activities signer.");
          return;
        }
        const signatureFields = value === "Yes"
          ? { [`affix${suffix}Signature`]: value, [`affix${suffix}SignatureURL`]: signatureURL, [`affix${suffix}SignatureName`]: profile.name, [`affix${suffix}SignatureAt`]: serverTimestamp(), approvalStage: stageAfter }
          : actor === "owner" ? { affixInitialSignature: "No" } : actor === "project-leader" ? { affixCheckedSignature: "No" } : { affixNotedSignature: "No" };
        try {
          await updateDoc(planRef, signatureFields);
        } catch (cause) {
          const code = (cause as { code?: string }).code;
          setError(code ? `Could not save the Calendar of Activities signature to its record (${code}).` : "Could not save the Calendar of Activities signature to its record.");
          return;
        }
        let affixedAt: unknown = value === "Yes" ? new Date() : undefined;
        if (value === "Yes") {
          try {
            const savedPlan = await getDoc(planRef);
            const timestampField = actor === "owner" ? "affixInitialSignatureAt" : actor === "project-leader" ? "affixCheckedSignatureAt" : "affixNotedSignatureAt";
            if (savedPlan.exists()) affixedAt = savedPlan.data()[timestampField] ?? affixedAt;
          } catch { /* Keep the local click time if the follow-up server read is unavailable. */ }
        }
        const signatureUpdate: Partial<CalendarOfActivities> = actor === "owner"
          ? value === "Yes" ? { affixInitialSignature: value, affixInitialSignatureURL: signatureURL, affixInitialSignatureName: profile.name, affixInitialSignatureAt: affixedAt, approvalStage: stageAfter } : { affixInitialSignature: "No" }
          : actor === "project-leader"
            ? value === "Yes" ? { affixCheckedSignature: value, affixCheckedSignatureURL: signatureURL, affixCheckedSignatureName: profile.name, affixCheckedSignatureAt: affixedAt, approvalStage: stageAfter } : { affixCheckedSignature: "No" }
            : value === "Yes" ? { affixNotedSignature: value, affixNotedSignatureURL: signatureURL, affixNotedSignatureName: profile.name, affixNotedSignatureAt: affixedAt, approvalStage: stageAfter } : { affixNotedSignature: "No" };
        setPlans((current) => current.map((item) => item.id === plan.id ? { ...item, ...signatureUpdate } : item));
        if (value === "Yes") {
          const event: NonNullable<CalendarOfActivitiesNotification["workflowEvent"]> = actor === "owner" ? "project-leader-signature" : actor === "project-leader" ? "chief-signature" : "creator-review";
          const notificationRef = doc(collection(db, calendarOfActivitiesNotificationsCollection));
          try {
            await setDoc(notificationRef, {
              recipientId,
              calendarId: plan.id,
              ownerId: plan.ownerId,
              unit: plan.unit,
              month: plan.month,
              activities: plan.activities.map(({ dateFrom, dateTo, activity, location }) => ({ dateFrom, dateTo, activity, location })),
              workflowEvent: event,
              read: false,
              createdAt: serverTimestamp(),
            });
          } catch (cause) {
            const code = (cause as { code?: string }).code;
            setError(code ? `Signature saved, but the next Calendar of Activities signer could not be notified (${code}).` : "Signature saved, but the next Calendar of Activities signer could not be notified.");
            return;
          }
        }
        return;
      }
      const signatureFields = value === "Yes"
        ? { affixSignature: value, affixSignatureURL: signatureURL, affixSignatureName: profile.name.trim(), affixSignatureAt: serverTimestamp() }
        : { affixSignature: value, affixSignatureURL: deleteField(), affixSignatureName: deleteField(), affixSignatureAt: deleteField() };
      try {
        await updateDoc(planRef, signatureFields);
      } catch (cause) {
        const code = (cause as { code?: string }).code;
        setError(code ? `Could not save the Calendar of Activities signature to its record (${code}).` : "Could not save the Calendar of Activities signature to its record.");
        return;
      }
      let affixedAt: unknown = value === "Yes" ? new Date() : undefined;
      if (value === "Yes") {
        try {
          const savedPlan = await getDoc(planRef);
          if (savedPlan.exists()) affixedAt = savedPlan.data().affixSignatureAt ?? affixedAt;
        } catch { /* Keep the local click time if the follow-up server read is unavailable. */ }
      }
      const signatureUpdate: Partial<CalendarOfActivities> = value === "Yes"
        ? { affixSignature: value, affixSignatureURL: signatureURL, affixSignatureName: profile.name.trim(), affixSignatureAt: affixedAt }
        : { affixSignature: value, affixSignatureURL: undefined, affixSignatureName: undefined, affixSignatureAt: undefined };
      setPlans((current) => current.map((item) => item.id === plan.id ? { ...item, ...signatureUpdate } : item));
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not update the Calendar of Activities signature choice (${code}).` : "Could not update the Calendar of Activities signature choice.");
    } finally { setUpdatingAffixSignatureId(null); }
  }

  async function deleteCalendarOfActivities(plan: CalendarOfActivities) {
    const firestore = db;
    if (!firestore) return;
    if (calendarOfActivitiesStatus(plan) !== "Pending") {
      setError("Approved or disapproved Calendars of Activities cannot be deleted.");
      setPendingDelete(null);
      return;
    }
    if (plan.ownerId !== user.uid) {
      setError("Only the original preparer can delete this Calendar of Activities.");
      setPendingDelete(null);
      return;
    }
    if (plan.approvalWorkflow === "fod-calendar" && plan.approvalStage !== "owner-initial") {
      setError("This Calendar can no longer be deleted after the signature route has started.");
      setPendingDelete(null);
      return;
    }
    setDeletingId(plan.id);
    setError("");
    try {
      const notificationSnapshot = await getDocs(query(collection(firestore, calendarOfActivitiesNotificationsCollection), where("calendarId", "==", plan.id), where("ownerId", "==", plan.ownerId), where("unit", "==", plan.unit)));
      const batch = writeBatch(firestore);
      notificationSnapshot.docs.forEach((notification) => batch.delete(notification.ref));
      batch.delete(doc(firestore, calendarOfActivitiesCollection, plan.id));
      await batch.commit();
      setPlans((current) => current.filter((item) => item.id !== plan.id));
      setPreview((current) => current?.id === plan.id ? null : current);
      setPendingDelete(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete the Calendar of Activities (${code}).` : "Could not delete the Calendar of Activities.");
      setPendingDelete(null);
    } finally { setDeletingId(null); }
  }

  function closePreview() { setPreview(null); onPreviewClose?.(); }

  const visiblePlans = mode === "approval" ? plans.filter((plan) => plan.approvalWorkflow === "fod-calendar"
    && plan.status === "Pending"
    && ((plan.approvalStage === "project-leader" && plan.initialSignerId === user.uid)
      || (plan.approvalStage === "chief" && plan.chiefSignerId === user.uid))) : plans;

  return <>
    {error && <div className="error-message calendar-of-activities-error" role="alert">{error}</div>}
    {loading ? <section className="content-section"><p className="muted">Loading Calendar of Activities records…</p></section> : mode !== "approved-records" && !profile ? <section className="content-section calendar-of-activities-profile-notice"><h2>Profile details needed</h2><p>Set your Office, Division, and Unit / Program / Project in Profile to view your office’s Calendar of Activities.</p></section> : mode === "prepared" && (view === "new" || (view === "edit" && editingPlan)) ? <CalendarOfActivitiesForm key={view === "edit" ? editingPlan!.id : "new"} user={user} profile={profile!} accounts={accounts} adminAccounts={adminAccounts} plan={view === "edit" ? editingPlan! : undefined} onSaved={(plan) => { if (view === "edit") setPlans((current) => current.map((item) => item.id === plan.id ? plan : item)); else setPlans((current) => [plan, ...current]); setEditingPlan(null); setView("list"); }} onCancel={() => { setEditingPlan(null); setView("list"); }} onError={setError} /> : <CalendarOfActivitiesList plans={visiblePlans} currentUserId={user.uid} onNew={() => { if (!profile?.name.trim() || !profile.position.trim()) { setError("Complete your name and position in Profile before preparing a new Calendar of Activities."); return; } setError(""); setEditingPlan(null); setView("new"); }} onEdit={(plan) => { setError(""); setEditingPlan(plan); setView("edit"); }} onView={setPreview} onDelete={setPendingDelete} onStatusChange={(plan, status) => void updateCalendarOfActivitiesStatus(plan, status)} onAffixSignatureChange={(plan, value) => void updateCalendarAffixSignature(plan, value)} fullSignatureAvailable={Boolean(profile?.fullSignatureURL.trim())} deletingId={deletingId} updatingStatusId={updatingStatusId} updatingAffixSignatureId={updatingAffixSignatureId} adminRecordsOnly={mode === "approved-records"} approvalTasksOnly={mode === "approval"} />}
    <DeleteConfirmation open={Boolean(pendingDelete)} title="Confirm Calendar of Activities Deletion?" description="Are you sure you want to delete this Calendar of Activities? This action cannot be undone, and its activity notifications will also be removed." busy={Boolean(pendingDelete && deletingId === pendingDelete.id)} onCancel={() => setPendingDelete(null)} onConfirm={() => { if (pendingDelete) void deleteCalendarOfActivities(pendingDelete); }} />
    {preview && <CalendarOfActivitiesPreview plan={preview} onClose={closePreview} readOnly={readOnlyPreview} />}
  </>;
}
