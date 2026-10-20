export const accomplishmentReportNotificationsCollection = "accomplishmentReportNotifications";

export type AccomplishmentReportWorkflowEvent =
  | "project-leader-signature"
  | "project-leader-completed"
  | "chief-signature"
  | "creator-review";

export type AccomplishmentReportWorkflowNotification = {
  id: string;
  recipientId: string;
  ownerId: string;
  reportId: string;
  unit: string;
  month: string;
  cycle: 1 | 2;
  event: AccomplishmentReportWorkflowEvent;
  read: boolean;
  createdAt?: unknown;
};
