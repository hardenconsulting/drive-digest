import { isDwgFile, summaryFor, typeLabel } from "./briefingLogic";
import { fetchThumbnailBlob } from "./driveService";
import type {
  BriefingData,
  BriefingFile,
  BriefingNarration,
  BriefingProject,
  FileChangeKind,
} from "./types";

const FONT = "system-ui,-apple-system,'Segoe UI',sans-serif";
const BLACK = "#000000";
const PANEL = "#121212";
const TEXT = "#f5f5f5";
const MUTED = "rgba(255,255,255,0.55)";
const HAIRLINE = "rgba(255,255,255,0.08)";
const RED = "#ef4444";
const RED_SOFT = "rgba(239,68,68,0.55)";
const RADIUS = "16px";
/** Change pills: green = neu, amber = geändert, grey = angesehen, red = gelöscht. */
const ADD_BG = "rgba(34,197,94,0.16)";
const ADD_FG = "#4ade80";
const ADD_BD = "rgba(34,197,94,0.35)";
const MOD_BG = "rgba(245,158,11,0.18)";
const MOD_FG = "#fbbf24";
const MOD_BD = "rgba(245,158,11,0.4)";
const VIEW_BG = "rgba(255,255,255,0.08)";
const VIEW_FG = "#a3a3a3";
const VIEW_BD = "rgba(255,255,255,0.08)";
const DEL_BG = "rgba(239,68,68,0.16)";
const DEL_FG = "#f87171";
const DEL_BD = "rgba(239,68,68,0.4)";
/** Eye mark for open-only files (HTML entity; Gmail-safe). */
const VIEW_MARK = "&#128065;";

/** Hero mesh: black + red radial glows (dark mail palette). */
const HEADER_BG = [
  "radial-gradient(ellipse 90% 70% at 18% 0%, rgba(239,68,68,0.38), transparent 58%)",
  "radial-gradient(ellipse 70% 55% at 88% 75%, rgba(185,28,28,0.28), transparent 60%)",
  "linear-gradient(180deg, #0a0a0a 0%, #000000 100%)",
].join(", ");

/** Dark project panel - soft red wash, no white. */
const CARD_BG = [
  "radial-gradient(ellipse 70% 45% at 100% 0%, rgba(239,68,68,0.14), transparent 65%)",
  "linear-gradient(180deg, #161616 0%, #101010 100%)",
].join(", ");

/** Full-bleed desktop stage: subtle grid + soft red ambience (no glass). */
const STAGE_BG = [
  "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px)",
  "linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)",
  "radial-gradient(ellipse 80% 50% at 50% -10%, rgba(239,68,68,0.16), transparent 55%)",
  "radial-gradient(ellipse 60% 40% at 90% 100%, rgba(185,28,28,0.1), transparent 50%)",
  "linear-gradient(180deg, #050505 0%, #000000 40%, #000000 100%)",
].join(", ");

const STAGE_BG_SIZE = "48px 48px, 48px 48px, auto, auto, auto";
const CONTENT_MAX = "760px";

