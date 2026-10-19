import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";

const app = initializeApp();
const db = getFirestore(app, "ps-taguibo");
const reminders = db.collection("documentReminders");
const hour = 60 * 60 * 1000;
const day = 24 * hour;
const permitDeletionAfter = 6 * hour;
const permitWarningAfter = permitDeletionAfter - 30 * 60 * 1000;
const rootSuperAdminEmail = "rjamescute2@gmail.com";

export const getUserEmailForPasswordReset = onCall({ region: "asia-southeast1" }, async (request) => {
  if (!request.auth || request.auth.token.email_verified !== true) {
    throw new HttpsError("unauthenticated", "Sign in with a verified email before requesting a password reset.");
  }

  const callerEmail = typeof request.auth.token.email === "string" ? request.auth.token.email.trim().toLowerCase() : "";
  const callerProfile = await db.collection("users").doc(request.auth.uid).get();
  const isRootSuperAdmin = callerEmail === rootSuperAdminEmail;
  const isApprovedSuperAdmin = callerProfile.exists
    && callerProfile.data()?.accountRole === "superadmin"
    && (callerProfile.data()?.accountStatus ?? "Approved") === "Approved";
  if (!isRootSuperAdmin && !isApprovedSuperAdmin) {
    throw new HttpsError("permission-denied", "Only an approved superadmin can request another account's password reset.");
  }

  const userId = request.data?.userId;
  if (typeof userId !== "string" || !userId.trim()) {
    throw new HttpsError("invalid-argument", "A user ID is required.");
  }

  const targetProfile = await db.collection("users").doc(userId).get();
  if (!targetProfile.exists || targetProfile.data()?.emailVerified !== true) {
    throw new HttpsError("not-found", "This verified user profile could not be found.");
  }

  try {
    const targetAccount = await getAuth(app).getUser(userId);
    if (!targetAccount.email || !targetAccount.emailVerified) {
      throw new HttpsError("failed-precondition", "This account does not have a verified email address.");
    }
    return { email: targetAccount.email };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error("Could not look up the target account for a password reset", { userId, error });
    throw new HttpsError("internal", "Could not look up the user's email address.");
  }
});

function manilaParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function dateOnlyManilaMillis(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, date] = value.split("-").map(Number);
  const utcMidnight = Date.UTC(year, month - 1, date);
  const parsed = new Date(utcMidnight);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== date) return null;
  return utcMidnight - 8 * hour;
}

function timestampMillis(value) {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return 0;
}

function isPending(status) {
  return status !== "Approved" && status !== "Disapproved";
}

function stableReminderId(kind, recordId) {
  return `${kind}__${encodeURIComponent(recordId)}`;
}

