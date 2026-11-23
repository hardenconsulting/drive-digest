---
name: drive-digest-setup
description: >-
  End-to-end setup for Drive Digest: yarn install, Apps Script API, clasp
  login/create, Script Properties, first push, trigger, and smoke run. Use when
  the user wants to install, onboard, configure, or get Drive Digest running
  for the first time.
---

# Drive Digest setup

Walk the user from clone to first mail. Do not invent folder IDs, emails, or API keys — ask and wait. Never commit `.clasp.json`, `.clasprc.json`, or secrets.

Related skills: `gas-clasp-typescript` (build/push details), `gas-openrouter-briefing` (AI config).

## 1. Local install

```bash
yarn install
yarn test
yarn build
```

Stop if tests fail.

## 2. Google account prep

1. User enables **Apps Script API**: https://script.google.com/home/usersettings
2. Login (browser flow — user must complete it):

```bash
yarn clasp login
```

## 3. Bind an Apps Script project

If no local `.clasp.json`:

```bash
yarn clasp create --type standalone --title "Drive Digest" --rootDir dist
```

If they already have a script: create `.clasp.json` with their `scriptId` and `"rootDir": "dist"`. Confirm `.clasp.json` is gitignored.

## 4. Script Properties (required)

In the Apps Script editor (**Project Settings → Script properties**), set:

| Key | Required | Notes |
|---|---|---|
| `ROOT_FOLDER_ID` | yes | Drive folder ID to scan (from the folder URL) |
| `BRIEFING_RECIPIENTS` | yes | Comma-separated emails |
| `OPENROUTER_API_KEY` | for AI | https://openrouter.ai — skip for HTML-only digests |
| `OPENROUTER_MODEL` | no | Default `google/gemini-2.5-flash-lite` |
| `EXCLUDED_FOLDER_NAMES` | no | Comma-separated root children to skip |
| `EXTRA_SEGMENT_NAMES` | no | Root children as their own mail segments |

Ask the user for each value. Offer to open the editor:

```bash
yarn clasp open-script
```

## 5. Push and authorize

```bash
yarn push
```

Use `yarn clasp push --force` if the manifest/scopes changed. User reloads the editor, runs `showBriefingConfig` once, and accepts the OAuth prompts (Drive, Gmail, external request).

## 6. Trigger + first run

1. Run `installDailyTrigger` → daily ~05:00 (script timezone, default `Etc/UTC`)
2. Run `runDailyBriefing` for a smoke test
3. Confirm mail arrives; if AI text is empty, check `OPENROUTER_API_KEY` / logs

## Checklist (paste for the user)

- [ ] `yarn install` / `yarn test` / `yarn build`
- [ ] Apps Script API on
- [ ] `yarn clasp login`
- [ ] `.clasp.json` → `rootDir: dist` (gitignored)
- [ ] Script Properties: `ROOT_FOLDER_ID`, `BRIEFING_RECIPIENTS`, optional OpenRouter
- [ ] `yarn push` (+ `--force` if needed)
- [ ] Authorize scopes via `showBriefingConfig`
- [ ] `installDailyTrigger` + `runDailyBriefing`
