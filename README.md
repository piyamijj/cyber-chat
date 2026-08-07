# Cyber Chat

A minimal, dark-theme-only chat interface built with Next.js (App Router), backed by Groq's OpenAI-compatible API.

## What this is

Cyber Chat is a single-page chat UI. The user picks a model from a dropdown showing friendly display names only — the real underlying model IDs are never sent to the browser or shown in the UI; all model resolution happens server-side in the API route.

## Model mapping

The dropdown shows three display names. Their mapping to real provider model IDs lives only in `lib/models.ts` and is resolved server-side in `app/api/chat/route.ts`:

- **cyber lite** — fast, lightweight model for quick everyday questions.
- **cyber flash** — high-speed model balancing power and response time.
- **cyber pro** — most capable model for complex, demanding tasks.

The client only ever sees the display name and slug (e.g. `cyber-lite`); the real model ID is resolved on the server and never appears in any client-side response, network payload, or the browser bundle.

## Environment variables

Copy `.env.example` to `.env.local` for local development:

```bash
cp .env.example .env.local
```

Required variable:

- `GROQ_API_KEY` — your Groq API key. Server-side only. Never prefix this with `NEXT_PUBLIC_`, never log it, never commit it. Get/rotate it at https://console.groq.com/keys.

When deploying, set `GROQ_API_KEY` as an environment variable in your hosting provider's dashboard (not in the repository).

## Local development

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

## Build

```bash
npm run build
npm run start
```

## Deployment

This project is designed to deploy on Vercel:

1. Push this repository to GitHub.
2. Import the repository into Vercel as a new project.
3. In the Vercel project's Environment Variables settings, add `GROQ_API_KEY` with your Groq API key value.
4. Deploy.
5. Optionally attach a custom domain to the Vercel project via Project Settings → Domains, then point your DNS provider at the target Vercel gives you.

No server, Docker, or reverse proxy setup is required for this project — Vercel handles building, hosting, HTTPS/SSL, and scaling automatically.

## Security notes

- The Groq API key is read only from `process.env.GROQ_API_KEY` inside the server-side API route (`app/api/chat/route.ts`). It is never returned in any API response, never logged, and never exposed to client-side code.
- The mapping from display names to real model IDs is intentionally kept server-side so real model identifiers are not discoverable from the browser, developer tools, or network tab.