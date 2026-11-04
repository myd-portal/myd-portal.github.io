import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { randomInt } from "node:crypto";
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

const wishlistEntries = db.collection("myWishlistEntries");
const wishlistParticipants = db.collection("myWishlistParticipants");
const wishlistDraw = db.collection("myWishlistDraws").doc("current");
const wishlistStatus = db.collection("myWishlistStatus").doc("current");

function isWishlistProfile(profile) {
  if (!profile || profile.emailVerified !== true || ![undefined, null, "Approved"].includes(profile.accountStatus)) return false;
  if (profile.accountRole === "regular") {
    return profile.office === "Division"
      && profile.division === "Field Operations Division"
      && ["AGRISTAT", "AMIA", "DRRM"].includes(profile.unit);
  }
  return profile.accountRole === "admin"
    && profile.office === "Division"
    && profile.division === "Field Operations Division"
    && profile.unit === "Field Operations Division"
    && profile.designation === "AGRISTAT/DRRM/AMIA Project Leader";
}

async function requireWishlistUser(request) {
  if (!request.auth || request.auth.token.email_verified !== true) {
    throw new HttpsError("unauthenticated", "Sign in with a verified email to use myWishlist.");
  }
  const profileSnapshot = await db.collection("users").doc(request.auth.uid).get();
  if (!profileSnapshot.exists || !isWishlistProfile(profileSnapshot.data())) {
    throw new HttpsError("permission-denied", "myWishlist is available to approved FOD AGRISTAT, AMIA, and DRRM regular users and the FOD Project Leader admin.");
  }
  return { uid: request.auth.uid, profile: profileSnapshot.data() };
}

async function getWishlistParticipants(transaction) {
  const profileQuery = db.collection("users").where("division", "==", "Field Operations Division");
  const profiles = transaction
    ? await transaction.get(profileQuery)
    : await profileQuery.get();
  return profiles.docs
    .filter((profile) => isWishlistProfile(profile.data()))
    .map((profile) => profile.id)
    .sort((first, second) => first.localeCompare(second));
}

function normalizeWishlistItems(items) {
  if (items === undefined) return undefined;
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
    throw new HttpsError("invalid-argument", "Add between 1 and 20 wishlist items.");
  }
  return items.map((item) => {
    if (!item || typeof item !== "object") throw new HttpsError("invalid-argument", "A wishlist item is invalid.");
    const desiredGift = requiredSpecialOrderText(item.desiredGift, "Desired Gift", 160);
    const description = requiredSpecialOrderText(item.description, "Description", 1000);
    const amount = optionalWishlistText(item.amount, "Amount", 80);
    const link = optionalWishlistText(item.link, "Link", 2048);
    if (link) {
      let url;
      try { url = new URL(link); } catch {}
      if (!url || !["http:", "https:"].includes(url.protocol) || !url.hostname) {
        throw new HttpsError("invalid-argument", "Link must be a valid HTTP or HTTPS URL.");
      }
    }
    return { desiredGift, description, amount, link };
  });
}

function optionalWishlistText(value, field, maxLength) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new HttpsError("invalid-argument", `${field} is invalid.`);
  }
  return value.trim();
}

function wishlistEntryIsComplete(entry) {
  return typeof entry?.nickname === "string"
    && entry.nickname.trim().length > 0
    && ((Array.isArray(entry.wishlist) && entry.wishlist.length > 0)
      || (entry.hasWishlist === true && typeof entry.itemCount === "number" && entry.itemCount > 0));
}

function wishlistProgress(participantIds, entries) {
  const completeCount = participantIds.filter((userId) => wishlistEntryIsComplete(entries.get(userId))).length;
  return {
    participantCount: participantIds.length,
    completedCount: completeCount,
    ready: completeCount >= 2,
  };
}

