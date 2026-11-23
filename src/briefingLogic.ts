import type {
  BriefingFile,
  BriefingProject,
  BriefingNarration,
  FileChangeKind,
  ProjectSummary,
} from "./types";

/** Script Property written only after a successful send. */
export const LAST_SUCCESSFUL_RUN_PROP = "lastSuccessfulRunAt";
export const SCAN_OFFSET_PROP = "BRIEFING_SCAN_OFFSET";
export const CYCLE_STARTED_PROP = "BRIEFING_CYCLE_STARTED_AT";
export const CYCLE_SEEN_PROP = "BRIEFING_CYCLE_SEEN";
export const CHANGES_TOKEN_PROP = "DRIVE_CHANGES_PAGE_TOKEN";
export const LEGACY_INVENTORY_PROP = "BRIEFING_INVENTORY_V1";
export const INVENTORY_PREFIX = "BRIEFING_INV_";
/** Id of the hidden Drive app-data file. The inventories themselves are not in properties. */
export const INVENTORY_FILE_ID_PROP = "BRIEFING_INVENTORY_FILE_ID";
export const INVENTORY_FILE_NAME = "drive-digest-inventory.json";

/** Apps Script allows about 9KB per value. Stay under that in UTF-8 bytes. */
export const PROPERTY_VALUE_MAX_BYTES = 8500;
/** Apps Script allows about 500KB for the whole properties store. */
export const PROPERTY_STORE_MAX_BYTES = 450_000;

/** Leave room for OpenRouter, thumbnails, and Gmail before the 6-minute limit. */
export const SCAN_BUDGET_MS = 3.5 * 60 * 1000;
export const THUMBNAIL_DEADLINE_MS = 5.25 * 60 * 1000;

export interface InventoryItem {
  id: string;
  name: string;
  mimeType: string;
  projectId: string;
  projectName: string;
  parentFolderId: string;
  parentFolderName: string;
}

export interface RawDriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  webViewLink?: string;
  createdTime?: string;
  modifiedTime?: string;
  viewedByMeTime?: string;
  trashedTime?: string;
}

/** UTF-8 size without TextEncoder (not in the Apps Script TS lib). */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function inventoryKey(projectId: string): string {
  return `${INVENTORY_PREFIX}${projectId}`;
}

export function inventoryChunkKey(projectId: string, gen: string, index: number): string {
  return `${inventoryKey(projectId)}_${gen}_${index}`;
}

export function isInventoryKeyForProject(projectId: string, key: string): boolean {
  if (key === inventoryKey(projectId)) return true;
  const prefix = `${inventoryKey(projectId)}_`;
  if (!key.startsWith(prefix)) return false;
  return /^[0-9a-z]+_\d+$/i.test(key.slice(prefix.length));
}

export function resolveWindowStart(
  stored: string | null | undefined,
  nowMs: number,
  fallbackHours: number,
): { startIso: string; usedFallback: boolean } {
  if (stored && stored.trim()) {
    const parsed = Date.parse(stored.trim());
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= nowMs) {
      return { startIso: new Date(parsed).toISOString(), usedFallback: false };
    }
  }
  const hours = fallbackHours > 0 ? fallbackHours : 24;
  return {
    startIso: new Date(nowMs - hours * 60 * 60 * 1000).toISOString(),
    usedFallback: true,
  };
}

export function elapsedWindowHours(
  startIso: string,
  nowMs: number,
  fallbackHours: number,
  usedFallback: boolean,
): number {
  if (usedFallback) return fallbackHours > 0 ? fallbackHours : 24;
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return fallbackHours > 0 ? fallbackHours : 24;
  return Math.max(1, Math.ceil((nowMs - start) / (60 * 60 * 1000)));
}

export function shouldRetryHttpStatus(code: number): boolean {
  return code === 408 || code === 429 || (code >= 500 && code <= 599);
}

export function isRetryableMessage(message: string): boolean {
  if (/\b408\b/.test(message) || /\b429\b/.test(message) || /\b5\d\d\b/.test(message)) {
    return true;
  }
  return /rate limit|quota exceeded|backend error|internal error|service unavailable|timed out|timeout|try again/i.test(
    message,
  );
}

export function retryBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = 400 * 2 ** attempt;
  const jitter = Math.floor(random() * 250);
  return Math.min(8000, base + jitter);
}

