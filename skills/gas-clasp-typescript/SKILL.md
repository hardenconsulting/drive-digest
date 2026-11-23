---
name: gas-clasp-typescript
description: >-
  Local Google Apps Script workflow with Yarn, esbuild, TypeScript, and clasp 3.
  Use when building, pushing, logging in, creating scripts, or debugging
  globalThis entry points, dist/rootDir, or clasp command renames in this repo.
---

# GAS + clasp + TypeScript

## Stack

- Source in `src/`, bundle via `build.js` (esbuild) → `dist/bundle.js`
- Manifest copied `src/appsscript.json` → `dist/appsscript.json`
- `.clasp.json` has `rootDir: "dist"`
- Scripts: `yarn build`, `yarn push` (= build + `clasp push`)

## Entry points for GAS

Bundled code is an IIFE. Assign handlers to `globalThis.__gasExports`.
`build.js` appends top-level wrappers so the editor dropdown lists them:

```ts
(globalThis as any).__gasExports = {
  runDailyBriefing: runDailyBriefingJob,
  installDailyTrigger,
};
```

```js
// footer in build.js
function runDailyBriefing(){ return globalThis.__gasExports.runDailyBriefing(); }
```

Without the footer, Apps Script shows “Keine Funktionen gefunden”.

## clasp 3 notes

- Login: `yarn clasp login` (needs Apps Script API enabled at https://script.google.com/home/usersettings)
- Open IDE: `yarn clasp open-script` (not `open`)
- Manifest changes: non-interactive `clasp push` skips unless `yarn clasp push --force`
- Create fails if `.clasp.json` already exists — remove only when intentionally recreating

## Push checklist

1. `yarn build`
2. `yarn clasp push --force` when `appsscript.json` / scopes changed
3. Authorize once in the Apps Script editor after new scopes
