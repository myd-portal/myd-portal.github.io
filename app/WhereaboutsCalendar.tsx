"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { collection, doc, getDocs, onSnapshot, query, setDoc, where, writeBatch, type Firestore } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "@/lib/firebase";
import type { AccountRole } from "@/lib/user-roles";
import { calendarOfActivitiesCollection } from "@/lib/calendar-of-activities-storage";
import { PHILIPPINE_HOLIDAYS_2026, type PhilippineHolidayCategory } from "@/lib/philippine-holidays-2026";
import { isPermitAdmin } from "./PermitSlipAdmin";
import { LEGACY_PENDING_STATUS, normalizeWorkflowStatus } from "./workflow-status";
import { assignApprovedPermitNumbers, displayPermitNumber } from "./permit-number";
import { accountDivisionOptions, accountOffice, accountOfficeOptions, accountProfileSelection, divisionsForOffice, executiveOfficeDivisionOptions, unitsForOfficeDivision } from "@/lib/account-profile";
import "./whereabouts-calendar.css";

type CalendarTravelOrder = {
  id: string;
  ownerId?: string;
  ownerUnit?: string;
  status: string;
  people: { name: string; userId?: string; position?: string; salary?: string; toNumber?: string }[];
  departureDate: string;
  returnDate: string;
  purpose: string;
  placeOfTravel: string;
  chargeTo?: string;
};
type ApprovedPermitSlip = {
  id: string;
  ownerId?: string;
  status: string;
  permitNo: string;
  approvedPermitNo?: string;
  userId?: string;
  name: string;
  date: string;
  purpose: string;
  unit?: string;
};
type ApprovedLeaveApplication = {
  id: string;
  leaveApplicationId: string;
  ownerId: string;
  status: string;
  firstName?: string;
  middleInitial?: string;
  lastName?: string;
  name?: string;
  office: string;
  leaveType: string;
  inclusiveDateFrom: string;
  inclusiveDateTo: string;
};
type ApprovedCalendarOfActivities = {
  id: string;
  ownerId?: string;
  unit: string;
  month: string;
  preparedName?: string;
  activities: { dateFrom: string; dateTo: string; activity: string; location: string; responsiblePeople?: { name: string }[] }[];
};
type ApprovedArchiveDocumentType = "Special Order" | "Notice to Attend" | "Calendar of Activities";
type ApprovedArchiveRecord = { id: string; data: Record<string, unknown> };
type ApprovedArchiveRow = {
  key: string;
  record: ApprovedArchiveRecord;
  type: ApprovedArchiveDocumentType;
  activityTitle: string;
  designatedPersonnel: string;
  dateFrom: string;
  dateTo: string;
  venue: string;
};
type StoredPermit = {
  id: string;
  ownerId?: string;
  permitNo: string;
  permitNos?: string[];
  date: string;
  names?: string[];
  personIds?: string[];
  name?: string;
  personUnits?: string[];
  purpose: string;
  unit?: string;
  personStatuses?: Record<string, { status?: string; approvedPermitNo?: string }>;
};

type PermitUnitFilter = "All" | string;
type SelectedCalendarEntry = {
  id: string;
  type: "Travel Order" | "Permit Slip" | "Leave Application";
  statuses: string[];
  names: string[];
  personKeys: string[];
  date: string;
  sortDate: string;
  sortEndDate: string;
  purpose: string;
  destination: string;
  unit?: string;
};

type CalendarFilterOption = { value: string; label: string };

const holidayCategoryClass: Record<PhilippineHolidayCategory, string> = {
  "Regular Holiday": "regular",
  "Special (Non-Working) Day": "special-non-working",
  "Special (Working) Day": "special-working",
  "Additional Special (Non-Working) Day": "additional-special-non-working",
};

function CalendarFilterDropdown({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: CalendarFilterOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const activeOptionId = `${listboxId}-option-${activeIndex}`;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setActiveIndex(selectedIndex);
        setOpen(true);
      } else {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((index) => (index + direction + options.length) % options.length);
      }
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      if (!open) {
        setActiveIndex(selectedIndex);
        setOpen(true);
      } else {
        const option = options[activeIndex];
        if (option) onChange(option.value);
        setOpen(false);
      }
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "Tab" && open) setOpen(false);
  }

  const selectedOption = options[selectedIndex];
  return <div className="whereabouts-filter-control" ref={rootRef}>
    <button
      type="button"
      className="whereabouts-filter-trigger"
      role="combobox"
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listboxId}
      aria-activedescendant={open ? activeOptionId : undefined}
      onClick={() => {
        setActiveIndex(selectedIndex);
        setOpen((current) => !current);
      }}
      onKeyDown={handleKeyDown}
    >
      <span>{selectedOption?.label ?? "Select an option"}</span>
      <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m5 7.5 5 5 5-5" /></svg>
    </button>
    {open && <div className="whereabouts-filter-menu" id={listboxId} role="listbox" aria-label={label}>
      {options.map((option, index) => <button
        type="button"
        className={`whereabouts-filter-option${index === activeIndex ? " is-active" : ""}`}
        id={`${listboxId}-option-${index}`}
        key={option.value}
        role="option"
        aria-selected={option.value === value}
        tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => { onChange(option.value); setOpen(false); }}
      >{option.label}</button>)}
    </div>}
  </div>;
}

function archiveText(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function uniqueArchiveNames(names: string[]) {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))].join(", ");
}

function normalizeUnit(value?: string): Exclude<PermitUnitFilter, "All"> | "" {
  const unit = value?.trim().toUpperCase();
  if (unit === "AGRISTAT" || unit === "FOD-AGRISTAT" || unit === "AGRICULTURAL STATISTICS") return "AGRISTAT";
  if (unit === "AMIA" || unit === "FOD-AMIA") return "AMIA";
  if (unit === "DRRM" || unit === "FOD-DRRM") return "DRRM";
  return "";
}

function displayUnit(value?: string) {
  const unit = normalizeUnit(value);
  const office = value?.trim() ? accountOffice({ office: value.trim(), profileFieldsVersion: 3 }) ?? "" : "";
  return unit ? `FOD-${unit}` : office || value?.trim() || "";
}

function leaveApplicantName(leave: ApprovedLeaveApplication) {
  if (leave.firstName && leave.lastName) {
    return [leave.firstName.trim(), leave.middleInitial?.trim(), leave.lastName.trim()].filter(Boolean).join(" ");
  }
  const storedName = leave.name?.trim() ?? "";
  if (!storedName) return "";
  const comma = storedName.indexOf(",");
  const last = comma < 0 ? "" : storedName.slice(0, comma).trim();
  const given = (comma < 0 ? storedName : storedName.slice(comma + 1)).trim().split(/\s+/).filter(Boolean);
  if (!given.length) return storedName;
  const first = given[0];
  const parsedLast = last || (given.length > 1 ? given[given.length - 1] : "");
  const middleName = last ? given.slice(1).join(" ") : given.slice(1, -1).join(" ");
  const initialSource = middleName.split(/\s+/)[0]?.replace(/\.+$/, "");
  const initial = initialSource ? `${Array.from(initialSource)[0].toLocaleUpperCase()}.` : "";
  return [first, initial, parsedLast].filter(Boolean).join(" ");
}

function middleInitial(value: string) {
  const first = value.trim().split(/\s+/)[0]?.replace(/\.+$/, "");
  const initial = first ? Array.from(first)[0] : "";
  return initial ? `${initial.toLocaleUpperCase()}.` : "";
}

function parseLeaveName(value: string) {
  const trimmed = value.trim().replace(/\s+/g, " ");
  const comma = trimmed.indexOf(",");
  if (comma >= 0) {
    const lastName = trimmed.slice(0, comma).trim();
    const given = trimmed.slice(comma + 1).trim().split(" ").filter(Boolean);
    return { firstName: given[0] ?? "", middleName: given.slice(1).join(" "), lastName };
  }
  const parts = trimmed.split(" ").filter(Boolean);
  return { firstName: parts[0] ?? "", middleName: parts.slice(1, -1).join(" "), lastName: parts.length > 1 ? parts[parts.length - 1] : "" };
}

