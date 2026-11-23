/** New / touched / opened-only / missing-or-trashed. */
export type FileChangeKind = "added" | "modified" | "viewed" | "deleted";

export interface BriefingFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
  createdTime: string;
  modifiedTime: string;
  parentFolderId: string;
  parentFolderName: string;
  /** True when a Drive thumbnail should be attempted (PDF / raster images). */
  hasPreview: boolean;
  /** added = neu; modified = Inhalt/Meta; viewed = nur geöffnet; deleted = Papierkorb oder seit letztem Scan weg. */
  changeKind: FileChangeKind;
}

export interface BriefingFileGroup {
  folderName: string;
  files: BriefingFile[];
}

export interface BriefingProject {
  id: string;
  name: string;
  latestActivity: string;
  groups: BriefingFileGroup[];
  /** Extra monitored root folder, rendered as its own mail segment. */
  segmentKind: "project" | "segment";
}

export interface BriefingData {
  generatedAt: string;
  /** Fallback is 24. Later runs store the elapsed hours since lastSuccessfulRunAt. */
  windowHours: number;
  /** Inclusive start of this run's change window (ISO). */
  windowStartIso: string;
  /** True when lastSuccessfulRunAt was missing or unusable. */
  usedFallbackWindow: boolean;
  /** Scan stopped early (time budget or an unfinished changes feed). */
  partialScan: boolean;
  projects: BriefingProject[];
  /** Special segments with activity (rendered after projects). */
  segments: BriefingProject[];
}

export interface ProjectSummary {
  /** Stable Drive folder id. Empty when the model omits it. */
  projectId: string;
  projectName: string;
  summary: string;
}

/** Full AI narration for a daily briefing booklet. */
export interface BriefingNarration {
  dayOverview: string;
  projects: ProjectSummary[];
}

export interface AppConfig {
  rootFolderId: string;
  openRouterApiKey: string;
  openRouterModel: string;
  recipients: string[];
  windowHours: number;
  excludedProjectNames: string[];
  /** Direct children of the root scanned as their own mail segments. */
  extraSegmentNames: string[];
}