export function typeLabel(mimeType: string): string {
  const mime = mimeType.toLowerCase();
  if (mime === "application/pdf") return "PDF";
  if (mime === "image/vnd.dwg" || mime.includes("dwg")) return "DWG";
  if (mime.startsWith("image/")) return "Bild";
  if (mime.includes("word")) return "DOC";
  if (mime.includes("sheet") || mime.includes("excel")) return "Tabelle";
  return "Datei";
}

export function isDwgFile(file: Pick<BriefingFile, "mimeType" | "name">): boolean {
  return file.mimeType.toLowerCase().includes("dwg") || /\.dwg$/i.test(file.name);
}

export function classifyChange(
  createdTime: string,
  modifiedTime: string,
  windowStartIso: string,
): "added" | "modified" | "viewed" {
  if (createdTime && createdTime > windowStartIso) return "added";
  if (modifiedTime && modifiedTime > windowStartIso) return "modified";
  return "viewed";
}

export function toBriefingFile(
  file: RawDriveFile,
  parentFolderId: string,
  parentFolderName: string,
  windowStartIso: string,
  changeKind?: FileChangeKind,
): BriefingFile {
  const id = file.id || "";
  const mimeType = file.mimeType || "application/octet-stream";
  const createdTime = file.createdTime || "";
  const modifiedTime = file.modifiedTime || "";
  const kind =
    changeKind || classifyChange(createdTime, modifiedTime, windowStartIso);
  const whenDeleted = file.trashedTime || modifiedTime || createdTime || "";
  const activityTime =
    kind === "deleted"
      ? whenDeleted
      : kind === "viewed"
        ? file.viewedByMeTime || modifiedTime || createdTime || ""
        : modifiedTime || createdTime || "";
  return {
    id,
    name: file.name || "(ohne Namen)",
    mimeType,
    webViewLink: file.webViewLink || `https://drive.google.com/file/d/${id}/view`,
    createdTime,
    modifiedTime: activityTime,
    parentFolderId,
    parentFolderName,
    hasPreview:
      kind === "deleted" || kind === "viewed" ? false : hasPreviewMime(mimeType),
    changeKind: kind,
  };
}

function hasPreviewMime(mimeType: string): boolean {
  if (mimeType === "application/pdf") return true;
  if (!mimeType.startsWith("image/")) return false;
  if (mimeType.includes("dwg")) return false;
  return true;
}

export function sortByModifiedDesc(files: BriefingFile[]): BriefingFile[] {
  return [...files].sort((a, b) =>
    (b.modifiedTime || "").localeCompare(a.modifiedTime || ""),
  );
}

/**
 * Newest record wins. Real changes beat open-only views; a live file beats an
 * older deletion for the same id (stale trash/change while the file is live).
 */
export function mergeFiles(files: BriefingFile[]): BriefingFile[] {
  const byId = new Map<string, BriefingFile>();
  for (const file of sortByModifiedDesc(files)) {
    const existing = byId.get(file.id);
    if (!existing) {
      byId.set(file.id, file);
      continue;
    }
    if (existing.changeKind === "viewed" && file.changeKind !== "viewed") {
      byId.set(file.id, file);
      continue;
    }
    if (file.changeKind === "viewed" && existing.changeKind !== "viewed") {
      continue;
    }
    if (existing.changeKind === "deleted" && file.changeKind !== "deleted") {
      byId.set(file.id, file);
    }
  }
  return [...byId.values()];
}

export function deletedFromSnapshot(
  previous: InventoryItem[],
  liveIds: Set<string>,
  projectId: string,
  windowStartIso: string,
  nowIso: string,
): BriefingFile[] {
  return previous
    .filter((item) => item.projectId === projectId && item.id && !liveIds.has(item.id))
    .map((item) =>
      toBriefingFile(
        {
          id: item.id,
          name: item.name,
          mimeType: item.mimeType,
          modifiedTime: nowIso,
          createdTime: "",
          webViewLink: `https://drive.google.com/file/d/${item.id}/view`,
        },
        item.parentFolderId,
        item.parentFolderName || "Dateien",
        windowStartIso,
        "deleted",
      ),
    );
}

/** Ids still present. Used when the full snapshot does not fit, so deletions are not reported again. */
export function inventoryKeepingSurvivors(
  previous: InventoryItem[],
  liveIds: Set<string>,
): InventoryItem[] {
  return previous.filter((item) => liveIds.has(item.id));
}

export function shrinkInventoryItems(
  items: InventoryItem[],
  nameLimit: number,
  parentLimit: number,
): InventoryItem[] {
  return items.map((item) => ({
    ...item,
    name: item.name.slice(0, nameLimit),
    parentFolderName: item.parentFolderName.slice(0, parentLimit),
    mimeType: item.mimeType.slice(0, 80),
    projectName: item.projectName.slice(0, 120),
  }));
}

