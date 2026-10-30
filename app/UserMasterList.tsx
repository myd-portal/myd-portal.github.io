"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { collection, deleteDoc, doc, onSnapshot, query, updateDoc, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { normalizeAccountRole, normalizeAccountStatus, type AccountRole, type AccountStatus } from "@/lib/user-roles";
import { accountProfileSelection } from "@/lib/account-profile";
import DeleteConfirmation from "./DeleteConfirmation";
import RecordPagination, { useRecordPagination } from "./RecordPagination";
import "./user-master-list.css";

type MasterListAccount = {
  id: string;
  createdAt?: unknown;
  name?: string;
  position?: string;
  designation?: string;
  office?: string;
  division?: string;
  assignment?: string;
  projectProgram?: string;
  unit?: string;
  profileFieldsVersion?: number;
  isRootSuperAdmin?: boolean;
  accountStatus?: AccountStatus;
  accountRole?: AccountRole | "user";
};

function accountCreatedAtMillis(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    const timestamp = value as { toMillis?: () => number; seconds?: number };
    if (typeof timestamp.toMillis === "function") return timestamp.toMillis();
    if (typeof timestamp.seconds === "number") return timestamp.seconds * 1000;
  }
  return 0;
}

const roleOptions: { value: AccountRole; label: string }[] = [
  { value: "superadmin", label: "Super Admin" },
  { value: "admin", label: "Admin" },
  { value: "regular", label: "Regular" },
];

