import { collection, doc, getDocs, query, serverTimestamp, where, type Firestore } from "firebase/firestore";

export type DocumentNotificationType = "Special Order" | "Notice to Attend" | "Permit Slip" | "Travel Order" | "Leave Application" | "Travel Expense Voucher" | "Certificate Approval" | "Certificate Decision";
export type CertificateCollectionName = "certificatesOfAppearance" | "completionCertificates" | "appreciationCertificates" | "participationCertificates";
export type DocumentNotificationSchedule = { dateFrom: string; dateTo: string; venue: string };

export type DocumentNotification = {
  id: string;
  recipientId: string;
  ownerId: string;
  documentId: string;
  documentType: DocumentNotificationType;
  approvalStep?: "initial" | "chief";
  activityTitle?: string;
  certificateType?: string;
  certificateCollection?: CertificateCollectionName;
  decisionStatus?: "Approved" | "Disapproved";
  destination?: string;
  dateFrom?: string;
  dateTo?: string;
  venue?: string;
  schedules?: DocumentNotificationSchedule[];
  date?: string;
  purpose?: string;
  departureDate?: string;
  returnDate?: string;
  placeOfTravel?: string;
  applicantName?: string;
  leaveType?: string;
  inclusiveDateFrom?: string;
  inclusiveDateTo?: string;
  travelMonth?: string;
  totalAmount?: number;
  read: boolean;
  createdAt?: unknown;
};

export type DocumentNotificationDraft = Omit<DocumentNotification, "id" | "read" | "createdAt">;

export function makeDocumentNotification(firestore: Firestore, draft: DocumentNotificationDraft) {
  return {
    reference: doc(collection(firestore, "documentNotifications")),
    data: { ...draft, read: false, createdAt: serverTimestamp() },
  };
}

export async function getDocumentNotificationReferences(firestore: Firestore, ownerId: string, documentId: string) {
  const snapshot = await getDocs(query(
    collection(firestore, "documentNotifications"),
    where("ownerId", "==", ownerId),
    where("documentId", "==", documentId),
  ));
  return snapshot.docs.map((notification) => notification.ref);
}
