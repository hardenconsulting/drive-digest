import {
  CHANGES_TOKEN_PROP,
  CYCLE_SEEN_PROP,
  CYCLE_STARTED_PROP,
  LAST_SUCCESSFUL_RUN_PROP,
  LEGACY_INVENTORY_PROP,
  PROPERTY_STORE_MAX_BYTES,
  PROPERTY_VALUE_MAX_BYTES,
  SCAN_BUDGET_MS,
  SCAN_OFFSET_PROP,
  sortBriefingBlocks,
  INVENTORY_FILE_ID_PROP,
  INVENTORY_FILE_NAME,
  INVENTORY_PREFIX,
  decodeInventoryFile,
  decodeInventoryRecord,
  deletedFromSnapshot,
  encodeInventoryFile,
  elapsedWindowHours,
  encodeManifest,
  inventoryChunkKey,
  inventoryKeepingSurvivors,
  inventoryKey,
  isInventoryKeyForProject,
  isDwgFile,
  mergeFiles,
  planScanProgress,
  projectedInventoryBytes,
  resolveWindowStart,
  shrinkInventoryItems,
  sortByModifiedDesc,
  splitInventoryChunks,
  toBriefingFile,
  utf8ByteLength,
  type InventoryItem,
  type ScanProgress,
} from "./briefingLogic";
import { fetchWithRetry, isRetryableError, withGasRetry } from "./retry";
import type { AppConfig, BriefingData, BriefingFile, BriefingProject } from "./types";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS =
  "id, name, mimeType, webViewLink, createdTime, modifiedTime, viewedByMeTime, parents";
const TRASH_FIELDS = `${FILE_FIELDS}, trashedTime`;
const PARENT_BATCH = 25;

interface DriveListFile {
  id?: string;
  name?: string;
  mimeType?: string;
  webViewLink?: string;
  createdTime?: string;
  modifiedTime?: string;
  viewedByMeTime?: string;
  trashedTime?: string;
  trashed?: boolean;
  parents?: string[];
}

interface FolderRef {
  id: string;
  name: string;
}

interface ScopeRoot {
  id: string;
  folderName: string;
  displayName: string;
  segmentKind: "project" | "segment";
}

interface DriveChangeRow {
  fileId?: string;
  removed?: boolean;
  time?: string;
  file?: DriveListFile;
}

interface ListedFiles {
  files: DriveListFile[];
  complete: boolean;
}

export interface PendingInventory {
  projectId: string;
  projectName: string;
  items: InventoryItem[];
}

export interface PendingScanState extends ScanProgress {
  inventories: PendingInventory[];
  changesPageToken?: string;
  /** Hidden app-data file to update. Absent until the first successful save. */
  inventoryFileId?: string;
}

interface LoadedInventory {
  fileId?: string;
  /** Set when the hidden file is the source of truth. Null keeps Script Properties. */
  byProject: Map<string, InventoryItem[]> | null;
}

export interface ScanResult {
  data: BriefingData;
  pending: PendingScanState;
}

type ScriptProps = GoogleAppsScript.Properties.Properties;

function quoteId(id: string): string {
  return `'${id.replace(/'/g, "")}'`;
}

function driveQueryTime(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, "Z");
}

function chunkIds(ids: string[], size: number): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    batches.push(ids.slice(index, index + size));
  }
  return batches;
}

function listAll(query: string, fields: string, deadlineMs: number): ListedFiles {
  const out: DriveListFile[] = [];
  let pageToken: string | undefined;

  do {
    if (Date.now() > deadlineMs) return { files: out, complete: false };
    const response = withGasRetry("Drive.Files.list", () =>
      Drive.Files!.list({
        q: query,
        pageSize: 100,
        pageToken,
        fields: `nextPageToken, files(${fields})`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: "allDrives",
      }),
    ) as { nextPageToken?: string; files?: DriveListFile[] };

    out.push(...(response.files || []));
    pageToken = response.nextPageToken || undefined;
  } while (pageToken);

  return { files: out, complete: true };
}

