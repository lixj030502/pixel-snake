# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # Install dependencies
npm run dev        # Start dev server at http://localhost:3000
npm run build      # Build for production
npm run preview    # Preview production build
npm run lint       # Type-check with tsc --noEmit (no test framework configured)
```

## Architecture

This is a single-page React + TypeScript Snake game built with Vite, Tailwind CSS v4, and Firebase.

**Core files:**
- `src/App.tsx` — The entire game in one component. Contains all game logic, rendering, and Firebase integration.
- `src/firebase.ts` — Initializes Firebase app, exports `auth` and `db` instances. Reads config from `firebase-applet-config.json`.
- `firebase-applet-config.json` — Firebase project config (committed; contains public API keys).
- `firestore.rules` — Firestore security rules. Users can only read/write their own `userScores/{userId}` document.

**Game loop:**
The game uses `requestAnimationFrame` for the main loop (`update` callback). Snake state is stored in `useRef` (not `useState`) to avoid re-renders during the game loop. `snakeRef`, `directionRef`, `nextDirectionRef`, `foodRef`, `speedRef` are all refs. React `useState` is only used for UI state (`score`, `highScores`, `isPaused`, `gameOver`, `hasStarted`).

**Firebase integration:**
- Anonymous authentication via `signInAnonymously` on app load.
- High scores stored in Firestore at `userScores/{uid}` with fields `highScores` (array of 5 numbers) and `updatedAt` (timestamp).
- `localStorage` used as a backup/migration path — scores are migrated from local storage to Firestore on first cloud sign-in.

**Rendering:**
Game is drawn on an HTML `<canvas>` element using 2D context. Grid is 20×20 cells, each 20px. Mobile controls use on-screen buttons (hidden on md+); also supports touch swipe and keyboard (arrow keys / WASD / Space).

## Environment

Copy `.env.example` to `.env.local` and set `GEMINI_API_KEY` if needed (not currently used by the game itself — a scaffold from AI Studio). Firebase config is in `firebase-applet-config.json`, not environment variables.
