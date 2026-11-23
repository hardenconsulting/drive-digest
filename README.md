# Drive Digest

A delectable digest of your Drive, delivered straight to your mail. Built entirely in Google Apps Script, which makes it "blazingly" fast. Drop in an OpenRouter key and watch the magic. Literal cents a month. Give it a try. Or don't.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![esbuild](https://img.shields.io/badge/esbuild-FFCF00?style=flat&logo=esbuild&logoColor=black)
![clasp](https://img.shields.io/badge/clasp-4285F4?style=flat&logo=google&logoColor=white)
![Yarn](https://img.shields.io/badge/Yarn-2C8EBB?style=flat&logo=yarn&logoColor=white)
![Google Apps Script](https://img.shields.io/badge/Google%20Apps%20Script-V8-4285F4?style=flat&logo=google&logoColor=white)

## What it does

1. Scans a Drive folder root since the last successful run (without a saved timestamp: last 24 h)
2. Groups by project → files / subfolders → DWG at the end
3. Optional: short English AI summaries via OpenRouter (`gemini-2.5-flash-lite`)
4. Sends a dark HTML mail with clickable thumbnail previews

Apps Script entry point: `runDailyBriefing`  
Trigger helper: `installDailyTrigger` (daily ~05:00, script timezone; default `Etc/UTC`)

Pills in the mail: green Neu, yellow Geändert, grey Angesehen (opened only), red Gelöscht.  
**Angesehen** uses `viewedByMeTime` of the account that runs the trigger.

## Setup

Point an AI agent at `skills/drive-digest-setup` if you want a guided install. Otherwise:

```bash
yarn install
```

1. Enable the Apps Script API in your Google account under [script.google.com/home/usersettings](https://script.google.com/home/usersettings).
2. Log in with clasp:

```bash
yarn clasp login
```

3. Create a new Apps Script project (or use an existing one):

```bash
clasp create --type standalone --title "Drive Digest" --rootDir dist
```

Or point an existing script at this repo. Keep a local `.clasp.json` with `rootDir` set to `dist` and your `scriptId`. That file stays gitignored — never commit it.

### Script Properties (Apps Script Editor)

| Key | Required | Description |
|---|---|---|
| `ROOT_FOLDER_ID` | yes | Drive folder ID to scan |
| `BRIEFING_RECIPIENTS` | yes | Recipients, comma-separated (Script Properties only, not User) |
| `OPENROUTER_API_KEY` | for AI | OpenRouter API key |
| `OPENROUTER_MODEL` | no | Defaults to `google/gemini-2.5-flash-lite` |
| `EXCLUDED_FOLDER_NAMES` | no | Comma-separated root children to skip |
| `EXTRA_SEGMENT_NAMES` | no | Comma-separated root children scanned as their own mail segments |

Run state is written by the script itself. Inventories live in a hidden Drive file (app data, not under the scan root). `lastSuccessfulRunAt` and the Changes token stay as small Script Properties. Until the new Drive permission is granted, inventories remain in Properties.

## Commands

```bash
yarn build              # src → dist/bundle.js + manifest
yarn typecheck          # tsc --noEmit
yarn test               # inventory, deletions, window, JSON repair
yarn push               # build + clasp push
yarn clasp open-script  # open the editor
```

After push: reload the editor, run `showBriefingConfig`, then `installDailyTrigger` (~05:00 script timezone), then `runDailyBriefing`.

## Project layout

```text
src/
  index.ts              # orchestration + globalThis exports
  driveService.ts       # Drive scan, thumbnails, DWG detection
  openRouterService.ts  # AI summaries
  mailService.ts        # HTML mail (cid: previews)
  config.ts / types.ts
  appsscript.json       # scopes + Drive Advanced Service
skills/                 # agent skills: setup, clasp, OpenRouter
build.js                # esbuild IIFE + GAS function footer
dist/                   # clasp rootDir
```

## Notes

- Public Drive thumbnail URLs often fail in mail clients → previews are fetched server-side and embedded as `cid:`.
- Real accordion/chevron does not work in Gmail (no JS). Compactness is in the layout.
- Never commit secrets. `.clasprc.json` and keys stay local / in Script Properties.

## License

MIT · Copyright 2026 Samuel Harden
