# Mind Vault

Mind Vault is a full-stack AI knowledge workspace built around three ideas: **store knowledge, retrieve it intelligently, and use AI to learn/work with it**.

The project contains a React + Vite frontend and a Node.js + Express backend with SQLite persistence, protected file storage, AI provider failover, source-grounded search, study tools, private AI conversations, real-time messaging, connection requests, groups, notes, tasks, analytics, profile customization, sharing, and production deployment scaffolding.

> **Version:** 32 — production hardening release

---

## 1. What Mind Vault does

### My Vault
- Upload PDFs, DOCX, TXT, Markdown, CSV, images and supported code/data files.
- Extract text and index it into searchable chunks.
- Re-index stored documents after processing changes.
- Open and download protected files.
- Share documents with other Mind Vault accounts.
- Create public share links for supported documents.
- Store files locally during development or in S3-compatible object storage in production.

### Search & Knowledge
- Semantic/lexical hybrid retrieval over indexed vault content.
- Synthesized answers grounded in the user's private documents.
- Source snippets and document references.
- Search history with a clear action.

### Knowledge AI
- A vault-grounded chat mode separate from the general assistant.
- Ask across the entire vault or lock the scope to one document.
- Saved knowledge conversations.
- Clear/delete conversation actions.
- Copy/reply message controls.

### AI Assistant
- General-purpose AI for coding, maths, study, writing, planning, explanations and everyday questions.
- Optional vault attachments.
- File/image/location input support where configured.
- Voice input through supported browser speech recognition.
- New chat, history, pinning, deletion, incognito mode and sharing.
- Copy/reply controls with a short copied confirmation.
- Language behavior: English input receives English; Hinglish/mixed input receives natural Roman-script Hinglish; Hindi is used when explicitly requested.
- Developer information is intentionally returned only when the user asks about the Mind Vault developer/creator.

### Study Room
- AI-generated source-grounded MCQs.
- Easy/medium/hard difficulty.
- 1–50 question selection.
- Source selection with a real placeholder state.
- Quiz answer submission and score tracking.
- Source-grounded summaries.
- Quiz normalization prevents malformed or filler-style options from being stored.

### Messages
- Direct chats.
- Group chats.
- Connection-based messaging.
- Connection requests that require recipient approval before a connection is created.
- Online/last-seen presence.
- Delete chat.
- Block/unblock contacts.
- Reply metadata.
- Message reactions.
- Copy message.
- Attachments with protected open/download routes.
- Location sharing.
- Camera capture in supported browsers.
- Notifications.
- WebSocket live delivery.
- Group creation and group deletion for the owner.

### My Connections
- Search users by name, username, email or phone.
- Username supports letters, numbers, dots and hyphens in valid positions.
- Username is required during registration.
- Phone number is required during registration.
- Live username availability checking during signup.
- Duplicate usernames are rejected server-side.
- Incoming requests can be accepted/rejected.
- Outgoing pending requests are visible.
- Existing connections can be opened or removed.

### Focus Board
- Persistent tasks.
- High/medium/low priorities.
- Complete/uncomplete tasks.
- Edit tasks.
- Delete tasks.

### Notes
- Create notes.
- Edit/version notes.
- Delete notes.
- Local draft persistence.

### Analytics
- Documents.
- Indexed chunks.
- Notes.
- Conversations.
- Quizzes.
- Flashcards.
- Tasks.
- Activity logs.
- Clean metric cards without the old decorative sparkline residue.

### Settings
- Dark/light/system theme.
- Neon accent themes.
- Profile name, username and phone.
- Circular profile photo with `object-fit: cover`.
- AI language and response-style controls.
- Font family and reading-size controls.

---

## 2. Architecture

```text
Browser
  │
  ├── React 19 + Vite client
  │       │
  │       ├── Authentication UI
  │       ├── Vault / Search / Knowledge AI
  │       ├── Study Room
  │       ├── Messages / Groups
  │       ├── Connections
  │       ├── Notes / Focus / Analytics
  │       └── Settings
  │
  └── HTTP / WebSocket
          │
          ▼
Node.js + Express API
  │
  ├── JWT authentication
  ├── SQLite database
  ├── File extraction + indexing
  ├── Protected file delivery
  ├── S3-compatible cloud storage adapter
  ├── AI provider router/fallbacks
  └── WebSocket messaging
```

### Main directories

```text
client/                 React + Vite application
client/src/main.tsx     Main UI/application implementation
client/src/styles.css   Theme + responsive UI styles
client/src/lib/api.ts   Authenticated API/file helpers
server/src/index.ts     Express routes + WebSocket server
server/src/db.ts        SQLite schema + migrations
server/src/ingest.ts    PDF/DOCX/text/image extraction + indexing
server/src/storage.ts   Local/S3-compatible file persistence
server/src/ai.ts        AI provider routing and fallbacks
server/src/auth.ts      Password/JWT authentication helpers
firebase.json           Firebase Hosting + Cloud Run rewrite
vercel.json             Vercel frontend deployment config
netlify.toml            Netlify frontend deployment config
Dockerfile              Production backend container
setup.md                Local setup guide
deployment.md           Deployment and security guide
```

---

## 3. AI provider architecture

The server supports multiple optional providers and can fail over when one is unavailable. Configure only the providers you actually intend to use.

Supported configuration includes:

- Groq
- Cerebras
- SambaNova
- Hugging Face Router
- OpenRouter
- Gemini
- Cohere
- OpenAI
- DeepSeek
- Mistral
- Together
- Ollama/local development

The backend never places provider API keys in the React client.

---

## 4. Security model