function listFilesInFolders(
  folderIds: string[],
  trashed: boolean,
  modifiedAfter: string | undefined,
  fields: string,
  deadlineMs: number,
): ListedFiles {
  const ids = folderIds.filter(Boolean);
  if (ids.length === 0) return { files: [], complete: true };

  const run = (withModified: boolean): ListedFiles => {
    const out: DriveListFile[] = [];
    for (const batch of chunkIds(ids, PARENT_BATCH)) {
      const parts = [
        `(${batch.map((id) => `${quoteId(id)} in parents`).join(" or ")})`,
        `trashed = ${trashed ? "true" : "false"}`,
        `mimeType != '${FOLDER_MIME}'`,
      ];
      if (withModified && modifiedAfter) {
        parts.push(`modifiedTime > '${driveQueryTime(modifiedAfter)}'`);
      }
      const listed = listAll(parts.join(" and "), fields, deadlineMs);
      out.push(...listed.files);
      if (!listed.complete) return { files: out, complete: false };
    }
    return { files: out, complete: true };
  };

  if (!modifiedAfter) return run(false);

  try {
    return run(true);
  } catch (err) {
    console.warn(
      `Drive-Query mit modifiedTime abgelehnt, Filter lokal (${String(err)}).`,
    );
    return run(false);
  }
}

function listSubfolders(parentId: string, deadlineMs: number): { folders: FolderRef[]; complete: boolean } {
  const query = [
    `${quoteId(parentId)} in parents`,
    "trashed = false",
    `mimeType = '${FOLDER_MIME}'`,
  ].join(" and ");
  const listed = listAll(query, "id, name", deadlineMs);
  return {
    complete: listed.complete,
    folders: listed.files
      .map((file) => ({ id: file.id || "", name: file.name || "(Ordner)" }))
      .filter((folder) => folder.id),
  };
}

function displaySegmentName(folderName: string): string {
  return folderName.replace(/^A_/, "").trim() || folderName;
}

export function fetchThumbnailBlob(fileId: string): GoogleAppsScript.Base.Blob | null {
  if (!fileId) return null;
  try {
    const meta = withGasRetry(`Thumbnail-Meta ${fileId}`, () =>
      Drive.Files!.get(fileId, {
        fields: "thumbnailLink",
        supportsAllDrives: true,
      }),
    ) as { thumbnailLink?: string };

    let url = meta.thumbnailLink;
    if (!url) return null;
    url = url.replace(/=s\d+/, "=s320");

    const response = fetchWithRetry(`Thumbnail ${fileId}`, url, {
      headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
      muteHttpExceptions: true,
    });
    const code = response.getResponseCode();
    if (code < 200 || code >= 300) {
      console.error(`Thumbnail HTTP ${code} für ${fileId}`);
      return null;
    }
    return response.getBlob().setName(`thumb-${fileId}.jpg`);
  } catch (err) {
    console.error(`Thumbnail fehlgeschlagen für ${fileId}: ${String(err)}`);
    return null;
  }
}

export { isDwgFile };

function sortFilesForBriefing(files: BriefingFile[]): BriefingFile[] {
  const byDate = sortByModifiedDesc(files);
  const regular = byDate.filter((file) => !isDwgFile(file));
  const dwgs = byDate.filter((file) => isDwgFile(file));
  return [...regular, ...dwgs];
}

function loadInventory(
  props: ScriptProps,
  projectId: string,
  projectName: string,
  loaded?: LoadedInventory,
): InventoryItem[] {
  if (loaded?.byProject) {
    const items = loaded.byProject.get(projectId) || [];
    return items.map((item) => ({
      ...item,
      projectId,
      projectName: item.projectName || projectName,
    }));
  }
  try {
    return decodeInventoryRecord(
      props.getProperty(inventoryKey(projectId)),
      (key) => props.getProperty(key),
      { projectId, projectName },
    );
  } catch (err) {
    console.error(`Inventar ${projectId} laden fehlgeschlagen: ${String(err)}`);
    return [];
  }
}

function isMissingFile(err: unknown): boolean {
  const message = String(err);
  return /\b404\b/.test(message) || /file not found/i.test(message);
}

function findHiddenInventoryFileId(): string | undefined {
  const listed = withGasRetry("Inventar-Datei suchen", () =>
    Drive.Files!.list({
      q: `name = '${INVENTORY_FILE_NAME}' and trashed = false`,
      spaces: "appDataFolder",
      fields: "files(id,name)",
      pageSize: 10,
    }),
  ) as { files?: Array<{ id?: string }> };
  return listed.files?.find((file) => file.id)?.id || undefined;
}

function readHiddenInventoryText(fileId: string): string {
  return withGasRetry("Inventar-Datei lesen", () =>
    Drive.Files!.get(fileId, { alt: "media" }),
  );
}

