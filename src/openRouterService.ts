import { extractNarration } from "./briefingLogic";
import { fetchWithRetry } from "./retry";
import type { BriefingData, BriefingNarration } from "./types";

interface OpenRouterChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | Array<{ type?: string; text?: string }> };
  }>;
  error?: { message?: string };
}

/**
 * Caveman voice (juliusbrussee/caveman): answer first, one idea per sentence,
 * fluff gone, meaning never dropped. English output. Filenames stay out of text
 * (rendered programmatically in mail as New/Changed/Viewed/Deleted).
 */
function projectPayload(project: BriefingData["projects"][number]) {
  const files = project.groups.flatMap((group) => group.files);
  return {
    projectId: project.id,
    projectName: project.name,
    kind: project.segmentKind,
    added: files.filter((file) => file.changeKind === "added").length,
    modified: files.filter((file) => file.changeKind === "modified").length,
    viewed: files.filter((file) => file.changeKind === "viewed").length,
    deleted: files.filter((file) => file.changeKind === "deleted").length,
    folders: project.groups.map((group) => ({
      folderName: group.folderName,
      files: group.files.map((file) => ({
        kind: file.changeKind,
        // Names for grounding only - never echo in summary text.
        name: file.name,
        type: file.mimeType.includes("pdf")
          ? "pdf"
          : file.mimeType.includes("dwg") || /\.dwg$/i.test(file.name)
            ? "dwg"
            : file.mimeType.startsWith("image/")
              ? "image"
              : "file",
        modifiedTime: file.modifiedTime,
      })),
    })),
  };
}

function buildPrompt(data: BriefingData): string {
  const payload = [
    ...data.projects.map(projectPayload),
    ...data.segments.map(projectPayload),
  ];

  return [
    "You write Drive Digest — a daily summary of Google Drive activity.",
    "Language: English. Voice: Caveman (juliusbrussee/caveman) — dense style, full facts.",
    "",
    "CAVEMAN RULES:",
    "- Answer first: [thing] [action] [why]. No greeting, no hedging, no recap.",
    "- One idea per sentence. Active. Short and clear (~20 words/sentence).",
    "- Never drop meaning: not/never/only stay. Numbers/units exact.",
    "- No theater, no filler (actually/basically/simply/in summary).",
    "- Articles optional when the sentence stays clear. Fragments ok if unambiguous.",
    "- If caveman form is less clear than plain text, use plain text.",
    "",
    "CONTENT:",
    "- Facts from metadata only. Invent nothing. No URLs.",
    "- Full picture: folders, types (PDF/CAD/photos), New / Changed / Viewed / Deleted.",
    "- viewed = opened only, not edited. Say so when relevant.",
    "- Sparse data → short. Busy day → a few dense sentences / 2 short paragraphs (\\n\\n).",
    "- NEVER put filenames in the text (they appear separately: green New, amber Changed, grey Viewed, red Deleted).",
    "- Use folder and type names sensibly (plans, drawings, photos, docs, …).",
    "",
    "Reply with JSON only:",
    '{"dayOverview":"...","projects":[{"projectId":"...","projectName":"...","summary":"..."}]}',
    "",
    "dayOverview: dense day overview (as long as the situation needs, typically 2-5 sentences).",
    "projects[].projectId: exact projectId from the data, do not change.",
    "projects[].summary: full project picture in Caveman English, no filenames.",
    "JSON must be complete. Prefer shorter over truncated.",
    "",
    "Data (changes since " +
      data.windowStartIso +
      ", ~" +
      data.windowHours +
      " h):",
    JSON.stringify(payload),
  ].join("\n");
}

function contentToText(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  return content
    .map((part) => part.text || "")
    .join("")
    .trim();
}

interface ChatAttempt {
  status: number;
  text: string;
  finishReason: string;
  errorMessage: string;
  raw: string;
}

