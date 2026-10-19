# My Desk Portal

A Next.js + Firebase permit-slip portal with email authentication, per-user permit records, automatic permit numbering, and A4 print output

The Firebase client uses the named Firestore database `ps-taguibo`.

## Run locally

1. Create a Firebase project and enable **Authentication > Email/Password** and **Firestore Database**.
2. Register a Web app in Firebase.
3. Copy `.env.example` to `.env.local` and fill in the Web app credentials.
4. Deploy the rules and index to the named database:

```bash
npx firebase-tools login
npx firebase-tools use ps-taguibo
npx firebase-tools deploy --only firestore
```

The included `firebase.json` targets the `ps-taguibo` database. If you use the Firebase Console instead, publish the contents of `firestore.rules` under the `ps-taguibo` database, not only under `(default)`.
5. Install and run:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## UploadThing profile photos

Profile photos are stored by UploadThing. Since this site is statically exported, its UploadThing endpoint runs as a small Cloudflare Worker; it verifies Firebase sign-in tokens and keeps the UploadThing token server-side. This does not use Firebase Functions or require the Blaze plan.

```bash
cd uploadthing-worker
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put UPLOADTHING_TOKEN
npx wrangler secret put FIREBASE_API_KEY
```

Use a rotated UploadThing token for `UPLOADTHING_TOKEN`. Set `FIREBASE_API_KEY` to the Firebase Web API key used by the site. For local Worker development, copy `uploadthing-worker/.dev.vars.example` to `uploadthing-worker/.dev.vars` and fill in the needed values, run `npx wrangler dev` from `uploadthing-worker`, and set `NEXT_PUBLIC_UPLOADTHING_URL=http://127.0.0.1:8787/api/uploadthing` in the site environment.

Set `NEXT_PUBLIC_UPLOADTHING_URL` in the site's `.env.local` and hosting build settings to the Worker endpoint, for example `https://ps-taguibo-uploadthing.<your-workers-subdomain>.workers.dev/api/uploadthing`. Build and republish the static site after setting it. Profile photos accept JPEG, PNG, or WebP files up to 4 MB.

Cleaning Task uploads require exactly four JPEG, PNG, or WebP source photos. The browser merges them into one 2×2 JPEG collage, then uploads that single image through the Worker to UploadThing (maximum 32 MB per source and for the merged file). The eligible uploader enters their Current Barangay and Current City before upload; Firestore stores and displays the location in `Barangay, City` order. The Worker checks the current Firebase profile and weekly assignment, and replaces the saved collage for each project while deleting its previous UploadThing file.

The Superadmin assigns one project to each Monday–Friday week from **Admin Panel → Cleaning Task Assignment**. Eligible Regular accounts in AGRISTAT, AMIA, and DRRM, plus an Admin whose designation is `AGRISTAT/DRRM/AMIA Project Leader`, can open Cleaning Task and upload when their profile unit is assigned for the current week. Admin and Superadmin accounts can view the landing-page posts. Deploy the Firestore rules and Worker after updating this feature; no Firebase Storage bucket or Function is used for Cleaning Task images.

Permit numbers increment independently by unit and year in the format `AMIA-2026-0001` or `AGRISTAT-2026-0001`. The number is assigned in a Firestore transaction so simultaneous submissions do not reuse a number.

## myDrive

Each signed-in account has an account-scoped file list in myDrive with a limit of 30 files and 30 MB total. Files of any type are uploaded to UploadThing; account-owned metadata is stored in Firestore. The UploadThing Worker checks the per-account quota and handles file renaming. Deploy the Firestore rules and Worker after updating this feature.

## Host on Vercel

From this folder, run:

```bash
npx vercel login
npx vercel --prod
```

When Vercel asks for project settings, accept the detected Next.js defaults. In the Vercel project settings, add these environment variables for **Production**:

```text
NEXT_PUBLIC_FIREBASE_API_KEY
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
NEXT_PUBLIC_FIREBASE_PROJECT_ID=ps-taguibo
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
NEXT_PUBLIC_FIREBASE_APP_ID
NEXT_PUBLIC_GIPHY_API_KEY
```

Copy the values from the local `.env` file. After saving the variables, redeploy with `npx vercel --prod`. Make sure the `ps-taguibo` Firestore rules and index are deployed before testing the hosted site.

## Host directly with GitHub Pages

This repository includes `.github/workflows/deploy-pages.yml`. In GitHub, add these repository secrets under **Settings > Secrets and variables > Actions**:

```text
NEXT_PUBLIC_FIREBASE_API_KEY
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
NEXT_PUBLIC_FIREBASE_PROJECT_ID
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
NEXT_PUBLIC_FIREBASE_APP_ID
NEXT_PUBLIC_GIPHY_API_KEY
```

Enable **Settings > Pages > Source: GitHub Actions**. Pushes to `master` then publish the app at:

`https://myd-portal.github.io/`