/**
 * Hidden Drive app-data file. Invisible in the Drive UI.
 * A missing permission or a missing file falls back to Script Properties.
 */
function loadHiddenInventory(props: ScriptProps): LoadedInventory {
  const storedId = props.getProperty(INVENTORY_FILE_ID_PROP) || undefined;
  try {
    let fileId = storedId;
    if (!fileId) fileId = findHiddenInventoryFileId();
    if (!fileId) return { byProject: null };
    const projects = decodeInventoryFile(readHiddenInventoryText(fileId));
    if (!projects) {
      console.error("Inventar-Datei unlesbar. Script Properties werden verwendet.");
      return { fileId, byProject: null };
    }
    const count = projects.reduce((sum, project) => sum + project.items.length, 0);
    console.log(`Verstecktes Inventar geladen: ${count} Dateien`);
    return {
      fileId,
      byProject: new Map(projects.map((project) => [project.projectId, project.items])),
    };
  } catch (err) {
    if (storedId && isMissingFile(err)) {
      console.warn("Inventar-Datei fehlt. Script Properties werden verwendet.");
      return { byProject: null };
    }
    console.error(
      `Verstecktes Inventar nicht lesbar, Script Properties bleiben aktiv: ${String(err)}`,
    );
    return { byProject: null };
  }
}

function saveHiddenInventory(
  props: ScriptProps,
  inventories: PendingInventory[],
  knownFileId?: string,
): string {
  const body = encodeInventoryFile(inventories);
  const blob = Utilities.newBlob(body, "application/json", INVENTORY_FILE_NAME);
  const existing = knownFileId || props.getProperty(INVENTORY_FILE_ID_PROP) || undefined;
  if (existing) {
    try {
      withGasRetry("Inventar-Datei aktualisieren", () =>
        Drive.Files!.update({ mimeType: "application/json" }, existing, blob),
      );
      return existing;
    } catch (err) {
      if (!isMissingFile(err)) throw err;
    }
  }

  const created = withGasRetry("Inventar-Datei anlegen", () =>
    Drive.Files!.create(
      {
        name: INVENTORY_FILE_NAME,
        mimeType: "application/json",
        parents: ["appDataFolder"],
      },
      blob,
    ),
  );
  if (!created.id) throw new Error("Inventar-Datei ohne ID");
  return created.id;
}

function propertyInventoryId(key: string, value: string): string | null {
  if (!key.startsWith(INVENTORY_PREFIX)) return null;
  const projectId = key.slice(INVENTORY_PREFIX.length);
  if (!projectId) return null;
  try {
    const parsed = JSON.parse(value) as { v?: unknown; chunks?: unknown; gen?: unknown };
    if (Array.isArray(parsed)) return projectId;
    if (parsed && parsed.v === 2 && typeof parsed.chunks === "number" && typeof parsed.gen === "string") {
      return projectId;
    }
  } catch {
    return null;
  }
  return null;
}

/** Pending roots replace their snapshot. Every other project stays in the saved file. */
function mergeInventorySnapshot(
  props: ScriptProps,
  pending: PendingInventory[],
  loaded: LoadedInventory,
): PendingInventory[] {
  const byId = new Map<string, PendingInventory>();
  if (loaded.byProject) {
    for (const [projectId, items] of loaded.byProject) {
      byId.set(projectId, {
        projectId,
        projectName: items.find((item) => item.projectName)?.projectName || "",
        items,
      });
    }
  } else {
    for (const [key, value] of Object.entries(props.getProperties())) {
      const projectId = propertyInventoryId(key, value);
      if (!projectId || byId.has(projectId)) continue;
      const items = loadInventory(props, projectId, "");
      byId.set(projectId, {
        projectId,
        projectName: items.find((item) => item.projectName)?.projectName || "",
        items,
      });
    }
  }
  for (const inventory of pending) byId.set(inventory.projectId, inventory);
  return [...byId.values()];
}

function deleteInventoryProperties(props: ScriptProps): void {
  const keys = Object.keys(props.getProperties());
  for (const key of keys) {
    if (key === LEGACY_INVENTORY_PROP || key.startsWith(INVENTORY_PREFIX)) {
      props.deleteProperty(key);
    }
  }
}