function leaveApplicationPurpose(leave: ApprovedLeaveApplication) {
  return leave.leaveType;
}

function approvedPermitNumber(permit: Pick<ApprovedPermitSlip, "permitNo" | "approvedPermitNo">, assignedNumbers: Record<string, string>) {
  const originalNumber = displayPermitNumber(permit.permitNo);
  return displayPermitNumber(permit.approvedPermitNo ?? assignedNumbers[originalNumber] ?? originalNumber);
}

async function publishExistingApprovedPermits(firestore: Firestore) {
  const [permitSnapshot, calendarSnapshot] = await Promise.all([
    getDocs(collection(firestore, "permits")),
    getDocs(collection(firestore, "approvedPermitCalendar")),
  ]);
  const existingCalendarEntries = new Map(calendarSnapshot.docs.map((item) => [item.id, item.data()]));
  const missingEntries: { id: string; data: Omit<ApprovedPermitSlip, "id"> & { permitId: string; statusKey: string } }[] = [];

  permitSnapshot.docs.forEach((item) => {
    const permit = { id: item.id, ...item.data() } as StoredPermit;
    const names = Array.isArray(permit.names) ? permit.names : permit.name ? [permit.name] : [];
    names.forEach((name, index) => {
      const permitNo = typeof permit.permitNos?.[index] === "string" && permit.permitNos[index]
        ? permit.permitNos[index]
        : typeof permit.permitNo === "string" ? permit.permitNo : "";
      const statusKey = permit.permitNos?.[index] || (names.length > 1 ? `${permitNo || permit.id}__person_${index + 1}` : permitNo || permit.id);
      const calendarId = `${permit.id}_${encodeURIComponent(statusKey)}`;
      const decision = permit.personStatuses?.[statusKey];
      const existingEntry = existingCalendarEntries.get(calendarId);
      if (decision?.status !== "Approved" || !permit.date || !name
        || (existingEntry && existingEntry.approvedPermitNo === decision.approvedPermitNo
          && existingEntry.ownerId === permit.ownerId
          && existingEntry.userId === permit.personIds?.[index])) return;
      missingEntries.push({
        id: calendarId,
        data: { permitId: permit.id, statusKey, status: "Approved", permitNo, ...(decision.approvedPermitNo ? { approvedPermitNo: decision.approvedPermitNo } : {}), ...(permit.personIds?.[index] ? { userId: permit.personIds[index] } : {}), name, date: permit.date, purpose: permit.purpose ?? "", unit: permit.personUnits?.[index] ?? permit.unit ?? "", ...(permit.ownerId ? { ownerId: permit.ownerId } : {}) },
      });
    });
  });

  for (let index = 0; index < missingEntries.length; index += 20) {
    await Promise.all(missingEntries.slice(index, index + 20).map(({ id, data }) => setDoc(doc(firestore, "approvedPermitCalendar", id), data)));
  }
}

