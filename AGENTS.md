# Repository Guidelines

## Project Structure & Module Organization
This is a Vite + React + TypeScript app.

- `App.tsx`, `index.tsx`: application entry and root composition.
- `components/`: UI and gameplay panels (e.g., `Dashboard.tsx`, `CombatPanel.tsx`).
- `context/`: React context and state provider (`GameContext.tsx`).
- `reducers/`: game state transitions (`gameReducer.ts`).
- `utils/`: core gameplay/AI/loot logic.
- `types/`: shared TypeScript interfaces and action types.
- `docs/`: gameplay and implementation documents.
- `dist/`: build output (generated; do not hand-edit).

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: start local Vite dev server.
- `npm run build`: create production bundle in `dist/`.
- `npm run preview`: preview the production build locally.

Example workflow:
```bash
npm install
npm run dev
```

## Coding Style & Naming Conventions
- Language: TypeScript + React functional components.
- Indentation: 2 spaces; keep semicolons and single quotes consistent with existing files.
- Components, types, and context providers: `PascalCase`.
- Variables/functions/actions: `camelCase`; constants: `UPPER_SNAKE_CASE`.
- File naming follows current patterns: components/types in `PascalCase` or domain-specific names (e.g., `gameReducer.ts`, `gameLogic.ts`).
- Keep reducer logic pure and centralized in `reducers/`; avoid scattering state mutations in components.

## Testing Guidelines
No automated test framework is configured yet (no `npm test` script currently).

- For now, validate changes by running `npm run build` and manually testing key gameplay flows in `npm run dev`.
- If adding tests, prefer Vitest + React Testing Library, with test files named `*.test.ts` / `*.test.tsx` colocated with source or in a `tests/` folder.

## Commit & Pull Request Guidelines
Recent history includes `feat: ...`, `chore(docs): ...`, and short imperative messages.

- Prefer Conventional Commit style: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`.
- Keep commits focused and scoped to one change.
- PRs should include:
  - concise summary and rationale,
  - linked issue/task (if available),
  - screenshots/GIFs for UI changes,
  - verification notes (e.g., `npm run build` success, manual test coverage).

## Security & Configuration Tips
- Set `GEMINI_API_KEY` in `.env.local`; never commit secrets.
- Do not commit local-only artifacts beyond lockfiles and intended source/docs updates.
