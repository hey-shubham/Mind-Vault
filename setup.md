# Mind Vault — Setup Guide (v32)

## 1. Requirements

- Node.js 22 LTS recommended
- npm
- Git (optional)
- Chrome/Edge/Firefox/Safari
- Optional: Ollama for local AI
- Optional: one or more cloud AI provider keys

## 2. Project structure

```text
MindVault/
├── client/
├── server/
├── firebase.json
├── vercel.json
├── netlify.toml
├── Dockerfile
├── package.json
├── README.md
├── setup.md
└── deployment.md
```

## 3. Install dependencies

From the project root:

```bash
npm run install:all
```

This runs:

```bash
npm install
npm --prefix client install
npm --prefix server install
```

No legacy-peer-deps flag is required by the project setup.

## 4. Environment

Copy:

```text
server/.env.example → server/.env
client/.env.example → client/.env
```

At minimum for local auth:

```env
JWT_SECRET=use-a-long-random-development-secret
CLIENT_ORIGIN=http://localhost:5173
```

For AI, configure at least one provider, for example:

```env
GROQ_API_KEY=...
```

For cloud file storage, configure:

```env
S3_ENDPOINT=...
S3_BUCKET=...
S3_REGION=auto
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

For a durable mounted SQLite file, optionally set:

```env
DATABASE_PATH=/persistent/mindvault.db
```

## 5. Development

Start frontend + backend together:

```bash
npm run dev
```

Frontend:

```text
http://localhost:5173
```

API:

```text
http://localhost:4000
```

Health:

```text
http://localhost:4000/api/health
```

## 6. Build

Full build:

```bash
npm run build
```

Only frontend:

```bash
npm run build:client
```

Only backend:

```bash
npm run build:server
```

Production backend:

```bash
npm start
```

The backend now starts the compiled JavaScript from `server/dist`; it does not require the development `tsx` watcher in production.

## 7. Troubleshooting

### Frontend says ECONNREFUSED for `/api`

The API server is not running or the frontend API URL is wrong.

Local:

```bash
npm --prefix server run dev
```

### Vite parser error

Run:

```bash
npm run build:client
```

The build stops at the exact TypeScript/JSX syntax error instead of hiding it behind the dev server.

### Backend syntax/build error

Run:

```bash
npm run build:server
```

### AI unavailable

Check `/api/health` and the configured provider key. Mind Vault has provider fallback logic, but at least one configured/available provider is needed for cloud AI responses.

### Files disappear after deployment

You are using ephemeral local storage. Configure S3-compatible storage or a durable mounted volume.

## 8. Production build check

Before deployment:

```bash
npm run build
```

Then verify:

```text
client/dist exists
server/dist exists
```

Do not deploy a build that reports TypeScript/JSX errors.