function requestNarration(
  apiKey: string,
  model: string,
  prompt: string,
  maxTokens: number,
  hint: string,
): ChatAttempt {
  const messages = [{ role: "user", content: hint ? `${prompt}\n${hint}` : prompt }];

  const send = (withResponseFormat: boolean): ChatAttempt => {
    const body: Record<string, unknown> = {
      model,
      temperature: 0.35,
      max_tokens: maxTokens,
      messages,
    };
    if (withResponseFormat) body.response_format = { type: "json_object" };
    const response = fetchWithRetry(
      "OpenRouter",
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "post",
        contentType: "application/json",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://script.google.com",
          "X-Title": "Drive-Digest",
        },
        payload: JSON.stringify(body),
        muteHttpExceptions: true,
      },
    );
    const raw = response.getContentText();
    const status = response.getResponseCode();
    let json: OpenRouterChatResponse = {};
    try {
      json = JSON.parse(raw) as OpenRouterChatResponse;
    } catch {
      json = {};
    }
    return {
      status,
      text: contentToText(json.choices?.[0]?.message?.content),
      finishReason: json.choices?.[0]?.finish_reason || "",
      errorMessage: json.error?.message || "",
      raw,
    };
  };

  const first = send(true);
  if (first.status === 400 && /response_format|json_object|structured/i.test(first.raw)) {
    console.warn("OpenRouter akzeptiert response_format nicht, neuer Versuch ohne.");
    return send(false);
  }
  return first;
}

function tryParseNarration(text: string): BriefingNarration | null {
  if (!text) return null;
  try {
    return extractNarration(text);
  } catch (err) {
    console.error(
      `OpenRouter-JSON nicht lesbar: ${String(err)}; Auszug: ${text.slice(0, 180)}`,
    );
    return null;
  }
}

/**
 * Caveman-style English narration; filenames listed programmatically in mail.
 * Parsing survives fenced JSON and answers cut off by max_tokens.
 */
export function summarizeProjectsWithOpenRouter(
  data: BriefingData,
  apiKey: string,
  model: string,
): BriefingNarration {
  const empty: BriefingNarration = { dayOverview: "", projects: [] };
  if (!apiKey || (data.projects.length === 0 && data.segments.length === 0)) {
    return empty;
  }

  const prompt = buildPrompt(data);

  try {
    const first = requestNarration(apiKey, model, prompt, 4000, "");
    if (first.status < 200 || first.status >= 300) {
      console.error(
        `OpenRouter HTTP ${first.status}: ${first.errorMessage || first.raw.slice(0, 180)}`,
      );
      return empty;
    }

    if (first.finishReason === "length") {
      console.warn("OpenRouter-Antwort abgeschnitten (finish_reason=length).");
    }

    const parsed = tryParseNarration(first.text);
    const needsRetry = !parsed || first.finishReason === "length";
    if (!needsRetry && parsed) return parsed;

    const second = requestNarration(
      apiKey,
      model,
      prompt,
      8000,
      "Vorige Antwort war unvollständig. Antworte kürzer, aber als vollständiges JSON.",
    );
    if (second.status < 200 || second.status >= 300) {
      console.error(
        `OpenRouter Retry HTTP ${second.status}: ${second.errorMessage || second.raw.slice(0, 180)}`,
      );
      return parsed || empty;
    }
    if (second.finishReason === "length") {
      console.warn("OpenRouter-Retry ebenfalls abgeschnitten (finish_reason=length).");
    }
    const reparsed = tryParseNarration(second.text);
    if (reparsed) return reparsed;
    if (parsed) {
      console.warn("OpenRouter-Retry ohne nutzbares JSON, erste (reparierte) Antwort wird verwendet.");
      return parsed;
    }
    console.error("OpenRouter lieferte kein lesbares JSON.");
    return empty;
  } catch (err) {
    console.error(`OpenRouter fehlgeschlagen: ${String(err)}`);
    return empty;
  }
}
