import type { AppConfig } from "./types";

/** Optional: comma-separated Script Properties override these empty defaults. */
const DEFAULT_EXCLUDED: string[] = [];
const DEFAULT_EXTRA_SEGMENTS: string[] = [];

function parseNameList(raw: string | null): string[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveRecipients(
  props: GoogleAppsScript.Properties.Properties,
): string[] {
  return parseNameList(props.getProperty("BRIEFING_RECIPIENTS"));
}

export function getConfig(): AppConfig {
  const props = PropertiesService.getScriptProperties();
  const recipients = resolveRecipients(props);

  const folderRaw = (props.getProperty("ROOT_FOLDER_ID") || "").trim();
  const excluded = parseNameList(props.getProperty("EXCLUDED_FOLDER_NAMES"));
  const extras = parseNameList(props.getProperty("EXTRA_SEGMENT_NAMES"));

  return {
    rootFolderId: folderRaw,
    openRouterApiKey: props.getProperty("OPENROUTER_API_KEY") || "",
    openRouterModel:
      props.getProperty("OPENROUTER_MODEL") || "google/gemini-2.5-flash-lite",
    recipients,
    windowHours: 24,
    excludedProjectNames: excluded.length > 0 ? excluded : DEFAULT_EXCLUDED,
    extraSegmentNames: extras.length > 0 ? extras : DEFAULT_EXTRA_SEGMENTS,
  };
}

/** Fail before the Drive scan and the paid OpenRouter call. */
export function assertConfigReady(config: AppConfig): void {
  if (!config.rootFolderId.trim()) {
    throw new Error("ROOT_FOLDER_ID fehlt. Bitte Script Property setzen.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(config.rootFolderId)) {
    throw new Error("ROOT_FOLDER_ID ist ungültig.");
  }
  if (config.recipients.length === 0) {
    throw new Error(
      "BRIEFING_RECIPIENTS ist leer. Bitte Script Properties setzen.",
    );
  }
}