function newInventoryGen(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/**
 * Chunks are written under a new generation. The manifest flips only after
 * every chunk exists, so a failed save keeps the previous snapshot readable.
 */
function writeInventory(
  props: ScriptProps,
  projectId: string,
  projectName: string,
  chunks: string[],
): void {
  const gen = newInventoryGen();
  const manifest = encodeManifest(chunks.length, projectName, gen);
  if (utf8ByteLength(manifest) > PROPERTY_VALUE_MAX_BYTES) {
    throw new Error(`Inventar-Manifest ${projectId} zu groß`);
  }
  chunks.forEach((body, index) => {
    if (utf8ByteLength(body) > PROPERTY_VALUE_MAX_BYTES) {
      throw new Error(`Inventar-Chunk ${projectId}#${index} hat ${utf8ByteLength(body)} Bytes`);
    }
  });

  const projected = projectedInventoryBytes(
    props.getProperties(),
    projectId,
    manifest,
    chunks,
    gen,
  );
  if (projected > PROPERTY_STORE_MAX_BYTES) {
    throw new Error(`Properties-Speicher ${projected} Bytes`);
  }

  chunks.forEach((body, index) => {
    const key = inventoryChunkKey(projectId, gen, index);
    withGasRetry(`Inventar ${key}`, () => props.setProperty(key, body));
  });
  withGasRetry(`Inventar ${projectId}`, () => props.setProperty(inventoryKey(projectId), manifest));

  const prefix = `${inventoryKey(projectId)}_`;
  const keepPrefix = `${prefix}${gen}_`;
  for (const key of Object.keys(props.getProperties())) {
    if (!key.startsWith(prefix) || key.startsWith(keepPrefix)) continue;
    if (!isInventoryKeyForProject(projectId, key)) continue;
    props.deleteProperty(key);
  }
}

function persistInventory(
  props: ScriptProps,
  projectId: string,
  projectName: string,
  items: InventoryItem[],
): void {
  const attempts = [
    items,
    shrinkInventoryItems(items, 80, 40),
    shrinkInventoryItems(items, 40, 16),
  ];
  let lastError = "unbekannt";

  for (const candidate of attempts) {
    try {
      writeInventory(
        props,
        projectId,
        projectName,
        splitInventoryChunks(candidate, PROPERTY_VALUE_MAX_BYTES),
      );
      return;
    } catch (err) {
      lastError = String(err);
      console.error(`Inventar ${projectId} speichern: ${lastError}`);
    }
  }

  const previous = loadInventory(props, projectId, projectName);
  const liveIds = new Set(items.map((item) => item.id));
  const survivors = inventoryKeepingSurvivors(previous, liveIds);
  writeInventory(
    props,
    projectId,
    projectName,
    splitInventoryChunks(survivors, PROPERTY_VALUE_MAX_BYTES),
  );
  console.warn(
    `Inventar ${projectId} nur reduziert gespeichert (${lastError}). Neue Dateien fehlen im Snapshot, bereits erkannte Löschungen werden nicht wiederholt.`,
  );
}

function setOrDelete(props: ScriptProps, key: string, value: string | null): void {
  if (value === null) props.deleteProperty(key);
  else props.setProperty(key, value);
}

export function commitBriefingState(pending: PendingScanState): void {
  const props = PropertiesService.getScriptProperties();
  const hadHiddenFile = Boolean(
    pending.inventoryFileId || props.getProperty(INVENTORY_FILE_ID_PROP),
  );

  try {
    const fileId = saveHiddenInventory(props, pending.inventories, pending.inventoryFileId);
    props.setProperty(INVENTORY_FILE_ID_PROP, fileId);
    deleteInventoryProperties(props);
    console.log("Inventar im versteckten Drive-Bereich gespeichert.");
  } catch (err) {
    if (hadHiddenFile) {
      throw new Error(`Verstecktes Inventar speichern fehlgeschlagen: ${String(err)}`);
    }
    console.error(
      `Verstecktes Inventar noch nicht verfügbar, Script Properties werden verwendet: ${String(err)}`,
    );
    for (const inventory of pending.inventories) {
      persistInventory(props, inventory.projectId, inventory.projectName, inventory.items);
    }
  }

  if (pending.changesPageToken) {
    props.setProperty(CHANGES_TOKEN_PROP, pending.changesPageToken);
  }

  let cycleSeen = pending.cycleSeen;
  let cycleStartedAt = pending.cycleStartedAt;
  let lastSuccessfulRunAt = pending.lastSuccessfulRunAt;
  if (cycleSeen) {
    const raw = JSON.stringify(cycleSeen);
    if (utf8ByteLength(raw) > PROPERTY_VALUE_MAX_BYTES) {
      console.warn(
        "Zyklus-Liste passt nicht in ein Script-Property. lastSuccessfulRunAt bleibt, bis ein Lauf alle Ordner schafft.",
      );
      cycleSeen = null;
      cycleStartedAt = null;
      lastSuccessfulRunAt = undefined;
    }
  }

  props.setProperty(SCAN_OFFSET_PROP, String(pending.scanOffset));
  setOrDelete(props, CYCLE_STARTED_PROP, cycleStartedAt);
  setOrDelete(props, CYCLE_SEEN_PROP, cycleSeen ? JSON.stringify(cycleSeen) : null);
  if (lastSuccessfulRunAt) {
    props.setProperty(LAST_SUCCESSFUL_RUN_PROP, lastSuccessfulRunAt);
  }

  try {
    props.deleteProperty(LEGACY_INVENTORY_PROP);
  } catch (err) {
    console.error(`Legacy-Inventar löschen fehlgeschlagen: ${String(err)}`);
  }
}

function readOffset(raw: string | null, total: number): number {
  if (total <= 0) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return 0;
  return value % total;
}

function readSeen(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch (err) {
    console.error(`BRIEFING_CYCLE_SEEN ungültig: ${String(err)}`);
    return [];
  }
}

function readCycleStart(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function toProject(root: ScopeRoot, files: BriefingFile[]): BriefingProject | null {
  if (files.length === 0) return null;
  const latestActivity = files.reduce(
    (max, file) => ((file.modifiedTime || "") > max ? file.modifiedTime : max),
    "",
  );

  const groupMap = new Map<string, BriefingFile[]>();
  for (const file of files) {
    const groupName = file.parentFolderId === root.id ? "Dateien" : file.parentFolderName;
    const list = groupMap.get(groupName) || [];
    list.push(file);
    groupMap.set(groupName, list);
  }

  const groups = [...groupMap.entries()].map(([folderName, groupFiles]) => ({
    folderName,
    files: sortFilesForBriefing(groupFiles),
  }));

  groups.sort((a, b) => {
    if (a.folderName === "Dateien") return -1;
    if (b.folderName === "Dateien") return 1;
    return a.folderName.localeCompare(b.folderName, "de");
  });

  return {
    id: root.id,
    name: root.displayName,
    latestActivity,
    groups,
    segmentKind: root.segmentKind,
  };
}

function attributeParent(
  file: DriveListFile,
  folders: FolderRef[],
  root: ScopeRoot,
): { parentFolderId: string; parentFolderName: string } {
  const names = new Map(folders.map((folder) => [folder.id, folder.name]));
  const parentId = (file.parents || []).find((id) => names.has(id)) || root.id;
  const parentFolderName =
    parentId === root.id ? "Dateien" : names.get(parentId) || "Dateien";
  return { parentFolderId: parentId, parentFolderName };
}

interface ChangeConsume {
  files: BriefingFile[];
  nextToken?: string;
  incomplete: boolean;
}

function consumeDeletedChanges(
  folderToRoot: Map<string, ScopeRoot>,
  inventoryByFileId: Map<string, InventoryItem>,
  windowStartIso: string,
  deadlineMs: number,
): ChangeConsume {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty(CHANGES_TOKEN_PROP);

  if (!token) {
    try {
      const start = withGasRetry("Drive.Changes.getStartPageToken", () =>
        Drive.Changes!.getStartPageToken({ supportsAllDrives: true }),
      ) as { startPageToken?: string };
      if (start.startPageToken) {
        console.log(
          "Drive-Changes-Token vorgemerkt. Er wird nach erfolgreichem Versand gespeichert.",
        );
        return { files: [], nextToken: start.startPageToken, incomplete: false };
      }
    } catch (err) {
      console.error(`Changes-Token fehlgeschlagen: ${String(err)}`);
      if (isRetryableError(err)) return { files: [], incomplete: true };
    }
    return { files: [], incomplete: false };
  }

  const deleted: BriefingFile[] = [];
  let pageToken: string | undefined = token;
  let resumeToken: string | undefined;

  try {
    do {
      if (Date.now() > deadlineMs) {
        console.warn("Changes-Abruf wegen Zeitbudget abgebrochen.");
        return { files: deleted, nextToken: resumeToken, incomplete: true };
      }

      const currentToken = pageToken;
      const resp = withGasRetry("Drive.Changes.list", () =>
        Drive.Changes!.list(currentToken as string, {
          pageSize: 100,
          includeRemoved: true,
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
          fields:
            "nextPageToken,newStartPageToken,changes(fileId,removed,time,file(id,name,mimeType,parents,trashed,trashedTime,webViewLink,createdTime,modifiedTime))",
        }),
      ) as {
        nextPageToken?: string;
        newStartPageToken?: string;
        changes?: DriveChangeRow[];
      };

      for (const change of resp.changes || []) {
        const file = change.file;
        const isGone = Boolean(change.removed || file?.trashed);
        if (!isGone) continue;

        const fileId = change.fileId || file?.id || "";
        if (!fileId) continue;

        const stamp = file?.trashedTime || change.time || "";
        if (stamp && stamp < windowStartIso) continue;

        const inv = inventoryByFileId.get(fileId);
        const parents = file?.parents || (inv ? [inv.parentFolderId] : []);

        let root: ScopeRoot | undefined;
        let parentFolderId = "";
        let parentFolderName = "Dateien";

        for (const parentId of parents) {
          const hit = folderToRoot.get(parentId);
          if (!hit) continue;
          root = hit;
          parentFolderId = parentId;
          parentFolderName =
            parentId === hit.id ? "Dateien" : inv?.parentFolderName || "Dateien";
          break;
        }

        if (!root && inv) {
          root = folderToRoot.get(inv.projectId) || {
            id: inv.projectId,
            folderName: inv.projectName,
            displayName: inv.projectName,
            segmentKind: "project",
          };
          parentFolderId = inv.parentFolderId;
          parentFolderName = inv.parentFolderName;
        }

        if (!root) continue;

        deleted.push(
          toBriefingFile(
            {
              id: fileId,
              name: file?.name || inv?.name || "(gelöscht)",
              mimeType: file?.mimeType || inv?.mimeType || "application/octet-stream",
              webViewLink: file?.webViewLink,
              createdTime: file?.createdTime || "",
              modifiedTime: stamp || new Date().toISOString(),
              trashedTime: file?.trashedTime || stamp,
            },
            parentFolderId || root.id,
            parentFolderName,
            windowStartIso,
            "deleted",
          ),
        );
      }

      pageToken = resp.nextPageToken || undefined;
      if (pageToken) resumeToken = pageToken;
      else if (resp.newStartPageToken) resumeToken = resp.newStartPageToken;
    } while (pageToken);

    console.log(`Drive Changes: ${deleted.length} Löschung(en) im Fenster`);
    return { files: deleted, nextToken: resumeToken, incomplete: false };
  } catch (err) {
    console.error(`Drive Changes fehlgeschlagen: ${String(err)}`);
    if (isRetryableError(err)) {
      return { files: deleted, nextToken: resumeToken, incomplete: true };
    }
    return { files: deleted, incomplete: false };
  }
}

function buildRoots(folders: FolderRef[], config: AppConfig): ScopeRoot[] {
  const extra = new Set(config.extraSegmentNames.map((name) => name.trim().toLowerCase()));
  const skip = new Set(
    [...config.excludedProjectNames, ...config.extraSegmentNames].map((name) =>
      name.trim().toLowerCase(),
    ),
  );

  const projects = folders.filter(
    (folder) => folder.id && !skip.has(folder.name.trim().toLowerCase()),
  );
  const segments = folders.filter(
    (folder) => folder.id && extra.has(folder.name.trim().toLowerCase()),
  );

  return [
    ...projects.map((folder) => ({
      id: folder.id,
      folderName: folder.name,
      displayName: folder.name,
      segmentKind: "project" as const,
    })),
    ...segments.map((folder) => ({
      id: folder.id,
      folderName: folder.name,
      displayName: displaySegmentName(folder.name),
      segmentKind: "segment" as const,
    })),
  ];
}

/**
 * Read-only scan. Script Properties are not written; commitBriefingState does that
 * after the mail has been sent.
 */
export function scanRecentProjects(config: AppConfig, runStartedMs = Date.now()): ScanResult {
  const runStartedAt = new Date(runStartedMs).toISOString();
  const deadlineMs = runStartedMs + SCAN_BUDGET_MS;
  const nowIso = runStartedAt;
  const props = PropertiesService.getScriptProperties();
  const storedCursor = props.getProperty(LAST_SUCCESSFUL_RUN_PROP);
  const window = resolveWindowStart(storedCursor, runStartedMs, config.windowHours);
  if (!window.usedFallback && storedCursor && storedCursor.trim() !== window.startIso) {
    console.warn(`lastSuccessfulRunAt normalisiert: ${storedCursor} -> ${window.startIso}`);
  } else if (window.usedFallback && storedCursor) {
    console.warn(
      `lastSuccessfulRunAt ungültig (${storedCursor}), Fallback ${config.windowHours}h ab ${window.startIso}`,
    );
  } else if (window.usedFallback) {
    console.log(`Kein lastSuccessfulRunAt, Fallback ${config.windowHours}h ab ${window.startIso}`);
  } else {
    console.log(`Fenster seit letztem erfolgreichen Lauf: ${window.startIso}`);
  }

  const rootListing = listSubfolders(config.rootFolderId, deadlineMs);
  const roots = buildRoots(rootListing.folders, config);
  const ordered = [...roots].sort((a, b) => a.id.localeCompare(b.id));
  const startOffset = readOffset(props.getProperty(SCAN_OFFSET_PROP), ordered.length);
  const previousSeen = readSeen(props.getProperty(CYCLE_SEEN_PROP));
  const previousCycleStartedAt = readCycleStart(props.getProperty(CYCLE_STARTED_PROP));
  const hiddenInventory = loadHiddenInventory(props);

  const folderToRoot = new Map<string, ScopeRoot>();
  const activityByRoot = new Map<string, BriefingFile[]>();
  const inventoryByFileId = new Map<string, InventoryItem>();
  const pendingInventories: PendingInventory[] = [];
  const visited: ScopeRoot[] = [];

  let snapshotDeletes = 0;
  let trashDeletes = 0;
  let inventoryFileCount = 0;
  let rootsPartial = !rootListing.complete;

  if (!rootListing.complete) {
    console.warn("Projektliste unvollständig (Zeitbudget). Es werden nur gelesene Ordner geprüft.");
  }

  for (let step = 0; step < ordered.length; step += 1) {
    if (Date.now() > deadlineMs) {
      rootsPartial = true;
      console.warn(
        `Scan-Zeitbudget erreicht nach ${visited.length}/${ordered.length} Ordnern.`,
      );
      break;
    }

    const root = ordered[(startOffset + step) % ordered.length];
    const previous = loadInventory(props, root.id, root.displayName, hiddenInventory);
    for (const item of previous) inventoryByFileId.set(item.id, item);

    const subs = listSubfolders(root.id, deadlineMs);
    if (!subs.complete) {
      rootsPartial = true;
      console.warn(
        `Unterordner von ${root.displayName} unvollständig. Scan gestoppt, nächster Lauf setzt hier fort.`,
      );
      break;
    }

    const folders: FolderRef[] = [{ id: root.id, name: root.folderName }, ...subs.folders];
    const live = listFilesInFolders(
      folders.map((folder) => folder.id),
      false,
      undefined,
      FILE_FIELDS,
      deadlineMs,
    );
    if (!live.complete) {
      rootsPartial = true;
      console.warn(
        `Dateiliste von ${root.displayName} unvollständig. Scan gestoppt, nächster Lauf setzt hier fort.`,
      );
      break;
    }

    const trash = listFilesInFolders(
      folders.map((folder) => folder.id),
      true,
      window.startIso,
      TRASH_FIELDS,
      deadlineMs,
    );
    if (!trash.complete) {
      rootsPartial = true;
      console.warn(
        `Papierkorb von ${root.displayName} unvollständig. Scan gestoppt, nächster Lauf setzt hier fort.`,
      );
      break;
    }

    folderToRoot.set(root.id, root);
    for (const folder of folders) folderToRoot.set(folder.id, root);

    const inventory: InventoryItem[] = [];
    const liveIds = new Set<string>();
    const bucket: BriefingFile[] = [];

    for (const file of live.files) {
      if (!file.id || liveIds.has(file.id)) continue;
      liveIds.add(file.id);
      const parent = attributeParent(file, folders, root);
      const item: InventoryItem = {
        id: file.id,
        name: file.name || "(ohne Namen)",
        mimeType: file.mimeType || "application/octet-stream",
        projectId: root.id,
        projectName: root.displayName,
        parentFolderId: parent.parentFolderId,
        parentFolderName: parent.parentFolderName,
      };
      inventory.push(item);
      inventoryByFileId.set(item.id, item);
      const mod = file.modifiedTime || "";
      const viewed = file.viewedByMeTime || "";
      if (mod > window.startIso || viewed > window.startIso) {
        bucket.push(
          toBriefingFile(file, parent.parentFolderId, parent.parentFolderName, window.startIso),
        );
      }
    }

    for (const file of trash.files) {
      const stamp = file.trashedTime || file.modifiedTime || "";
      if (!(stamp > window.startIso)) continue;
      if (file.mimeType === FOLDER_MIME) continue;
      const parent = attributeParent(file, folders, root);
      trashDeletes += 1;
      bucket.push(
        toBriefingFile(
          file,
          parent.parentFolderId,
          parent.parentFolderName,
          window.startIso,
          "deleted",
        ),
      );
    }

    const fromSnapshot = deletedFromSnapshot(
      previous,
      liveIds,
      root.id,
      window.startIso,
      nowIso,
    );
    snapshotDeletes += fromSnapshot.length;
    bucket.push(...fromSnapshot);

    inventoryFileCount += inventory.length;
    pendingInventories.push({
      projectId: root.id,
      projectName: root.displayName,
      items: inventory,
    });
    activityByRoot.set(root.id, bucket);
    visited.push(root);
  }

  let changesToken: string | undefined;
  let changesIncomplete = false;
  let changeFiles: BriefingFile[] = [];

  if (!rootsPartial && rootListing.complete && Date.now() <= deadlineMs) {
    const changes = consumeDeletedChanges(
      folderToRoot,
      inventoryByFileId,
      window.startIso,
      deadlineMs,
    );
    changeFiles = changes.files;
    changesToken = changes.nextToken;
    changesIncomplete = changes.incomplete;
    for (const file of changeFiles) {
      const inv = inventoryByFileId.get(file.id);
      const root =
        folderToRoot.get(file.parentFolderId) ||
        (inv ? folderToRoot.get(inv.projectId) : undefined);
      if (!root) continue;
      const bucket = activityByRoot.get(root.id) || [];
      bucket.push(file);
      activityByRoot.set(root.id, bucket);
    }
  } else if (!rootsPartial && rootListing.complete) {
    changesIncomplete = true;
    console.warn("Changes-Abruf wegen Zeitbudget nicht gestartet.");
  }

  for (const [rootId, files] of activityByRoot) {
    activityByRoot.set(rootId, mergeFiles(files));
  }

  console.log(
    `Lösch-Quellen: trash=${trashDeletes}, snapshot=${snapshotDeletes}, changes=${changeFiles.length}; Inventar ${inventoryFileCount} Dateien / ${visited.length} von ${ordered.length} Roots`,
  );

  const builtProjects: BriefingProject[] = [];
  const builtSegments: BriefingProject[] = [];
  for (const root of visited) {
    const project = toProject(root, activityByRoot.get(root.id) || []);
    if (!project) continue;
    if (root.segmentKind === "segment") builtSegments.push(project);
    else builtProjects.push(project);
  }

  const orderedBlocks = sortBriefingBlocks(builtProjects, builtSegments);
  const incomplete = rootsPartial || changesIncomplete || !rootListing.complete;
  const progress = planScanProgress({
    orderedIds: ordered.map((root) => root.id),
    startOffset,
    visitedIds: visited.map((root) => root.id),
    previousSeen,
    previousCycleStartedAt,
    runStartedAt,
    incomplete,
    allowCycleAdvance: rootListing.complete && !changesIncomplete,
  });

  const data: BriefingData = {
    generatedAt: new Date().toISOString(),
    windowHours: elapsedWindowHours(
      window.startIso,
      Date.now(),
      config.windowHours,
      window.usedFallback,
    ),
    windowStartIso: window.startIso,
    usedFallbackWindow: window.usedFallback,
    partialScan: incomplete,
    projects: orderedBlocks.projects,
    segments: orderedBlocks.segments,
  };

  return {
    data,
    pending: {
      ...progress,
      inventories: mergeInventorySnapshot(props, pendingInventories, hiddenInventory),
      changesPageToken: changesToken,
      inventoryFileId: hiddenInventory.fileId,
    },
  };
}
