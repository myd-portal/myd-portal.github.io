"use client";

import { useState, type ChangeEvent } from "react";
import type { User } from "firebase/auth";
import { doc, updateDoc } from "firebase/firestore";
import { generateReactHelpers } from "@uploadthing/react";
import { db } from "@/lib/firebase";

const uploadThingUrl = process.env.NEXT_PUBLIC_UPLOADTHING_URL || "/api/uploadthing";
const uploadThingConfigured = Boolean(process.env.NEXT_PUBLIC_UPLOADTHING_URL);
const maxSignatureBytes = 4 * 1024 * 1024;

const { useUploadThing } = generateReactHelpers<any>({ url: uploadThingUrl });

export default function ProfileSignatureUpload({
  user,
  label,
  fieldName,
  signatureURL,
  disabled = false,
  onUploaded,
}: {
  user: User;
  label: "Full Signature" | "Initial Signature";
  fieldName: "fullSignatureURL" | "initialSignatureURL";
  signatureURL: string;
  disabled?: boolean;
  onUploaded: (url: string) => void;
}) {
  const [error, setError] = useState("");
  const { startUpload, isUploading } = useUploadThing("profileSignature", {
    headers: async () => ({ Authorization: `Bearer ${await user.getIdToken(true)}`, "X-Profile-Signature-Field": fieldName }),
    onUploadError: (uploadError) => setError(uploadError.message || `Could not upload your ${label.toLowerCase()}. Try again.`),
  });

  async function handleSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    if (file.type !== "image/png" || !file.name.toLowerCase().endsWith(".png")) {
      setError("Choose a PNG image.");
      return;
    }
    if (file.size > maxSignatureBytes) {
      setError("Signatures must be 4 MB or smaller.");
      return;
    }
    if (!uploadThingConfigured) {
      setError("Signature uploads are not configured yet.");
      return;
    }

    setError("");
    try {
      const uploadedFiles = await startUpload([file]);
      const uploaded = uploadedFiles?.[0] as { key?: string; ufsUrl?: string; url?: string; serverData?: { signatureURL?: string } } | undefined;
      const appId = process.env.NEXT_PUBLIC_UPLOADTHING_APP_ID;
      const keyURL = uploaded?.key && appId ? `https://${appId}.ufs.sh/f/${uploaded.key}` : undefined;
      const uploadedURL = uploaded?.serverData?.signatureURL ?? uploaded?.ufsUrl ?? uploaded?.url ?? keyURL;
      if (!uploadedURL) {
        if (!uploadedFiles) return;
        throw new Error("The signature uploaded, but its permanent link was not returned.");
      }
      if (!db) throw new Error("Your profile could not be updated. Sign in again and retry.");
      await updateDoc(doc(db, "users", user.uid), { [fieldName]: uploadedURL });
      onUploaded(uploadedURL);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not upload your ${label.toLowerCase()}. Try again.`);
    }
  }

  return (
    <div className="profile-signature-field">
      <div className="profile-signature-preview-wrap">
        {signatureURL
          ? <img className="profile-signature-preview" src={signatureURL} alt={`${label} preview`} />
          : <span className="profile-signature-preview profile-signature-placeholder" aria-label={`No ${label.toLowerCase()} uploaded`} />}
      </div>
      <div className="profile-signature-controls">
        <strong>{label}</strong>
        <label className="profile-photo-select">
          <span className="ghost-button">{isUploading ? "Uploading..." : signatureURL ? "Change" : "Choose PNG"}</span>
          <input type="file" accept=".png,image/png" aria-label={`Upload ${label.toLowerCase()}`} onChange={(event) => void handleSelection(event)} disabled={disabled || isUploading} />
        </label>
        <small>PNG. Maximum 4 MB.</small>
        {error && <span className="auth-message auth-message-error" role="alert">{error}</span>}
      </div>
    </div>
  );
}
