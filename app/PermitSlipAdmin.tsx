"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, query, runTransaction, serverTimestamp } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "@/lib/firebase";
import { ADMIN_EMAIL, SUPERADMIN_EMAIL, normalizeAccountRole, type AccountRole } from "@/lib/user-roles";
import { accountProfileSelection } from "@/lib/account-profile";
import { isFieldOperationsChiefPermitSignatory, isFieldOperationsPermitOwner, isFieldOperationsProjectLeaderPermitOwner, isFieldOperationsProjectLeaderPermitSignatory } from "@/lib/permit-signatory";
import { loadPersonnel, type PersonnelEntry } from "@/lib/personnel";
import { normalizeWorkflowStatus, type WorkflowStatus } from "./workflow-status";
import { assignApprovedPermitNumbers, displayPermitNumber, highestApprovedPermitSequence, permitNumberYear } from "./permit-number";
import RecordPagination, { recordPageSize, useRecordPagination } from "./RecordPagination";
import "./permit-slip-admin.css";

type PermitStatus = WorkflowStatus;
type PermitUnitFilter = string;
type PersonDecision = { status?: PermitStatus; decidedAt?: unknown; signerName?: string; signerSignatureURL?: string; decidedBy?: string; approvedPermitNo?: string };
export type AdminPermit = {
  id: string;
  permitNo: string;
  permitNos?: string[];
  date: string;
  names: string[];
  personIds?: string[];
  name?: string;
  personUnits?: string[];
  unit?: string;
  purpose: string;
  ownerId?: string;
  ownerRole?: AccountRole;
  ownerOffice?: string;
  ownerDivision?: string;
  ownerUnit?: string;
  ownerAssignment?: string;
  personStatuses?: Record<string, PersonDecision>;
};

export const PERMIT_ADMIN_EMAILS = [ADMIN_EMAIL, SUPERADMIN_EMAIL] as const;
export function isPermitAdmin(email?: string | null, role?: AccountRole) {
  const accountRole = normalizeAccountRole(role, email);
  return accountRole === "admin" || accountRole === "superadmin";
}

function permitNumber(permit: AdminPermit, index: number) {
  const personNumber = permit.permitNos?.[index];
  if (typeof personNumber === "string" && personNumber) return personNumber;
  return typeof permit.permitNo === "string" ? permit.permitNo : "";
}

function decisionKey(permit: AdminPermit, index: number) {
  const personNumber = permit.permitNos?.[index];
  if (typeof personNumber === "string" && personNumber) return personNumber;
  const permitNo = typeof permit.permitNo === "string" ? permit.permitNo : "";
  const keyBase = permitNo || permit.id;
  return permit.names.length > 1 ? `${keyBase}__person_${index + 1}` : keyBase;
}

function personStatus(permit: AdminPermit, index: number): PermitStatus {
  return normalizeWorkflowStatus(permit.personStatuses?.[decisionKey(permit, index)]?.status);
}

function permitOwnerScope(permit: AdminPermit, account?: PersonnelEntry) {
  const office = permit.ownerOffice || account?.office || "";
  const savedProfile = permit.ownerDivision && permit.ownerUnit
    ? accountProfileSelection({ office, division: permit.ownerDivision, unit: permit.ownerUnit, profileFieldsVersion: 4 })
    : null;
  const legacyProfile = accountProfileSelection({
    office,
    assignment: permit.ownerAssignment || permit.ownerUnit || account?.unit || account?.division || "",
    profileFieldsVersion: 3,
  });
  const profile = savedProfile?.unit ? savedProfile : legacyProfile;
  return {
    ownerRole: permit.ownerRole ?? account?.accountRole,
    ownerOffice: profile.office,
    ownerDivision: profile.division,
    ownerUnit: profile.unit,
  };
}