function createElfsterAssignments(participantIds) {
  if (participantIds.length < 2) throw new HttpsError("failed-precondition", "At least two users must enter a wishlist before the reveal can begin.");
  // Sattolo's shuffle creates one random cycle, so nobody draws themself and each nickname is used once.
  const cycle = [...participantIds];
  for (let index = cycle.length - 1; index > 0; index -= 1) {
    const otherIndex = randomInt(index);
    [cycle[index], cycle[otherIndex]] = [cycle[otherIndex], cycle[index]];
  }
  return new Map(cycle.map((userId, index) => [userId, cycle[(index + 1) % cycle.length]]));
}

function publicWishlistStatus({ participantCount, completedCount, drawActive, revealedCount = 0 }) {
  const drawPoolCount = drawActive ? completedCount : participantCount;
  return {
    participantCount,
    completedCount,
    ready: drawActive || completedCount >= 2,
    drawActive,
    revealedCount,
    remainingCount: Math.max(0, drawPoolCount - revealedCount),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function revealedWishlist(assignment, snapshot) {
  return {
    nickname: snapshot.nickname,
    wishlist: snapshot.wishlist,
    cycleId: assignment.cycleId,
  };
}

export const saveMyWishlist = onCall({ region: "asia-southeast1" }, async (request) => {
  const { uid } = await requireWishlistUser(request);
  const nickname = requiredSpecialOrderText(request.data?.nickname, "Nickname", 40);
  const submittedItems = normalizeWishlistItems(request.data?.wishlist);
  const userReference = db.collection("users").doc(uid);
  const entryReference = wishlistEntries.doc(uid);
  const participantReference = wishlistParticipants.doc(uid);

  await db.runTransaction(async (transaction) => {
    const [profileSnapshot, drawSnapshot, entrySnapshot] = await Promise.all([
      transaction.get(userReference),
      transaction.get(wishlistDraw),
      transaction.get(entryReference),
    ]);
    if (!profileSnapshot.exists || !isWishlistProfile(profileSnapshot.data())) {
      throw new HttpsError("permission-denied", "Your account no longer meets the myWishlist access requirements.");
    }
    if (drawSnapshot.exists) {
      throw new HttpsError("failed-precondition", "The Elfster reveal has started, so wishlists are now locked.");
    }

    const participantIds = await getWishlistParticipants(transaction);
    if (!participantIds.includes(uid)) throw new HttpsError("permission-denied", "Your account is not an active myWishlist participant.");
    const otherParticipantRefs = participantIds.filter((userId) => userId !== uid).map((userId) => wishlistParticipants.doc(userId));
    const otherParticipants = otherParticipantRefs.length ? await transaction.getAll(...otherParticipantRefs) : [];
    const duplicateNickname = otherParticipants.some((participant) => participant.exists
      && typeof participant.data()?.nickname === "string"
      && participant.data().nickname.trim().toLocaleLowerCase() === nickname.toLocaleLowerCase());
    if (duplicateNickname) throw new HttpsError("already-exists", "That nickname is already in use. Choose a different nickname.");

    const previousEntry = entrySnapshot.data();
    const wishlist = submittedItems ?? previousEntry?.wishlist ?? [];
    const entry = { nickname, wishlist, updatedAt: FieldValue.serverTimestamp() };
    const progressEntries = new Map([[uid, { ...entry, updatedAt: null }]]);
    for (const participant of otherParticipants) {
      if (participant.exists) progressEntries.set(participant.id, participant.data());
    }
    const progress = wishlistProgress(participantIds, progressEntries);
    transaction.set(entryReference, entry);
    transaction.set(participantReference, {
      nickname,
      hasWishlist: wishlist.length > 0,
      itemCount: wishlist.length,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(wishlistStatus, publicWishlistStatus({
      ...progress,
      drawActive: false,
    }));
  });

  return { saved: true };
});

export const getMyWishlistState = onCall({ region: "asia-southeast1" }, async (request) => {
  const { uid } = await requireWishlistUser(request);
  const participantIds = await getWishlistParticipants();
  const [entrySnapshot, drawSnapshot] = await Promise.all([
    wishlistEntries.doc(uid).get(),
    wishlistDraw.get(),
  ]);
  const ownEntry = entrySnapshot.exists ? entrySnapshot.data() : null;
  let state = {
    nickname: ownEntry?.nickname ?? "",
    wishlist: ownEntry?.wishlist ?? [],
    participantCount: participantIds.length,
    completedCount: 0,
    ready: false,
    drawActive: drawSnapshot.exists,
    isParticipant: participantIds.includes(uid),
    revealed: null,
  };

  if (drawSnapshot.exists) {
    const draw = drawSnapshot.data();
    state.participantCount = draw.specifiedUserCount ?? draw.participantIds.length;
    state.completedCount = draw.entryCount ?? draw.participantIds.length;
    state.ready = true;
    state.isParticipant = draw.participantIds.includes(uid);
    if (state.isParticipant) {
      const assignmentSnapshot = await wishlistDraw.collection("assignments").doc(uid).get();
      const assignment = assignmentSnapshot.data();
      if (assignment?.revealed && typeof assignment.targetId === "string") {
        const targetSnapshot = await wishlistDraw.collection("snapshots").doc(assignment.targetId).get();
        if (targetSnapshot.exists) state.revealed = revealedWishlist(assignment, targetSnapshot.data());
      }
    }
  } else {
    const entryRefs = participantIds.map((userId) => wishlistEntries.doc(userId));
    const entrySnapshots = entryRefs.length ? await db.getAll(...entryRefs) : [];
    const entries = new Map(entrySnapshots.filter((entry) => entry.exists).map((entry) => [entry.id, entry.data()]));
    const progress = wishlistProgress(participantIds, entries);
    state = { ...state, ...progress };
    await wishlistStatus.set(publicWishlistStatus({ ...progress, drawActive: false }), { merge: true });
  }
  return state;
});

export const revealElfster = onCall({ region: "asia-southeast1" }, async (request) => {
  const { uid } = await requireWishlistUser(request);
  return db.runTransaction(async (transaction) => {
    const drawSnapshot = await transaction.get(wishlistDraw);

    if (drawSnapshot.exists) {
      const draw = drawSnapshot.data();
      if (!draw.participantIds.includes(uid)) {
        throw new HttpsError("failed-precondition", "Your account joined after this Elfster draw started and is not part of the current draw.");
      }
      const assignmentReference = wishlistDraw.collection("assignments").doc(uid);
      const assignmentSnapshot = await transaction.get(assignmentReference);
      if (!assignmentSnapshot.exists) throw new HttpsError("failed-precondition", "Your Elfster assignment could not be found.");
      const assignment = assignmentSnapshot.data();
      const targetReference = wishlistDraw.collection("snapshots").doc(assignment.targetId);
      const targetSnapshot = await transaction.get(targetReference);
      if (!targetSnapshot.exists) throw new HttpsError("internal", "The revealed wishlist could not be found.");

      if (!assignment.revealed) {
        const revealedCount = (draw.revealedCount ?? 0) + 1;
        transaction.update(assignmentReference, { revealed: true, revealedAt: FieldValue.serverTimestamp() });
        transaction.update(wishlistDraw, { revealedCount, remainingCount: draw.participantIds.length - revealedCount });
        transaction.set(wishlistStatus, publicWishlistStatus({
          participantCount: draw.specifiedUserCount ?? draw.participantIds.length,
          completedCount: draw.entryCount ?? draw.participantIds.length,
          drawActive: true,
          revealedCount,
        }));
      }
      return { ...revealedWishlist(assignment, targetSnapshot.data()), alreadyRevealed: Boolean(assignment.revealed) };
    }

    const participantIds = await getWishlistParticipants(transaction);
    if (!participantIds.includes(uid)) throw new HttpsError("permission-denied", "Your account is not an active myWishlist participant.");
    if (participantIds.length > 200) throw new HttpsError("resource-exhausted", "This Elfster draw has more than 200 participants. Contact the system administrator.");

    const entryReferences = participantIds.map((userId) => wishlistEntries.doc(userId));
    const entrySnapshots = await transaction.getAll(...entryReferences);
    const entries = new Map(entrySnapshots.filter((entry) => entry.exists).map((entry) => [entry.id, entry.data()]));
    const progress = wishlistProgress(participantIds, entries);
    if (!progress.ready) throw new HttpsError("failed-precondition", `At least two specified users must save a nickname and wishlist before the reveal can begin (${progress.completedCount} complete).`);
    const drawParticipantIds = participantIds.filter((userId) => wishlistEntryIsComplete(entries.get(userId)));
    if (!drawParticipantIds.includes(uid)) {
      throw new HttpsError("failed-precondition", "Save your nickname and at least one wishlist item before revealing a match.");
    }

    const assignments = createElfsterAssignments(drawParticipantIds);
    const cycleId = wishlistDraw.id;
    const now = FieldValue.serverTimestamp();
    const myTargetId = assignments.get(uid);
    const myAssignment = { targetId: myTargetId, cycleId, revealed: true, revealedAt: now };
    const targetEntry = entries.get(myTargetId);
    transaction.create(wishlistDraw, {
      cycleId,
      participantIds: drawParticipantIds,
      specifiedUserCount: participantIds.length,
      entryCount: drawParticipantIds.length,
      revealedCount: 1,
      remainingCount: drawParticipantIds.length - 1,
      startedAt: now,
    });
    for (const userId of drawParticipantIds) {
      const targetId = assignments.get(userId);
      transaction.create(wishlistDraw.collection("assignments").doc(userId), userId === uid
        ? myAssignment
        : { targetId, cycleId, revealed: false, revealedAt: null });
      transaction.create(wishlistDraw.collection("snapshots").doc(userId), {
        nickname: entries.get(userId).nickname,
        wishlist: entries.get(userId).wishlist,
      });
    }
    transaction.set(wishlistStatus, publicWishlistStatus({
      participantCount: participantIds.length,
      completedCount: drawParticipantIds.length,
      drawActive: true,
      revealedCount: 1,
    }));
    return {
      nickname: targetEntry.nickname,
      wishlist: targetEntry.wishlist,
      cycleId,
      alreadyRevealed: false,
    };
  });
});

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

function requiredSpecialOrderText(value, field, maxLength) {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", `${field} is required.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new HttpsError("invalid-argument", `${field} must be between 1 and ${maxLength} characters.`);
  }
  return normalized;
}

function specialOrderTextArray(value, field, { allowEmpty = false, maxLength = 120, maxItems = 100 } = {}) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new HttpsError("invalid-argument", `${field} must contain between 1 and ${maxItems} entries.`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length > maxLength || (!allowEmpty && !entry.trim())) {
      throw new HttpsError("invalid-argument", `${field} contains an invalid entry.`);
    }
    return entry.trim();
  });
}