interface InventoryChunk {
  v: 2;
  items: string[][];
}

interface InventoryManifest {
  v: 2;
  /** Chunk generation. Old generations stay readable until the manifest flips. */
  gen: string;
  chunks: number;
  projectName?: string;
}

export function encodeChunk(items: InventoryItem[]): string {
  const payload: InventoryChunk = {
    v: 2,
    items: items.map((item) => [
      item.id,
      item.name,
      item.mimeType,
      item.parentFolderId,
      item.parentFolderName,
    ]),
  };
  return JSON.stringify(payload);
}

export function encodeManifest(chunkCount: number, projectName: string, gen: string): string {
  const payload: InventoryManifest = {
    v: 2,
    gen,
    chunks: chunkCount,
    projectName: projectName.slice(0, 200),
  };
  return JSON.stringify(payload);
}

function fitSingleItem(item: InventoryItem, maxBytes: number): InventoryItem {
  if (utf8ByteLength(encodeChunk([item])) <= maxBytes) return item;
  let lo = 0;
  let hi = item.name.length;
  let best: InventoryItem = { ...item, name: "" };
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const trial = { ...item, name: item.name.slice(0, mid) };
    if (utf8ByteLength(encodeChunk([trial])) <= maxBytes) {
      best = trial;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (utf8ByteLength(encodeChunk([best])) <= maxBytes) return best;
  const minimal: InventoryItem = {
    ...best,
    name: best.name.slice(0, 24),
    mimeType: "application/octet-stream",
    parentFolderName: "",
    projectName: "",
  };
  if (utf8ByteLength(encodeChunk([minimal])) <= maxBytes) return minimal;
  throw new Error("Inventar-Eintrag größer als ein Script-Property");
}

export function splitInventoryChunks(items: InventoryItem[], maxBytes: number): string[] {
  const chunks: string[] = [];
  let batch: InventoryItem[] = [];

  const flush = (): void => {
    if (batch.length === 0) return;
    chunks.push(encodeChunk(batch));
    batch = [];
  };

  for (const raw of items) {
    const item = fitSingleItem(raw, maxBytes);
    if (batch.length === 0) {
      batch.push(item);
      continue;
    }
    const trial = encodeChunk([...batch, item]);
    if (utf8ByteLength(trial) <= maxBytes) {
      batch.push(item);
      continue;
    }
    flush();
    batch.push(item);
  }
  flush();
  return chunks;
}

function asManifest(value: unknown): InventoryManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<InventoryManifest>;
  if (record.v !== 2 || typeof record.chunks !== "number" || record.chunks < 0) return null;
  if (!Number.isInteger(record.chunks)) return null;
  if (typeof record.gen !== "string" || !record.gen) return null;
  return {
    v: 2,
    gen: record.gen,
    chunks: record.chunks,
    projectName: typeof record.projectName === "string" ? record.projectName : "",
  };
}

function coerceLegacyItem(
  value: unknown,
  fallback: { projectId: string; projectName: string },
): InventoryItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<InventoryItem>;
  const id = String(record.id || "");
  if (!id) return null;
  return {
    id,
    name: String(record.name || "(ohne Namen)"),
    mimeType: String(record.mimeType || "application/octet-stream"),
    projectId: String(record.projectId || fallback.projectId),
    projectName: String(record.projectName || fallback.projectName),
    parentFolderId: String(record.parentFolderId || fallback.projectId),
    parentFolderName: String(record.parentFolderName || "Dateien"),
  };
}

export function decodeInventoryRecord(
  main: string | null | undefined,
  readKey: (key: string) => string | null | undefined,
  fallback: { projectId: string; projectName: string },
): InventoryItem[] {
  if (!main || !main.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(main);
  } catch {
    return [];
  }

  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => coerceLegacyItem(item, fallback))
      .filter((item): item is InventoryItem => item !== null);
  }

  const manifest = asManifest(parsed);
  if (!manifest) return [];

  const projectName = manifest.projectName || fallback.projectName;
  const items: InventoryItem[] = [];
  for (let index = 0; index < manifest.chunks; index += 1) {
    const raw = readKey(inventoryChunkKey(fallback.projectId, manifest.gen, index));
    if (!raw) continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(raw);
    } catch {
      continue;
    }
    const rows =
      chunk && typeof chunk === "object" && Array.isArray((chunk as InventoryChunk).items)
        ? (chunk as InventoryChunk).items
        : [];
    for (const row of rows) {
      if (!Array.isArray(row) || !row[0]) continue;
      items.push({
        id: String(row[0]),
        name: String(row[1] || "(ohne Namen)"),
        mimeType: String(row[2] || "application/octet-stream"),
        parentFolderId: String(row[3] || fallback.projectId),
        parentFolderName: String(row[4] || "Dateien"),
        projectId: fallback.projectId,
        projectName,
      });
    }
  }
  return items;
}