function monthString(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function displayDate(value: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium" }).format(new Date(`${value}T00:00:00`));
}

export default function PermitSlipAdmin({ user, mode, focusNotificationKey, canManagePermits, accountRole, office, division, unit, designation }: { user: User; mode: "statistics" | "status"; focusNotificationKey?: string | null; canManagePermits: boolean; accountRole: AccountRole; office: string; division: string; unit: string; designation: string }) {
  const [permits, setPermits] = useState<AdminPermit[]>([]);
  const [permitOwnerAccounts, setPermitOwnerAccounts] = useState<Record<string, PersonnelEntry>>({});
  const [month, setMonth] = useState(monthString(new Date()));
  const [unitFilter, setUnitFilter] = useState<PermitUnitFilter>("All");
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState("");
  const [error, setError] = useState("");
  const isScopedFieldOperationsChief = isFieldOperationsChiefPermitSignatory({ accountRole, office, division, unit, designation });
  const isScopedFieldOperationsProjectLeader = isFieldOperationsProjectLeaderPermitSignatory({ accountRole, office, division, unit, designation });

  useEffect(() => {
    let cancelled = false;
    void loadPersonnel({ deduplicateByName: false }).then((accounts) => {
      if (cancelled) return;
      setPermitOwnerAccounts(Object.fromEntries(accounts.map((account) => [account.userId, account])));
    }).catch(() => {
      if (!cancelled) setPermitOwnerAccounts({});
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!db) { setLoading(false); return; }
    const firestore = db;
    return onSnapshot(query(collection(firestore, "permits")), (snapshot) => {
      setPermits(snapshot.docs.map((permitDoc) => {
        const data = permitDoc.data() as Omit<AdminPermit, "id">;
        return {
          ...data,
          id: permitDoc.id,
          permitNo: typeof data.permitNo === "string" ? data.permitNo : "",
          permitNos: Array.isArray(data.permitNos) ? data.permitNos as string[] : undefined,
          names: Array.isArray(data.names) ? data.names : data.name ? [data.name] : [],
        };
      }).sort((left, right) => right.date.localeCompare(left.date)));
      setError("");
      setLoading(false);
    }, (snapshotError) => {
      setError(snapshotError.code ? `Could not load Permit Slips (${snapshotError.code}).` : "Could not load Permit Slips.");
      setLoading(false);
    });
  }, [user.uid]);

  const entries = useMemo(() => permits.flatMap((permit) => permit.names.map((name, index) => ({
    permit,
    index,
    name,
    unit: permit.personUnits?.[index] ?? permit.unit,
    permitNo: permitNumber(permit, index),
    status: personStatus(permit, index),
    approvedPermitNo: permit.personStatuses?.[decisionKey(permit, index)]?.approvedPermitNo,
  }))), [permits]);
  const statusScopeEntries = useMemo(() => {
    if (mode !== "status") return entries;
    if (isScopedFieldOperationsChief) return entries.filter((entry) => isFieldOperationsPermitOwner(permitOwnerScope(entry.permit, permitOwnerAccounts[entry.permit.ownerId ?? ""])));
    if (isScopedFieldOperationsProjectLeader) return entries.filter((entry) => isFieldOperationsProjectLeaderPermitOwner(permitOwnerScope(entry.permit, permitOwnerAccounts[entry.permit.ownerId ?? ""])));
    return entries;
  }, [entries, isScopedFieldOperationsChief, isScopedFieldOperationsProjectLeader, mode, permitOwnerAccounts]);
  const availableAssignments = useMemo(() => [...new Set(statusScopeEntries.map((entry) => entry.unit).filter((unit): unit is string => Boolean(unit?.trim())))]
    .sort((first, second) => first.localeCompare(second, "en", { sensitivity: "base" })), [statusScopeEntries]);
  const approvedPermitNumbers = useMemo(() => assignApprovedPermitNumbers(entries
    .filter((entry) => entry.status === "Approved")
    .map((entry) => ({ permitNo: entry.permitNo, approvedPermitNo: entry.approvedPermitNo }))), [entries]);

  const statusEntries = useMemo(() => statusScopeEntries
    .filter((entry) => unitFilter === "All" || entry.unit === unitFilter)
    .sort((left, right) => {
      if (left.status === "Pending" && right.status !== "Pending") return -1;
      if (right.status === "Pending" && left.status !== "Pending") return 1;
      const leftPsNo = left.status === "Approved"
        ? (left.approvedPermitNo ?? approvedPermitNumbers[displayPermitNumber(left.permitNo)] ?? displayPermitNumber(left.permitNo))
        : "";
      const rightPsNo = right.status === "Approved"
        ? (right.approvedPermitNo ?? approvedPermitNumbers[displayPermitNumber(right.permitNo)] ?? displayPermitNumber(right.permitNo))
        : "";
      if (leftPsNo && rightPsNo) return rightPsNo.localeCompare(leftPsNo, "en", { numeric: true, sensitivity: "base" });
      if (leftPsNo) return -1;
      if (rightPsNo) return 1;
      return right.permit.date.localeCompare(left.permit.date)
        || right.permitNo.localeCompare(left.permitNo, "en", { numeric: true, sensitivity: "base" });
    }), [statusScopeEntries, approvedPermitNumbers, unitFilter]);
  const { currentPage: currentStatusPage, pageCount: statusPageCount, visibleRecords: visibleStatusEntries, setPage: setStatusPage } = useRecordPagination(statusEntries);

  useEffect(() => {
    if (mode !== "status" || !focusNotificationKey || loading) return;
    if (unitFilter !== "All") {
      setUnitFilter("All");
      return;
    }
    const targetIndex = statusEntries.findIndex(({ permit, index }) => `${permit.id}:${decisionKey(permit, index)}` === focusNotificationKey);
    if (targetIndex < 0) return;
    setStatusPage(Math.floor(targetIndex / recordPageSize));
  }, [focusNotificationKey, loading, mode, setStatusPage, statusEntries, unitFilter]);

  useEffect(() => {
    if (mode !== "status" || !focusNotificationKey || loading) return;
    const targetIndex = statusEntries.findIndex(({ permit, index }) => `${permit.id}:${decisionKey(permit, index)}` === focusNotificationKey);
    if (targetIndex < 0 || Math.floor(targetIndex / recordPageSize) !== currentStatusPage) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`permit-status-${encodeURIComponent(focusNotificationKey)}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentStatusPage, focusNotificationKey, loading, mode, statusEntries]);

  const monthlyStats = useMemo(() => {
    const stats = new Map<string, { name: string; purposes: Set<string>; approved: number; disapproved: number }>();
    for (const entry of entries) {
      if (!entry.permit.date?.startsWith(`${month}-`)) continue;
      if (unitFilter !== "All" && entry.unit !== unitFilter) continue;
      const key = entry.name.trim().toLocaleLowerCase();
      if (!key) continue;
      const row = stats.get(key) ?? { name: entry.name.trim(), purposes: new Set<string>(), approved: 0, disapproved: 0 };
      if (entry.permit.purpose?.trim()) row.purposes.add(entry.permit.purpose.trim());
      if (entry.status === "Approved") row.approved += 1;
      if (entry.status === "Disapproved") row.disapproved += 1;
      stats.set(key, row);
    }
    return [...stats.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [entries, month, unitFilter]);
  const { currentPage: currentStatsPage, pageCount: statsPageCount, visibleRecords: visibleMonthlyStats, setPage: setStatsPage } = useRecordPagination(monthlyStats);

  async function changeStatus(permit: AdminPermit, personIndex: number, status: PermitStatus) {
    if (!db || !canManagePermits) return;
    if (status === "Pending") return;
    if (personStatus(permit, personIndex) !== "Pending") return;
    const permitNo = permitNumber(permit, personIndex);
    const statusKey = decisionKey(permit, personIndex);
    const key = `${permit.id}:${statusKey}`;
    setSavingKey(key);
    setError("");
    try {
      const firestore = db;
      const permitRef = doc(firestore, "permits", permit.id);
      const calendarRef = doc(firestore, "approvedPermitCalendar", `${permit.id}_${encodeURIComponent(statusKey)}`);
      const year = permitNumberYear(permitNo, permit.date);
      const counterRef = doc(firestore, "permitCounters", `approved-${year}`);
      const currentNumbers = assignApprovedPermitNumbers(entries
        .filter((entry) => entry.status === "Approved")
        .map((entry) => ({ permitNo: entry.permitNo, approvedPermitNo: entry.approvedPermitNo })));
      const baselineHighest = (targetYear: string) => entries.filter((entry) => entry.status === "Approved").reduce((highest, entry) => {
        const match = /^(\d{4})-(\d{4,})$/.exec(entry.approvedPermitNo ?? "");
        return match?.[1] === targetYear ? Math.max(highest, Number(match[2])) : highest;
      }, highestApprovedPermitSequence(currentNumbers, targetYear));

      await runTransaction(firestore, async (transaction) => {
        const profileSnapshot = await transaction.get(doc(firestore, "users", user.uid));
        const profileData = profileSnapshot.exists() ? profileSnapshot.data() : null;
        const signerName = typeof profileData?.name === "string" ? profileData.name.trim() : "";
        const signerSignatureURL = typeof profileData?.fullSignatureURL === "string" ? profileData.fullSignatureURL.trim() : "";
        if (!signerName) throw new Error("Your account name is missing. Update your profile before deciding this Permit Slip.");
        if (status === "Approved" && !signerSignatureURL) throw new Error("Upload your Full Signature in Profile before approving this Permit Slip.");
        const permitSnapshot = await transaction.get(permitRef);
        if (!permitSnapshot.exists()) throw new Error("This Permit Slip no longer exists.");
        const data = permitSnapshot.data();
        const calendarSnapshot = await transaction.get(calendarRef);
        const latestPermitNumbers = Array.isArray(data.permitNos) ? data.permitNos as unknown[] : [];
        const latestPermitNo = typeof latestPermitNumbers[personIndex] === "string"
          ? latestPermitNumbers[personIndex] as string
          : typeof data.permitNo === "string" ? data.permitNo : "";
        const latestDate = typeof data.date === "string" ? data.date : permit.date;
        const latestYear = permitNumberYear(latestPermitNo, latestDate);
        const currentDecision = (data.personStatuses as Record<string, PersonDecision> | undefined)?.[statusKey] ?? {};
        if (normalizeWorkflowStatus(currentDecision.status) !== "Pending") {
          throw new Error("Approved or Disapproved Permit Slips cannot be changed.");
        }
        let approvedPermitNo = currentDecision.approvedPermitNo;

        if (status === "Approved") {
          const latestCounterRef = latestYear === year ? counterRef : doc(firestore, "permitCounters", `approved-${latestYear}`);
          const counterSnapshot = await transaction.get(latestCounterRef);
          const counterValue = Number(counterSnapshot.exists() ? counterSnapshot.data().lastNumber : 0) || 0;
          const assignedMatch = /^(\d{4})-(\d{4,})$/.exec(approvedPermitNo ?? "");
          if (!assignedMatch || assignedMatch[1] !== latestYear) {
            const startingNumber = counterSnapshot.exists() ? counterValue : baselineHighest(latestYear);
            const nextNumber = Math.max(startingNumber, counterValue) + 1;
            approvedPermitNo = `${latestYear}-${String(nextNumber).padStart(4, "0")}`;
            transaction.set(latestCounterRef, { year: latestYear, lastNumber: nextNumber });
          } else if (counterValue < Math.max(Number(assignedMatch[2]), baselineHighest(latestYear))) {
            transaction.set(latestCounterRef, { year: latestYear, lastNumber: Math.max(Number(assignedMatch[2]), baselineHighest(latestYear)) });
          }
        }
        if (status === "Approved" && !approvedPermitNo) throw new Error("Could not assign a PS No. Please try again.");

        const nextDecision: PersonDecision = {
          ...currentDecision,
          status,
          decidedAt: serverTimestamp(),
          decidedBy: user.uid,
          signerName,
        };
        if (status === "Approved") nextDecision.signerSignatureURL = signerSignatureURL;
        if (approvedPermitNo) nextDecision.approvedPermitNo = approvedPermitNo;
        transaction.update(permitRef, { [`personStatuses.${statusKey}`]: nextDecision, lastDecisionKey: statusKey });

        if (status === "Approved") {
          const names = Array.isArray(data.names) ? data.names as string[] : [];
          const units = Array.isArray(data.personUnits) ? data.personUnits as string[] : [];
          transaction.set(calendarRef, {
            permitId: permit.id,
            statusKey,
            status: "Approved",
            permitNo: latestPermitNo,
            approvedPermitNo,
            name: names[personIndex] ?? permit.names[personIndex] ?? "",
            ...(typeof data.personIds?.[personIndex] === "string" ? { userId: data.personIds[personIndex] as string } : {}),
            date: latestDate,
            purpose: typeof data.purpose === "string" ? data.purpose : permit.purpose,
            unit: units[personIndex] ?? data.unit ?? permit.personUnits?.[personIndex] ?? permit.unit ?? "",
            ...(typeof data.ownerId === "string" ? { ownerId: data.ownerId } : {}),
          });
        } else {
          if (calendarSnapshot.exists()) transaction.delete(calendarRef);
        }
      });
    } catch (updateError) {
      const code = (updateError as { code?: string }).code;
      const message = updateError instanceof Error ? updateError.message : "";
      setError(code ? `Could not update ${permitNo} (${code}).` : message || `Could not update ${permitNo}.`);
    } finally {
      setSavingKey("");
    }
  }

  const title = mode === "statistics" ? "Permit Slip Statistics" : "Permit Slip Status";

  return <section className="content-section permit-admin-section">
    <div className="section-heading permit-admin-heading">
      <div><p className="eyebrow">{canManagePermits ? "Administrator access" : "Reports"}</p><h2>{title}</h2><p className="muted">{mode === "statistics" ? "Monthly approved and disapproved Permit Slips, grouped by person." : canManagePermits ? "Review and update each person’s Permit Slip independently." : "View the current status of Permit Slips."}</p></div>
      <div className="permit-admin-filters">{mode === "statistics" && <label>Month<input type="month" value={month} onChange={(event) => { setMonth(event.target.value); setStatsPage(0); }} /></label>}<label>Unit / Program / Project<select value={unitFilter} onChange={(event) => { setUnitFilter(event.target.value as PermitUnitFilter); setStatusPage(0); setStatsPage(0); }}><option value="All">All Units / Programs / Projects</option>{availableAssignments.map((assignment) => <option key={assignment} value={assignment}>{assignment}</option>)}</select></label></div>
    </div>
    {error && <div className="permit-admin-error" role="alert">{error}</div>}
    {loading ? <p className="permit-admin-empty">Loading Permit Slips…</p> : mode === "statistics" ? <>
      {monthlyStats.length === 0 ? <p className="permit-admin-empty">No Permit Slips were created this month.</p> : <div className="permit-admin-table-wrap"><table className="permit-admin-table"><thead><tr><th>Name</th><th>Purpose</th><th>No. of Approved Permit Slips</th><th>No. of Disapproved Permit Slips</th></tr></thead><tbody>{visibleMonthlyStats.map((row) => <tr key={row.name}><td data-label="Name">{row.name}</td><td data-label="Purpose">{[...row.purposes].join("; ") || "—"}</td><td data-label="No. of Approved Permit Slips">{row.approved}</td><td data-label="No. of Disapproved Permit Slips">{row.disapproved}</td></tr>)}</tbody></table><RecordPagination totalRecords={monthlyStats.length} currentPage={currentStatsPage} pageCount={statsPageCount} onPageChange={setStatsPage} label="Permit Slip Statistics" /></div>}
    </> : statusEntries.length === 0 ? <p className="permit-admin-empty">{permits.length === 0 ? "No Permit Slips have been submitted." : "No Permit Slips match this office."}</p> : <div className="permit-admin-table-wrap"><table className="permit-admin-table permit-status-table"><thead><tr><th>PS No.</th><th>Date</th><th>Name</th><th>Office</th><th>Purpose</th><th>Status</th></tr></thead><tbody>{visibleStatusEntries.map(({ permit, index, name, unit, permitNo, status, approvedPermitNo }) => {
      const key = `${permit.id}:${decisionKey(permit, index)}`;
      const originalNumber = displayPermitNumber(permitNo);
      const displayedNumber = status === "Approved" ? (approvedPermitNo ?? approvedPermitNumbers[originalNumber] ?? originalNumber) || "—" : "Pending";
       return (
         <tr
           id={`permit-status-${encodeURIComponent(key)}`}
           key={key}
         >
           <td data-label="PS No.">{displayedNumber}</td>
           <td data-label="Date">{displayDate(permit.date)}</td>
           <td data-label="Name">{name}</td>
           <td data-label="Office">{unit || "—"}</td>
           <td data-label="Purpose">{permit.purpose || "—"}</td>
           <td data-label="Status">
             {canManagePermits ? (
               <>
                 <select
                   className={`permit-admin-status permit-admin-status-${status.toLowerCase()}`}
                   value={status}
                   disabled={savingKey === key || status !== "Pending"}
                   title={status !== "Pending" ? `${status} Permit Slips cannot be changed.` : undefined}
                   aria-label={`Status for ${name}, ${displayPermitNumber(permitNo)}${status !== "Pending" ? `, locked after ${status.toLowerCase()}` : ""}`}
                   onChange={(event) => void changeStatus(permit, index, event.target.value as PermitStatus)}
                 >
                   <option>Pending</option>
                   <option>Approved</option>
                   <option>Disapproved</option>
                 </select>
                 {savingKey === key && <small className="permit-admin-saving">Saving…</small>}
               </>
             ) : (
               status
             )}
           </td>
         </tr>
       );
    })}</tbody></table><RecordPagination totalRecords={statusEntries.length} currentPage={currentStatusPage} pageCount={statusPageCount} onPageChange={setStatusPage} label="Permit Slip Status" /></div>}
  </section>;
}