export interface BriefingMailContent {
  html: string;
  text: string;
  inlineImages: { [cid: string]: GoogleAppsScript.Base.Blob };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Break digit runs so mail clients do not invent tel: links. */
function antiTel(value: string): string {
  return escapeHtml(value).replace(/\d/g, (digit) => `${digit}&#8203;`);
}

function scriptTz(): string {
  return Session.getScriptTimeZone() || "Etc/UTC";
}

function formatDigestDate(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Utilities.formatDate(d, scriptTz(), "d. MMM yyyy '·' HH:mm");
}

function allBriefingBlocks(data: BriefingData): BriefingProject[] {
  return [...data.projects, ...data.segments];
}

function collectPreviewFiles(data: BriefingData): BriefingFile[] {
  const files: BriefingFile[] = [];
  for (const project of allBriefingBlocks(data)) {
    for (const group of project.groups) {
      for (const file of group.files) {
        if (file.hasPreview && file.id) files.push(file);
      }
    }
  }
  return files;
}

function loadInlinePreviews(
  data: BriefingData,
  thumbnailDeadlineMs?: number,
): {
  cidByFileId: Map<string, string>;
  inlineImages: { [cid: string]: GoogleAppsScript.Base.Blob };
} {
  const cidByFileId = new Map<string, string>();
  const inlineImages: { [cid: string]: GoogleAppsScript.Base.Blob } = {};
  let index = 0;
  let skipped = 0;

  for (const file of collectPreviewFiles(data)) {
    if (thumbnailDeadlineMs && Date.now() > thumbnailDeadlineMs) {
      skipped += 1;
      continue;
    }
    const blob = fetchThumbnailBlob(file.id);
    if (!blob) continue;
    const cid = `preview${index}`;
    index += 1;
    cidByFileId.set(file.id, cid);
    inlineImages[cid] = blob;
  }

  if (skipped > 0) {
    console.warn(`Previews übersprungen wegen Zeitbudget: ${skipped}`);
  }

  return { cidByFileId, inlineImages };
}

function renderHeader(day: string, introText: string): string {
  return [
    `<tr><td style="padding:0 0 18px;border-radius:${RADIUS};background:${BLACK};background-image:${HEADER_BG}">`,
    `<div style="padding:28px 24px 24px">`,
    `<div style="font-size:11px;letter-spacing:0.2em;font-weight:700;color:rgba(255,255,255,0.85)">DRIVE DIGEST</div>`,
    `<div class="briefing-title" style="font-size:26px;font-weight:800;letter-spacing:-0.02em;color:#ffffff;margin:10px 0 0;line-height:1.15">Drive Digest</div>`,
    `<div style="font-size:13px;color:rgba(255,255,255,0.7);margin:10px 0 16px;line-height:1.5">${antiTel(day)}</div>`,
    `<div style="height:1px;width:96px;background:${RED_SOFT};border-radius:1px"></div>`,
    `<div style="font-size:14px;line-height:1.55;color:rgba(255,255,255,0.72);margin:18px 0 0">${antiTel(introText)}</div>`,
    `</div>`,
    `</td></tr>`,
  ].join("");
}

function formatAiHtml(text: string): string {
  return antiTel(text).replace(/\n/g, "<br>");
}

function renderAiBlock(text: string): string {
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 14px">`,
    `<tr>`,
    `<td width="4" style="width:4px;background:${RED};border-radius:2px;font-size:0;line-height:0">&nbsp;</td>`,
    `<td style="padding:2px 0 2px 14px;font-size:15px;line-height:1.55;color:rgba(255,255,255,0.88);font-weight:500">`,
    formatAiHtml(text),
    `</td>`,
    `</tr>`,
    `</table>`,
  ].join("");
}

function renderNamePill(
  file: BriefingFile,
  kind: "added" | "modified" | "viewed" | "deleted",
): string {
  const style =
    kind === "added"
      ? { bg: ADD_BG, fg: ADD_FG, bd: ADD_BD, mark: "+" }
      : kind === "modified"
        ? { bg: MOD_BG, fg: MOD_FG, bd: MOD_BD, mark: "~" }
        : kind === "viewed"
          ? { bg: VIEW_BG, fg: VIEW_FG, bd: VIEW_BD, mark: VIEW_MARK }
          : { bg: DEL_BG, fg: DEL_FG, bd: DEL_BD, mark: "−" };
  return [
    `<a href="${escapeHtml(file.webViewLink)}" style="display:inline-block;text-decoration:none;margin:0 6px 6px 0">`,
    `<span style="display:inline-block;padding:4px 9px;border-radius:6px;background:${style.bg};border:1px solid ${style.bd};color:${style.fg};font-size:12px;font-weight:600;line-height:1.3;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">`,
    `<span style="opacity:0.85;margin-right:4px">${style.mark}</span>${antiTel(file.name)}`,
    `</span>`,
    `</a>`,
  ].join("");
}