function hasSpecialOrderDesignation(value, designation) {
  return typeof value === "string"
    && value.split(";").map((entry) => entry.trim()).includes(designation);
}

export const createFodSpecialOrder = onCall({ region: "asia-southeast1" }, async (request) => {
  if (!request.auth || request.auth.token.email_verified !== true) {
    throw new HttpsError("unauthenticated", "Sign in with a verified email before creating a Special Order.");
  }

  const ownerId = request.auth.uid;
  const ownerSnapshot = await db.collection("users").doc(ownerId).get();
  if (!ownerSnapshot.exists) {
    throw new HttpsError("failed-precondition", "Your user profile could not be found.");
  }
  const owner = ownerSnapshot.data();
  const role = typeof owner.accountRole === "string" ? owner.accountRole.toLowerCase() : "";
  if (!(["regular", "user"].includes(role)
      && (owner.accountStatus === undefined || owner.accountStatus === null || owner.accountStatus === "Approved")
      && owner.office === "Division"
      && owner.division === "Field Operations Division"
      && ["AGRISTAT", "DRRM", "AMIA"].includes(owner.unit))) {
    throw new HttpsError("permission-denied", "Only an approved Regular account in AGRISTAT, DRRM, or AMIA can use this Special Order route.");
  }

  const orderId = request.data?.orderId;
  if (typeof orderId !== "string" || !/^[A-Za-z0-9_-]{20}$/.test(orderId)) {
    throw new HttpsError("invalid-argument", "A valid Special Order ID is required.");
  }
  const signatoryName = requiredSpecialOrderText(request.data?.signatoryName, "Signatory name", 120);
  const signatoryDesignation = requiredSpecialOrderText(request.data?.signatoryDesignation, "Signatory designation", 120);
  const subject = requiredSpecialOrderText(request.data?.subject, "Subject", 500);
  const activityTitle = requiredSpecialOrderText(request.data?.activityTitle, "Activity title", 500);
  const organizer = requiredSpecialOrderText(request.data?.organizer, "Organizer or host", 300);
  const dateFrom = requiredSpecialOrderText(request.data?.dateFrom, "Start date", 40);
  const dateTo = requiredSpecialOrderText(request.data?.dateTo, "End date", 40);
  const timeFrom = requiredSpecialOrderText(request.data?.timeFrom, "Start time", 20);
  const timeTo = requiredSpecialOrderText(request.data?.timeTo, "End time", 20);
  const venue = requiredSpecialOrderText(request.data?.venue, "Venue", 500);
  const attachmentLink = typeof request.data?.attachmentLink === "string" ? request.data.attachmentLink.trim() : "";
  let attachmentUrl;
  try { if (attachmentLink) attachmentUrl = new URL(attachmentLink); } catch {}
  if (attachmentLink.length > 2048 || (attachmentLink && (!attachmentUrl || !["http:", "https:"].includes(attachmentUrl.protocol) || !attachmentUrl.hostname))) {
    throw new HttpsError("invalid-argument", "Attachment Link must be a valid HTTP or HTTPS URL of at most 2048 characters.");
  }
  const participants = specialOrderTextArray(request.data?.participants, "Designated personnel", { maxLength: 120 });
  const participantPositions = specialOrderTextArray(request.data?.participantPositions, "Personnel positions", { allowEmpty: true });
  const participantUnits = specialOrderTextArray(request.data?.participantUnits, "Personnel units", { allowEmpty: true });
  const participantUserIds = specialOrderTextArray(request.data?.participantUserIds, "Personnel user IDs", { allowEmpty: true, maxLength: 128 });
  if (participantPositions.length !== participants.length
      || participantUnits.length !== participants.length
      || participantUserIds.length !== participants.length) {
    throw new HttpsError("invalid-argument", "Personnel names and details must have matching lengths.");
  }
  const participantIds = [...new Set(participantUserIds.filter(Boolean))];

  const routeSnapshot = await db.collection("users")
    .where("unit", "==", "Field Operations Division")
    .get();
  const routeAccounts = routeSnapshot.docs
    .map((document) => ({ ...document.data(), userId: document.id }))
    .filter((account) => account.accountRole === "admin"
      && (account.accountStatus === undefined || account.accountStatus === null || account.accountStatus === "Approved")
      && account.office === "Division"
      && account.division === "Field Operations Division"
      && account.unit === "Field Operations Division")
    .sort((first, second) => first.userId.localeCompare(second.userId));
  const projectLeader = routeAccounts.find((account) => hasSpecialOrderDesignation(account.designation, "AGRISTAT/DRRM/AMIA Project Leader"));
  const chief = routeAccounts.find((account) => hasSpecialOrderDesignation(account.designation, "Chief"));
  if (!projectLeader) {
    throw new HttpsError("failed-precondition", "An approved Field Operations Division Project Leader Admin account is required.");
  }
  if (!chief) {
    throw new HttpsError("failed-precondition", "An approved Field Operations Division Chief Admin account is required.");
  }
  if (projectLeader.userId === chief.userId || projectLeader.userId === ownerId || chief.userId === ownerId) {
    throw new HttpsError("failed-precondition", "The Special Order approval route must use distinct approver accounts.");
  }

  const orderReference = db.collection("specialOrders").doc(orderId);
  const record = {
    subject,
    activityTitle,
    organizer,
    dateFrom,
    dateTo,
    timeFrom,
    timeTo,
    venue,
    attachmentLink,
    participants,
    participantPositions,
    participantUnits,
    participantUserIds,
    participantIds,
    recipientIds: participantIds.filter((userId) => userId !== ownerId),
    signatoryName,
    signatoryDesignation,
    ownerId,
    ownerOffice: owner.office,
    ownerDivision: owner.division,
    ownerUnit: owner.unit,
    approvalWorkflow: "fod",
    approvalStage: "owner-send",
    externalSignatory: ["Regional Executive Director", "RTD for Operations", "RTD for Research and Regulations"].includes(signatoryDesignation),
    initialSignerId: projectLeader.userId,
    chiefSignerId: chief.userId,
    affixInitialSignature: "No",
    affixChiefInitialSignature: "No",
    createdAt: FieldValue.serverTimestamp(),
  };

  try {
    await orderReference.create(record);
  } catch (error) {
    logger.error("Could not create the FOD Special Order", { ownerId, orderId, error });
    throw new HttpsError("internal", "Could not save the Special Order.");
  }
  return { orderId, initialSignerId: projectLeader.userId, chiefSignerId: chief.userId };
});

