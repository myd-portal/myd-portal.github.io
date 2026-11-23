# myWishlist Cloudflare Worker

This Worker replaces the three myWishlist Cloud Functions. It keeps authorization, nickname checks, the draw, and reveal handling on a server while reading and writing the existing `ps-taguibo` Firestore database through its REST API.

The existing `ps-taguibo` database was checked with the read-only Firebase CLI on 2026-11-23 and reports `freeTier: true`, so this Worker can use its Firestore free quota without enabling billing. Firestore's current Firebase pricing guide says the first database qualifies regardless of ID, while the Google Cloud pricing page still says named databases do not receive free quota: [Firebase Firestore pricing](https://firebase.google.com/docs/firestore/pricing), [Google Cloud Firestore pricing](https://cloud.google.com/firestore/pricing). Cloud Functions elsewhere in this application still need the Firebase billing plan; this Worker only replaces `getMyWishlistState`, `saveMyWishlist`, and `revealElfster`.

## Required setup

1. Create a Cloudflare account and sign in to Wrangler from this folder with `npx wrangler login`.
2. Create a dedicated Google service account for this Worker. Grant it `roles/datastore.user` with an IAM condition restricted to `projects/ps-taguibo/databases/ps-taguibo`. Do not use an owner or editor service account, and avoid an unconditional project-wide data role. Google documents [database-scoped Firestore IAM conditions](https://docs.cloud.google.com/firestore/native/docs/manage-databases#configure_per-database_access_permissions).
3. Create a key for that service account and store the full JSON key as a Cloudflare Worker secret. From this folder, run `npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON` and paste the JSON when prompted. Never put the key in this repository, `.env`, `wrangler.toml`, or a client-side variable.
4. Deploy with `npm run deploy`. Wrangler prints the Worker URL, usually `https://myd-wishlist-api.<account-subdomain>.workers.dev`.
5. Set the GitHub repository variable `NEXT_PUBLIC_WISHLIST_API_URL` to that URL; the Pages workflow uses it for the static build and refuses to publish while it is unset. For local development, set the same variable to the local Worker URL in the root `.env.local`. The Worker URL is public configuration, not a secret.

The Worker verifies Firebase ID tokens itself, checks the signed-in profile against the myWishlist eligibility rules, and only returns the current user's revealed assignment. Service-account REST calls bypass Firestore Security Rules, so keep its key in Cloudflare Secrets and keep the service account separate from human accounts. See Google's [Firestore REST API authentication guide](https://firebase.google.com/docs/firestore/use-rest-api) and [Firebase ID token verification guide](https://firebase.google.com/docs/auth/admin/verify-id-tokens).

## Local Worker development

Create an ignored `wishlist-worker/.dev.vars` file containing `FIREBASE_SERVICE_ACCOUNT_JSON` with the one-line service account JSON. Do not commit that file. Start the Worker with `npm run dev`; set the app's `NEXT_PUBLIC_WISHLIST_API_URL` to the local Worker URL printed by Wrangler.

The default allowed origins are the GitHub Pages site, `localhost:3000`, and `192.168.254.101:3000`. Update `ALLOWED_ORIGINS` in `wrangler.toml` if the site uses another origin.
