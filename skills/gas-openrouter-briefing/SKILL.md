---
name: gas-openrouter-briefing
description: >-
  OpenRouter chat completions via UrlFetchApp for Drive Digest English
  summaries (caveman voice). Use when configuring OPENROUTER_API_KEY, choosing
  models, or debugging LLM fallbacks in this GAS project.
---

# GAS OpenRouter Briefing

## Config (Script Properties)

| Key | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API key (never commit) |
| `OPENROUTER_MODEL` | Default `google/gemini-2.5-flash-lite` |
| `BRIEFING_RECIPIENTS` | Comma-separated emails |
| `ROOT_FOLDER_ID` | Drive root for scan |

## Voice

Summaries follow [caveman](https://github.com/juliusbrussee/caveman) rules in English:

- Answer first, fluff gone, meaning never dropped
- One idea per sentence (~20 words), active voice
- Full package when metadata supports it; never invent
- **No filenames in AI text** (mail: Neu `+` green / Geändert `~` amber / Gelöscht `−` red from Drive trash)

## Call pattern

- `POST https://openrouter.ai/api/v1/chat/completions`
- Prompt JSON: `{ dayOverview, projects: [{ projectName, summary }] }`
- Input includes names for grounding; output must not echo them
- `max_tokens` 4000, one retry at 8000, `response_format: json_object`; truncated JSON is repaired. On failure send HTML without AI text (diff list still works)