function requiredNtaText(value, field, maxLength) {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", `${field} is required.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new HttpsError("invalid-argument", `${field} must be between 1 and ${maxLength} characters.`);
  }
  return normalized;
}

function optionalNtaText(value, field, maxLength) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new HttpsError("invalid-argument", `${field} is invalid.`);
  }
  return value.trim();
}

function ntaProfileDesignation(value, requested) {
  return typeof value === "string" && value.split(";").map((entry) => entry.trim()).includes(requested);
}

function ntaAccountDesignation(value) {
  if (ntaProfileDesignation(value, "Chief")) return "Chief";
  if (ntaProfileDesignation(value, "OIC")) return "OIC";
  return "";
}

function ntaApproverProfile(account, designation) {
  return typeof account.accountRole === "string" && account.accountRole.toLowerCase() === "admin"
    && (account.accountStatus === undefined || account.accountStatus === null || account.accountStatus === "Approved")
    && account.office === "Division"
    && account.division === "Field Operations Division"
    && account.unit === "Field Operations Division"
    && ntaProfileDesignation(account.designation, designation);
}

function requiredNtaBatches(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new HttpsError("invalid-argument", "At least one valid NTA schedule is required.");
  }
  return value.map((batch, index) => {
    if (!batch || typeof batch !== "object" || Array.isArray(batch)) {
      throw new HttpsError("invalid-argument", `Schedule ${index + 1} is invalid.`);
    }
    const venueType = batch.venueType;
    if (venueType !== "physical" && venueType !== "virtual") {
      throw new HttpsError("invalid-argument", `Schedule ${index + 1} has an invalid venue type.`);
    }
    if (!Array.isArray(batch.attendees) || batch.attendees.length === 0 || batch.attendees.length > 200) {
      throw new HttpsError("invalid-argument", `Schedule ${index + 1} needs at least one attendee.`);
    }
    const attendees = batch.attendees.map((attendee, attendeeIndex) => {
      if (!attendee || typeof attendee !== "object" || Array.isArray(attendee)) {
        throw new HttpsError("invalid-argument", `Attendee ${attendeeIndex + 1} in schedule ${index + 1} is invalid.`);
      }
      return {
        name: requiredNtaText(attendee.name, "Attendee name", 120),
        position: optionalNtaText(attendee.position, "Attendee position", 200),
        office: optionalNtaText(attendee.office, "Attendee office", 200),
        unit: requiredNtaText(attendee.unit, "Attendee unit", 200),
        userId: optionalNtaText(attendee.userId, "Attendee user ID", 128),
        manual: attendee.manual === true,
      };
    });
    return {
      number: optionalNtaText(batch.number, "Schedule number", 20) || String(index + 1),
      dateFrom: requiredNtaText(batch.dateFrom, "Start date", 40),
      dateTo: requiredNtaText(batch.dateTo, "End date", 40),
      timeFrom: requiredNtaText(batch.timeFrom, "Start time", 20),
      timeTo: requiredNtaText(batch.timeTo, "End time", 20),
      venueType,
      venue: requiredNtaText(batch.venue, "Venue", 500),
      link: optionalNtaText(batch.link, "Meeting link", 2048),
      attendees,
    };
  });
}

