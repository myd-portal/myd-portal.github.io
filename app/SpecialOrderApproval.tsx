"use client";

import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, query, serverTimestamp, where, writeBatch } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "@/lib/firebase";
import { makeDocumentNotification } from "@/lib/document-notifications";
import { safeAttachmentHref } from "@/lib/attachment-link";

export type SpecialOrderApprovalRecord = {
  id: string;
  subject: string;
  activityTitle: string;
  dateFrom: string;
  dateTo: string;
  venue: string;
  attachmentLink?: string;
  signatoryName?: string;
  signatoryDesignation?: string;
  participants: string[];
  ownerId: string;
  ownerUnit?: string;
  createdAt?: unknown;
  approvalStage?: "initial" | "chief" | "returned" | "approved";
  externalSignatory?: boolean;
  initialSignerId?: string;
  chiefSignerId?: string;
  affixInitialSignature?: "Yes" | "No";
  affixInitialSignatureURL?: string;
  affixInitialSignatureName?: string;
  affixInitialSignatureAt?: unknown;
  affixChiefInitialSignature?: "Yes" | "No";
  affixChiefInitialSignatureURL?: string;
  affixChiefInitialSignatureName?: string;
  affixChiefInitialSignatureAt?: unknown;
  affixSignature?: "Yes" | "No";
  affixSignatureURL?: string;
  affixSignatureName?: string;
  affixSignatureAt?: unknown;
  approvalActionStage?: ApprovalStage;
};

type ApprovalStage = "initial" | "chief";

function scheduleLabel(from: string, to: string) {
  const format = (value: string) => value ? new Intl.DateTimeFormat("en-PH", { dateStyle: "medium" }).format(new Date(`${value}T00:00:00`)) : "Not specified";
  return from === to ? format(from) : `${format(from)} \u2013 ${format(to)}`;
}