export default function UserMasterList({ user }: { user: User }) {
  const [accounts, setAccounts] = useState<MasterListAccount[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [editing, setEditing] = useState<MasterListAccount | null>(null);
  const [editValues, setEditValues] = useState<{ accountRole: AccountRole; accountStatus: AccountStatus }>({ accountRole: "regular", accountStatus: "Pending" });
  const [pendingDelete, setPendingDelete] = useState<MasterListAccount | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const filteredAccounts = useMemo(() => {
    const terms = searchQuery.trim().toLocaleLowerCase("en-PH").split(/\s+/).filter(Boolean);
    if (!terms.length) return accounts;
    return accounts.filter((account) => {
      const searchableText = [
        account.name,
        account.position,
        account.designation,
        accountProfileSelection(account).office,
        accountProfileSelection(account).division,
        accountProfileSelection(account).unit,
        account.assignment,
        account.projectProgram,
        account.unit,
        normalizeAccountRole(account.accountRole),
        normalizeAccountStatus(account.accountStatus),
      ].filter((value): value is string => typeof value === "string").join(" ").toLocaleLowerCase("en-PH");
      return terms.every((term) => searchableText.includes(term));
    });
  }, [accounts, searchQuery]);
  const { currentPage, pageCount, visibleRecords, setPage } = useRecordPagination(filteredAccounts);

  useEffect(() => {
    if (!db) { setError("Firebase is not configured."); setLoading(false); return; }
    return onSnapshot(query(collection(db, "users"), where("emailVerified", "==", true)), (snapshot) => {
      const rows = snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as MasterListAccount));
      rows.sort((first, second) => {
        const newestFirst = accountCreatedAtMillis(second.createdAt) - accountCreatedAtMillis(first.createdAt);
        const statusOrder = (normalizeAccountStatus(first.accountStatus) === "Pending" ? 0 : 1) - (normalizeAccountStatus(second.accountStatus) === "Pending" ? 0 : 1);
        return newestFirst || statusOrder || String(first.name ?? "").localeCompare(String(second.name ?? ""), "en", { sensitivity: "base" });
      });
      setAccounts(rows);
      setError("");
      setLoading(false);
    }, (cause) => {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not load User Approval (${code}).` : "Could not load User Approval.");
      setLoading(false);
    });
  }, []);

  const accountCountLabel = useMemo(() => `${accounts.length} verified ${accounts.length === 1 ? "account" : "accounts"}`, [accounts.length]);

  function editAccount(account: MasterListAccount) {
    setEditValues({ accountRole: normalizeAccountRole(account.accountRole), accountStatus: normalizeAccountStatus(account.accountStatus) });
    setEditing(account);
    setError("");
    setMessage("");
  }

  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!db || !editing || busyId) return;
    setBusyId(editing.id);
    setError("");
    setMessage("");
    try {
      await updateDoc(doc(db, "users", editing.id), editValues);
      setMessage(`${editing.name || "Account"} updated.`);
      setEditing(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not update this account (${code}).` : "Could not update this account.");
    } finally {
      setBusyId("");
    }
  }

  async function deleteAccount() {
    if (!db || !pendingDelete || busyId) return;
    setBusyId(pendingDelete.id);
    setError("");
    setMessage("");
    try {
      await deleteDoc(doc(db, "users", pendingDelete.id));
      setMessage(`${pendingDelete.name || "Account"} removed from User Approval and system access disabled.`);
      setPendingDelete(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete this account (${code}).` : "Could not delete this account.");
    } finally {
      setBusyId("");
    }
  }

  return <>{editing ? <section className="content-section form-section user-master-list-section user-master-list-edit-section">
    <div className="section-heading"><div><p className="eyebrow">Super Admin / Edit account</p><h2>Edit User Approval</h2><p className="muted">Update the role or approval status for {editing.name || "this account"}.</p></div><button type="button" className="ghost-button" disabled={busyId === editing.id} onClick={() => { setEditing(null); setError(""); }}>Cancel</button></div>
    {error && <p className="user-master-list-message is-error" role="alert">{error}</p>}
    <form className="permit-form user-master-list-edit-form" onSubmit={(event) => void saveAccount(event)}>
      <label>Role<select value={editValues.accountRole} onChange={(event) => setEditValues({ ...editValues, accountRole: event.target.value as AccountRole })} required>{roleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label>Account Status<select className="status-select" data-status={editValues.accountStatus} value={editValues.accountStatus} onChange={(event) => setEditValues({ ...editValues, accountStatus: event.target.value as AccountStatus })} required>{(["Pending", "Approved", "Disapproved"] as AccountStatus[]).map((status) => <option key={status}>{status}</option>)}</select></label>
      <div className="form-actions"><button type="submit" className="primary-button" disabled={busyId === editing.id}>{busyId === editing.id ? "Saving..." : "Save changes"}</button></div>
    </form>
  </section> : <section className="content-section user-master-list-section">
    <div className="section-heading"><div><p className="eyebrow">Super Admin</p><h2>User Approval</h2><p className="muted">Verified accounts waiting for approval and active system users.</p></div><span className="user-master-list-count">{accountCountLabel}</span></div>
    {error && <p className="user-master-list-message is-error" role="alert">{error}</p>}
    {message && <p className="user-master-list-message" role="status">{message}</p>}
    {loading ? <p className="muted">Loading verified accounts...</p> : accounts.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No verified accounts yet</h3><p>Accounts appear here after their owners verify their email address and sign in.</p></div> : <>
      <div className="user-master-list-toolbar">
        <label className="user-master-list-search">Search accounts<input type="search" value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setPage(0); }} placeholder="Name, position, office, division, unit, role..." /></label>
        {searchQuery.trim() && <span className="user-master-list-results">{filteredAccounts.length} matching {filteredAccounts.length === 1 ? "account" : "accounts"}</span>}
      </div>
      {filteredAccounts.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No matching accounts</h3><p>Try a different name, position, designation, office, division, unit, role, or status.</p></div> : <>
      <div className="user-master-list-table-wrap"><table className="user-master-list-table"><thead><tr><th>Name</th><th>Designation</th><th>Office</th><th>Division</th><th>Unit / Program / Project</th><th>Role / Status</th><th>Actions</th></tr></thead><tbody>
      {visibleRecords.map((account) => {
        const status = normalizeAccountStatus(account.accountStatus);
        const role = normalizeAccountRole(account.accountRole);
        const protectedAccount = account.id === user.uid || account.isRootSuperAdmin === true;
        const busy = busyId === account.id;
        const profile = accountProfileSelection(account);
        return <tr key={account.id}>
          <td data-label="Name"><strong>{account.name || "—"}</strong></td>
          <td data-label="Designation">{account.designation || "—"}</td>
          <td data-label="Office">{profile.office || "—"}</td>
          <td data-label="Division">{profile.division || "—"}</td>
          <td data-label="Unit / Program / Project">{profile.unit || "—"}</td>
          <td data-label="Role / Status"><strong>{roleOptions.find((option) => option.value === role)?.label ?? "Regular"}</strong><span className="user-master-list-status">{status}</span></td>
          <td className="user-master-list-actions" data-label="Actions"><button type="button" className="row-action" disabled={busy || protectedAccount} onClick={() => editAccount(account)}>Edit</button><button type="button" className="delete-button" disabled={busy || protectedAccount} onClick={() => setPendingDelete(account)}>Delete</button></td>
        </tr>;
      })}
      </tbody></table></div>
      <RecordPagination totalRecords={filteredAccounts.length} currentPage={currentPage} pageCount={pageCount} onPageChange={setPage} label="User Approval" />
      </>}
    </>}
    <DeleteConfirmation open={Boolean(pendingDelete)} title="Delete this account?" description={`Remove ${pendingDelete?.name || "this account"} from User Approval? Its Firestore profile will be deleted, which disables access to My Desk.`} busy={Boolean(pendingDelete && busyId === pendingDelete.id)} onCancel={() => setPendingDelete(null)} onConfirm={() => void deleteAccount()} />
  </section>}</>;
}
