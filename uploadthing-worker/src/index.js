import { createRouteHandler, createUploadthing, UploadThingError, UTApi } from "uploadthing/server";

const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const cleaningTaskUnits = new Set(["AGRISTAT", "AMIA", "DRRM"]);

function firebaseIdToken(request) {
  const [, idToken] = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i) ?? [];
  return idToken ?? "";
}

async function verifiedFirebaseUser(idToken, firebaseApiKey) {
  if (!idToken || !firebaseApiKey) return null;
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    },
  );
  if (!response.ok) return null;
  const user = (await response.json()).users?.[0];
  if (!user?.localId || user.disabled || user.emailVerified !== true) return null;
  return user;
}

async function getFirestoreDocument(env, idToken, collectionName, documentId) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const databaseId = env.FIREBASE_DATABASE_ID || "(default)";
  if (!projectId) throw new Error("Firebase project is not configured on the UploadThing Worker.");
  const path = [collectionName, documentId].map(encodeURIComponent).join("/");
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents/${path}`,
    { headers: { Authorization: `Bearer ${idToken}` } },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("The Firebase account or Cleaning Task assignment could not be checked.");
  const document = await response.json();
  return Object.fromEntries(Object.entries(document.fields ?? {}).map(([key, value]) => [key, firestoreValue(value)]));
}

async function queryMyDriveFiles(env, idToken, ownerId) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const databaseId = env.FIREBASE_DATABASE_ID || "(default)";
  if (!projectId) throw new Error("Firebase project is not configured on the UploadThing Worker.");
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents:runQuery`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "myDriveFiles" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "ownerId" },
              op: "EQUAL",
              value: { stringValue: ownerId },
            },
          },
          limit: 31,
        },
      }),
    },
  );
  if (!response.ok) throw new Error("Your myDrive storage limit could not be checked.");
  const documents = await response.json();
  return documents.filter((item) => item.document).map((item) => ({
    id: item.document.name.split("/").pop(),
    ...Object.fromEntries(Object.entries(item.document.fields ?? {}).map(([key, value]) => [key, firestoreValue(value)])),
  }));
}

function firestoreFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    if (typeof value === "string") return [key, { stringValue: value }];
    if (typeof value === "number" && Number.isInteger(value)) return [key, { integerValue: String(value) }];
    if (value instanceof Date) return [key, { timestampValue: value.toISOString() }];
    return [key, { nullValue: null }];
  }));
}

async function createMyDriveFileRecord(env, idToken, documentId, fields) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const databaseId = env.FIREBASE_DATABASE_ID || "(default)";
  const query = new URLSearchParams({ documentId });
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents/myDriveFiles?${query}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}`, "content-type": "application/json" },
      body: JSON.stringify({ fields: firestoreFields(fields) }),
    },
  );
  if (response.status === 409) {
    const existing = await getFirestoreDocument(env, idToken, "myDriveFiles", documentId);
    if (existing?.ownerId === fields.ownerId && existing?.fileKey === fields.fileKey) return;
  }
  if (!response.ok && response.status !== 409) throw new Error("The uploaded file could not be saved to your myDrive.");
  if (response.status === 409) throw new Error("The uploaded file could not be saved to your myDrive.");
}

async function updateMyDriveFileName(env, idToken, documentId, name) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const databaseId = env.FIREBASE_DATABASE_ID || "(default)";
  const query = new URLSearchParams({ "updateMask.fieldPaths": "name" });
  const path = ["myDriveFiles", documentId].map(encodeURIComponent).join("/");
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents/${path}?${query}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${idToken}`, "content-type": "application/json" },
      body: JSON.stringify({ fields: { name: { stringValue: name } } }),
    },
  );
  if (!response.ok) throw new Error("The renamed file could not be saved to your myDrive.");
}