function dateKey(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizePersonnelName(value: string) {
  const trimmed = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  const comma = trimmed.indexOf(",");
  const ordered = comma >= 0
    ? `${trimmed.slice(comma + 1)} ${trimmed.slice(0, comma)}`
    : trimmed;
  return ordered.toLocaleLowerCase()
    .replace(/[.'’`]/g, "")
    .replace(/[-‐‑‒–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function personnelNameParts(value: string) {
  const parts = normalizePersonnelName(value).split(" ").filter(Boolean);
  return { first: parts[0] ?? "", last: parts[parts.length - 1] ?? "" };
}

function personnelIdentityKey(name: string, userId: string | undefined, accounts: ReadonlyMap<string, { name: string }>) {
  const normalizedName = normalizePersonnelName(name);
  if (!normalizedName || normalizedName === "not specified") return "";

  const knownAccountName = userId ? accounts.get(userId)?.name : undefined;
  if (knownAccountName) return `name:${normalizePersonnelName(knownAccountName)}`;
  if (userId) return `id:${userId}`;

  const parts = personnelNameParts(name);
  if (parts.first && parts.last) {
    const matchingAccounts = [...accounts.values()].filter((account) => {
      const accountParts = personnelNameParts(account.name);
      return accountParts.first === parts.first && accountParts.last === parts.last;
    });
    if (matchingAccounts.length === 1) return `name:${normalizePersonnelName(matchingAccounts[0].name)}`;
  }
  return `name:${normalizedName}`;
}

function countUniquePersonnel(names: string[]) {
  return new Set(names.map(normalizePersonnelName).filter(Boolean)).size;
}

function formatCalendarDate(value: string, options: Intl.DateTimeFormatOptions = { month: "long", day: "numeric", year: "numeric" }) {
  if (!value) return "";
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-PH", options).format(new Date(year, month - 1, day));
}

function formatCalendarDateRange(from: string, to: string) {
  if (!from || !to) return [formatCalendarDate(from), formatCalendarDate(to)].filter(Boolean).join(" - ");
  if (from === to) return formatCalendarDate(from);

  const [startYear, startMonth, startDay] = from.split("-").map(Number);
  const [endYear, endMonth, endDay] = to.split("-").map(Number);
  const startMonthName = formatCalendarDate(from, { month: "long" });
  const endMonthName = formatCalendarDate(to, { month: "long" });
  if (startYear === endYear && startMonth === endMonth) {
    return `${startMonthName} ${startDay}-${endDay}, ${startYear}`;
  }

  const startDate = `${startMonthName} ${startDay}${startYear === endYear ? "" : `, ${startYear}`}`;
  return `${startDate} - ${endMonthName} ${endDay}, ${endYear}`;
}

export default function WhereaboutsCalendarModule({ user, accountRole, office, division, unit, assignment, onViewApprovedDocument }: { user: User; accountRole: AccountRole; office: string; division?: string; unit?: string; assignment?: string; onViewApprovedDocument?: (record: { id: string; type: ApprovedArchiveDocumentType; data: Record<string, unknown>; readOnly: true }) => void }) {
  const canFilterOfficeAssignment = isPermitAdmin(user.email, accountRole);
  const accountScope = division !== undefined || unit !== undefined
    ? accountProfileSelection({ office, division: division ?? "", unit: unit ?? "", profileFieldsVersion: 4 })
    : accountProfileSelection({ office, assignment: assignment ?? "", profileFieldsVersion: 3 });
  const defaultDivisionFilter = canFilterOfficeAssignment ? "All" : accountScope.division || "All";
  const defaultUnitFilter: PermitUnitFilter = canFilterOfficeAssignment ? "All" : accountScope.unit || accountScope.division || "All";
  const today = new Date();
  const todayKey = dateKey(today.getFullYear(), today.getMonth(), today.getDate());
  const [orders, setOrders] = useState<CalendarTravelOrder[]>([]);
  const [permitSlips, setPermitSlips] = useState<ApprovedPermitSlip[]>([]);
  const [leaveApplications, setLeaveApplications] = useState<ApprovedLeaveApplication[]>([]);
  const [calendarsOfActivities, setCalendarsOfActivities] = useState<ApprovedCalendarOfActivities[]>([]);
  const [approvedSpecialOrders, setApprovedSpecialOrders] = useState<ApprovedArchiveRecord[]>([]);
  const [approvedNtas, setApprovedNtas] = useState<ApprovedArchiveRecord[]>([]);
  const [approvedArchiveLoading, setApprovedArchiveLoading] = useState(true);
  const [approvedArchiveError, setApprovedArchiveError] = useState("");
  const [totalPersonnelCount, setTotalPersonnelCount] = useState<number | null>(null);
  const [totalPersonnelLoading, setTotalPersonnelLoading] = useState(true);
  const [accountScopes, setAccountScopes] = useState<Map<string, { office: string; division: string; unit: string; name: string }>>(() => new Map());
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDate, setSelectedDate] = useState(todayKey);
  const [nameSearch, setNameSearch] = useState("");
  const [documentFilter, setDocumentFilter] = useState<"permit" | "travel" | "leave">("permit");
  const [approvedArchiveFilter, setApprovedArchiveFilter] = useState<"all" | "so" | "nta" | "calendar">("all");
  const [approvedArchiveSearch, setApprovedArchiveSearch] = useState("");
  const [approvedArchivePage, setApprovedArchivePage] = useState(0);
  const [divisionFilter, setDivisionFilter] = useState(defaultDivisionFilter);
  const [unitFilter, setUnitFilter] = useState<PermitUnitFilter>(defaultUnitFilter);
  const [selectedPeoplePage, setSelectedPeoplePage] = useState(0);
  const [permitPage, setPermitPage] = useState(0);
  const [travelPage, setTravelPage] = useState(0);
  const [leavePage, setLeavePage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const approvedPermitNumbers = useMemo(() => assignApprovedPermitNumbers(permitSlips), [permitSlips]);

  useEffect(() => { setSelectedPeoplePage(0); }, [selectedDate]);
  useEffect(() => {
    setDivisionFilter(defaultDivisionFilter);
    setUnitFilter(defaultUnitFilter);
  }, [defaultDivisionFilter, defaultUnitFilter]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setOrders([]);
    setPermitSlips([]);
    setLeaveApplications([]);
    setCalendarsOfActivities([]);
    setApprovedSpecialOrders([]);
    setApprovedNtas([]);
    setApprovedArchiveLoading(true);
    setApprovedArchiveError("");
    setAccountScopes(new Map());
    setTotalPersonnelCount(null);
    setTotalPersonnelLoading(true);
    setError("");
    if (!db) { setError("Firebase is not configured."); setLoading(false); setTotalPersonnelLoading(false); setApprovedArchiveLoading(false); return () => { active = false; }; }
    const firestore = db;
    void getDocs(collection(firestore, "users")).then((snapshot) => {
      if (!active) return;
      const scopes = new Map<string, { office: string; division: string; unit: string; name: string }>();
      snapshot.docs.forEach((account) => {
        const profile = accountProfileSelection(account.data());
        scopes.set(account.id, {
          office: profile.office,
          division: profile.division,
          unit: profile.unit || profile.division,
          name: typeof account.data().name === "string" ? account.data().name.trim() : "",
        });
      });
      setAccountScopes(scopes);
      setTotalPersonnelCount(countUniquePersonnel([...scopes.values()].map((person) => person.name)));
    }).catch(() => {
      if (active) setTotalPersonnelCount(null);
    }).finally(() => {
      if (active) setTotalPersonnelLoading(false);
    });
    if (isPermitAdmin(user.email, accountRole)) {
      void publishExistingApprovedPermits(firestore).catch((cause) => {
        const code = (cause as { code?: string }).code;
        if (active) setError(code ? `Could not sync approved Permit Slips (${code}).` : "Could not sync approved Permit Slips.");
      });
    }
    const initialSources = new Set(["travel", "permits", "leave", "leave-backfill"]);
    const initialArchiveSources = new Set(["special-orders", "ntas"]);
    const finishArchiveLoad = (source: string) => {
      initialArchiveSources.delete(source);
      if (active && initialArchiveSources.size === 0) setApprovedArchiveLoading(false);
    };
    const finishInitialLoad = (source: string) => {
      initialSources.delete(source);
      if (active && initialSources.size === 0) setLoading(false);
    };
    const unsubscribeTravel = onSnapshot(query(collection(firestore, "travelOrders"), where("status", "in", ["Approved", "Pending", LEGACY_PENDING_STATUS])), (snapshot) => {
      const calendarOrders = snapshot.docs.map((item) => {
        const data = item.data();
        return { id: item.id, ...data, status: normalizeWorkflowStatus(data.status) } as CalendarTravelOrder;
      }).filter((order) => order.departureDate && order.returnDate);
      if (active) setOrders(calendarOrders);
      finishInitialLoad("travel");
    }, (cause) => {
      const code = (cause as { code?: string }).code;
      if (active) setError(code ? `Could not load Travel Orders (${code}).` : "Could not load Travel Orders. Refresh and try again.");
      finishInitialLoad("travel");
    });
    const unsubscribeCalendarsOfActivities = onSnapshot(collection(firestore, calendarOfActivitiesCollection), (snapshot) => {
      const approved = snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as ApprovedCalendarOfActivities))
        .filter((plan) => plan.month && Array.isArray(plan.activities));
      if (active) setCalendarsOfActivities(approved);
    }, (cause) => {
      const code = (cause as { code?: string }).code;
      if (active) setError(code ? `Could not load Calendar of Activities (${code}).` : "Could not load Calendar of Activities. Refresh and try again.");
    });
    const unsubscribeApprovedSpecialOrders = onSnapshot(collection(firestore, "specialOrders"), (snapshot) => {
      const records = snapshot.docs.map((item) => ({ id: item.id, data: { ...item.data(), id: item.id } }));
      if (active) setApprovedSpecialOrders(records);
      finishArchiveLoad("special-orders");
    }, (cause) => {
      const code = (cause as { code?: string }).code;
      if (active) setApprovedArchiveError((current) => current || (code ? `Could not load Special Orders (${code}).` : "Could not load Special Orders."));
      finishArchiveLoad("special-orders");
    });
    const unsubscribeApprovedNtas = onSnapshot(collection(firestore, "ntaRecords"), (snapshot) => {
      const records = snapshot.docs.map((item) => ({ id: item.id, data: { ...item.data(), id: item.id } }));
      if (active) setApprovedNtas(records);
      finishArchiveLoad("ntas");
    }, (cause) => {
      const code = (cause as { code?: string }).code;
      if (active) setApprovedArchiveError((current) => current || (code ? `Could not load Notices to Attend (${code}).` : "Could not load Notices to Attend."));
      finishArchiveLoad("ntas");
    });
    const unsubscribePermits = onSnapshot(collection(firestore, "approvedPermitCalendar"), (snapshot) => {
      const approved = snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as ApprovedPermitSlip))
        .filter((permit) => permit.status === "Approved" && permit.date && permit.name);
      if (active) setPermitSlips(approved);
      finishInitialLoad("permits");
    }, (cause) => {
      const code = (cause as { code?: string }).code;
      if (active) setError(code ? `Could not load approved Permit Slips (${code}).` : "Could not load approved Permit Slips. Refresh and try again.");
      finishInitialLoad("permits");
    });
    const unsubscribeLeaveApplications = onSnapshot(query(collection(firestore, "approvedLeaveCalendar"), where("status", "in", ["Approved", "Pending"])), (snapshot) => {
      const approved = snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as ApprovedLeaveApplication))
        .filter((leave) => ["Approved", "Pending"].includes(leave.status)
          && leave.inclusiveDateFrom && leave.inclusiveDateTo && ((leave.firstName && leave.lastName) || leave.name));
      if (active) setLeaveApplications(approved);
      finishInitialLoad("leave");
    }, (cause) => {
      const code = (cause as { code?: string }).code;
      if (active) setError(code ? `Could not load Leave Applications (${code}).` : "Could not load Leave Applications. Refresh and try again.");
      finishInitialLoad("leave");
    });
    let legacyLeaveBackfillComplete = false;
    const unsubscribeLeaveBackfill = onSnapshot(query(collection(firestore, "leaveApplications"), where("ownerId", "==", user.uid)), { includeMetadataChanges: true }, (snapshot) => {
      if (snapshot.metadata.fromCache || legacyLeaveBackfillComplete) return;
      legacyLeaveBackfillComplete = true;
      const activeLeaveRecords = snapshot.docs.flatMap((item) => {
        const data = item.data();
        if (!(data.status === "Approved" || data.status === "Pending")
          || typeof data.name !== "string" || !data.name.trim()
          || typeof data.office !== "string" || typeof data.leaveType !== "string"
          || typeof data.inclusiveDateFrom !== "string" || typeof data.inclusiveDateTo !== "string") return [];
        const parsedName = parseLeaveName(data.name);
        const firstName = typeof data.firstName === "string" ? data.firstName : parsedName.firstName;
        const middleName = typeof data.middleName === "string" ? data.middleName : parsedName.middleName;
        const lastName = typeof data.lastName === "string" ? data.lastName : parsedName.lastName;
        return [{ leaveApplicationId: item.id, ownerId: user.uid, status: data.status, firstName, middleInitial: middleInitial(middleName), lastName, office: data.office, leaveType: data.leaveType, inclusiveDateFrom: data.inclusiveDateFrom, inclusiveDateTo: data.inclusiveDateTo }];
      });
      void (async () => {
        for (let index = 0; index < activeLeaveRecords.length; index += 10) {
          const batch = writeBatch(firestore);
          activeLeaveRecords.slice(index, index + 10).forEach((record) => {
            batch.set(doc(firestore, "approvedLeaveCalendar", record.leaveApplicationId), record);
          });
          await batch.commit();
        }
      })().then(() => finishInitialLoad("leave-backfill")).catch((cause) => {
        const code = (cause as { code?: string }).code;
        if (active) setError(code ? `Could not sync existing Leave Applications (${code}).` : "Could not sync existing Leave Applications.");
        finishInitialLoad("leave-backfill");
      });
    }, (cause) => {
      const code = (cause as { code?: string }).code;
      if (active) setError(code ? `Could not sync existing Leave Applications (${code}).` : "Could not sync existing Leave Applications.");
      finishInitialLoad("leave-backfill");
    });
    return () => { active = false; unsubscribeTravel(); unsubscribeCalendarsOfActivities(); unsubscribeApprovedSpecialOrders(); unsubscribeApprovedNtas(); unsubscribePermits(); unsubscribeLeaveApplications(); unsubscribeLeaveBackfill(); };
  }, [user.uid, user.email, accountRole, office, division, unit, assignment]);

  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const monthName = new Intl.DateTimeFormat("en-PH", { month: "long", year: "numeric" }).format(month);
  const leadingDays = new Date(year, monthIndex, 1).getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cellCount = Math.ceil((leadingDays + daysInMonth) / 7) * 7;
  const cells = Array.from({ length: cellCount }, (_, index) => {
    const day = index - leadingDays + 1;
    return day > 0 && day <= daysInMonth ? day : null;
  });

  const unitMatchesFilter = (recordUnit: string, selectedUnit: string) => {
    if (selectedUnit === "All") return true;
    const normalizedRecord = normalizeUnit(recordUnit);
    const normalizedSelected = normalizeUnit(selectedUnit);
    return normalizedRecord && normalizedSelected
      ? normalizedRecord === normalizedSelected
      : recordUnit.trim().toLocaleLowerCase() === selectedUnit.trim().toLocaleLowerCase();
  };
  const recordMatchesSelectedScope = (recordOffice?: string, recordDivision?: string, recordUnit?: string) => {
    const inferredOffice = recordOffice
      || (recordDivision && accountDivisionOptions.includes(recordDivision as (typeof accountDivisionOptions)[number]) ? "Division" : "")
      || (recordDivision && executiveOfficeDivisionOptions.includes(recordDivision as (typeof executiveOfficeDivisionOptions)[number]) ? "Office of the Regional Executive Director" : "")
      || (recordDivision && accountOfficeOptions.find((officeOption) => divisionsForOffice(officeOption).includes(recordDivision)))
      || (recordUnit && normalizeUnit(recordUnit) ? "Division" : "")
      || accountOfficeOptions.find((officeOption) => divisionsForOffice(officeOption).some((divisionOption) => unitsForOfficeDivision(officeOption, divisionOption).some((option) => option.toLocaleLowerCase() === recordUnit?.trim().toLocaleLowerCase())))
      || accountScope.office
      || "";
    const candidate = recordDivision
      ? accountProfileSelection({ office: accountOffice({ office: inferredOffice, profileFieldsVersion: 3 }) ?? inferredOffice, division: recordDivision, unit: recordUnit ?? "", profileFieldsVersion: 4 })
      : accountProfileSelection({ office: recordOffice || inferredOffice, assignment: recordUnit ?? "", profileFieldsVersion: 3 });
    if (divisionFilter !== "All" && candidate.division !== divisionFilter) return false;
    return unitMatchesFilter(candidate.unit || candidate.division || recordUnit || "", unitFilter);
  };
  const recordMatchesAccountScope = (ownerId?: string, recordUnit?: string, recordOffice?: string, recordName?: string) => {
    const ownerScope = ownerId ? accountScopes.get(ownerId) : undefined;
    if (ownerScope?.office) return recordMatchesSelectedScope(ownerScope.office, ownerScope.division, ownerScope.unit);
    const normalizedUnit = normalizeUnit(recordUnit);
    const normalizedName = recordName?.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    if (normalizedName) {
      const matchingPeople = [...accountScopes.values()].filter((person) => {
        const nameMatches = person.name.trim().replace(/\s+/g, " ").toLocaleLowerCase() === normalizedName;
        return nameMatches && (!recordUnit || unitMatchesFilter(person.unit, normalizedUnit || recordUnit));
      });
      if (matchingPeople.length) return matchingPeople.some((person) => recordMatchesSelectedScope(person.office, person.division, person.unit));
    }
    if (divisionFilter === "All" && unitFilter === "All" && !recordOffice && !recordUnit) return true;
    const fallbackOffice = recordOffice || (normalizedUnit ? "Division" : accountScope.office);
    return recordMatchesSelectedScope(fallbackOffice, undefined, normalizedUnit || recordUnit || "");
  };
  const recordUnitForFilter = (ownerId?: string, fallbackUnit?: string) =>
    accountScopes.get(ownerId ?? "")?.unit || normalizeUnit(fallbackUnit) || fallbackUnit || "";
  const availableSummaryDivisions = [...new Set([...accountDivisionOptions, ...executiveOfficeDivisionOptions])];
  const availableSummaryUnits = divisionFilter === "All"
    ? [...new Set(accountOfficeOptions.flatMap((officeOption) => divisionsForOffice(officeOption).flatMap((divisionOption) => unitsForOfficeDivision(officeOption, divisionOption))))]
    : [...new Set(accountOfficeOptions.flatMap((officeOption) => unitsForOfficeDivision(officeOption, divisionFilter)))];
  const calendarOrders = orders.filter((order) => recordMatchesAccountScope(order.ownerId, order.ownerUnit ?? order.chargeTo));
  const calendarPermitSlips = permitSlips.filter((permit) => recordMatchesAccountScope(permit.ownerId, permit.unit, undefined, permit.name));
  const calendarLeaveApplications = leaveApplications.filter((leave) => recordMatchesAccountScope(leave.ownerId, leave.office));

  function ordersOnDate(key: string) {
    return calendarOrders.filter((order) => order.departureDate <= key && order.returnDate >= key);
  }

  function peopleOnDate(key: string) {
    const people = [
      ...ordersOnDate(key).flatMap((order) => order.people ?? []),
      ...calendarPermitSlips.filter((permit) => permit.date === key),
      ...calendarLeaveApplications.filter((leave) => leave.inclusiveDateFrom <= key && leave.inclusiveDateTo >= key)
        .map((leave) => ({ name: leaveApplicantName(leave), userId: leave.ownerId })),
    ];
    const uniqueCount = new Set(people.map((person) => personnelIdentityKey(person.name, person.userId, accountScopes)).filter(Boolean)).size;
    return selectedPersonnelTotal === null ? uniqueCount : Math.min(uniqueCount, selectedPersonnelTotal);
  }

  function hasPendingItemOnDate(key: string) {
    return calendarOrders.some((order) => order.status === "Pending" && order.departureDate <= key && order.returnDate >= key)
      || calendarLeaveApplications.some((leave) => leave.status === "Pending" && leave.inclusiveDateFrom <= key && leave.inclusiveDateTo >= key);
  }

  function hasApprovedItemOnDate(key: string) {
    return calendarOrders.some((order) => order.status === "Approved" && order.departureDate <= key && order.returnDate >= key)
      || calendarPermitSlips.some((permit) => permit.date === key)
      || calendarLeaveApplications.some((leave) => leave.status === "Approved" && leave.inclusiveDateFrom <= key && leave.inclusiveDateTo >= key);
  }

  function holidaysOnDate(key: string) {
    return PHILIPPINE_HOLIDAYS_2026.filter((holiday) => holiday.date === key);
  }

  function changeMonth(offset: number) {
    const next = new Date(year, monthIndex + offset, 1);
    setMonth(next);
    setSelectedDate(dateKey(next.getFullYear(), next.getMonth(), 1));
    setSelectedPeoplePage(0);
    setPermitPage(0);
    setTravelPage(0);
    setLeavePage(0);
  }

  const selectedOrders = ordersOnDate(selectedDate);
  const selectedDateHolidays = holidaysOnDate(selectedDate);
  const selectedPermitSlips = calendarPermitSlips.filter((permit) => permit.date === selectedDate);
  const selectedPeopleEntries = [
    ...selectedOrders.flatMap((order) => {
      const people: CalendarTravelOrder["people"] = order.people?.length ? order.people : [{ name: "Not specified" }];
      return people.map((person, index) => ({
        id: `travel-${order.id}-${index}`,
        type: "Travel Order",
        status: order.status,
        name: person.name || "Not specified",
        number: person.toNumber?.trim() ? `TO No. ${person.toNumber.trim()}` : "",
        date: formatCalendarDateRange(order.departureDate, order.returnDate),
        sortDate: order.departureDate,
        sortEndDate: order.returnDate,
        purpose: order.purpose || "—",
        destination: order.placeOfTravel || "—",
        unit: order.chargeTo || "",
        personKey: personnelIdentityKey(person.name || "Not specified", person.userId, accountScopes),
      }));
    }),
    ...selectedPermitSlips.map((permit) => ({
      id: `permit-${permit.id}`,
      type: "Permit Slip",
      status: permit.status,
      name: permit.name,
      number: permit.approvedPermitNo || permit.permitNo ? `PS No. ${permit.approvedPermitNo ?? approvedPermitNumbers[displayPermitNumber(permit.permitNo)] ?? displayPermitNumber(permit.permitNo)}` : "",
      date: formatCalendarDate(permit.date),
      sortDate: permit.date,
      sortEndDate: permit.date,
      purpose: permit.purpose || "—",
      destination: "",
      unit: permit.unit || "",
      personKey: personnelIdentityKey(permit.name, permit.userId, accountScopes),
    })),
    ...calendarLeaveApplications.filter((leave) => leave.inclusiveDateFrom <= selectedDate && leave.inclusiveDateTo >= selectedDate).map((leave) => ({
      id: `leave-${leave.id}`,
      type: "Leave Application",
      status: leave.status,
      name: leaveApplicantName(leave) || "Not specified",
      number: "",
      date: formatCalendarDateRange(leave.inclusiveDateFrom, leave.inclusiveDateTo),
      sortDate: leave.inclusiveDateFrom,
      sortEndDate: leave.inclusiveDateTo,
      purpose: leaveApplicationPurpose(leave),
      destination: "",
      unit: leave.office || "",
      personKey: personnelIdentityKey(leaveApplicantName(leave) || "Not specified", leave.ownerId, accountScopes),
    })),
  ];
  const selectedPeopleByDetails = new Map<string, SelectedCalendarEntry>();
  selectedPeopleEntries.forEach((person) => {
    const entry: SelectedCalendarEntry = {
      id: person.id,
      type: person.type as SelectedCalendarEntry["type"],
      statuses: [person.status],
      names: [`${person.name}${person.number ? ` (${person.number})` : ""}`],
      personKeys: [person.personKey || `display:${normalizePersonnelName(person.name)}`],
      date: person.date,
      sortDate: person.sortDate,
      sortEndDate: person.sortEndDate,
      purpose: person.purpose,
      destination: person.destination,
      unit: person.unit,
    };
    const key = entry.type === "Leave Application" ? entry.id : JSON.stringify([entry.type, entry.date, entry.purpose, entry.destination, entry.unit]);
    const existing = selectedPeopleByDetails.get(key);
    if (existing) {
      if (!entry.personKeys.length) {
        existing.names.push(...entry.names);
      } else {
        entry.personKeys.forEach((personKey, index) => {
          const existingIndex = existing.personKeys.indexOf(personKey);
          const incomingName = entry.names[index] ?? "";
          if (existingIndex < 0) {
            existing.personKeys.push(personKey);
            existing.names.push(incomingName);
          } else if (incomingName.includes("(TO No.") && !existing.names[existingIndex]?.includes("(TO No.")) {
            existing.names[existingIndex] = incomingName;
          }
        });
      }
      existing.statuses = [...new Set([...existing.statuses, ...entry.statuses])];
    } else {
      selectedPeopleByDetails.set(key, entry);
    }
  });
  const selectedPeople = [...selectedPeopleByDetails.values()].sort((left, right) =>
    left.sortDate.localeCompare(right.sortDate)
    || left.sortEndDate.localeCompare(right.sortEndDate)
    || left.type.localeCompare(right.type));
  const rawPersonnelNotInOfficeCount = new Set(selectedPeopleEntries.map((person) => person.personKey).filter(Boolean)).size;
  const [selectedYear, selectedMonth, selectedDay] = selectedDate.split("-").map(Number);
  const selectedDateWeekday = new Date(selectedYear, selectedMonth - 1, selectedDay).getDay();
  const selectedNonWorkingHoliday = selectedDateHolidays.find((holiday) => holiday.category !== "Special (Working) Day");
  const zeroPersonnelMessage = selectedNonWorkingHoliday
    ? `Office is closed for ${selectedNonWorkingHoliday.name}.`
    : selectedDateWeekday === 6
      ? "Personnel are off duty on Saturday."
      : selectedDateWeekday === 0
        ? "Personnel are off duty on Sunday."
        : "All personnel are present in the office.";
  const selectedPeoplePageSize = 3;
  const selectedPeoplePageCount = Math.max(1, Math.ceil(selectedPeople.length / selectedPeoplePageSize));
  const currentSelectedPeoplePage = Math.min(selectedPeoplePage, selectedPeoplePageCount - 1);
  const visibleSelectedPeople = selectedPeople.slice(currentSelectedPeoplePage * selectedPeoplePageSize, currentSelectedPeoplePage * selectedPeoplePageSize + selectedPeoplePageSize);
  const summaryYear = String(year);
  const yearStart = `${summaryYear}-01-01`;
  const yearEnd = `${summaryYear}-12-31`;
  const normalizedSearch = nameSearch.trim().toLocaleLowerCase();
  const annualPermits = permitSlips
    .filter((permit) => permit.date >= yearStart && permit.date <= yearEnd)
    .filter((permit) => recordMatchesAccountScope(permit.ownerId, permit.unit, undefined, permit.name))
    .filter((permit) => !normalizedSearch || (permit.name ?? "").toLocaleLowerCase().includes(normalizedSearch))
    .filter((permit) => unitMatchesFilter(recordUnitForFilter(permit.ownerId, permit.unit), unitFilter))
    .sort((left, right) => approvedPermitNumber(right, approvedPermitNumbers).localeCompare(approvedPermitNumber(left, approvedPermitNumbers), "en", { numeric: true, sensitivity: "base" }) || right.date.localeCompare(left.date) || left.name.localeCompare(right.name));
  const annualOrders = orders
    .filter((order) => order.status === "Approved")
    .filter((order) => order.departureDate <= yearEnd && order.returnDate >= yearStart)
    .filter((order) => recordMatchesAccountScope(order.ownerId, order.ownerUnit ?? order.chargeTo))
    .filter((order) => !normalizedSearch || (order.people ?? []).some((person) => (person.name ?? "").toLocaleLowerCase().includes(normalizedSearch)))
    .filter((order) => unitMatchesFilter(recordUnitForFilter(order.ownerId, order.ownerUnit ?? order.chargeTo), unitFilter))
    .sort((left, right) =>
      right.departureDate.localeCompare(left.departureDate)
      || right.returnDate.localeCompare(left.returnDate));
  const annualLeaveApplications = leaveApplications
    .filter((leave) => leave.status === "Approved")
    .filter((leave) => leave.inclusiveDateFrom <= yearEnd && leave.inclusiveDateTo >= yearStart)
    .filter((leave) => recordMatchesAccountScope(leave.ownerId, leave.office))
    .filter((leave) => !normalizedSearch || leaveApplicantName(leave).toLocaleLowerCase().includes(normalizedSearch))
    .filter((leave) => unitMatchesFilter(recordUnitForFilter(leave.ownerId, leave.office), unitFilter))
    .sort((left, right) =>
      right.inclusiveDateFrom.localeCompare(left.inclusiveDateFrom)
      || right.inclusiveDateTo.localeCompare(left.inclusiveDateTo)
      || leaveApplicantName(left).localeCompare(leaveApplicantName(right)));
  const permitPageCount = Math.max(1, Math.ceil(annualPermits.length / 10));
  const travelPageCount = Math.max(1, Math.ceil(annualOrders.length / 10));
  const leavePageCount = Math.max(1, Math.ceil(annualLeaveApplications.length / 10));
  const currentPermitPage = Math.min(permitPage, permitPageCount - 1);
  const currentTravelPage = Math.min(travelPage, travelPageCount - 1);
  const currentLeavePage = Math.min(leavePage, leavePageCount - 1);
  const visibleAnnualPermits = annualPermits.slice(currentPermitPage * 10, currentPermitPage * 10 + 10);
  const visibleAnnualOrders = annualOrders.slice(currentTravelPage * 10, currentTravelPage * 10 + 10);
  const visibleAnnualLeaveApplications = annualLeaveApplications.slice(currentLeavePage * 10, currentLeavePage * 10 + 10);
  const approvedArchiveRows = useMemo(() => {
    const rows: ApprovedArchiveRow[] = [];
    approvedSpecialOrders.forEach((record) => {
      const data = record.data;
      const participants = Array.isArray(data.participants) ? data.participants.map(archiveText) : [];
      rows.push({ key: `so-${record.id}`, record, type: "Special Order", activityTitle: archiveText(data.activityTitle), designatedPersonnel: uniqueArchiveNames(participants), dateFrom: archiveText(data.dateFrom), dateTo: archiveText(data.dateTo), venue: archiveText(data.venue) });
    });
    approvedNtas.forEach((record) => {
      const data = record.data;
      const batches = Array.isArray(data.batches) ? data.batches as Record<string, unknown>[] : [];
      if (batches.length) {
        batches.forEach((batch, index) => {
          const attendees = Array.isArray(batch.attendees) ? (batch.attendees as Record<string, unknown>[]).map((attendee) => archiveText(attendee.name)) : [];
          rows.push({ key: `nta-${record.id}-${index}`, record, type: "Notice to Attend", activityTitle: archiveText(data.activityTitle), designatedPersonnel: uniqueArchiveNames(attendees), dateFrom: archiveText(batch.dateFrom) || archiveText(data.dateFrom), dateTo: archiveText(batch.dateTo) || archiveText(data.dateTo), venue: archiveText(batch.venue) || archiveText(batch.link) || archiveText(data.venue) || archiveText(data.link) });
        });
      } else {
        const attendees = Array.isArray(data.attendees) ? (data.attendees as Record<string, unknown>[]).map((attendee) => archiveText(attendee.name)) : [];
        rows.push({ key: `nta-${record.id}`, record, type: "Notice to Attend", activityTitle: archiveText(data.activityTitle), designatedPersonnel: uniqueArchiveNames([...attendees, archiveText(data.to)]), dateFrom: archiveText(data.dateFrom), dateTo: archiveText(data.dateTo), venue: archiveText(data.venue) || archiveText(data.link) });
      }
    });
    calendarsOfActivities.forEach((plan) => {
      plan.activities.forEach((activity, index) => rows.push({
        key: `calendar-${plan.id}-${index}`,
        record: { id: plan.id, data: plan as unknown as Record<string, unknown> },
        type: "Calendar of Activities",
        activityTitle: archiveText(activity.activity),
        designatedPersonnel: uniqueArchiveNames((activity.responsiblePeople ?? []).map((person) => archiveText(person.name))),
        dateFrom: archiveText(activity.dateFrom),
        dateTo: archiveText(activity.dateTo),
        venue: archiveText(activity.location),
      }));
    });
    return rows.sort((left, right) => right.dateFrom.localeCompare(left.dateFrom) || left.activityTitle.localeCompare(right.activityTitle));
  }, [approvedNtas, approvedSpecialOrders, calendarsOfActivities]);
  const normalizedArchiveSearch = approvedArchiveSearch.trim().toLocaleLowerCase();
  const filteredApprovedArchiveRows = approvedArchiveRows
    .filter((row) => approvedArchiveFilter === "all"
      || (approvedArchiveFilter === "so" && row.type === "Special Order")
      || (approvedArchiveFilter === "nta" && row.type === "Notice to Attend")
      || (approvedArchiveFilter === "calendar" && row.type === "Calendar of Activities"))
    .filter((row) => !normalizedArchiveSearch || row.designatedPersonnel.toLocaleLowerCase().includes(normalizedArchiveSearch));
  const approvedArchivePageCount = Math.max(1, Math.ceil(filteredApprovedArchiveRows.length / 5));
  const currentApprovedArchivePage = Math.min(approvedArchivePage, approvedArchivePageCount - 1);
  const visibleApprovedArchiveRows = filteredApprovedArchiveRows.slice(currentApprovedArchivePage * 5, currentApprovedArchivePage * 5 + 5);
  const selectedPersonnelTotal = (divisionFilter !== "All" || unitFilter !== "All")
    ? countUniquePersonnel([...accountScopes.values()].filter((person) => recordMatchesSelectedScope(person.office, person.division, person.unit)).map((person) => person.name))
    : totalPersonnelCount;
  const personnelNotInOfficeCount = selectedPersonnelTotal === null
    ? rawPersonnelNotInOfficeCount
    : Math.min(rawPersonnelNotInOfficeCount, selectedPersonnelTotal);
  return <section className="content-section whereabouts-calendar-section">
    <div className="section-heading whereabouts-heading"><div><p className="eyebrow">Travel, Leave, and Permit Records</p><h2>Whereabouts Calendar</h2><p className="muted">Select a date to view pending or approved Travel Orders and Leave Applications, approved Permit Slips, and 2026 Philippine holidays and special days.</p></div></div>
    <div className="whereabouts-calendar-filters" aria-label="Filter whereabouts calendar">
      <CalendarFilterDropdown label="Division" value={divisionFilter} options={[{ value: "All", label: "All Divisions" }, ...availableSummaryDivisions.map((option) => ({ value: option, label: option }))]} onChange={(value) => { setDivisionFilter(value); setUnitFilter("All"); setSelectedPeoplePage(0); setPermitPage(0); setTravelPage(0); setLeavePage(0); }} />
      <CalendarFilterDropdown label="Unit / Program / Project" value={unitFilter} options={[{ value: "All", label: "All Units / Programs / Projects" }, ...availableSummaryUnits.map((option) => ({ value: option, label: option }))]} onChange={(value) => { setUnitFilter(value as PermitUnitFilter); setSelectedPeoplePage(0); setPermitPage(0); setTravelPage(0); setLeavePage(0); }} />
    </div>
    {error && <div className="error-message whereabouts-error">{error}</div>}
    <section className="whereabouts-calendar" aria-label="Whereabouts and Philippine holiday calendar">
      <header className="whereabouts-calendar-toolbar"><button type="button" className="whereabouts-month-arrow" aria-label="Previous month" onClick={() => changeMonth(-1)}>‹</button><h3>{monthName}</h3><button type="button" className="whereabouts-month-arrow" aria-label="Next month" onClick={() => changeMonth(1)}>›</button><button type="button" className="whereabouts-today-button" onClick={() => { setMonth(new Date(today.getFullYear(), today.getMonth(), 1)); setSelectedDate(todayKey); setSelectedPeoplePage(0); setPermitPage(0); setTravelPage(0); setLeavePage(0); }}>Today</button></header>
      <div className="whereabouts-weekdays" aria-hidden="true">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((name, index) => <span className={index === 0 ? "whereabouts-weekday-sunday" : index === 6 ? "whereabouts-weekday-saturday" : undefined} key={name}>{name}</span>)}</div>
      <div className="whereabouts-days">
        {cells.map((day, index) => {
          if (day === null) return <span className="whereabouts-day whereabouts-day-empty" aria-hidden="true" key={`blank-${index}`} />;
          const key = dateKey(year, monthIndex, day);
          const peopleCount = peopleOnDate(key);
          const dayHolidays = holidaysOnDate(key);
          const selected = selectedDate === key;
          const hasPending = hasPendingItemOnDate(key);
          const hasApproved = hasApprovedItemOnDate(key);
          const statusClass = hasPending ? (hasApproved ? "whereabouts-day-mixed-status" : "whereabouts-day-pending") : hasApproved ? "whereabouts-day-approved" : "";
          const classes = ["whereabouts-day", statusClass, dayHolidays.length ? "whereabouts-day-holiday" : "", selected ? "whereabouts-day-selected" : ""].filter(Boolean).join(" ");
          const weekendNumberClass = index % 7 === 0 ? "whereabouts-day-number-sunday" : index % 7 === 6 ? "whereabouts-day-number-saturday" : "";
          const holidayLabel = dayHolidays.map((holiday) => `${holiday.name} (${holiday.category})`).join(", ");
          const label = `${formatCalendarDate(key, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}${peopleCount ? `, ${peopleCount} ${peopleCount === 1 ? "person" : "people"} out of office` : ", no personnel out of office"}${hasPending ? ", includes a Pending Travel Order or Leave Application" : ""}${holidayLabel ? `, ${holidayLabel}` : ""}`;
          return <button type="button" className={classes} aria-label={label} aria-pressed={selected} key={key} onClick={() => { setSelectedDate(key); setSelectedPeoplePage(0); }}><span className={`whereabouts-day-number ${weekendNumberClass}`}>{day}</span>{dayHolidays.map((holiday) => <span key={holiday.name} title={holiday.name} className={`whereabouts-day-holiday-label whereabouts-day-holiday-${holidayCategoryClass[holiday.category]}`}>{holiday.name}</span>)}{peopleCount > 0 && <span className="whereabouts-day-count">{peopleCount}</span>}</button>;
        })}
      </div>
      <div className="whereabouts-legend"><span><i className="whereabouts-legend-approved" />Approved</span><span><i className="whereabouts-legend-pending" />Pending</span><span><i className="whereabouts-legend-mixed" />Approved and Pending</span><span><i className="whereabouts-legend-holiday" />Holiday / Special Day</span></div>
    </section>
    <section className="whereabouts-date-details" aria-live="polite">
      <div className="whereabouts-details-heading"><div><p className="eyebrow">Selected date</p><h3>{formatCalendarDate(selectedDate)}</h3></div><span className="whereabouts-detail-count">{loading ? "Loading..." : `${selectedPeople.length} ${selectedPeople.length === 1 ? "entry" : "entries"}`}</span></div>
      {loading ? <p className="whereabouts-personnel-count"><span>No. of Personnel Out of Office</span><strong>Loading...</strong><span>of</span><strong>Loading...</strong></p> : personnelNotInOfficeCount === 0 ? <p className="whereabouts-personnel-count">{zeroPersonnelMessage}</p> : <p className="whereabouts-personnel-count"><span>No. of Personnel Out of Office</span><strong>{personnelNotInOfficeCount}</strong><span>of</span><strong>{totalPersonnelLoading ? "Loading..." : selectedPersonnelTotal ?? "Unavailable"}</strong></p>}
      {selectedDateHolidays.length > 0 && <div className="whereabouts-holiday-details" aria-label="Philippine holiday and special day">
        <strong>Philippine Holiday / Special Day</strong>
        {selectedDateHolidays.map((holiday) => <p key={holiday.name}><span>{holiday.name}</span><small>{holiday.category}</small></p>)}
      </div>}
      {loading ? <p className="muted">Loading Travel Orders, Permit Slips, and Leave Applications...</p> : personnelNotInOfficeCount === 0 ? null : selectedPeople.length === 0 ? <p className="whereabouts-empty-date">No Travel Orders, Permit Slips, or Leave Applications on this date.</p> : <>
        {selectedPeoplePageCount > 1 && <nav className="whereabouts-pagination whereabouts-date-pagination" aria-label="Selected date people pages"><button type="button" onClick={() => setSelectedPeoplePage((page) => Math.max(0, page - 1))} disabled={currentSelectedPeoplePage === 0}>Previous</button><span aria-live="polite">Page {currentSelectedPeoplePage + 1} of {selectedPeoplePageCount}</span><button type="button" onClick={() => setSelectedPeoplePage((page) => Math.min(selectedPeoplePageCount - 1, page + 1))} disabled={currentSelectedPeoplePage >= selectedPeoplePageCount - 1}>Next</button></nav>}
        <div className="whereabouts-date-table-wrap"><table className="whereabouts-date-table"><thead><tr><th>Person</th><th>Date</th><th>Purpose / Destination</th></tr></thead><tbody>
          {visibleSelectedPeople.map((person) => <tr key={person.id}><td><span className="whereabouts-date-person-type">{person.type}</span>{person.statuses.map((status) => <span key={status} className={`whereabouts-status-label whereabouts-status-label-${status.toLowerCase()}`}>{status}</span>)}<strong>{person.names.join(", ")}</strong>{person.unit && <small>{displayUnit(person.unit)}</small>}</td><td>{person.date}</td><td className="whereabouts-date-purpose">{person.purpose}{person.destination && <small>{person.destination}</small>}</td></tr>)}
        </tbody></table></div>
      </>}
    </section>
    <section className="whereabouts-annual-summary" aria-label={`Whereabouts records for ${summaryYear}`}>
      <header className="whereabouts-summary-heading"><div><p className="eyebrow">Annual summary</p><h2>Approved Records — {summaryYear}</h2></div></header>
      <div className={`whereabouts-summary-filters${canFilterOfficeAssignment ? "" : " whereabouts-summary-filters-regular"}`}>
        <label>Approved Document<select value={documentFilter} onChange={(event) => setDocumentFilter(event.target.value as "permit" | "travel" | "leave")}><option value="permit">Permit Slips</option><option value="travel">Travel Orders</option><option value="leave">Leave Applications</option></select></label>
        <label>Name Search<input type="search" value={nameSearch} onChange={(event) => { setNameSearch(event.target.value); setPermitPage(0); setTravelPage(0); setLeavePage(0); }} placeholder="Search by Name" /></label>
      </div>
      {documentFilter === "permit" && <section className="whereabouts-summary-table-section" aria-labelledby="whereabouts-permit-summary-title">
        <div className="whereabouts-summary-table-heading"><h3 id="whereabouts-permit-summary-title">Approved Permit Slips</h3><span>{annualPermits.length === 0 ? "0 records" : `${currentPermitPage * 10 + 1}–${Math.min(currentPermitPage * 10 + visibleAnnualPermits.length, annualPermits.length)} of ${annualPermits.length}`}</span></div>
        <div className="whereabouts-summary-table-wrap"><table className="whereabouts-summary-table"><thead><tr><th>Date</th><th>Name</th><th>Office</th><th>Purpose</th></tr></thead><tbody>
          {visibleAnnualPermits.map((permit) => <tr key={`annual-permit-${permit.id}`}><td>{formatCalendarDate(permit.date)}</td><td>{permit.name}{permit.approvedPermitNo || permit.permitNo ? ` (PS No. ${permit.approvedPermitNo ?? approvedPermitNumbers[displayPermitNumber(permit.permitNo)] ?? displayPermitNumber(permit.permitNo)})` : ""}</td><td>{permit.unit ? displayUnit(permit.unit) : "—"}</td><td>{permit.purpose || "—"}</td></tr>)}
          {!loading && visibleAnnualPermits.length === 0 && <tr><td className="whereabouts-summary-empty" colSpan={4}>No approved Permit Slips match this year and filter.</td></tr>}
          {loading && <tr><td className="whereabouts-summary-empty" colSpan={4}>Loading approved Permit Slips…</td></tr>}
        </tbody></table></div>
        {permitPageCount > 1 && <nav className="whereabouts-pagination" aria-label="Approved Permit Slips pages"><button type="button" onClick={() => setPermitPage((page) => Math.max(0, page - 1))} disabled={currentPermitPage === 0}>Previous</button><span aria-live="polite">Page {currentPermitPage + 1} of {permitPageCount}</span><button type="button" onClick={() => setPermitPage((page) => Math.min(permitPageCount - 1, page + 1))} disabled={currentPermitPage >= permitPageCount - 1}>Next</button></nav>}
      </section>}
      {documentFilter === "travel" && <section className="whereabouts-summary-table-section" aria-labelledby="whereabouts-travel-summary-title">
        <div className="whereabouts-summary-table-heading"><h3 id="whereabouts-travel-summary-title">Approved Travel Orders</h3><span>{annualOrders.length === 0 ? "0 records" : `${currentTravelPage * 10 + 1}–${Math.min(currentTravelPage * 10 + visibleAnnualOrders.length, annualOrders.length)} of ${annualOrders.length}`}</span></div>
        <div className="whereabouts-summary-table-wrap"><table className="whereabouts-summary-table"><thead><tr><th>Name</th><th>Departure From To</th><th>Destination</th><th>Purpose</th></tr></thead><tbody>
          {visibleAnnualOrders.map((order) => <tr key={`annual-travel-${order.id}`}><td>{(order.people ?? []).map((person) => person.name ? `${person.name}${person.toNumber?.trim() ? ` (TO No. ${person.toNumber.trim()})` : ""}` : "").filter(Boolean).join(", ") || "Not specified"}</td><td>{formatCalendarDateRange(order.departureDate, order.returnDate)}</td><td>{order.placeOfTravel || "—"}</td><td>{order.purpose || "—"}</td></tr>)}
          {!loading && visibleAnnualOrders.length === 0 && <tr><td className="whereabouts-summary-empty" colSpan={4}>No Travel Orders match this year and filter.</td></tr>}
          {loading && <tr><td className="whereabouts-summary-empty" colSpan={4}>Loading Travel Orders…</td></tr>}
        </tbody></table></div>
        {travelPageCount > 1 && <nav className="whereabouts-pagination" aria-label="Travel Order pages"><button type="button" onClick={() => setTravelPage((page) => Math.max(0, page - 1))} disabled={currentTravelPage === 0}>Previous</button><span aria-live="polite">Page {currentTravelPage + 1} of {travelPageCount}</span><button type="button" onClick={() => setTravelPage((page) => Math.min(travelPageCount - 1, page + 1))} disabled={currentTravelPage >= travelPageCount - 1}>Next</button></nav>}
      </section>}
      {documentFilter === "leave" && <section className="whereabouts-summary-table-section" aria-labelledby="whereabouts-leave-summary-title">
        <div className="whereabouts-summary-table-heading"><h3 id="whereabouts-leave-summary-title">Approved Leave Applications</h3><span>{annualLeaveApplications.length === 0 ? "0 records" : `${currentLeavePage * 10 + 1}–${Math.min(currentLeavePage * 10 + visibleAnnualLeaveApplications.length, annualLeaveApplications.length)} of ${annualLeaveApplications.length}`}</span></div>
        <div className="whereabouts-summary-table-wrap"><table className="whereabouts-summary-table"><thead><tr><th>Name</th><th>Inclusive Dates</th><th>Office</th><th>Type of Leave</th></tr></thead><tbody>
          {visibleAnnualLeaveApplications.map((leave) => <tr key={`annual-leave-${leave.id}`}><td>{leaveApplicantName(leave)}</td><td>{formatCalendarDateRange(leave.inclusiveDateFrom, leave.inclusiveDateTo)}</td><td>{displayUnit(leave.office) || "—"}</td><td>{leave.leaveType}</td></tr>)}
          {!loading && visibleAnnualLeaveApplications.length === 0 && <tr><td className="whereabouts-summary-empty" colSpan={4}>No approved Leave Applications match this year and filter.</td></tr>}
          {loading && <tr><td className="whereabouts-summary-empty" colSpan={4}>Loading approved Leave Applications…</td></tr>}
        </tbody></table></div>
        {leavePageCount > 1 && <nav className="whereabouts-pagination" aria-label="Approved Leave Applications pages"><button type="button" onClick={() => setLeavePage((page) => Math.max(0, page - 1))} disabled={currentLeavePage === 0}>Previous</button><span aria-live="polite">Page {currentLeavePage + 1} of {leavePageCount}</span><button type="button" onClick={() => setLeavePage((page) => Math.min(leavePageCount - 1, page + 1))} disabled={currentLeavePage >= leavePageCount - 1}>Next</button></nav>}
      </section>}
    </section>
    <section className="whereabouts-approved-archive" aria-label="SO, NTA, Calendar of Activities">
      <header className="whereabouts-summary-heading"><div><p className="eyebrow">Public records</p><h2>SO, NTA, Calendar of Activities</h2></div></header>
      <div className="whereabouts-summary-filters whereabouts-approved-archive-filters">
        <label>Approved Document<select value={approvedArchiveFilter} onChange={(event) => { setApprovedArchiveFilter(event.target.value as "all" | "so" | "nta" | "calendar"); setApprovedArchivePage(0); }}><option value="all">All</option><option value="so">SO</option><option value="nta">NTA</option><option value="calendar">Calendar of Activities</option></select></label>
        <label>Name Search<input type="search" value={approvedArchiveSearch} onChange={(event) => { setApprovedArchiveSearch(event.target.value); setApprovedArchivePage(0); }} placeholder="Search by Name" /></label>
      </div>
      <section className="whereabouts-summary-table-section" aria-label="Document records">
        <div className="whereabouts-summary-table-heading"><h3>Documents</h3><span>{filteredApprovedArchiveRows.length === 0 ? "0 records" : `${currentApprovedArchivePage * 5 + 1}–${Math.min(currentApprovedArchivePage * 5 + visibleApprovedArchiveRows.length, filteredApprovedArchiveRows.length)} of ${filteredApprovedArchiveRows.length}`}</span></div>
        {approvedArchiveError && <div className="error-message whereabouts-error" role="status">{approvedArchiveError}</div>}
        <div className="whereabouts-summary-table-wrap"><table className="whereabouts-summary-table whereabouts-approved-archive-table"><thead><tr><th>Document Type</th><th>Activity Title</th><th>Designated Personnel</th><th>Date</th><th>Venue</th><th>View</th></tr></thead><tbody>
          {visibleApprovedArchiveRows.map((row) => <tr key={row.key}>
            <td>{row.type}</td>
            <td>{row.activityTitle || "—"}</td>
            <td>{row.designatedPersonnel || "—"}</td>
            <td>{row.dateFrom ? formatCalendarDateRange(row.dateFrom, row.dateTo || row.dateFrom) : "—"}</td>
            <td>{row.venue || "—"}</td>
            <td><button type="button" className="whereabouts-archive-view" aria-label="View document" title="View document" disabled={!onViewApprovedDocument} onClick={() => onViewApprovedDocument?.({ id: row.record.id, type: row.type, data: row.record.data, readOnly: true })}><svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg></button></td>
          </tr>)}
          {approvedArchiveLoading && <tr><td className="whereabouts-summary-empty" colSpan={6}>Loading documents…</td></tr>}
          {!approvedArchiveLoading && visibleApprovedArchiveRows.length === 0 && <tr><td className="whereabouts-summary-empty" colSpan={6}>No documents match this filter.</td></tr>}
        </tbody></table></div>
        {approvedArchivePageCount > 1 && <nav className="whereabouts-pagination" aria-label="Document pages"><button type="button" onClick={() => setApprovedArchivePage((page) => Math.max(0, page - 1))} disabled={currentApprovedArchivePage === 0}>Previous</button><span aria-live="polite">Page {currentApprovedArchivePage + 1} of {approvedArchivePageCount}</span><button type="button" onClick={() => setApprovedArchivePage((page) => Math.min(approvedArchivePageCount - 1, page + 1))} disabled={currentApprovedArchivePage >= approvedArchivePageCount - 1}>Next</button></nav>}
      </section>
    </section>
  </section>;
}
