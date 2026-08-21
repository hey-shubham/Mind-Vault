# Mind Vault — Production Deployment (v32)

## Recommended production architecture

Use a static frontend host plus a real Node.js API runtime:

```text
Firebase Hosting / Netlify / Vercel
             │
             ▼
        React/Vite SPA
             │
             ▼
     Node.js + Express API
       │             │
       ▼             ▼
 Durable database   S3/R2/B2 storage
```

**Firebase Hosting alone is not the backend.** The included Firebase configuration routes `/api/**` to Cloud Run.

**Netlify/Vercel can host the frontend.** Keep the Express/WebSocket backend on Cloud Run, Render, Railway, Fly.io or another Node-capable service unless you deliberately redesign the backend for serverless execution.

---

## 1. Build locally first

```bash
npm run install:all
npm run build
```

Never deploy while the build reports an error.

---

## 2. Production environment variables

Backend:

```env
NODE_ENV=production
PORT=4000
JWT_SECRET=<long-random-secret>
CLIENT_ORIGIN=https://your-domain.example

# At least one AI provider
GROQ_API_KEY=...
# or GEMINI_API_KEY=...
# or OPENAI_API_KEY=...
# or OPENROUTER_API_KEY=...

# Durable file storage — strongly recommended
S3_ENDPOINT=...
S3_BUCKET=...
S3_REGION=auto
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...

# Optional durable mounted SQLite path
DATABASE_PATH=/persistent/mindvault.db

GOOGLE_CLIENT_ID=...
```

`CLIENT_ORIGIN` accepts a comma-separated allowlist when multiple frontend origins are intentionally required.

Never put private provider keys in `VITE_*` variables.

---

## 3. Firebase Hosting + Cloud Run

### Firebase

Install/login:

```bash
npm install -g firebase-tools
firebase login
firebase use YOUR_FIREBASE_PROJECT_ID
```

The included `firebase.json` publishes:

```text
client/dist
```

and rewrites:

```text
/api/** → Cloud Run service mindvault-api
```

### Backend container

Build:

```bash
gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT_ID/mindvault/mindvault-api
```

Deploy:

```bash
gcloud run deploy mindvault-api \
  --image REGION-docker.pkg.dev/PROJECT_ID/mindvault/mindvault-api \
  --region us-central1 \
  --allow-unauthenticated
```

Set backend secrets in Cloud Run/Secret Manager.

Then deploy the frontend:

```bash
firebase deploy --only hosting
```

### Critical Firebase note

Cloud Run's normal filesystem is not a durable database. Do not rely on `server/data/mindvault.db` for multi-instance production data. Use a durable volume/database strategy and S3-compatible object storage.

---

## 4. Netlify frontend

The repository includes `netlify.toml`.

Build command:

```text
npm install && npm --prefix client install && npm --prefix client run build
```

Publish directory:

```text
client/dist
```

Set:

```env
VITE_API_URL=https://YOUR-API-DOMAIN/api
VITE_WS_URL=wss://YOUR-API-DOMAIN/ws/chat
```

Deploy the Node backend separately.

---

## 5. Vercel frontend

The repository includes `vercel.json`.

Set:

```env
VITE_API_URL=https://YOUR-API-DOMAIN/api
VITE_WS_URL=wss://YOUR-API-DOMAIN/ws/chat
```

The Vercel deployment should be treated as the frontend deployment. Keep the Express/WebSocket server on a Node runtime designed for long-lived processes.

---

## 6. WebSockets

Production chat uses:

```text
wss://YOUR-API-DOMAIN/ws/chat?token=JWT
```

Set:

```env
VITE_WS_URL=wss://YOUR-API-DOMAIN/ws/chat
```

if the frontend and backend are on different domains.

Use HTTPS/WSS only in production.

---

## 7. Storage

For development, local storage is acceptable.

For production, configure S3-compatible storage:

```env
S3_ENDPOINT=...
S3_BUCKET=...
S3_REGION=auto
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

Then a user's uploaded PDF remains available through the authenticated API after signing into the same account from another device.

---

## 8. Database

The project currently uses SQLite.

### Single durable server

A durable mounted SQLite file can be used:

```env
DATABASE_PATH=/persistent/mindvault.db
```

### Horizontally scaled production

Migrate the database layer to PostgreSQL/MySQL before running multiple API instances. SQLite is not a suitable shared database for arbitrary serverless replicas.

---

## 9. Security checklist

- [ ] `NODE_ENV=production`
- [ ] Strong random `JWT_SECRET`
- [ ] Secrets stored in platform secret manager
- [ ] No `.env` files committed
- [ ] HTTPS enabled
- [ ] WSS enabled
- [ ] `CLIENT_ORIGIN` restricted to real frontend origins
- [ ] S3 bucket access restricted to the application
- [ ] No public bucket listing
- [ ] Durable database configured
- [ ] Cloud logs enabled
- [ ] Backups enabled
- [ ] Custom domain configured if public
- [ ] API rate limiting/WAF configured at the platform edge for high-traffic deployments
- [ ] Provider keys rotated if exposed

---

## 10. Smoke test after deployment

Open:

```text
https://YOUR-FRONTEND-DOMAIN
```

Then test:

1. Register a new account.
2. Confirm username and phone are required.
3. Try a duplicate username.
4. Upload a PDF.
5. Open and download the PDF.
6. Search the vault.
7. Ask Knowledge AI and clear its chat.
8. Ask the General AI in English.
9. Ask it in Hinglish.
10. Generate a quiz.
11. Verify dark/light question and option contrast.
12. Search for another user.
13. Send a connection request.
14. Approve it from the other account.
15. Start a direct chat.
16. Block/unblock the contact.
17. Delete the chat.
18. Create a group and verify no member is preselected.
19. Send a group message.
20. Upload a chat attachment and test both View and Download.
21. Test profile photo cropping.
22. Test analytics/activity.
23. Refresh the page and confirm the session remains valid.
24. Log into the same account on another device/browser and confirm durable vault files are available.

---

## 11. Health endpoint

```text
GET /api/health
```

It reports only non-secret runtime status such as AI availability and storage mode.

---

## 12. Rollback

Keep the previous frontend release and backend revision available until the smoke test passes. Roll back the frontend and API independently if necessary.

---

## 13. Important limitation

This release is **deployment-hardened and build-ready**, but no ZIP can magically make an ephemeral SQLite filesystem durable. For a genuine public production service, configure durable database storage and S3-compatible object storage before real users upload important data.