function renderChangeColumn(
  title: string,
  files: BriefingFile[],
  kind: "added" | "modified" | "viewed" | "deleted",
): string {
  if (files.length === 0) return "";
  const pills = files.map((f) => renderNamePill(f, kind)).join("");
  const titleColor =
    kind === "added"
      ? ADD_FG
      : kind === "modified"
        ? MOD_FG
        : kind === "viewed"
          ? VIEW_FG
          : DEL_FG;
  return [
    `<div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${titleColor};margin:0 0 8px">${escapeHtml(title)}</div>`,
    `<div>${pills}</div>`,
  ].join("");
}

/** Programmatic Neu / Geändert / Angesehen / Gelöscht; AI never lists names. */
function renderChangeDiff(project: BriefingProject): string {
  const files = project.groups.flatMap((g) => g.files);
  const added = files.filter((f) => f.changeKind === "added");
  const modified = files.filter((f) => f.changeKind === "modified");
  const viewed = files.filter((f) => f.changeKind === "viewed");
  const deleted = files.filter((f) => f.changeKind === "deleted");
  if (
    added.length === 0 &&
    modified.length === 0 &&
    viewed.length === 0 &&
    deleted.length === 0
  ) {
    return "";
  }

  const neu = renderChangeColumn("Neu", added, "added");
  const geaendert = renderChangeColumn("Geändert", modified, "modified");
  const angesehen = renderChangeColumn("Angesehen", viewed, "viewed");
  const geloescht = renderChangeColumn("Gelöscht", deleted, "deleted");

  const topRow =
    neu && geaendert
      ? [
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 10px">`,
          `<tr>`,
          `<td width="50%" valign="top" style="width:50%;padding:0 10px 0 0">${neu}</td>`,
          `<td width="50%" valign="top" style="width:50%;padding:0 0 0 10px">${geaendert}</td>`,
          `</tr>`,
          `</table>`,
        ].join("")
      : neu || geaendert
        ? `<div style="margin:0 0 10px">${neu || geaendert}</div>`
        : "";

  const viewBlock = angesehen
    ? `<div style="margin:0 0 10px">${angesehen}</div>`
    : "";

  const delBlock = geloescht
    ? `<div style="margin:0 0 16px">${geloescht}</div>`
    : "";

  return (
    `${topRow}${viewBlock}${delBlock}` ||
    `<div style="margin:0 0 16px"></div>`
  );
}

function renderDayOverview(text: string): string {
  if (!text.trim()) return "";
  return [
    `<tr><td style="padding:0 0 18px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" `,
    `style="width:100%;border-radius:${RADIUS};border:1px solid ${HAIRLINE};background:${PANEL};background-image:${CARD_BG}">`,
    `<tr><td style="padding:20px 20px 18px">`,
    `<div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${MUTED};margin:0 0 12px">Tagesüberblick</div>`,
    renderAiBlock(text),
    `</td></tr></table>`,
    `</td></tr>`,
  ].join("");
}

function chunkPairs<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) {
    rows.push(items.slice(i, i + 2));
  }
  return rows;
}

function previewMedia(file: BriefingFile, cid?: string): string {
  const label = typeLabel(file.mimeType);
  if (cid) {
    return [
      `<img src="cid:${cid}" alt="" width="340" height="150" `,
      `style="display:block;width:100%;max-width:100%;height:150px;object-fit:cover;border-radius:12px;background:#1a1a1a;border:0" />`,
    ].join("");
  }

  const badgeBg = label === "PDF" ? RED : "#2a2a2a";
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" `,
    `style="width:100%;height:150px;border-radius:12px;background:#1a1a1a">`,
    `<tr><td align="center" valign="middle" style="height:150px;border-radius:12px">`,
    `<span style="display:inline-block;padding:6px 10px;border-radius:6px;background:${badgeBg};color:#ffffff;font-size:10px;font-weight:700;letter-spacing:0.06em">${escapeHtml(label)}</span>`,
    `</td></tr></table>`,
  ].join("");
}

