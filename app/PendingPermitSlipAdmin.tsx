"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, deleteDoc, doc, onSnapshot, query } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { matchesAdminSearch } from "@/lib/admin-search";
import DeleteConfirmation from "./DeleteConfirmation";
import RecordPagination, { useRecordPagination } from "./RecordPagination";
import { normalizeWorkflowStatus } from "./workflow-status";
import "./admin-search.css";
import "./pending-permit-slip-admin.css";

type PermitRecord = {
  id: string;
  names: string[];
  date: string;
  personStatuses?: Record<string, { status?: string }>;
  lastDecisionKey?: string | null;
};

function isPendingPermit(data: Record<string, unknown>) {
  const statuses = data.personStatuses;
  if (data.status !== undefined && normalizeWorkflowStatus(data.status) !== "Pending") return false;
  if (statuses && typeof statuses === "object" && Object.values(statuses).some((decision) => {
    if (!decision || typeof decision !== "object") return false;
    return normalizeWorkflowStatus((decision as { status?: unknown }).status) !== "Pending";
  })) return false;
  const hasNoDecisions = data.lastDecisionKey == null
    && (!statuses || (typeof statuses === "object" && Object.keys(statuses).length === 0));
  return hasNoDecisions;
}

function formatDate(value: string) {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeZone: "Asia/Manila" }).format(date);
}

export default function PendingPermitSlipAdmin() {
  const [permits, setPermits] = useState<PermitRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [pendingDelete, setPendingDelete] = useState<PermitRecord | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const sortedPermits = useMemo(() => [...permits].sort((first, second) => second.date.localeCompare(first.date)), [permits]);
  const filteredPermits = useMemo(() => sortedPermits.filter((permit) => matchesAdminSearch([permit.names, permit.date, formatDate(permit.date)], searchQuery)), [sortedPermits, searchQuery]);
  const { currentPage, pageCount, visibleRecords, setPage } = useRecordPagination(filteredPermits);

  useEffect(() => {
    if (!db) {
      setError("Firebase is not configured.");
      setLoading(false);
      return;
    }

    return onSnapshot(query(collection(db, "permits")), (snapshot) => {
      const rows = snapshot.docs.flatMap((item) => {
        const data = item.data() as Record<string, unknown>;
        if (!isPendingPermit(data)) return [];
        const names = Array.isArray(data.names)
          ? data.names.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
          : typeof data.name === "string" && data.name.trim() ? [data.name] : [];
        if (names.length === 0) return [];
        return [{
          id: item.id,
          names,
          date: typeof data.date === "string" ? data.date : "",
          personStatuses: data.personStatuses as PermitRecord["personStatuses"],
          lastDecisionKey: typeof data.lastDecisionKey === "string" ? data.lastDecisionKey : null,
        }];
      });
      setPermits(rows);
      setError("");
      setLoading(false);
    }, (cause) => {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not load pending Permit Slips (${code}).` : "Could not load pending Permit Slips.");
      setLoading(false);
    });
  }, []);

  async function deletePermit() {
    if (!db || !pendingDelete || busyId) return;
    setBusyId(pendingDelete.id);
    setError("");
    setMessage("");
    try {
      await deleteDoc(doc(db, "permits", pendingDelete.id));
      setMessage(`Pending Permit Slip for ${pendingDelete.names.join(", ")} deleted.`);
      setPendingDelete(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete this Permit Slip (${code}).` : "Could not delete this Permit Slip.");
    } finally {
      setBusyId("");
    }
  }

  return <section className="content-section pending-permit-admin-section">
    <div className="section-heading">
      <div>
        <p className="eyebrow">Super Admin</p>
        <h2>Pending Permit Slips</h2>
        <p className="muted">Review and remove Permit Slips that have not received a decision.</p>
      </div>
      <span className="pending-permit-admin-count">{permits.length} {permits.length === 1 ? "permit" : "permits"}</span>
    </div>
    {error && <p className="pending-permit-admin-message is-error" role="alert">{error}</p>}
    {message && <p className="pending-permit-admin-message" role="status">{message}</p>}
    {loading ? <p className="muted">Loading pending Permit Slips...</p> : permits.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No pending Permit Slips</h3><p>New submissions awaiting a decision will appear here.</p></div> : <>
      <div className="admin-list-toolbar">
        <label className="admin-list-search">Search pending Permit Slips<input type="search" value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setPage(0); }} placeholder="Name or date..." /></label>
        {searchQuery.trim() && <span className="admin-list-results">{filteredPermits.length} matching {filteredPermits.length === 1 ? "permit" : "permits"}</span>}
      </div>
      {filteredPermits.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No matching pending Permit Slips</h3><p>Try another name or date.</p></div> : <>
      <div className="pending-permit-admin-table-wrap">
        <table className="pending-permit-admin-table">
          <thead><tr><th>Name</th><th>Date</th><th>Action</th></tr></thead>
          <tbody>{visibleRecords.map((permit) => <tr key={permit.id}>
            <td data-label="Name">{permit.names.join(", ")}</td>
            <td data-label="Date">{formatDate(permit.date)}</td>
            <td data-label="Action"><button type="button" className="pending-permit-admin-delete" disabled={Boolean(busyId)} onClick={() => setPendingDelete(permit)}>Delete</button></td>
          </tr>)}</tbody>
        </table>
      </div>
      <RecordPagination totalRecords={filteredPermits.length} currentPage={currentPage} pageCount={pageCount} onPageChange={setPage} label="Pending Permit Slips" />
      </>}
    </>}
    <DeleteConfirmation
      open={Boolean(pendingDelete)}
      title="Delete this pending Permit Slip?"
      description={`Permanently delete the pending Permit Slip for ${pendingDelete?.names.join(", ") || "this applicant"}, dated ${formatDate(pendingDelete?.date ?? "")}?`}
      busy={Boolean(pendingDelete && busyId === pendingDelete.id)}
      onCancel={() => setPendingDelete(null)}
      onConfirm={() => void deletePermit()}
    />
  </section>;
}
