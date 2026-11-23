const firebaseJwksUrl = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const oauthTokenUrl = "https://oauth2.googleapis.com/token";
const firestoreApiRoot = "https://firestore.googleapis.com/v1";
const firestoreScope = "https://www.googleapis.com/auth/datastore";
const maxRequestBytes = 128 * 1024;

let cachedFirebaseKeys = null;
let cachedFirebaseKeysUntil = 0;
let cachedServiceAccountEmail = "";
let cachedServiceAccountKeyPem = "";
let cachedServiceAccountKeyPromise = null;
let cachedFirestoreAccessToken = "";
let cachedFirestoreAccessTokenUntil = 0;

class WishlistError extends Error {
  constructor(code, message, httpStatus = 500) {
    super(message);
    this.name = "WishlistError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

class FirestoreError extends Error {
  constructor(httpStatus, status, message) {
    super(message || "Firestore request failed.");
    this.name = "FirestoreError";
    this.httpStatus = httpStatus;
    this.status = status || "UNKNOWN";
  }
}

function jsonResponse(request, env, body, status = 200) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: "Origin",
  });
  const origin = request.headers.get("Origin");
  if (origin && getAllowedOrigins(env).has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function getAllowedOrigins(env) {
  return new Set((env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean));
}

function getRequestOriginError(request, env) {
  const origin = request.headers.get("Origin");
  return origin && !getAllowedOrigins(env).has(origin)
    ? new WishlistError("permission-denied", "This website is not allowed to use myWishlist.", 403)
    : null;
}

function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64UrlEncode(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function refreshFirebaseKeys() {
  const now = Date.now();
  let response;
  try {
    response = await fetch(firebaseJwksUrl, { headers: { Accept: "application/json" } });
  } catch {
    throw new WishlistError("unavailable", "Sign-in verification is temporarily unavailable. Try again.", 503);
  }
  if (!response.ok) throw new WishlistError("unavailable", "Sign-in verification is temporarily unavailable. Try again.", 503);
  const result = await response.json();
  if (!Array.isArray(result.keys)) throw new WishlistError("unavailable", "Sign-in verification is temporarily unavailable. Try again.", 503);
  cachedFirebaseKeys = result.keys;
  const maxAge = Number(response.headers.get("Cache-Control")?.match(/max-age=(\d+)/i)?.[1] ?? 3600);
  cachedFirebaseKeysUntil = now + Math.max(60, Math.min(maxAge, 86400)) * 1000;
}

async function firebaseSigningKey(kid) {
  if (!cachedFirebaseKeys || cachedFirebaseKeysUntil <= Date.now()) await refreshFirebaseKeys();
  let jwk = cachedFirebaseKeys.find((key) => key.kid === kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256"));
  if (!jwk) {
    await refreshFirebaseKeys();
    jwk = cachedFirebaseKeys.find((key) => key.kid === kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256"));
  }
  if (!jwk) throw new WishlistError("unauthenticated", "Your sign-in session is invalid. Sign in again.", 401);
  try {
    return await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new WishlistError("unavailable", "Sign-in verification is temporarily unavailable. Try again.", 503);
  }
}

async function verifyFirebaseIdToken(request, projectId) {
  const authorization = request.headers.get("Authorization") || "";
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) throw new WishlistError("unauthenticated", "Sign in to use myWishlist.", 401);
  const pieces = tokenMatch[1].split(".");
  if (pieces.length !== 3) throw new WishlistError("unauthenticated", "Your sign-in session is invalid. Sign in again.", 401);

  let header;
  let claims;
  let signature;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(pieces[0])));
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(pieces[1])));
    signature = base64UrlDecode(pieces[2]);
  } catch {
    throw new WishlistError("unauthenticated", "Your sign-in session is invalid. Sign in again.", 401);
  }

  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== "RS256" || typeof header.kid !== "string"
    || claims.iss !== `https://securetoken.google.com/${projectId}`
    || claims.aud !== projectId
    || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128
    || !Number.isFinite(claims.exp) || claims.exp <= now
    || !Number.isFinite(claims.iat) || claims.iat > now + 60
    || !Number.isFinite(claims.auth_time) || claims.auth_time > now + 60
    || claims.email_verified !== true) {
    throw new WishlistError("unauthenticated", "Sign in with a verified email to use myWishlist.", 401);
  }

  const key = await firebaseSigningKey(header.kid);
  const signedContent = new TextEncoder().encode(`${pieces[0]}.${pieces[1]}`);
  const isValid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedContent);
  if (!isValid) throw new WishlistError("unauthenticated", "Your sign-in session is invalid. Sign in again.", 401);
  return { uid: claims.sub };
}