export interface InventoryFileProject {
  projectId: string;
  projectName: string;
  items: InventoryItem[];
}

/** One JSON document for every project. Drive app data has no 9KB value cap. */
export function encodeInventoryFile(projects: InventoryFileProject[]): string {
  const payload: {
    v: 1;
    projects: Record<string, { projectName: string; items: string[][] }>;
  } = { v: 1, projects: {} };
  for (const project of projects) {
    payload.projects[project.projectId] = {
      projectName: project.projectName.slice(0, 200),
      items: project.items.map((item) => [
        item.id,
        item.name,
        item.mimeType,
        item.parentFolderId,
        item.parentFolderName,
      ]),
    };
  }
  return JSON.stringify(payload);
}

export function decodeInventoryFile(raw: string): InventoryFileProject[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as { v?: unknown; projects?: unknown };
  if (record.v !== 1 || !record.projects || typeof record.projects !== "object") return null;
  const projects: InventoryFileProject[] = [];
  for (const [projectId, value] of Object.entries(record.projects as Record<string, unknown>)) {
    if (!projectId || !value || typeof value !== "object") continue;
    const project = value as { projectName?: unknown; items?: unknown };
    const projectName = String(project.projectName || "");
    const items: InventoryItem[] = [];
    if (Array.isArray(project.items)) {
      for (const row of project.items) {
        if (!Array.isArray(row) || !row[0]) continue;
        items.push({
          id: String(row[0]),
          name: String(row[1] || "(ohne Namen)"),
          mimeType: String(row[2] || "application/octet-stream"),
          parentFolderId: String(row[3] || projectId),
          parentFolderName: String(row[4] || "Dateien"),
          projectId,
          projectName,
        });
      }
    }
    projects.push({ projectId, projectName, items });
  }
  return projects;
}

export function inventoryGeneration(main: string | null | undefined): string | null {
  if (!main) return null;
  try {
    const manifest = asManifest(JSON.parse(main));
    return manifest ? manifest.gen : null;
  } catch {
    return null;
  }
}

export function propertiesByteSize(entries: Record<string, string>): number {
  let total = 0;
  for (const [key, value] of Object.entries(entries)) {
    total += utf8ByteLength(key) + utf8ByteLength(value);
  }
  return total;
}

export function projectedInventoryBytes(
  existing: Record<string, string>,
  projectId: string,
  manifest: string,
  chunks: string[],
  gen: string,
): number {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (!isInventoryKeyForProject(projectId, key)) next[key] = value;
  }
  next[inventoryKey(projectId)] = manifest;
  chunks.forEach((chunk, index) => {
    next[inventoryChunkKey(projectId, gen, index)] = chunk;
  });
  return propertiesByteSize(next);
}

/** Newest activity first. Every project and every file stays in the mail. */
export function sortBriefingBlocks(
  projects: BriefingProject[],
  segments: BriefingProject[],
): { projects: BriefingProject[]; segments: BriefingProject[] } {
  const byActivity = (a: BriefingProject, b: BriefingProject): number =>
    (b.latestActivity || "").localeCompare(a.latestActivity || "");
  return {
    projects: [...projects].sort(byActivity),
    segments: [...segments].sort(byActivity),
  };
}

export interface ScanProgressInput {
  orderedIds: string[];
  startOffset: number;
  visitedIds: string[];
  previousSeen: string[];
  previousCycleStartedAt: string | null;
  runStartedAt: string;
  /** Root walk or changes feed did not finish. */
  incomplete: boolean;
  /**
   * When false (changes feed unfinished), do not move lastSuccessfulRunAt
   * even if every current root was visited across the cycle.
   */
  allowCycleAdvance: boolean;
}

export interface ScanProgress {
  lastSuccessfulRunAt?: string;
  scanOffset: number;
  cycleStartedAt: string | null;
  cycleSeen: string[] | null;
}