async function createReminder(kind, recordId, ownerId, details) {
  const reference = reminders.doc(stableReminderId(kind, recordId));
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(reference);
    if (!existing.exists) {
      transaction.create(reference, {
        recipientId: ownerId,
        ownerId,
        kind,
        recordId,
        ...details,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  });
}

async function ensureReminder(kind, recordId, ownerId, details) {
  const reference = reminders.doc(stableReminderId(kind, recordId));
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(reference);
    const fields = { recipientId: ownerId, ownerId, kind, recordId, ...details };
    if (!existing.exists) {
      transaction.create(reference, {
        ...fields,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    const current = existing.data();
    const changed = Object.entries(fields).some(([key, value]) => {
      const currentValue = current[key];
      if (value instanceof Timestamp && currentValue instanceof Timestamp) return !value.isEqual(currentValue);
      return currentValue !== value;
    });
    if (changed) transaction.update(reference, fields);
  });
}

async function clearResolvedReminders(kind, isResolved) {
  const snapshot = await reminders.where("kind", "==", kind).get();
  const stale = await Promise.all(snapshot.docs.map(async (notification) => {
    const data = notification.data();
    return await isResolved(data) ? notification.ref : null;
  }));
  const resolved = stale.filter(Boolean);
  for (let start = 0; start < resolved.length; start += 450) {
    const batch = db.batch();
    resolved.slice(start, start + 450).forEach((reference) => batch.delete(reference));
    await batch.commit();
  }
}

function recordRefForReminder(reminder) {
  if (reminder.kind === "travel-order-status") return db.collection("travelOrders").doc(reminder.recordId);
  if (reminder.kind === "leave-application-status") return db.collection("leaveApplications").doc(reminder.recordId);
  if (reminder.kind === "permit-slip-expiry") return db.collection("permits").doc(reminder.recordId);
  if (reminder.kind === "accomplishment-report") {
    const suffix = reminder.cycle === 1 ? "first" : "second";
    return db.collection("accomplishmentReports").doc(`${reminder.ownerId}_${reminder.month}_${suffix}`);
  }
  return null;
}

function permitDecisionKey(data, index, permitId) {
  const numbers = Array.isArray(data.permitNos) ? data.permitNos : [];
  if (typeof numbers[index] === "string") return numbers[index];
  const names = Array.isArray(data.names) ? data.names : [];
  const permitNo = typeof data.permitNo === "string" && data.permitNo ? data.permitNo : permitId;
  return names.length > 1 ? `${permitNo}__person_${index + 1}` : permitNo;
}

function pendingPermitIndices(data, permitId) {
  const names = Array.isArray(data.names) ? data.names : typeof data.name === "string" ? [data.name] : [];
  return names.flatMap((_, index) => {
    const decision = data.personStatuses?.[permitDecisionKey(data, index, permitId)];
    return isPending(decision?.status) ? [index] : [];
  });
}

async function processPendingPermit(permitSnapshot, now) {
  const permitRef = permitSnapshot.ref;
  const initialData = permitSnapshot.data();
  const createdAt = timestampMillis(initialData.createdAt);
  if (!createdAt || now < createdAt + permitWarningAfter) return false;

  const result = await db.runTransaction(async (transaction) => {
    const fresh = await transaction.get(permitRef);
    if (!fresh.exists) return { removedUserIds: [], deletedPermit: false, shouldWarn: false };
    const data = fresh.data();
    const currentCreatedAt = timestampMillis(data.createdAt);
    if (!currentCreatedAt || now < currentCreatedAt + permitWarningAfter) return { removedUserIds: [], deletedPermit: false, shouldWarn: false };
    const names = Array.isArray(data.names) ? data.names : typeof data.name === "string" ? [data.name] : [];
    const pendingIndices = pendingPermitIndices(data, permitRef.id);
    if (!pendingIndices.length) return { removedUserIds: [], deletedPermit: false, shouldWarn: false };

    if (now < currentCreatedAt + permitDeletionAfter) {
      return { removedUserIds: [], deletedPermit: false, shouldWarn: true };
    }

    const pendingSet = new Set(pendingIndices);
    const keepIndices = names.map((_, index) => index).filter((index) => !pendingSet.has(index));
    const personIds = Array.isArray(data.personIds) ? data.personIds : [];
    const retainedUserIds = new Set(keepIndices.map((index) => personIds[index]).filter((id) => typeof id === "string"));
    const removedUserIds = [...new Set(pendingIndices.map((index) => personIds[index]).filter((id) => typeof id === "string" && !retainedUserIds.has(id)))];

    if (keepIndices.length === 0) {
      transaction.delete(permitRef);
      return { removedUserIds, deletedPermit: true, shouldWarn: false };
    }

    const permitNos = Array.isArray(data.permitNos) ? data.permitNos : [];
    const personUnits = Array.isArray(data.personUnits) ? data.personUnits : [];
    const keptStatuses = { ...(data.personStatuses ?? {}) };
    pendingIndices.forEach((index) => delete keptStatuses[permitDecisionKey(data, index, permitRef.id)]);
    const keptPersonIds = keepIndices.map((index) => personIds[index]).filter((id) => typeof id === "string");
    const keptPermitNos = keepIndices.map((index) => permitNos[index]).filter((number) => typeof number === "string");
    const keptPersonUnits = keepIndices.map((index) => personUnits[index]).filter((unit) => typeof unit === "string");
    const nextData = {
      names: keepIndices.map((index) => names[index]),
      personStatuses: keptStatuses,
      permitNo: keptPermitNos[0] ?? data.permitNo ?? "",
      unit: keptPersonUnits[0] ?? data.unit,
    };
    if (personIds.length) nextData.personIds = keptPersonIds;
    if (permitNos.length) nextData.permitNos = keptPermitNos;
    if (personUnits.length) nextData.personUnits = keptPersonUnits;
    if (typeof data.name === "string") nextData.name = keepIndices.map((index) => names[index]).join(", ");
    if (Array.isArray(data.recipientIds) && personIds.length) {
      nextData.recipientIds = [...new Set(keptPersonIds.filter((id) => id !== data.ownerId))];
    }
    transaction.update(permitRef, nextData);
    return { removedUserIds, deletedPermit: false, shouldWarn: false };
  });

  if (result.deletedPermit || result.removedUserIds.length) {
    const assignedNotifications = await db.collection("documentNotifications")
      .where("ownerId", "==", initialData.ownerId)
      .where("documentId", "==", permitRef.id)
      .get();
    const batch = db.batch();
    let hasDeletes = false;
    assignedNotifications.docs.forEach((notification) => {
      if (result.deletedPermit || result.removedUserIds.includes(notification.data().recipientId)) {
        batch.delete(notification.ref);
        hasDeletes = true;
      }
    });
    if (hasDeletes) await batch.commit();
  }
  if (result.deletedPermit) {
    const calendarEntries = await db.collection("approvedPermitCalendar").where("permitId", "==", permitRef.id).get();
    for (let start = 0; start < calendarEntries.docs.length; start += 450) {
      const batch = db.batch();
      calendarEntries.docs.slice(start, start + 450).forEach((entry) => batch.delete(entry.ref));
      await batch.commit();
    }
  }
  return result.shouldWarn;
}

async function processTravelOrders(now) {
  const snapshot = await db.collection("travelOrders").where("status", "==", "Pending").get();
  const pendingIds = new Set(snapshot.docs.map((item) => item.id));
  await Promise.all(snapshot.docs.map(async (item) => {
    const data = item.data();
    const returnMillis = dateOnlyManilaMillis(data.returnDate);
    if (returnMillis !== null && now >= returnMillis + 2 * day) {
      await createReminder("travel-order-status", item.id, data.ownerId, {
        date: data.date || data.departureDate || "",
        returnDate: data.returnDate,
        purpose: data.purpose ?? "",
        destination: data.placeOfTravel ?? "",
      });
    }
  }));
  await clearResolvedReminders("travel-order-status", async (reminder) => {
    if (pendingIds.has(reminder.recordId)) return false;
    const record = await recordRefForReminder(reminder)?.get();
    return !record?.exists || !isPending(record.data()?.status);
  });
}

async function processLeaveApplications(now) {
  const snapshot = await db.collection("leaveApplications").where("status", "==", "Pending").get();
  const pendingIds = new Set(snapshot.docs.map((item) => item.id));
  await Promise.all(snapshot.docs.map(async (item) => {
    const data = item.data();
    const filedMillis = dateOnlyManilaMillis(data.filedDate);
    if (filedMillis !== null && now >= filedMillis + 7 * day) {
      await createReminder("leave-application-status", item.id, data.ownerId, {
        date: data.filedDate,
        leaveType: data.leaveType ?? "",
        inclusiveDateFrom: data.inclusiveDateFrom ?? "",
        inclusiveDateTo: data.inclusiveDateTo ?? "",
      });
    }
  }));
  await clearResolvedReminders("leave-application-status", async (reminder) => {
    if (pendingIds.has(reminder.recordId)) return false;
    const record = await recordRefForReminder(reminder)?.get();
    return !record?.exists || record.data()?.status !== "Pending";
  });
}

async function processPermits(now) {
  const warningThreshold = Timestamp.fromMillis(now - permitWarningAfter);
  const snapshot = await db.collection("permits").where("createdAt", "<=", warningThreshold).get();
  const activeReminderIds = new Set();
  await Promise.all(snapshot.docs.map(async (item) => {
    const data = item.data();
    const shouldWarn = await processPendingPermit(item, now);
    if (shouldWarn && typeof data.ownerId === "string") {
      activeReminderIds.add(item.id);
      const createdAt = timestampMillis(data.createdAt);
      await ensureReminder("permit-slip-expiry", item.id, data.ownerId, {
        date: data.date ?? "",
        purpose: data.purpose ?? "",
        deletesAt: createdAt ? Timestamp.fromMillis(createdAt + permitDeletionAfter) : null,
      });
    }
  }));
  const warningSnapshot = await reminders.where("kind", "==", "permit-slip-expiry").get();
  const staleWarnings = warningSnapshot.docs.filter((notification) => !activeReminderIds.has(notification.data().recordId));
  for (let start = 0; start < staleWarnings.length; start += 450) {
    const batch = db.batch();
    staleWarnings.slice(start, start + 450).forEach((notification) => batch.delete(notification.ref));
    await batch.commit();
  }
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatCycleLabel(year, month, cycle, endDay) {
  const monthName = new Intl.DateTimeFormat("en-PH", { month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, 1)));
  const startDay = cycle === 1 ? 1 : 16;
  return `${monthName} ${startDay}-${endDay}, ${year}`;
}

async function processAccomplishmentReports(now) {
  const { year: yearText, month: monthText, day: dayText } = manilaParts(now);
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  const dayNumber = Number(dayText);
  const endOfMonth = lastDayOfMonth(year, monthNumber);
  const cycle = dayNumber === 15 ? 1 : dayNumber === endOfMonth ? 2 : null;

  if (cycle) {
    const month = `${year}-${monthText}`;
    const endDay = cycle === 1 ? 15 : endOfMonth;
    const users = await db.collection("users").get();
    const userIds = users.docs.map((user) => user.id);
    const reportRefs = userIds.map((userId) => db.collection("accomplishmentReports").doc(`${userId}_${month}_${cycle === 1 ? "first" : "second"}`));
    for (let start = 0; start < reportRefs.length; start += 450) {
      const reports = await db.getAll(...reportRefs.slice(start, start + 450));
      await Promise.all(reports.map(async (report, index) => {
        if (report.exists) return;
        const userId = userIds[start + index];
        const reminderId = `${userId}_${month}_${cycle}`;
        await createReminder("accomplishment-report", reminderId, userId, {
          month,
          cycle,
          startDay: cycle === 1 ? 1 : 16,
          endDay,
          periodLabel: formatCycleLabel(year, monthNumber, cycle, endDay),
        });
      }));
    }
  }

  await clearResolvedReminders("accomplishment-report", async (reminder) => {
    const report = await recordRefForReminder(reminder)?.get();
    return Boolean(report?.exists);
  });
}

export const sendPendingDocumentReminders = onSchedule({
  schedule: "every 60 minutes",
  timeZone: "Asia/Manila",
  region: "asia-southeast1",
  timeoutSeconds: 540,
  memory: "512MiB",
}, async () => {
  const now = Date.now();
  await Promise.all([
    processTravelOrders(now),
    processLeaveApplications(now),
    processAccomplishmentReports(now),
  ]).catch((error) => {
    logger.error("Could not process all document reminders", error);
    throw error;
  });
});
export const expirePendingPermitSlips = onSchedule({
  schedule: "* * * * *",
  timeZone: "Asia/Manila",
  region: "asia-southeast1",
  timeoutSeconds: 540,
  memory: "512MiB",
}, async () => {
  try {
    await processPermits(Date.now());
  } catch (error) {
    logger.error("Could not process pending Permit Slip expiry", error);
    throw error;
  }
});