async function deleteMyDriveFileRecord(env, idToken, documentId) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const databaseId = env.FIREBASE_DATABASE_ID || "(default)";
  const path = ["myDriveFiles", documentId].map(encodeURIComponent).join("/");
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents/${path}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${idToken}` } },
  );
  if (!response.ok && response.status !== 404) throw new Error("The deleted file could not be removed from your myDrive list.");
}

function firestoreValue(value) {
  if (Object.hasOwn(value, "stringValue")) return value.stringValue;
  if (Object.hasOwn(value, "booleanValue")) return value.booleanValue;
  if (Object.hasOwn(value, "integerValue")) return Number(value.integerValue);
  if (Object.hasOwn(value, "doubleValue")) return value.doubleValue;
  if (Object.hasOwn(value, "timestampValue")) return new Date(value.timestampValue);
  if (Object.hasOwn(value, "nullValue")) return null;
  if (value.mapValue) return Object.fromEntries(Object.entries(value.mapValue.fields ?? {}).map(([key, item]) => [key, firestoreValue(item)]));
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(firestoreValue);
  return undefined;
}

function isEligibleCleaningTaskProfile(profile) {
  if (!profile || (profile.accountStatus ?? "Approved") !== "Approved") return false;
  return profile.accountRole === "admin"
    && profile.designation === "AGRISTAT/DRRM/AMIA Project Leader"
    && profile.office === "Division"
    && profile.division === "Field Operations Division"
    && profile.unit === "Field Operations Division";
}

function canUploadInitialSignature(profile) {
  return profile?.accountRole === "admin"
    || profile?.accountRole === "superadmin"
    || (["regular", "user"].includes(profile?.accountRole) && ["Chief", "OIC"].includes(profile?.designation));
}

function manilaCurrentWeekStart(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const dateParts = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const date = new Date(Date.UTC(Number(dateParts.year), Number(dateParts.month) - 1, Number(dateParts.day)));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function createUploadRouter(env) {
  const upload = createUploadthing();
  return {
    profilePhoto: upload({
      image: { maxFileSize: "4MB", maxFileCount: 1 },
    })
      .middleware(async ({ req, files }) => {
        const user = await verifiedFirebaseUser(firebaseIdToken(req), env.FIREBASE_API_KEY);
        if (!user) throw new UploadThingError("A verified account is required to upload a profile photo.");
        if (files.length !== 1 || !allowedImageTypes.has(files[0].type)) {
          throw new UploadThingError("Choose a JPEG, PNG, or WebP profile photo.");
        }
        return { userId: user.localId };
      })
      .onUploadComplete(async ({ file }) => ({ photoURL: file.ufsUrl })),

    profileSignature: upload({
      image: { maxFileSize: "4MB", maxFileCount: 1 },
    })
      .middleware(async ({ req, files }) => {
        const idToken = firebaseIdToken(req);
        const user = await verifiedFirebaseUser(idToken, env.FIREBASE_API_KEY);
        if (!user) throw new UploadThingError("A verified account is required to upload a signature.");
        if (files.length !== 1 || files[0].type !== "image/png" || !files[0].name.toLowerCase().endsWith(".png")) {
          throw new UploadThingError("Choose a PNG signature image.");
        }

        const profile = await getFirestoreDocument(env, idToken, "users", user.localId);
        const role = profile?.accountRole;
        if (!profile || (profile.accountStatus ?? "Approved") !== "Approved"
          || !["regular", "user", "admin", "superadmin"].includes(role)) {
          throw new UploadThingError("Signature uploads are available to approved Regular and Admin accounts.");
        }
        if (req.headers.get("x-profile-signature-field") === "initialSignatureURL" && !canUploadInitialSignature(profile)) {
          throw new UploadThingError("Initial Signatures are available to Admin accounts and Regular accounts designated Chief or OIC.");
        }
        return { userId: user.localId };
      })
      .onUploadComplete(async ({ file }) => ({ signatureURL: file.ufsUrl })),

    cleaningTaskImage: upload({
      blob: { maxFileSize: "32MB", maxFileCount: 1 },
    })
      .middleware(async ({ req, files }) => {
        const idToken = firebaseIdToken(req);
        const user = await verifiedFirebaseUser(idToken, env.FIREBASE_API_KEY);
        if (!user) throw new UploadThingError("A verified account is required to upload a Cleaning Task image.");
        if (files.length !== 1 || !allowedImageTypes.has(files[0].type)) {
          throw new UploadThingError("Choose a JPEG, PNG, or WebP Cleaning Task image.");
        }

        const profile = await getFirestoreDocument(env, idToken, "users", user.localId);
        if (!isEligibleCleaningTaskProfile(profile)) {
          throw new UploadThingError("Cleaning Task uploads are available only to the Field Operations Project Leader account.");
        }

        const weekStart = manilaCurrentWeekStart();
        const assignment = await getFirestoreDocument(env, idToken, "cleaningTaskAssignments", weekStart);
        const now = Date.now();
        if (!assignment || !cleaningTaskUnits.has(assignment.unit)
          || !(assignment.startAt instanceof Date) || !(assignment.endAt instanceof Date)
          || now < assignment.startAt.getTime() || now >= assignment.endAt.getTime()) {
          throw new UploadThingError("There is no active Cleaning Task assignment for the current work week.");
        }

        return { userId: user.localId, unit: assignment.unit, weekStart };
      })
      .onUploadComplete(async ({ file }) => ({ imageURL: file.ufsUrl, fileKey: file.key })),

    myDriveFile: upload({
      blob: { maxFileSize: "30MB", maxFileCount: 1, contentDisposition: "attachment" },
    }, { awaitServerData: true })
      .middleware(async ({ req, files }) => {
        const idToken = firebaseIdToken(req);
        const user = await verifiedFirebaseUser(idToken, env.FIREBASE_API_KEY);
        if (!user) throw new UploadThingError("A verified account is required to upload to myDrive.");
        if (files.length !== 1 || !Number.isFinite(files[0].size) || files[0].size < 0 || files[0].size > 30 * 1024 * 1024) {
          throw new UploadThingError("Choose a file that is 30 MB or smaller.");
        }

        const existingFiles = await queryMyDriveFiles(env, idToken, user.localId);
        const existingBytes = existingFiles.reduce((total, item) => total + (Number.isFinite(item.size) ? item.size : 0), 0);
        if (existingFiles.length >= 30) throw new UploadThingError("myDrive can store up to 30 files per account.");
        if (existingBytes + files[0].size > 30 * 1024 * 1024) {
          throw new UploadThingError("This file exceeds the remaining 30 MB of myDrive storage.");
        }
        return { userId: user.localId, idToken, recordId: crypto.randomUUID() };
      })
      .onUploadComplete(async ({ file, metadata }) => {
        const fields = {
          ownerId: metadata.userId,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          fileURL: file.ufsUrl,
          fileKey: file.key,
          uploadedAt: new Date(),
        };
        try {
          await createMyDriveFileRecord(env, metadata.idToken, metadata.recordId, fields);
        } catch (error) {
          await new UTApi({ token: env.UPLOADTHING_TOKEN }).deleteFiles(file.key).catch(() => {});
          throw new UploadThingError(error instanceof Error ? error.message : "The uploaded file could not be saved to your myDrive.");
        }
        return { fileId: metadata.recordId, name: file.name, size: file.size };
      }),
  };
}

async function renameMyDriveFile(request, env) {
  const idToken = firebaseIdToken(request);
  const user = await verifiedFirebaseUser(idToken, env.FIREBASE_API_KEY);
  if (!user) return new Response("A verified account is required to rename files.", { status: 401 });
  const { fileId, fileKey, newName } = await request.json().catch(() => ({}));
  const name = typeof newName === "string" ? newName.trim() : "";
  if (typeof fileId !== "string" || !/^[\w-]{1,80}$/.test(fileId)
    || typeof fileKey !== "string" || !/^[\w.-]{1,200}$/.test(fileKey)
    || !name || name.length > 160 || /[\\/\u0000-\u001f]/.test(name)) {
    return new Response("Enter a valid file name.", { status: 400 });
  }

  const file = await getFirestoreDocument(env, idToken, "myDriveFiles", fileId);
  if (!file || file.ownerId !== user.localId || file.fileKey !== fileKey) {
    return new Response("That file is not available in your myDrive.", { status: 404 });
  }
  if (file.name === name) return new Response(null, { status: 204 });

  const api = new UTApi({ token: env.UPLOADTHING_TOKEN });
  const result = await api.renameFiles({ fileKey, newName: name });
  if (!result.success) return new Response("UploadThing could not rename this file.", { status: 502 });
  try {
    await updateMyDriveFileName(env, idToken, fileId, name);
  } catch (error) {
    await api.renameFiles({ fileKey, newName: file.name }).catch(() => {});
    throw error;
  }
  return new Response(null, { status: 204 });
}

async function deleteMyDriveFile(request, env) {
  const idToken = firebaseIdToken(request);
  const user = await verifiedFirebaseUser(idToken, env.FIREBASE_API_KEY);
  if (!user) return new Response("A verified account is required to delete myDrive files.", { status: 401 });
  const { fileId, fileKey } = await request.json().catch(() => ({}));
  if (typeof fileId !== "string" || !/^[\w-]{1,80}$/.test(fileId)
    || typeof fileKey !== "string" || !/^[\w.-]{1,200}$/.test(fileKey)) {
    return new Response("Select a valid myDrive file.", { status: 400 });
  }

  const file = await getFirestoreDocument(env, idToken, "myDriveFiles", fileId);
  if (!file || file.ownerId !== user.localId || file.fileKey !== fileKey) {
    return new Response("That file is not available in your myDrive.", { status: 404 });
  }

  try {
    const result = await new UTApi({ token: env.UPLOADTHING_TOKEN }).deleteFiles(fileKey);
    if (!result.success) return new Response("UploadThing could not delete this file.", { status: 502 });
  } catch (error) {
    console.error("Could not delete the myDrive UploadThing file", error);
    return new Response("UploadThing could not delete this file. Try again.", { status: 502 });
  }

  try {
    await deleteMyDriveFileRecord(env, idToken, fileId);
  } catch (error) {
    console.error("Could not remove the deleted myDrive file record", error);
    return new Response("The file was removed from storage, but its myDrive entry could not be removed. Retry Delete to finish.", { status: 502 });
  }
  return new Response(null, { status: 204 });
}

async function deletePreviousProfilePhoto(request, env) {
  const idToken = firebaseIdToken(request);
  const user = await verifiedFirebaseUser(idToken, env.FIREBASE_API_KEY);
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { previousUrl } = await request.json().catch(() => ({}));
  const key = uploadThingFileKey(previousUrl);
  if (!key) return new Response("Invalid photo URL", { status: 400 });
  await new UTApi({ token: env.UPLOADTHING_TOKEN }).deleteFiles(key);
  return new Response(null, { status: 204 });
}

function uploadThingFileKey(value) {
  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/^\/f\/([\w.-]+)$/);
    if (match && /(^|\.)(ufs\.sh|utfs\.io)$/.test(parsed.hostname)) return match[1];
  } catch {}
  return "";
}

async function deletePreviousCleaningTaskImage(request, env) {
  const idToken = firebaseIdToken(request);
  const user = await verifiedFirebaseUser(idToken, env.FIREBASE_API_KEY);
  if (!user) return new Response("Unauthorized", { status: 401 });
  const profile = await getFirestoreDocument(env, idToken, "users", user.localId);
  if (!isEligibleCleaningTaskProfile(profile)) return new Response("Forbidden", { status: 403 });

  const { unit, imageId, fileKey } = await request.json().catch(() => ({}));
  if (!cleaningTaskUnits.has(unit) || imageId !== "current" || typeof fileKey !== "string" || !/^[\w.-]{1,128}$/.test(fileKey)) {
    return new Response("Invalid Cleaning Task image", { status: 400 });
  }
  const image = await getFirestoreDocument(env, idToken, "cleaningTaskImages", imageId);
  if (!image || image.unit !== unit || image.previousFileKey !== fileKey || !image.previousFileOwnerId) {
    return new Response("The previous image does not belong to this Cleaning Task replacement", { status: 403 });
  }
  await new UTApi({ token: env.UPLOADTHING_TOKEN }).deleteFiles(fileKey);
  return new Response(null, { status: 204 });
}

async function handleUploadThing(request, env, context, url) {
  const handlers = createRouteHandler({
    router: createUploadRouter(env),
    config: {
      token: env.UPLOADTHING_TOKEN,
      isDev: env.ENVIRONMENT === "development" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
      fetch: (target, init) => {
        if (init && "cache" in init) delete init.cache;
        return fetch(target, init);
      },
      handleDaemonPromise: (promise) => context.waitUntil(promise),
    },
  });
  return handlers(request);
}

function addCors(response, request) {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("origin");
  headers.set("access-control-allow-origin", origin || "*");
  headers.set("access-control-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    request.headers.get("access-control-request-headers") || "authorization, content-type",
  );
  headers.set("access-control-max-age", "86400");
  headers.append("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    const isProfilePhotoDelete = url.pathname === "/api/delete-photo";
    const isCleaningTaskDelete = url.pathname === "/api/delete-cleaning-task-image";
    const isMyDriveRename = url.pathname === "/api/rename-my-drive-file";
    const isMyDriveDelete = url.pathname === "/api/delete-my-drive-file";

    if (!["/api/uploadthing", "/api/delete-photo", "/api/delete-cleaning-task-image", "/api/rename-my-drive-file", "/api/delete-my-drive-file"].includes(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method === "OPTIONS") return addCors(new Response(null, { status: 204 }), request);

    try {
      let response;
      if (isProfilePhotoDelete || isCleaningTaskDelete || isMyDriveRename || isMyDriveDelete) {
        if (request.method !== "POST") response = new Response("Method not allowed", { status: 405 });
        else if (isProfilePhotoDelete) response = await deletePreviousProfilePhoto(request, env);
        else if (isCleaningTaskDelete) response = await deletePreviousCleaningTaskImage(request, env);
        else if (isMyDriveDelete) response = await deleteMyDriveFile(request, env);
        else response = await renameMyDriveFile(request, env);
      } else if (request.method !== "GET" && request.method !== "POST") {
        response = new Response("Method not allowed", { status: 405 });
      } else {
        response = await handleUploadThing(request, env, context, url);
      }
      return addCors(response, request);
    } catch (error) {
      console.error(error);
      return addCors(new Response("The request could not be completed", { status: 500 }), request);
    }
  },
};