/** Tile: preview on top, meta underneath (for 2-col grid). */
function renderFileTile(file: BriefingFile, cid?: string): string {
  const dateLabel = formatDigestDate(file.modifiedTime);
  const label = typeLabel(file.mimeType);
  const badgeStyle =
    label === "PDF"
      ? `background:${RED};color:#ffffff`
      : `background:#2a2a2a;color:#ffffff`;

  return [
    `<a href="${escapeHtml(file.webViewLink)}" style="display:block;text-decoration:none;color:${TEXT}">`,
    previewMedia(file, cid),
    `<div style="padding:8px 2px 0">`,
    `<div style="font-size:13px;font-weight:600;line-height:1.3;color:${TEXT};margin:0 0 3px;word-break:break-word">${antiTel(file.name)}</div>`,
    `<div style="font-size:10px;color:${MUTED};margin:0 0 5px">${antiTel(dateLabel)}</div>`,
    `<span style="display:inline-block;padding:2px 7px;border-radius:5px;font-size:9px;font-weight:700;letter-spacing:0.05em;${badgeStyle}">${escapeHtml(label)}</span>`,
    `</div>`,
    `</a>`,
  ].join("");
}

function renderFileGrid(
  files: BriefingFile[],
  cidByFileId: Map<string, string>,
): string {
  if (files.length === 0) return "";

  const rows = chunkPairs(files)
    .map((pair) => {
      const cells = [0, 1]
        .map((i) => {
          const file = pair[i];
          const pad =
            i === 0
              ? "padding:0 8px 14px 0"
              : "padding:0 0 14px 8px";
          if (!file) {
            return `<td width="50%" valign="top" style="width:50%;${pad}">&nbsp;</td>`;
          }
          return [
            `<td width="50%" valign="top" style="width:50%;${pad}">`,
            renderFileTile(file, cidByFileId.get(file.id)),
            `</td>`,
          ].join("");
        })
        .join("");

      return `<tr>${cells}</tr>`;
    })
    .join("");

  return [
    `<table role="presentation" class="file-grid" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:4px 0 0">`,
    rows,
    `</table>`,
  ].join("");
}

function renderDwgCard(file: BriefingFile): string {
  const dateLabel = formatDigestDate(file.modifiedTime);
  return [
    `<a href="${escapeHtml(file.webViewLink)}" style="display:block;text-decoration:none;color:${TEXT};margin:0">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-bottom:1px solid ${HAIRLINE}">`,
    `<tr>`,
    `<td style="padding:12px 0">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`,
    `<td width="52" valign="middle" style="width:52px;padding:0 12px 0 0">`,
    `<span style="display:inline-block;padding:4px 8px;border-radius:6px;background:#2a2a2a;color:#ffffff;font-size:10px;font-weight:700;letter-spacing:0.08em">DWG</span>`,
    `</td>`,
    `<td valign="middle">`,
    `<div style="font-size:14px;font-weight:600;line-height:1.35;color:${TEXT};margin:0 0 3px">${antiTel(file.name)}</div>`,
    `<div style="font-size:11px;color:${MUTED}">${antiTel(dateLabel)}</div>`,
    `</td>`,
    `</tr></table>`,
    `</td>`,
    `</tr>`,
    `</table>`,
    `</a>`,
  ].join("");
}

function renderDwgBand(files: BriefingFile[]): string {
  if (files.length === 0) return "";
  const cards = files.map(renderDwgCard).join("");
  return [
    `<div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};margin:18px 0 4px">CAD / DWG</div>`,
    cards,
  ].join("");
}