export default function SpecialOrderApproval({ user, stage, focusRecordId, onView, onFocusHandled }: {
  user: User;
  stage: ApprovalStage;
  focusRecordId?: string;
  onView: (record: SpecialOrderApprovalRecord) => void;
  onFocusHandled?: () => void;
}) {
  const [records, setRecords] = useState<SpecialOrderApprovalRecord[]>([]);
  const [initialSignature, setInitialSignature] = useState("");
  const [accountName, setAccountName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!db) { setLoading(false); setError("Firebase is not configured."); return; }
    const firestore = db;
    const fieldName = stage === "initial" ? "initialSignerId" : "chiefSignerId";
    const stageValue = stage;
    setLoading(true);
    const approvalQueries = [{ actionStage: stageValue, filters: [
      where("approvalWorkflow", "==", "fod"),
      where(fieldName, "==", user.uid),
      where("approvalStage", "==", stageValue),
      ...(stage === "chief" ? [where("affixInitialSignature", "==", "Yes")] : []),
    ] }];
    const liveRecords = new Map<string, SpecialOrderApprovalRecord>();
    let pendingSnapshots = approvalQueries.length;
    const unsubscribes = approvalQueries.map(({ actionStage, filters }) => onSnapshot(query(collection(firestore, "specialOrders"), ...filters), (snapshot) => {
      for (const [id, record] of liveRecords) if (record.approvalActionStage === actionStage) liveRecords.delete(id);
      snapshot.docs.forEach((item) => liveRecords.set(item.id, { ...item.data(), id: item.id, approvalActionStage: actionStage } as SpecialOrderApprovalRecord));
      const next = [...liveRecords.values()];
      next.sort((first, second) => (first.createdAt && typeof first.createdAt === "object" && "toMillis" in first.createdAt && typeof first.createdAt.toMillis === "function" ? first.createdAt.toMillis() as number : 0)
        - (second.createdAt && typeof second.createdAt === "object" && "toMillis" in second.createdAt && typeof second.createdAt.toMillis === "function" ? second.createdAt.toMillis() as number : 0));
      setRecords(next);
      if (pendingSnapshots > 0) pendingSnapshots -= 1;
      setLoading(pendingSnapshots > 0);
      setError("");
    }, (cause) => {
      const code = (cause as { code?: string }).code;
      pendingSnapshots = 0;
      setLoading(false);
      setError(code ? `Could not load SO approvals (${code}).` : "Could not load SO approvals. Refresh and try again.");
    }));
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [stage, user.uid]);

  useEffect(() => {
    if (!db) return;
    return onSnapshot(doc(db, "users", user.uid), (snapshot) => {
      const data = snapshot.data();
      if (!data) return;
      setInitialSignature(typeof data.initialSignatureURL === "string" ? data.initialSignatureURL : "");
      setAccountName(typeof data.name === "string" ? data.name.trim() : user.displayName ?? "");
    }, () => setError("Could not load your profile signature."));
  }, [stage, user.displayName, user.uid]);

  useEffect(() => {
    if (!focusRecordId) return;
    const record = records.find((item) => item.id === focusRecordId);
    if (record) {
      onView(record);
      onFocusHandled?.();
    }
  }, [focusRecordId, onFocusHandled, onView, records]);

  async function changeAffixSignature(record: SpecialOrderApprovalRecord, value: "Yes" | "No") {
    if (!db || busyId) return;
    const actionStage = record.approvalActionStage ?? stage;
    const signature = initialSignature;
    if (value === "Yes" && !signature.trim()) {
      setError("Upload your Initial Signature in Profile before affixing it to an SO.");
      return;
    }
    setBusyId(record.id);
    setError("");
    try {
      const firestore = db;
      const orderRef = doc(firestore, "specialOrders", record.id);
      const batch = writeBatch(firestore);
      if (actionStage === "initial") {
        if (value === "No") {
          batch.update(orderRef, { affixInitialSignature: "No" });
        } else {
          batch.update(orderRef, {
            affixInitialSignature: "Yes",
            affixInitialSignatureURL: signature.trim(),
            affixInitialSignatureName: accountName,
            affixInitialSignatureAt: serverTimestamp(),
            approvalStage: "chief",
          });
          if (record.chiefSignerId && record.chiefSignerId !== user.uid) {
            const notification = makeDocumentNotification(firestore, {
              recipientId: record.chiefSignerId,
              ownerId: user.uid,
              documentId: record.id,
              documentType: "Special Order",
              activityTitle: record.activityTitle,
              dateFrom: record.dateFrom,
              dateTo: record.dateTo,
              venue: record.venue,
              approvalStep: "chief",
            });
            batch.set(notification.reference, notification.data);
          }
        }
      } else if (value === "No") {
        batch.update(orderRef, { affixChiefInitialSignature: "No" });
      } else {
        batch.update(orderRef, {
          affixChiefInitialSignature: "Yes",
          affixChiefInitialSignatureURL: signature.trim(),
          affixChiefInitialSignatureName: accountName,
          affixChiefInitialSignatureAt: serverTimestamp(),
          approvalStage: "returned",
        });
        const notification = makeDocumentNotification(firestore, {
          recipientId: record.ownerId,
          ownerId: user.uid,
          documentId: record.id,
          documentType: "Special Order",
          activityTitle: record.activityTitle,
          dateFrom: record.dateFrom,
          dateTo: record.dateTo,
          venue: record.venue,
        });
        batch.set(notification.reference, notification.data);
      }
      await batch.commit();
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(code ? `Could not update the SO signature (${code}).` : "Could not update the SO signature. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  const isInitial = stage === "initial";
  const heading = "SO Approval";
  const signatureLabel = "Affix Initial Signature";

  return <section className="content-section so-approval-section">
    <div className="section-heading"><div><p className="eyebrow">Admin panel</p><h2>{heading}</h2><p className="muted">{records.length} Special Order{records.length === 1 ? "" : "s"} awaiting {isInitial ? "FOD Project Leader initial signature" : "Field Operations Division Chief initial signature"}.</p></div></div>
    {error && <p className="error-message" role="alert">{error}</p>}
    {loading ? <p className="muted">Loading SO approvals...</p> : records.length === 0 ? <div className="empty-state"><span className="empty-number">00</span><h3>No Special Orders awaiting your action</h3><p>New requests will appear here.</p></div> : <div className="permit-table so-approval-table">
      <div className="table-head"><span>Subject</span><span>Activity</span><span>Schedule</span><span>Attachment</span><span>{signatureLabel}</span><span>View</span></div>
      {records.map((record) => <div className="table-row" key={record.id}>
        <strong data-label="Subject">{record.subject}</strong>
        <span data-label="Activity">{record.activityTitle}</span>
        <span data-label="Schedule">{scheduleLabel(record.dateFrom, record.dateTo)}</span>
        <span data-label="Attachment">{safeAttachmentHref(record.attachmentLink) ? <a className="row-action" href={safeAttachmentHref(record.attachmentLink) ?? undefined} target="_blank" rel="noopener noreferrer">View Attachment</a> : "—"}</span>
        <label className="so-approval-affix" data-label="Affix Initial Signature"><select className="affix-signature-select" aria-label={`Affix Initial Signature for ${record.subject}`} value={record.approvalActionStage === "initial" ? record.affixInitialSignature ?? "No" : record.affixChiefInitialSignature ?? "No"} disabled={busyId === record.id} onChange={(event) => { if (event.target.value === "Yes" || event.target.value === "No") void changeAffixSignature(record, event.target.value); }}>
          <option value="Yes" disabled={!initialSignature.trim()}>Yes</option><option value="No">No</option>
        </select></label>
        <span className="permit-row-actions" data-label="View"><button type="button" className="row-action" onClick={() => onView(record)}>View</button></span>
      </div>)}
    </div>}
  </section>;
}