export function planScanProgress(input: ScanProgressInput): ScanProgress {
  const total = input.orderedIds.length;
  if (!input.incomplete) {
    return {
      lastSuccessfulRunAt: input.runStartedAt,
      scanOffset: 0,
      cycleStartedAt: null,
      cycleSeen: null,
    };
  }
  if (total === 0) {
    return {
      scanOffset: 0,
      cycleStartedAt: null,
      cycleSeen: null,
    };
  }

  const offset = ((input.startOffset % total) + total) % total;
  const seen = new Set<string>([...input.previousSeen, ...input.visitedIds]);
  const covered = input.orderedIds.every((id) => seen.has(id));
  const nextOffset = (offset + input.visitedIds.length) % total;
  const relevantSeen = input.orderedIds.filter((id) => seen.has(id));

  if (input.allowCycleAdvance && covered) {
    return {
      lastSuccessfulRunAt: input.previousCycleStartedAt || input.runStartedAt,
      scanOffset: 0,
      cycleStartedAt: null,
      cycleSeen: null,
    };
  }

  if (covered) {
    return {
      scanOffset: 0,
      cycleStartedAt: null,
      cycleSeen: null,
    };
  }

  return {
    scanOffset: nextOffset,
    cycleStartedAt: input.previousCycleStartedAt || input.runStartedAt,
    cycleSeen: relevantSeen,
  };
}

export function summaryFor(
  project: { id: string; name: string },
  summaries: ProjectSummary[],
): string | undefined {
  const id = project.id.trim();
  if (id) {
    const byId = summaries.find((item) => item.projectId.trim() === id && item.summary.trim());
    if (byId) return byId.summary.trim();
  }
  const name = project.name.trim().toLowerCase();
  const byName = summaries.find(
    (item) => item.projectName.trim().toLowerCase() === name && item.summary.trim(),
  );
  return byName ? byName.summary.trim() : undefined;
}

function unwrapFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function scanJsonStructure(source: string): {
  stack: string[];
  inString: boolean;
  stringStart: number;
} {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      stringStart = index;
      continue;
    }
    if (char === "{" || char === "[") stack.push(char);
    else if ((char === "}" || char === "]") && stack.length > 0) stack.pop();
  }
  return { stack, inString, stringStart };
}

/**
 * Close a JSON object cut off by max_tokens: finish an open string,
 * drop a dangling key, then close arrays and objects.
 */
export function closeTruncatedJson(input: string): string {
  let source = input.trim();
  if (source.endsWith("\\")) source = source.slice(0, -1);

  const opened = scanJsonStructure(source);
  if (opened.inString && opened.stringStart >= 0) {
    const before = source.slice(0, opened.stringStart).trimEnd();
    if (/[{,]\s*$/.test(before)) source = before.replace(/,\s*$/, "");
    else source += '"';
  }

  source = source.replace(/,\s*$/, "");
  if (/:\s*$/.test(source)) source += "null";

  const finalScan = scanJsonStructure(source);
  if (finalScan.inString) source += '"';
  for (let index = finalScan.stack.length - 1; index >= 0; index -= 1) {
    source += finalScan.stack[index] === "{" ? "}" : "]";
  }
  return source;
}

function parseJsonLoose(text: string): unknown {
  const raw = unwrapFence(text);
  const start = raw.indexOf("{");
  if (start === -1) throw new Error("Keine JSON-Objekt-Antwort von OpenRouter");
  const slice = raw.slice(start);

  const attempts = [slice, closeTruncatedJson(slice)];
  let lastError: unknown;
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (err) {
      lastError = err;
    }
  }

  for (let end = slice.length; end > 0; end -= 1) {
    const char = slice[end - 1];
    if (char !== "}" && char !== "]") continue;
    try {
      return JSON.parse(closeTruncatedJson(slice.slice(0, end)));
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Keine JSON-Objekt-Antwort von OpenRouter");
}

export function extractNarration(text: string): BriefingNarration {
  const parsed = parseJsonLoose(text) as {
    dayOverview?: unknown;
    projects?: unknown;
  };
  const projects = Array.isArray(parsed.projects)
    ? parsed.projects.map((item) => {
        const record = (item || {}) as {
          projectId?: unknown;
          projectName?: unknown;
          summary?: unknown;
        };
        return {
          projectId: String(record.projectId || ""),
          projectName: String(record.projectName || ""),
          summary: String(record.summary || ""),
        };
      })
    : [];

  return {
    dayOverview: String(parsed.dayOverview || "").trim(),
    projects,
  };
}