function shellOpen(): string {
  return [
    `<!DOCTYPE html><html><head>`,
    `<meta name="format-detection" content="telephone=no,address=no,email=no">`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="color-scheme" content="dark">`,
    `<meta name="supported-color-schemes" content="dark">`,
    `<style type="text/css">`,
    `:root { color-scheme: dark; }`,
    `body, .stage { margin:0 !important; padding:0 !important; background-color:${BLACK} !important; }`,
    `.stage {`,
    `  background-color:${BLACK};`,
    `  background-image:${STAGE_BG};`,
    `  background-size:${STAGE_BG_SIZE};`,
    `  background-position:0 0, 0 0, center top, right bottom, center;`,
    `  background-repeat:repeat, repeat, no-repeat, no-repeat, no-repeat;`,
    `}`,
    `.stage-pad { padding:40px 28px 48px !important; }`,
    `.content { max-width:${CONTENT_MAX} !important; width:100% !important; }`,
    `@media only screen and (max-width: 620px) {`,
    `  .stage-pad { padding:20px 12px 28px !important; }`,
    `  .content { max-width:100% !important; }`,
    `  .briefing-title { font-size:22px !important; }`,
    `  /* Keep 2-col grid; tighter gutters only */`,
    `  .file-grid td { padding-left:4px !important; padding-right:4px !important; }`,
    `}`,
    `@media only screen and (min-width: 900px) {`,
    `  .stage-pad { padding:48px 40px 56px !important; }`,
    `  .content { max-width:820px !important; }`,
    `}`,
    `</style>`,
    `</head>`,
    `<body style="margin:0;padding:0;background-color:${BLACK};background-image:${STAGE_BG};background-size:${STAGE_BG_SIZE}">`,
    `<table role="presentation" class="stage" width="100%" cellpadding="0" cellspacing="0" border="0" `,
    `style="width:100%;background-color:${BLACK};background-image:${STAGE_BG};background-size:${STAGE_BG_SIZE}">`,
    `<tr><td class="stage-pad" align="center" style="padding:40px 24px 48px">`,
    `<table role="presentation" class="content" width="100%" cellpadding="0" cellspacing="0" border="0" `,
    `style="max-width:${CONTENT_MAX};width:100%;font-family:${FONT}">`,
  ].join("");
}

function shellClose(): string {
  return [
    `<tr><td style="padding:20px 8px 0;font-size:11px;color:rgba(255,255,255,0.35);line-height:1.4;text-align:center">`,
    `Dateien öffnen in Google Drive.`,
    `</td></tr>`,
    `</table></td></tr></table>`,
    `</body></html>`,
  ].join("");
}

function windowPhrase(data: BriefingData): string {
  if (data.usedFallbackWindow) {
    return `in den letzten ${data.windowHours} Stunden`;
  }
  return `seit ${formatDigestDate(data.windowStartIso)}`;
}

function limitNotes(data: BriefingData): string {
  const notes: string[] = [];
  if (data.partialScan) {
    notes.push(
      "Hinweis: Scan unvollständig wegen Zeitlimit. Der nächste Lauf holt den Rest nach.",
    );
  }
  return notes.join(" ");
}

function changeLabel(kind: FileChangeKind): string {
  if (kind === "added") return "Neu";
  if (kind === "modified") return "Geändert";
  if (kind === "viewed") return "Angesehen";
  return "Gelöscht";
}

function buildPlainText(
  data: BriefingData,
  narration: BriefingNarration,
  day: string,
): string {
  const lines: string[] = [`Drive Digest - ${day}`, ""];
  if (narration.dayOverview.trim()) {
    lines.push(narration.dayOverview.trim(), "");
  }

  const blocks = allBriefingBlocks(data);
  if (blocks.length === 0) {
    lines.push(`Keine Aktivität ${windowPhrase(data)} im Scan-Ordner.`);
  } else {
    const parts = [
      data.projects.length ? `${data.projects.length} Projekt(e)` : null,
      data.segments.length ? `${data.segments.length} Segment(e)` : null,
    ].filter(Boolean);
    lines.push(`${parts.join(", ")} mit Aktivität ${windowPhrase(data)}.`, "");
    for (const project of blocks) {
      lines.push(project.name);
      const summary = summaryFor(project, narration.projects);
      if (summary) lines.push(summary);
      for (const file of project.groups.flatMap((group) => group.files)) {
        lines.push(`- ${changeLabel(file.changeKind)}: ${file.name}`);
        lines.push(`  ${file.webViewLink}`);
      }
      lines.push("");
    }
  }

  const notes = limitNotes(data);
  if (notes) lines.push(notes, "");
  lines.push("Dateien öffnen in Google Drive.");
  return lines.join("\n");
}

function renderEmptyState(data: BriefingData, day: string): string {
  const notes = limitNotes(data);
  const text = `Keine Aktivität ${windowPhrase(data)} im Scan-Ordner.${notes ? ` ${notes}` : ""}`;
  return [shellOpen(), renderHeader(day, text), shellClose()].join("");
}

export function buildBriefingMail(
  data: BriefingData,
  narration: BriefingNarration,
  thumbnailDeadlineMs?: number,
): BriefingMailContent {
  const day = Utilities.formatDate(
    new Date(data.generatedAt),
    scriptTz(),
    "d. MMM yyyy",
  );
  const text = buildPlainText(data, narration, day);

  const blocks = allBriefingBlocks(data);
  if (blocks.length === 0) {
    return { html: renderEmptyState(data, day), inlineImages: {}, text };
  }

  const { cidByFileId, inlineImages } = loadInlinePreviews(data, thumbnailDeadlineMs);
  console.log(`Inline-Previews geladen: ${Object.keys(inlineImages).length}`);

  const sections = blocks
    .map((project) => {
      const ai = summaryFor(project, narration.projects);
      const dwgFiles = project.groups
        .flatMap((g) => g.files)
        .filter(
          (f) =>
            isDwgFile(f) &&
            f.changeKind !== "deleted" &&
            f.changeKind !== "viewed",
        );

      const groupsHtml = project.groups
        .map((group) => {
          const regular = group.files.filter(
            (f) =>
              !isDwgFile(f) &&
              f.changeKind !== "deleted" &&
              f.changeKind !== "viewed",
          );
          if (regular.length === 0) return "";
          return [
            `<div style="display:inline-block;margin:16px 0 8px;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,0.06);border:1px solid ${HAIRLINE};font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED}">${antiTel(group.folderName)}</div>`,
            renderFileGrid(regular, cidByFileId),
          ].join("");
        })
        .join("");

      const eyebrow =
        project.segmentKind === "segment"
          ? `<div style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${RED_SOFT};margin:0 0 8px">Segment</div>`
          : "";

      return [
        `<tr><td style="padding:0 0 14px">`,
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" `,
        `style="width:100%;border-radius:${RADIUS};border:1px solid ${HAIRLINE};background:${PANEL};background-image:${CARD_BG}">`,
        `<tr><td style="padding:22px 20px 14px">`,
        eyebrow,
        `<div style="font-size:20px;font-weight:800;letter-spacing:-0.02em;color:${TEXT};margin:0 0 12px;line-height:1.2">${antiTel(project.name)}</div>`,
        ai ? renderAiBlock(ai) : "",
        renderChangeDiff(project),
        groupsHtml,
        renderDwgBand(dwgFiles),
        `</td></tr>`,
        `</table>`,
        `</td></tr>`,
      ].join("");
    })
    .join("");

  const introParts = [
    data.projects.length
      ? `${data.projects.length} Projekt(e)`
      : null,
    data.segments.length
      ? `${data.segments.length} Segment(e)`
      : null,
  ].filter(Boolean);
  const notes = limitNotes(data);
  const intro = `${introParts.join(", ")} mit Aktivität ${windowPhrase(data)}.${notes ? ` ${notes}` : ""}`;

  const html = [
    shellOpen(),
    renderHeader(day, intro),
    renderDayOverview(narration.dayOverview),
    sections,
    shellClose(),
  ].join("");

  return { html, inlineImages, text };
}

export function sendBriefingEmail(
  recipients: string[],
  data: BriefingData,
  mail: BriefingMailContent,
): void {
  if (recipients.length === 0) {
    throw new Error(
      "BRIEFING_RECIPIENTS ist leer. Bitte Script Properties setzen.",
    );
  }

  const day = Utilities.formatDate(
    new Date(data.generatedAt),
    scriptTz(),
    "yyyy-MM-dd",
  );

  const options: GoogleAppsScript.Gmail.GmailAdvancedOptions = {
    htmlBody: mail.html,
    name: "Drive Digest",
  };

  if (Object.keys(mail.inlineImages).length > 0) {
    options.inlineImages = mail.inlineImages;
  }

  const plain = mail.text.trim() || "Drive Digest";
  GmailApp.sendEmail(
    recipients.join(","),
    `Drive Digest - ${day}`,
    plain,
    options,
  );
}
