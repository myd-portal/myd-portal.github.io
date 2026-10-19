"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, deleteDoc, doc, onSnapshot, query } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { matchesAdminSearch, searchableAdminText } from "@/lib/admin-search";
import DeleteConfirmation from "./DeleteConfirmation";
import RecordPagination, { useRecordPagination } from "./RecordPagination";
import "./admin-search.css";
import "./document-notification-admin.css";

type DocumentNotificationRow = {
  id: string;
  documentType?: string;
  createdAt?: unknown;
  searchText?: string;
};

function createdAtMillis(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    const timestamp = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
    if (typeof timestamp.toMillis === "function") return timestamp.toMillis();
    if (typeof timestamp.toDate === "function") return timestamp.toDate().getTime();
    if (typeof timestamp.seconds === "number") return timestamp.seconds * 1000;
  }
  return 0;
}

function formatCreatedAt(value: unknown) {
  const milliseconds = createdAtMillis(value);
  if (!milliseconds) return "—";
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  }).format(new Date(milliseconds));
}

export default function DocumentNotificationAdmin() {
  const [notifications, setNotifications] = useState<DocumentNotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [pendingDelete, setPendingDelete] = useState<DocumentNotificationRow | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const sortedNotifications = useMemo(() => [...notifications].sort((first, second) => createdAtMillis(second.createdAt) - createdAtMillis(first.createdAt)), [notifications]);
  const filteredNotifications = useMemo(() => sortedNotifications.filter((notification) => matchesAdminSearch([notification.documentType, notification.createdAt, notification.searchText], searchQuery)), [sortedNotifications, searchQuery]);
  const { currentPage, pageCount, visibleRecords, setPage } = useRecordPagination(filteredNotifications);

  useEffect(() => {
    if (!db) {
      setError("Firebase is not configured.");
      setLoading(false);
      return;
    }

    return onSnapshot(query(collection(db, "documentNotifications")), (snapshot) => {
      const rows = snapshot.docs.map((item) => {
        const data = item.data();
        return {
          id: item.id,
          documentType: typeof data.documentType === "string" ? data.documentType : "Unknown",
          createdAt: data.createdAt,
          searchText: searchableAdminText(data),
        };
      });
      setNotifications(rows);
      setError("");
      setLoading(false);
    }, (cause) => {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not load document notifications (${code}).` : "Could not load document notifications.");
      setLoading(false);
    });
  }, []);

  async function deleteNotification() {
    if (!db || !pendingDelete || busyId) return;
    setBusyId(pendingDelete.id);
    setError("");
    setMessage("");
    try {
      await deleteDoc(doc(db, "documentNotifications", pendingDelete.id));
      setMessage(`${pendingDelete.documentType || "Document"} notification deleted.`);
      setPendingDelete(null);
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not delete this notification (${code}).` : "Could not delete this notification.");
    } finally {
      setBusyId("");
    }
  }

  return <section className="content-section document-notification-admin-section">
    <div className="section-heading">
      <div>
        <p className="eyebrow">Super Admin</p>
        <h2>Document Notifications</h2>
        <p className="muted">Review and remove document notifications.</p>
      </div>
      <span className="document-notification-admin-count">{notifications.length} {notifications.length === 1 ? "notification" : "notifications"}</span>
    </div>
    {error && <p className="document-notification-admin-message is-error" role="alert">{error}</p>}
    {message && <p className="document-notification-admin-message" role="status">{message}</p>}
    {loading ? <p className="muted">Loading document notifications...</p> : notifications.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No document notifications</h3><p>New document notifications will appear here.</p></div> : <>
      <div className="admin-list-toolbar">
        <label className="admin-list-search">Search document notifications<input type="search" value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setPage(0); }} placeholder="Document type, name, date, or details..." /></label>
        {searchQuery.trim() && <span className="admin-list-results">{filteredNotifications.length} matching {filteredNotifications.length === 1 ? "notification" : "notifications"}</span>}
      </div>
      {filteredNotifications.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No matching document notifications</h3><p>Try another document type, name, date, or detail.</p></div> : <>
      <div className="document-notification-admin-table-wrap">
        <table className="document-notification-admin-table">
          <thead><tr><th>Document Type</th><th>Created At</th><th>Action</th></tr></thead>
          <tbody>{visibleRecords.map((notification) => <tr key={notification.id}>
            <td data-label="Document Type">{notification.documentType || "Unknown"}</td>
            <td data-label="Created At">{formatCreatedAt(notification.createdAt)}</td>
            <td data-label="Action"><button type="button" className="document-notification-admin-delete" disabled={Boolean(busyId)} onClick={() => setPendingDelete(notification)}>Delete</button></td>
          </tr>)}</tbody>
        </table>
      </div>
      <RecordPagination totalRecords={filteredNotifications.length} currentPage={currentPage} pageCount={pageCount} onPageChange={setPage} label="Document Notifications" />
      </>}
    </>}
    <DeleteConfirmation
      open={Boolean(pendingDelete)}
      title="Delete this document notification?"
      description={`Permanently remove the ${pendingDelete?.documentType || "document"} notification created ${formatCreatedAt(pendingDelete?.createdAt)}?`}
      busy={Boolean(pendingDelete && busyId === pendingDelete.id)}
      onCancel={() => setPendingDelete(null)}
      onConfirm={() => void deleteNotification()}
    />
  </section>;
}