### Authentication
- Passwords are hashed with bcrypt.
- JWT sessions expire after seven days.
- Bearer tokens are sent from the browser to the API.
- Production requires an explicit `JWT_SECRET`.

### File security
- Files are uploaded through authenticated routes.
- File names are sanitized.
- Upload size is limited to 50 MB per file.
- Executable/unlisted file extensions are rejected.
- Vault files are served only after ownership/access checks.
- Chat attachments are served through authenticated routes.
- Public share links expose only the share-token interface, not internal storage paths.

### Browser/API security
- CORS is restricted to the configured `CLIENT_ORIGIN` allowlist.
- `X-Content-Type-Options: nosniff` is enabled.
- `X-Frame-Options: SAMEORIGIN` is enabled.
- Referrer policy is restricted.
- Camera, microphone and geolocation permissions are explicitly scoped.
- Secrets belong in server environment variables, never in `client/.env` with a public `VITE_` prefix.

### URL ingestion
Public URL ingestion accepts HTTP/HTTPS URLs and rejects common localhost/private-network targets to reduce SSRF risk. For a high-security deployment, place the backend behind an outbound egress policy as well.

---

## 5. Important production storage note

SQLite and the default local file directory are suitable for development and single-machine deployments. They are **not automatically durable across arbitrary serverless instances**.

For a real multi-device production deployment:

1. Use S3-compatible storage for uploaded files.
2. Use a durable database/volume strategy for SQLite, or migrate the database layer to a managed database such as PostgreSQL before scaling horizontally.
3. Do not rely on ephemeral container storage for user data.

The included storage adapter supports S3-compatible object storage such as AWS S3, Cloudflare R2 and similar services.

---

## 6. Developer profile behavior

If a user explicitly asks who created/developed Mind Vault, the AI can provide the configured public developer profile:

**Shubham Kumar** — 4th-year B.Tech Computer Science & Engineering student at **JB Institute of Technology**, focused on frontend/MERN development and AI-enabled web applications. The configured profile also includes the project's public GitHub/LinkedIn handles and selected project/skill information.

The assistant is instructed not to expose passwords, API keys, tokens, private account data or hidden system information.

---

## 7. Local development

Requirements:

- Node.js 22 LTS recommended.
- npm.
- A supported browser.
- Optional AI provider key(s).
- Optional Ollama for local AI.

Install everything:

```bash
npm run install:all
```

Create the server environment file:

```text
server/.env
```

using `server/.env.example` as the template.

Start both applications:

```bash
npm run dev
```

Frontend:

```text
http://localhost:5173
```

Backend:

```text
http://localhost:4000
```

Health check:

```text
http://localhost:4000/api/health
```

---

## 8. Production build

Build the frontend and backend together:

```bash
npm run build
```

Frontend output:

```text
client/dist
```

Backend output:

```text
server/dist
```

Run the compiled backend:

```bash
npm start
```

The server listens on the `PORT` environment variable and defaults to `4000` locally.

---

## 9. Deployment choices

### Recommended architecture

```text
Firebase Hosting / Netlify / Vercel
              │
              ▼
        React static client
              │
              ▼
        Node.js API server
              │
       ┌──────┴──────┐
       ▼             ▼
 Durable DB      S3-compatible storage
```

For Firebase, the included `firebase.json` can rewrite `/api/**` to Cloud Run.

For Netlify or Vercel, set:

```env
VITE_API_URL=https://YOUR-API-DOMAIN/api
VITE_WS_URL=wss://YOUR-API-DOMAIN/ws/chat
```

and rebuild the client.

---

## 10. Version 32 hardening changes

- Fixed the broken connection-request approval SQL/TypeScript syntax.
- Fixed the broken connection-card JSX template literal.
- Added production JWT-secret enforcement.
- Removed dotenv override behavior so deployment environment variables are not unexpectedly overwritten.
- Added username uniqueness migration.
- Added public/private URL ingestion validation.
- Added upload extension filtering.
- Added basic HTTP security headers.
- Added JSON error handling for API middleware failures.
- Removed internal storage-path leakage from public document-share metadata.
- Fixed protected media links in contact profiles so they use authenticated file access.
- Made Knowledge AI “Clear chat” remove the current saved conversation as well as its visible messages.
- Made Study Room's “Select a source” state a non-selectable placeholder.
- Added Vercel and Netlify frontend deployment scaffolding.
- Added a real production backend build/start pipeline.
- Reworked Docker into a build/runtime image instead of trying to run the development `tsx` command in production.

---

## 11. Do not commit secrets

Never commit:

```text
server/.env
client/.env
JWT_SECRET
GROQ_API_KEY
OPENAI_API_KEY
GEMINI_API_KEY
OPENROUTER_API_KEY
HF_TOKEN
S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY
```

If a secret is ever exposed, rotate it immediately.

---

## 12. Final verification

Before going public, test at minimum:

- Registration with required username + phone.
- Duplicate username rejection.
- Login by email and username.
- Profile photo upload and circular display.
- Vault upload/open/download/delete.
- Search and Knowledge AI clear chat.
- General AI in English and Hinglish.
- AI copy/reply.
- Quiz generation, all answer options and submission.
- Light/dark quiz contrast.
- Connection request → approve/reject → connection.
- Block/unblock.
- Delete chat.
- Group creation with no preselected member.
- Direct/group attachment view + download.
- Notifications.
- Presence/last seen.
- Analytics/activity deletion.
- Production health endpoint.
- HTTPS + WSS.
- Cross-device file retrieval with durable storage.

Mind Vault is designed to be deployable, but **database durability and object storage are deployment responsibilities**. Do not put user production data on an ephemeral serverless filesystem.
