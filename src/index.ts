import { THUMBNAIL_DEADLINE_MS } from "./briefingLogic";
import { assertConfigReady, getConfig } from "./config";
import { commitBriefingState, scanRecentProjects } from "./driveService";
import { buildBriefingMail, sendBriefingEmail } from "./mailService";
import { summarizeProjectsWithOpenRouter } from "./openRouterService";
import type { BriefingNarration } from "./types";

const LOCK_WAIT_MS = 15_000;
const OPENROUTER_SKIP_AFTER_MS = 5 * 60 * 1000;

function emptyNarration(): BriefingNarration {
  return { dayOverview: "", projects: [] };
}

function runDailyBriefingJob(): void {
  const config = getConfig();
  assertConfigReady(config);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    console.log("Anderer Briefing-Lauf ist aktiv. Dieser Lauf wird übersprungen.");
    return;
  }

  const runStartedMs = Date.now();
  try {
    try {
      installDailyTrigger(true);
    } catch (err) {
      console.error(`Trigger-Prüfung fehlgeschlagen: ${String(err)}`);
    }

    console.log(`Drive Digest Start - Root ${config.rootFolderId}`);

    const { data, pending } = scanRecentProjects(config, runStartedMs);
    console.log(
      `Aktivität: ${data.projects.length} Projekt(e), ${data.segments.length} Segment(e), Fenster ab ${data.windowStartIso}`,
    );

    let narration = emptyNarration();
    if (Date.now() > runStartedMs + OPENROUTER_SKIP_AFTER_MS) {
      console.warn("OpenRouter übersprungen wegen Zeitbudget.");
    } else {
      narration = summarizeProjectsWithOpenRouter(
        data,
        config.openRouterApiKey,
        config.openRouterModel,
      );
      if (
        !narration.dayOverview &&
        narration.projects.length === 0 &&
        (data.projects.length > 0 || data.segments.length > 0)
      ) {
        console.log(
          "OpenRouter-Zusammenfassung übersprungen oder fehlgeschlagen - HTML-Fallback.",
        );
      }
    }

    const mail = buildBriefingMail(
      data,
      narration,
      runStartedMs + THUMBNAIL_DEADLINE_MS,
    );
    sendBriefingEmail(config.recipients, data, mail);
    console.log(`Briefing gesendet an: ${config.recipients.join(", ")}`);

    commitBriefingState(pending);
    if (pending.lastSuccessfulRunAt) {
      console.log(`lastSuccessfulRunAt gesetzt: ${pending.lastSuccessfulRunAt}`);
    } else {
      console.log(
        "lastSuccessfulRunAt nicht verschoben (Scan unvollständig, nächster Lauf holt den Rest).",
      );
    }
  } finally {
    lock.releaseLock();
  }
}

function installDailyTrigger(quiet = false): void {
  const tz = Session.getScriptTimeZone() || "Etc/UTC";
  const handlers = ScriptApp.getProjectTriggers().filter(
    (trigger) => trigger.getHandlerFunction() === "runDailyBriefing",
  );

  if (handlers.length === 1) {
    if (!quiet) {
      console.log(
        `Täglicher Trigger für runDailyBriefing um 05:00 ${tz} ist bereits gesetzt.`,
      );
    }
    return;
  }

  handlers.forEach((trigger) => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger("runDailyBriefing")
    .timeBased()
    .atHour(5)
    .everyDays(1)
    .inTimezone(tz)
    .create();

  console.log(`Täglicher Trigger für runDailyBriefing um 05:00 ${tz} gesetzt.`);
}

/** Logs what the shared Script Properties resolve to (no mail). */
function showBriefingConfig(): void {
  const config = getConfig();
  const props = PropertiesService.getScriptProperties().getProperties();
  console.log("--- Briefing Config ---");
  console.log(`BRIEFING_RECIPIENTS raw: ${props.BRIEFING_RECIPIENTS || "(nicht gesetzt)"}`);
  console.log(`Empfänger parsed: ${config.recipients.join(", ") || "(leer)"}`);
  console.log(`ROOT_FOLDER_ID: ${config.rootFolderId}`);
  console.log(
    `OPENROUTER_API_KEY: ${config.openRouterApiKey ? "(gesetzt)" : "(leer)"}`,
  );
  console.log(`Läufer: ${Session.getActiveUser().getEmail() || "(unbekannt)"}`);
  console.log("Nur Script Properties zählen - User Properties werden ignoriert.");
}

// Apps Script's function dropdown only lists top-level `function` decls.
// build.js appends those wrappers; they call into this export bag.
(globalThis as any).__gasExports = {
  runDailyBriefing: runDailyBriefingJob,
  installDailyTrigger: () => installDailyTrigger(false),
  showBriefingConfig,
};