function decodePem(pem) {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function serviceAccountAccessToken(env) {
  if (cachedFirestoreAccessToken && cachedFirestoreAccessTokenUntil > Date.now() + 60_000) {
    return cachedFirestoreAccessToken;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON || "");
  } catch {
    throw new WishlistError("failed-precondition", "The myWishlist server is missing its Firestore credentials.", 500);
  }
  if (typeof serviceAccount.client_email !== "string" || typeof serviceAccount.private_key !== "string"
    || serviceAccount.project_id !== env.FIREBASE_PROJECT_ID) {
    throw new WishlistError("failed-precondition", "The myWishlist server is missing its Firestore credentials.", 500);
  }

  if (cachedServiceAccountEmail !== serviceAccount.client_email || cachedServiceAccountKeyPem !== serviceAccount.private_key) {
    cachedServiceAccountEmail = serviceAccount.client_email;
    cachedServiceAccountKeyPem = serviceAccount.private_key;
    cachedServiceAccountKeyPromise = crypto.subtle.importKey(
      "pkcs8",
      decodePem(serviceAccount.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    cachedFirestoreAccessToken = "";
    cachedFirestoreAccessTokenUntil = 0;
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64UrlEncode(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: firestoreScope,
    aud: oauthTokenUrl,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const content = `${header}.${claims}`;
  const signingKey = await cachedServiceAccountKeyPromise;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(content));
  const assertion = `${content}.${base64UrlEncode(new Uint8Array(signature))}`;

  let response;
  try {
    response = await fetch(oauthTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
  } catch {
    throw new WishlistError("unavailable", "The wishlist database is temporarily unavailable. Try again.", 503);
  }
  const tokenResponse = await response.json().catch(() => null);
  if (!response.ok || typeof tokenResponse?.access_token !== "string") {
    console.error("[myWishlist] Firestore authorization failed", response.status);
    throw new WishlistError("unavailable", "The wishlist database is temporarily unavailable. Contact the administrator.", 503);
  }
  cachedFirestoreAccessToken = tokenResponse.access_token;
  cachedFirestoreAccessTokenUntil = Date.now() + Math.max(60, Number(tokenResponse.expires_in) || 3600) * 1000;
  return cachedFirestoreAccessToken;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
}

function responseRecords(result) {
  if (Array.isArray(result)) return result;
  return result && typeof result === "object" ? [result] : [];
}

class FirestoreClient {
  constructor(env) {
    if (!env.FIREBASE_PROJECT_ID || !env.FIRESTORE_DATABASE_ID) {
      throw new WishlistError("failed-precondition", "The myWishlist server is not configured.", 500);
    }
    this.env = env;
    this.resource = `projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/${encodeURIComponent(env.FIRESTORE_DATABASE_ID)}/documents`;
    this.base = `${firestoreApiRoot}/${this.resource}`;
  }

  documentName(path) {
    return `${this.resource}/${path}`;
  }

  async request(suffix, body) {
    const token = await serviceAccountAccessToken(this.env);
    let response;
    try {
      response = await fetch(`${this.base}${suffix}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new WishlistError("unavailable", "The wishlist database is temporarily unavailable. Try again.", 503);
    }
    const result = await parseJsonResponse(response);
    if (!response.ok) {
      throw new FirestoreError(response.status, result?.error?.status, result?.error?.message);
    }
    return result;
  }

  async get(path, transaction) {
    const result = await this.batchGet([path], transaction);
    return result.get(path) ?? null;
  }

  async batchGet(paths, transaction) {
    if (!paths.length) return new Map();
    const result = await this.request(":batchGet", {
      documents: paths.map((path) => this.documentName(path)),
      ...(transaction ? { transaction } : {}),
    });
    const records = responseRecords(result);
    const documents = new Map();
    for (const record of records) {
      const name = record.found?.name || record.missing;
      const prefix = `${this.resource}/`;
      if (typeof name !== "string" || !name.startsWith(prefix)) continue;
      const path = name.slice(prefix.length);
      documents.set(path, record.found ? decodeFirestoreDocument(record.found) : null);
    }
    return documents;
  }

  async queryUsersByDivision(transaction) {
    const result = await this.request(":runQuery", {
      structuredQuery: {
        from: [{ collectionId: "users" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "division" },
            op: "EQUAL",
            value: { stringValue: "Field Operations Division" },
          },
        },
      },
      ...(transaction ? { transaction } : {}),
    });
    return responseRecords(result)
      .filter((item) => item.document)
      .map((item) => decodeFirestoreDocument(item.document));
  }

  async beginTransaction() {
    const result = await this.request(":beginTransaction", { options: { readWrite: {} } });
    if (typeof result?.transaction !== "string") throw new WishlistError("internal", "Could not start the wishlist transaction.");
    return result.transaction;
  }

  async commit(transaction, writes) {
    return this.request(":commit", { writes, transaction });
  }

  async rollback(transaction) {
    return this.request(":rollback", { transaction });
  }
}

function decodeFirestoreValue(value) {
  if (Object.prototype.hasOwnProperty.call(value, "nullValue")) return null;
  if (Object.prototype.hasOwnProperty.call(value, "stringValue")) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, "booleanValue")) return value.booleanValue;
  if (Object.prototype.hasOwnProperty.call(value, "integerValue")) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, "doubleValue")) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, "timestampValue")) return value.timestampValue;
  if (Object.prototype.hasOwnProperty.call(value, "referenceValue")) return value.referenceValue;
  if (Object.prototype.hasOwnProperty.call(value, "bytesValue")) return value.bytesValue;
  if (Object.prototype.hasOwnProperty.call(value, "geoPointValue")) return value.geoPointValue;
  if (value.arrayValue) return (value.arrayValue.values || []).map(decodeFirestoreValue);
  if (value.mapValue) return decodeFirestoreFields(value.mapValue.fields || {});
  return null;
}

function decodeFirestoreFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeFirestoreValue(value)]));
}

function decodeFirestoreDocument(document) {
  const path = document.name.split("/documents/").at(-1) || "";
  return { ...decodeFirestoreFields(document.fields || {}), id: path.split("/").at(-1) || "" };
}

function encodeFirestoreValue(value) {
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeFirestoreValue) } };
  if (typeof value === "object") return { mapValue: { fields: encodeFirestoreFields(value) } };
  throw new WishlistError("invalid-argument", "A wishlist value could not be saved.", 400);
}

function encodeFirestoreFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, encodeFirestoreValue(value)]));
}

function writeDocument(db, path, value, exists) {
  return {
    update: { name: db.documentName(path), fields: encodeFirestoreFields(value) },
    ...(exists === undefined ? {} : { currentDocument: { exists } }),
  };
}

async function runTransaction(db, operation) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const transaction = await db.beginTransaction();
    try {
      const prepared = await operation(transaction);
      await db.commit(transaction, prepared.writes);
      return prepared.result;
    } catch (cause) {
      await db.rollback(transaction).catch(() => {});
      if (attempt < 4 && cause instanceof FirestoreError && (cause.httpStatus === 409 || cause.status === "ABORTED")) continue;
      throw cause;
    }
  }
  throw new WishlistError("aborted", "The wishlist changed while the request was being saved. Please retry.", 409);
}

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

async function requireWishlistUser(db, request, projectId) {
  const identity = await verifyFirebaseIdToken(request, projectId);
  const profile = await db.get(`users/${identity.uid}`);
  if (!isWishlistProfile(profile)) {
    throw new WishlistError("permission-denied", "myWishlist is available to approved FOD AGRISTAT, AMIA, and DRRM regular users and the FOD Project Leader admin.", 403);
  }
  return { uid: identity.uid, profile };
}

async function getWishlistParticipants(db, transaction) {
  return (await db.queryUsersByDivision(transaction))
    .filter((profile) => isWishlistProfile(profile))
    .map((profile) => profile.id)
    .sort((first, second) => first.localeCompare(second));
}

function requiredText(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new WishlistError("invalid-argument", `${field} is required.`, 400);
  }
  const text = value.trim();
  if (text.length > maxLength) throw new WishlistError("invalid-argument", `${field} must be between 1 and ${maxLength} characters.`, 400);
  return text;
}

function optionalText(value, field, maxLength) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new WishlistError("invalid-argument", `${field} is invalid.`, 400);
  }
  return value.trim();
}

function normalizeWishlistItems(items) {
  if (items === undefined) return undefined;
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
    throw new WishlistError("invalid-argument", "Add between 1 and 20 wishlist items.", 400);
  }
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new WishlistError("invalid-argument", "A wishlist item is invalid.", 400);
    }
    const desiredGift = requiredText(item.desiredGift, "Desired Gift", 160);
    const description = requiredText(item.description, "Description", 1000);
    const amount = optionalText(item.amount, "Amount", 80);
    const link = optionalText(item.link, "Link", 2048);
    if (link) {
      let url;
      try { url = new URL(link); } catch {}
      if (!url || !["http:", "https:"].includes(url.protocol) || !url.hostname) {
        throw new WishlistError("invalid-argument", "Link must be a valid HTTP or HTTPS URL.", 400);
      }
    }
    return { desiredGift, description, amount, link };
  });
}

function wishlistEntryIsComplete(entry) {
  return typeof entry?.nickname === "string"
    && entry.nickname.trim().length > 0
    && ((Array.isArray(entry.wishlist) && entry.wishlist.length > 0)
      || (entry.hasWishlist === true && typeof entry.itemCount === "number" && entry.itemCount > 0));
}

function wishlistProgress(participantIds, entries) {
  const completedCount = participantIds.filter((userId) => wishlistEntryIsComplete(entries.get(userId))).length;
  return {
    participantCount: participantIds.length,
    completedCount,
    ready: completedCount >= 2,
  };
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
    updatedAt: new Date(),
  };
}

function createElfsterAssignments(participantIds) {
  if (participantIds.length < 2) {
    throw new WishlistError("failed-precondition", "At least two users must enter a wishlist before the reveal can begin.", 412);
  }
  const cycle = [...participantIds];
  for (let index = cycle.length - 1; index > 0; index -= 1) {
    const otherIndex = randomInt(index);
    [cycle[index], cycle[otherIndex]] = [cycle[otherIndex], cycle[index]];
  }
  return new Map(cycle.map((userId, index) => [userId, cycle[(index + 1) % cycle.length]]));
}

function randomInt(maxExclusive) {
  const range = 0x100000000;
  const limit = range - (range % maxExclusive);
  const value = new Uint32Array(1);
  do { crypto.getRandomValues(value); } while (value[0] >= limit);
  return value[0] % maxExclusive;
}

function revealedWishlist(assignment, snapshot) {
  return {
    nickname: snapshot.nickname,
    wishlist: snapshot.wishlist,
    cycleId: assignment.cycleId,
  };
}

async function getMyWishlistState(db, uid) {
  return runTransaction(db, async (transaction) => {
    const [participantIds, ownDocuments] = await Promise.all([
      getWishlistParticipants(db, transaction),
      db.batchGet([`myWishlistEntries/${uid}`, "myWishlistDraws/current"], transaction),
    ]);
    const ownEntry = ownDocuments.get(`myWishlistEntries/${uid}`);
    const draw = ownDocuments.get("myWishlistDraws/current");
    const state = {
      nickname: ownEntry?.nickname ?? "",
      wishlist: ownEntry?.wishlist ?? [],
      participantCount: participantIds.length,
      completedCount: 0,
      ready: false,
      drawActive: Boolean(draw),
      isParticipant: participantIds.includes(uid),
      revealed: null,
    };

    if (draw) {
      const drawParticipantIds = Array.isArray(draw.participantIds) ? draw.participantIds : [];
      state.participantCount = draw.specifiedUserCount ?? drawParticipantIds.length;
      state.completedCount = draw.entryCount ?? drawParticipantIds.length;
      state.ready = true;
      state.isParticipant = drawParticipantIds.includes(uid);
      if (state.isParticipant) {
        const assignment = await db.get(`myWishlistDraws/current/assignments/${uid}`, transaction);
        if (assignment?.revealed && typeof assignment.targetId === "string") {
          const snapshot = await db.get(`myWishlistDraws/current/snapshots/${assignment.targetId}`, transaction);
          if (snapshot) state.revealed = revealedWishlist(assignment, snapshot);
        }
      }
      return { result: state, writes: [] };
    }

    const entryDocuments = await db.batchGet(participantIds.map((userId) => `myWishlistEntries/${userId}`), transaction);
    const entries = new Map([...entryDocuments].map(([path, entry]) => [path.split("/").at(-1), entry]));
    const progress = wishlistProgress(participantIds, entries);
    return {
      result: { ...state, ...progress },
      writes: [writeDocument(db, "myWishlistStatus/current", publicWishlistStatus({ ...progress, drawActive: false }))],
    };
  });
}

async function saveMyWishlist(db, uid, requestData) {
  const nickname = requiredText(requestData.nickname, "Nickname", 40);
  const submittedItems = normalizeWishlistItems(requestData.wishlist);
  return runTransaction(db, async (transaction) => {
    const initialDocs = await db.batchGet([
      `users/${uid}`,
      "myWishlistDraws/current",
      `myWishlistEntries/${uid}`,
    ], transaction);
    const profile = initialDocs.get(`users/${uid}`);
    const draw = initialDocs.get("myWishlistDraws/current");
    const previousEntry = initialDocs.get(`myWishlistEntries/${uid}`);
    if (!isWishlistProfile(profile)) {
      throw new WishlistError("permission-denied", "Your account no longer meets the myWishlist access requirements.", 403);
    }
    if (draw) throw new WishlistError("failed-precondition", "The Elfster reveal has started, so wishlists are now locked.", 412);

    const participantIds = await getWishlistParticipants(db, transaction);
    if (!participantIds.includes(uid)) {
      throw new WishlistError("permission-denied", "Your account is not an active myWishlist participant.", 403);
    }
    const otherIds = participantIds.filter((userId) => userId !== uid);
    const otherDocuments = await db.batchGet(otherIds.map((userId) => `myWishlistParticipants/${userId}`), transaction);
    const otherParticipants = new Map(otherIds.map((userId) => [userId, otherDocuments.get(`myWishlistParticipants/${userId}`)]));
    const nicknameKey = nickname.toLocaleLowerCase();
    const duplicateNickname = [...otherParticipants.values()].some((participant) => participant
      && typeof participant.nickname === "string"
      && participant.nickname.trim().toLocaleLowerCase() === nicknameKey);
    if (duplicateNickname) {
      throw new WishlistError("already-exists", "That nickname is already in use. Choose a different nickname.", 409);
    }

    const wishlist = submittedItems ?? previousEntry?.wishlist ?? [];
    const entry = { nickname, wishlist, updatedAt: new Date() };
    const progressEntries = new Map([[uid, entry], ...otherParticipants]);
    const progress = wishlistProgress(participantIds, progressEntries);
    const participant = {
      nickname,
      hasWishlist: wishlist.length > 0,
      itemCount: wishlist.length,
      updatedAt: new Date(),
    };
    return {
      result: { saved: true },
      writes: [
        writeDocument(db, `myWishlistEntries/${uid}`, entry),
        writeDocument(db, `myWishlistParticipants/${uid}`, participant),
        writeDocument(db, "myWishlistStatus/current", publicWishlistStatus({ ...progress, drawActive: false })),
      ],
    };
  });
}

async function revealElfster(db, uid) {
  return runTransaction(db, async (transaction) => {
    const draw = await db.get("myWishlistDraws/current", transaction);
    if (draw) {
      const participantIds = Array.isArray(draw.participantIds) ? draw.participantIds : [];
      if (!participantIds.includes(uid)) {
        throw new WishlistError("failed-precondition", "Your account joined after this Elfster draw started and is not part of the current draw.", 412);
      }
      const assignment = await db.get(`myWishlistDraws/current/assignments/${uid}`, transaction);
      if (!assignment || typeof assignment.targetId !== "string") {
        throw new WishlistError("failed-precondition", "Your Elfster assignment could not be found.", 412);
      }
      const snapshot = await db.get(`myWishlistDraws/current/snapshots/${assignment.targetId}`, transaction);
      if (!snapshot) throw new WishlistError("internal", "The revealed wishlist could not be found.");

      if (assignment.revealed) {
        return { result: { ...revealedWishlist(assignment, snapshot), alreadyRevealed: true }, writes: [] };
      }
      const revealedCount = (draw.revealedCount ?? 0) + 1;
      const changedAssignment = { ...assignment, revealed: true, revealedAt: new Date() };
      const changedDraw = { ...draw, revealedCount, remainingCount: participantIds.length - revealedCount };
      const status = publicWishlistStatus({
        participantCount: draw.specifiedUserCount ?? participantIds.length,
        completedCount: draw.entryCount ?? participantIds.length,
        drawActive: true,
        revealedCount,
      });
      return {
        result: { ...revealedWishlist(assignment, snapshot), alreadyRevealed: false },
        writes: [
          writeDocument(db, `myWishlistDraws/current/assignments/${uid}`, changedAssignment, true),
          writeDocument(db, "myWishlistDraws/current", changedDraw, true),
          writeDocument(db, "myWishlistStatus/current", status),
        ],
      };
    }

    const participantIds = await getWishlistParticipants(db, transaction);
    if (!participantIds.includes(uid)) {
      throw new WishlistError("permission-denied", "Your account is not an active myWishlist participant.", 403);
    }
    if (participantIds.length > 200) {
      throw new WishlistError("resource-exhausted", "This Elfster draw has more than 200 participants. Contact the system administrator.", 429);
    }

    const entryDocuments = await db.batchGet(participantIds.map((userId) => `myWishlistEntries/${userId}`), transaction);
    const entries = new Map([...entryDocuments].map(([path, entry]) => [path.split("/").at(-1), entry]));
    const progress = wishlistProgress(participantIds, entries);
    if (!progress.ready) {
      throw new WishlistError("failed-precondition", `At least two specified users must save a nickname and wishlist before the reveal can begin (${progress.completedCount} complete).`, 412);
    }
    const drawParticipantIds = participantIds.filter((userId) => wishlistEntryIsComplete(entries.get(userId)));
    if (!drawParticipantIds.includes(uid)) {
      throw new WishlistError("failed-precondition", "Save your nickname and at least one wishlist item before revealing a match.", 412);
    }

    const assignments = createElfsterAssignments(drawParticipantIds);
    const cycleId = "current";
    const now = new Date();
    const myTargetId = assignments.get(uid);
    const myAssignment = { targetId: myTargetId, cycleId, revealed: true, revealedAt: now };
    const targetEntry = entries.get(myTargetId);
    const writes = [writeDocument(db, "myWishlistDraws/current", {
      cycleId,
      participantIds: drawParticipantIds,
      specifiedUserCount: participantIds.length,
      entryCount: drawParticipantIds.length,
      revealedCount: 1,
      remainingCount: drawParticipantIds.length - 1,
      startedAt: now,
    }, false)];
    for (const userId of drawParticipantIds) {
      const targetId = assignments.get(userId);
      writes.push(writeDocument(db, `myWishlistDraws/current/assignments/${userId}`, userId === uid
        ? myAssignment
        : { targetId, cycleId, revealed: false, revealedAt: null }, false));
      const entry = entries.get(userId);
      writes.push(writeDocument(db, `myWishlistDraws/current/snapshots/${userId}`, {
        nickname: entry.nickname,
        wishlist: entry.wishlist,
      }, false));
    }
    writes.push(writeDocument(db, "myWishlistStatus/current", publicWishlistStatus({
      participantCount: participantIds.length,
      completedCount: drawParticipantIds.length,
      drawActive: true,
      revealedCount: 1,
    })));
    return {
      result: {
        nickname: targetEntry.nickname,
        wishlist: targetEntry.wishlist,
        cycleId,
        alreadyRevealed: false,
      },
      writes,
    };
  });
}

function mapFirestoreError(cause) {
  if (!(cause instanceof FirestoreError)) return cause;
  if (cause.httpStatus === 404) return new WishlistError("not-found", "A wishlist record could not be found.", 404);
  if (cause.status === "ABORTED" || cause.httpStatus === 409) {
    return new WishlistError("aborted", "The wishlist changed while the request was being saved. Please retry.", 409);
  }
  if (cause.httpStatus === 429) return new WishlistError("resource-exhausted", "The wishlist service is busy. Please retry later.", 429);
  console.error("[myWishlist] Firestore request failed", cause.httpStatus, cause.status);
  return new WishlistError("unavailable", "The wishlist database is temporarily unavailable. Contact the administrator.", 503);
}

async function readRequestData(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > maxRequestBytes) throw new WishlistError("invalid-argument", "The wishlist request is too large.", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxRequestBytes) {
    throw new WishlistError("invalid-argument", "The wishlist request is too large.", 413);
  }
  try {
    const data = text ? JSON.parse(text) : {};
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid request body");
    return data;
  } catch {
    throw new WishlistError("invalid-argument", "The wishlist request is invalid.", 400);
  }
}

function errorResponse(request, env, cause) {
  const error = mapFirestoreError(cause);
  if (error instanceof WishlistError) {
    return jsonResponse(request, env, { error: { code: error.code, message: error.message } }, error.httpStatus);
  }
  console.error("[myWishlist] Unexpected request failure", error?.name || "Error", error?.message || "Unknown error");
  return jsonResponse(request, env, {
    error: { code: "internal", message: "The myWishlist service could not complete the request. Contact the administrator." },
  }, 500);
}

export default {
  async fetch(request, env) {
    const originError = getRequestOriginError(request, env);
    if (originError) return errorResponse(request, env, originError);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: jsonResponse(request, env, {}).headers });
    if (request.method !== "POST") {
      return errorResponse(request, env, new WishlistError("invalid-argument", "Use POST for myWishlist requests.", 405));
    }

    const action = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);
    if (!["getMyWishlistState", "saveMyWishlist", "revealElfster"].includes(action)) {
      return errorResponse(request, env, new WishlistError("not-found", "This myWishlist action was not found.", 404));
    }

    try {
      if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        throw new WishlistError("invalid-argument", "Send a JSON wishlist request.", 400);
      }
      const data = await readRequestData(request);
      const projectId = env.FIREBASE_PROJECT_ID;
      const db = new FirestoreClient(env);
      const { uid } = await requireWishlistUser(db, request, projectId);
      let result;
      if (action === "getMyWishlistState") result = await getMyWishlistState(db, uid);
      else if (action === "saveMyWishlist") result = await saveMyWishlist(db, uid, data);
      else result = await revealElfster(db, uid);
      return jsonResponse(request, env, { data: result });
    } catch (cause) {
      return errorResponse(request, env, cause);
    }
  },
};