export const createFodNta = onCall({ region: "asia-southeast1" }, async (request) => {
  if (!request.auth || request.auth.token.email_verified !== true) {
    throw new HttpsError("unauthenticated", "Sign in with a verified email before creating a Notice to Attend.");
  }

  const ownerId = request.auth.uid;
  const ownerSnapshot = await db.collection("users").doc(ownerId).get();
  if (!ownerSnapshot.exists) {
    throw new HttpsError("failed-precondition", "Your user profile could not be found.");
  }
  const owner = ownerSnapshot.data();
  const ownerRole = typeof owner.accountRole === "string" ? owner.accountRole.toLowerCase() : "";
  if (!(ownerRole === "regular" || ownerRole === "user")
      || !([undefined, null, "Approved"].includes(owner.accountStatus))
      || owner.office !== "Division"
      || owner.division !== "Field Operations Division"
      || !["AGRISTAT", "DRRM", "AMIA"].includes(owner.unit)) {
    throw new HttpsError("permission-denied", "Only a Regular account in AGRISTAT, DRRM, or AMIA can use this NTA route.");
  }

  const ntaId = request.data?.ntaId;
  if (typeof ntaId !== "string" || !/^[A-Za-z0-9_-]{20}$/.test(ntaId)) {
    throw new HttpsError("invalid-argument", "A valid Notice to Attend ID is required.");
  }
  const input = request.data?.record;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpsError("invalid-argument", "Notice details are required.");
  }
  const mode = input.mode;
  if (!["individual", "batch", "multiple"].includes(mode)) {
    throw new HttpsError("invalid-argument", "Select a valid notice type.");
  }
  const subject = requiredNtaText(input.subject, "Subject", 500);
  const activityTitle = requiredNtaText(input.activityTitle, "Activity title", 500);
  const organizer = requiredNtaText(input.organizer, "Organizer or host", 300);
  const attachmentLink = optionalNtaText(input.attachmentLink, "Attachment Link", 2048);
  let attachmentUrl;
  try { if (attachmentLink) attachmentUrl = new URL(attachmentLink); } catch {}
  if (attachmentLink && (!attachmentUrl || !["http:", "https:"].includes(attachmentUrl.protocol) || !attachmentUrl.hostname)) {
    throw new HttpsError("invalid-argument", "Attachment Link must be a valid HTTP or HTTPS URL.");
  }

  const signatoryAdminId = requiredNtaText(input.signatoryAdminId, "Signatory account", 128);
  const signatorySnapshot = await db.collection("users").doc(signatoryAdminId).get();
  const signatory = signatorySnapshot.exists ? signatorySnapshot.data() : null;
  const signatoryDesignation = signatory ? ntaAccountDesignation(signatory.designation) : "";
  if (!signatory
      || typeof signatory.accountRole !== "string"
      || signatory.accountRole.toLowerCase() !== "admin"
      || !([undefined, null, "Approved"].includes(signatory.accountStatus))
      || !signatoryDesignation
      || typeof signatory.name !== "string"
      || !signatory.name.trim()
      || signatory.name.trim().length > 120) {
    throw new HttpsError("failed-precondition", "The selected signatory must be an approved Admin with a Chief or OIC designation.");
  }
  const signatoryUnit = [signatory.unit, signatory.assignment, signatory.division, signatory.office]
    .find((value) => typeof value === "string" && value.trim())?.trim() ?? "";
  const signatoryPosition = `${signatoryDesignation}${signatoryUnit ? `, ${signatoryUnit}` : ""}`;

  const usersSnapshot = await db.collection("users").get();
  const routeAccounts = usersSnapshot.docs
    .map((document) => ({ ...document.data(), userId: document.id }))
    .sort((first, second) => first.userId.localeCompare(second.userId));
  const projectLeader = routeAccounts.find((account) => ntaApproverProfile(account, "AGRISTAT/DRRM/AMIA Project Leader"));
  const chief = routeAccounts.find((account) => ntaApproverProfile(account, "Chief"));
  if (!projectLeader) {
    throw new HttpsError("failed-precondition", "An approved Field Operations Division Project Leader Admin account is required.");
  }
  if (!chief) {
    throw new HttpsError("failed-precondition", "An approved Field Operations Division Chief Admin account is required.");
  }
  if (projectLeader.userId === chief.userId || projectLeader.userId === ownerId || chief.userId === ownerId) {
    throw new HttpsError("failed-precondition", "The NTA approval route must use distinct approver accounts.");
  }

  const record = {
    mode,
    subject,
    activityTitle,
    organizer,
    attachmentLink,
    signatoryName: signatory.name.trim(),
    signatoryDesignation: signatoryPosition,
    signatoryAdminId,
    ownerId,
    ownerOffice: owner.office,
    ownerDivision: owner.division,
    ownerUnit: owner.unit,
    approvalWorkflow: "fod",
    approvalStage: "owner-send",
    initialSignerId: projectLeader.userId,
    chiefSignerId: chief.userId,
    affixInitialSignature: "No",
    createdAt: FieldValue.serverTimestamp(),
  };

  let recipientIds = [];
  if (mode === "individual") {
    const venueType = input.venueType;
    if (venueType !== "physical" && venueType !== "virtual") {
      throw new HttpsError("invalid-argument", "Select a valid venue type.");
    }
    const toUserId = optionalNtaText(input.toUserId, "Personnel user ID", 128);
    const individual = {
      to: requiredNtaText(input.to, "Personnel name", 120),
      toUserId,
      positionDesignation: requiredNtaText(input.positionDesignation, "Personnel position", 200),
      dateFrom: requiredNtaText(input.dateFrom, "Start date", 40),
      dateTo: requiredNtaText(input.dateTo, "End date", 40),
      timeFrom: requiredNtaText(input.timeFrom, "Start time", 20),
      timeTo: requiredNtaText(input.timeTo, "End time", 20),
      venueType,
      venue: requiredNtaText(input.venue, "Venue", 500),
      link: optionalNtaText(input.link, "Meeting link", 2048),
    };
    if (toUserId && toUserId !== ownerId) recipientIds = [toUserId];
    Object.assign(record, individual);
  } else {
    const batches = requiredNtaBatches(input.batches);
    recipientIds = [...new Set(batches.flatMap((batch) => batch.attendees.map((attendee) => attendee.userId)).filter((userId) => userId && userId !== ownerId))];
    Object.assign(record, { batches });
  }
  Object.assign(record, { recipientIds });

  try {
    await db.collection("ntaRecords").doc(ntaId).create(record);
  } catch (error) {
    logger.error("Could not create the FOD Notice to Attend", { ownerId, ntaId, error });
    throw new HttpsError("internal", "Could not save the Notice to Attend.");
  }
  return {
    ntaId,
    initialSignerId: projectLeader.userId,
    chiefSignerId: chief.userId,
    signatoryName: signatory.name.trim(),
    signatoryDesignation: signatoryPosition,
    ownerOffice: owner.office,
    ownerDivision: owner.division,
    ownerUnit: owner.unit,
    recipientIds,
  };
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

