"use strict";
(() => {
  // src/briefingLogic.ts
  var LAST_SUCCESSFUL_RUN_PROP = "lastSuccessfulRunAt";
  var SCAN_OFFSET_PROP = "BRIEFING_SCAN_OFFSET";
  var CYCLE_STARTED_PROP = "BRIEFING_CYCLE_STARTED_AT";
  var CYCLE_SEEN_PROP = "BRIEFING_CYCLE_SEEN";
  var CHANGES_TOKEN_PROP = "DRIVE_CHANGES_PAGE_TOKEN";
  var LEGACY_INVENTORY_PROP = "BRIEFING_INVENTORY_V1";
  var INVENTORY_PREFIX = "BRIEFING_INV_";
  var INVENTORY_FILE_ID_PROP = "BRIEFING_INVENTORY_FILE_ID";
  var INVENTORY_FILE_NAME = "drive-digest-inventory.json";
  var PROPERTY_VALUE_MAX_BYTES = 8500;
  var PROPERTY_STORE_MAX_BYTES = 45e4;
  var SCAN_BUDGET_MS = 3.5 * 60 * 1e3;
  var THUMBNAIL_DEADLINE_MS = 5.25 * 60 * 1e3;
  function utf8ByteLength(value) {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 128) bytes += 1;
      else if (code < 2048) bytes += 2;
      else if (code >= 55296 && code <= 56319) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    }
    return bytes;
  }
  function inventoryKey(projectId) {
    return `${INVENTORY_PREFIX}${projectId}`;
  }
  function inventoryChunkKey(projectId, gen, index) {
    return `${inventoryKey(projectId)}_${gen}_${index}`;
  }
  function isInventoryKeyForProject(projectId, key) {
    if (key === inventoryKey(projectId)) return true;
    const prefix = `${inventoryKey(projectId)}_`;
    if (!key.startsWith(prefix)) return false;
    return /^[0-9a-z]+_\d+$/i.test(key.slice(prefix.length));
  }
  function resolveWindowStart(stored, nowMs, fallbackHours) {
    if (stored && stored.trim()) {
      const parsed = Date.parse(stored.trim());
      if (!Number.isNaN(parsed) && parsed > 0 && parsed <= nowMs) {
        return { startIso: new Date(parsed).toISOString(), usedFallback: false };
      }
    }
    const hours = fallbackHours > 0 ? fallbackHours : 24;
    return {
      startIso: new Date(nowMs - hours * 60 * 60 * 1e3).toISOString(),
      usedFallback: true
    };
  }
  function elapsedWindowHours(startIso, nowMs, fallbackHours, usedFallback) {
    if (usedFallback) return fallbackHours > 0 ? fallbackHours : 24;
    const start = Date.parse(startIso);
    if (Number.isNaN(start)) return fallbackHours > 0 ? fallbackHours : 24;
    return Math.max(1, Math.ceil((nowMs - start) / (60 * 60 * 1e3)));
  }
  function shouldRetryHttpStatus(code) {
    return code === 408 || code === 429 || code >= 500 && code <= 599;
  }
  function isRetryableMessage(message) {
    if (/\b408\b/.test(message) || /\b429\b/.test(message) || /\b5\d\d\b/.test(message)) {
      return true;
    }
    return /rate limit|quota exceeded|backend error|internal error|service unavailable|timed out|timeout|try again/i.test(
      message
    );
  }
  function retryBackoffMs(attempt, random = Math.random) {
    const base = 400 * 2 ** attempt;
    const jitter = Math.floor(random() * 250);
    return Math.min(8e3, base + jitter);
  }
  function typeLabel(mimeType) {
    const mime = mimeType.toLowerCase();
    if (mime === "application/pdf") return "PDF";
    if (mime === "image/vnd.dwg" || mime.includes("dwg")) return "DWG";
    if (mime.startsWith("image/")) return "Bild";
    if (mime.includes("word")) return "DOC";
    if (mime.includes("sheet") || mime.includes("excel")) return "Tabelle";
    return "Datei";
  }
  function isDwgFile(file) {
    return file.mimeType.toLowerCase().includes("dwg") || /\.dwg$/i.test(file.name);
  }
  function classifyChange(createdTime, modifiedTime, windowStartIso) {
    if (createdTime && createdTime > windowStartIso) return "added";
    if (modifiedTime && modifiedTime > windowStartIso) return "modified";
    return "viewed";
  }
  function toBriefingFile(file, parentFolderId, parentFolderName, windowStartIso, changeKind) {
    const id = file.id || "";
    const mimeType = file.mimeType || "application/octet-stream";
    const createdTime = file.createdTime || "";
    const modifiedTime = file.modifiedTime || "";
    const kind = changeKind || classifyChange(createdTime, modifiedTime, windowStartIso);
    const whenDeleted = file.trashedTime || modifiedTime || createdTime || "";
    const activityTime = kind === "deleted" ? whenDeleted : kind === "viewed" ? file.viewedByMeTime || modifiedTime || createdTime || "" : modifiedTime || createdTime || "";
    return {
      id,
      name: file.name || "(ohne Namen)",
      mimeType,
      webViewLink: file.webViewLink || `https://drive.google.com/file/d/${id}/view`,
      createdTime,
      modifiedTime: activityTime,
      parentFolderId,
      parentFolderName,
      hasPreview: kind === "deleted" || kind === "viewed" ? false : hasPreviewMime(mimeType),
      changeKind: kind
    };
  }
  function hasPreviewMime(mimeType) {
    if (mimeType === "application/pdf") return true;
    if (!mimeType.startsWith("image/")) return false;
    if (mimeType.includes("dwg")) return false;
    return true;
  }
  function sortByModifiedDesc(files) {
    return [...files].sort(
      (a, b) => (b.modifiedTime || "").localeCompare(a.modifiedTime || "")
    );
  }
  function mergeFiles(files) {
    const byId = /* @__PURE__ */ new Map();
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
  function deletedFromSnapshot(previous, liveIds, projectId, windowStartIso, nowIso) {
    return previous.filter((item) => item.projectId === projectId && item.id && !liveIds.has(item.id)).map(
      (item) => toBriefingFile(
        {
          id: item.id,
          name: item.name,
          mimeType: item.mimeType,
          modifiedTime: nowIso,
          createdTime: "",
          webViewLink: `https://drive.google.com/file/d/${item.id}/view`
        },
        item.parentFolderId,
        item.parentFolderName || "Dateien",
        windowStartIso,
        "deleted"
      )
    );
  }
  function inventoryKeepingSurvivors(previous, liveIds) {
    return previous.filter((item) => liveIds.has(item.id));
  }
  function shrinkInventoryItems(items, nameLimit, parentLimit) {
    return items.map((item) => ({
      ...item,
      name: item.name.slice(0, nameLimit),
      parentFolderName: item.parentFolderName.slice(0, parentLimit),
      mimeType: item.mimeType.slice(0, 80),
      projectName: item.projectName.slice(0, 120)
    }));
  }
  function encodeChunk(items) {
    const payload = {
      v: 2,
      items: items.map((item) => [
        item.id,
        item.name,
        item.mimeType,
        item.parentFolderId,
        item.parentFolderName
      ])
    };
    return JSON.stringify(payload);
  }
  function encodeManifest(chunkCount, projectName, gen) {
    const payload = {
      v: 2,
      gen,
      chunks: chunkCount,
      projectName: projectName.slice(0, 200)
    };
    return JSON.stringify(payload);
  }
  function fitSingleItem(item, maxBytes) {
    if (utf8ByteLength(encodeChunk([item])) <= maxBytes) return item;
    let lo = 0;
    let hi = item.name.length;
    let best = { ...item, name: "" };
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
    const minimal = {
      ...best,
      name: best.name.slice(0, 24),
      mimeType: "application/octet-stream",
      parentFolderName: "",
      projectName: ""
    };
    if (utf8ByteLength(encodeChunk([minimal])) <= maxBytes) return minimal;
    throw new Error("Inventar-Eintrag gr\xF6\xDFer als ein Script-Property");
  }
  function splitInventoryChunks(items, maxBytes) {
    const chunks = [];
    let batch = [];
    const flush = () => {
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
  function asManifest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value;
    if (record.v !== 2 || typeof record.chunks !== "number" || record.chunks < 0) return null;
    if (!Number.isInteger(record.chunks)) return null;
    if (typeof record.gen !== "string" || !record.gen) return null;
    return {
      v: 2,
      gen: record.gen,
      chunks: record.chunks,
      projectName: typeof record.projectName === "string" ? record.projectName : ""
    };
  }
  function coerceLegacyItem(value, fallback) {
    if (!value || typeof value !== "object") return null;
    const record = value;
    const id = String(record.id || "");
    if (!id) return null;
    return {
      id,
      name: String(record.name || "(ohne Namen)"),
      mimeType: String(record.mimeType || "application/octet-stream"),
      projectId: String(record.projectId || fallback.projectId),
      projectName: String(record.projectName || fallback.projectName),
      parentFolderId: String(record.parentFolderId || fallback.projectId),
      parentFolderName: String(record.parentFolderName || "Dateien")
    };
  }
  function decodeInventoryRecord(main, readKey, fallback) {
    if (!main || !main.trim()) return [];
    let parsed;
    try {
      parsed = JSON.parse(main);
    } catch {
      return [];
    }
    if (Array.isArray(parsed)) {
      return parsed.map((item) => coerceLegacyItem(item, fallback)).filter((item) => item !== null);
    }
    const manifest = asManifest(parsed);
    if (!manifest) return [];
    const projectName = manifest.projectName || fallback.projectName;
    const items = [];
    for (let index = 0; index < manifest.chunks; index += 1) {
      const raw = readKey(inventoryChunkKey(fallback.projectId, manifest.gen, index));
      if (!raw) continue;
      let chunk;
      try {
        chunk = JSON.parse(raw);
      } catch {
        continue;
      }
      const rows = chunk && typeof chunk === "object" && Array.isArray(chunk.items) ? chunk.items : [];
      for (const row of rows) {
        if (!Array.isArray(row) || !row[0]) continue;
        items.push({
          id: String(row[0]),
          name: String(row[1] || "(ohne Namen)"),
          mimeType: String(row[2] || "application/octet-stream"),
          parentFolderId: String(row[3] || fallback.projectId),
          parentFolderName: String(row[4] || "Dateien"),
          projectId: fallback.projectId,
          projectName
        });
      }
    }
    return items;
  }
  function encodeInventoryFile(projects) {
    const payload = { v: 1, projects: {} };
    for (const project of projects) {
      payload.projects[project.projectId] = {
        projectName: project.projectName.slice(0, 200),
        items: project.items.map((item) => [
          item.id,
          item.name,
          item.mimeType,
          item.parentFolderId,
          item.parentFolderName
        ])
      };
    }
    return JSON.stringify(payload);
  }
  function decodeInventoryFile(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed;
    if (record.v !== 1 || !record.projects || typeof record.projects !== "object") return null;
    const projects = [];
    for (const [projectId, value] of Object.entries(record.projects)) {
      if (!projectId || !value || typeof value !== "object") continue;
      const project = value;
      const projectName = String(project.projectName || "");
      const items = [];
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
            projectName
          });
        }
      }
      projects.push({ projectId, projectName, items });
    }
    return projects;
  }
  function propertiesByteSize(entries) {
    let total = 0;
    for (const [key, value] of Object.entries(entries)) {
      total += utf8ByteLength(key) + utf8ByteLength(value);
    }
    return total;
  }
  function projectedInventoryBytes(existing, projectId, manifest, chunks, gen) {
    const next = {};
    for (const [key, value] of Object.entries(existing)) {
      if (!isInventoryKeyForProject(projectId, key)) next[key] = value;
    }
    next[inventoryKey(projectId)] = manifest;
    chunks.forEach((chunk, index) => {
      next[inventoryChunkKey(projectId, gen, index)] = chunk;
    });
    return propertiesByteSize(next);
  }
  function sortBriefingBlocks(projects, segments) {
    const byActivity = (a, b) => (b.latestActivity || "").localeCompare(a.latestActivity || "");
    return {
      projects: [...projects].sort(byActivity),
      segments: [...segments].sort(byActivity)
    };
  }
  function planScanProgress(input) {
    const total = input.orderedIds.length;
    if (!input.incomplete) {
      return {
        lastSuccessfulRunAt: input.runStartedAt,
        scanOffset: 0,
        cycleStartedAt: null,
        cycleSeen: null
      };
    }
    if (total === 0) {
      return {
        scanOffset: 0,
        cycleStartedAt: null,
        cycleSeen: null
      };
    }
    const offset = (input.startOffset % total + total) % total;
    const seen = /* @__PURE__ */ new Set([...input.previousSeen, ...input.visitedIds]);
    const covered = input.orderedIds.every((id) => seen.has(id));
    const nextOffset = (offset + input.visitedIds.length) % total;
    const relevantSeen = input.orderedIds.filter((id) => seen.has(id));
    if (input.allowCycleAdvance && covered) {
      return {
        lastSuccessfulRunAt: input.previousCycleStartedAt || input.runStartedAt,
        scanOffset: 0,
        cycleStartedAt: null,
        cycleSeen: null
      };
    }
    if (covered) {
      return {
        scanOffset: 0,
        cycleStartedAt: null,
        cycleSeen: null
      };
    }
    return {
      scanOffset: nextOffset,
      cycleStartedAt: input.previousCycleStartedAt || input.runStartedAt,
      cycleSeen: relevantSeen
    };
  }
  function summaryFor(project, summaries) {
    const id = project.id.trim();
    if (id) {
      const byId = summaries.find((item) => item.projectId.trim() === id && item.summary.trim());
      if (byId) return byId.summary.trim();
    }
    const name = project.name.trim().toLowerCase();
    const byName = summaries.find(
      (item) => item.projectName.trim().toLowerCase() === name && item.summary.trim()
    );
    return byName ? byName.summary.trim() : void 0;
  }
  function unwrapFence(text) {
    const trimmed = text.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    return fenced ? fenced[1].trim() : trimmed;
  }
  function scanJsonStructure(source) {
    const stack = [];
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
  function closeTruncatedJson(input) {
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
  function parseJsonLoose(text) {
    const raw = unwrapFence(text);
    const start = raw.indexOf("{");
    if (start === -1) throw new Error("Keine JSON-Objekt-Antwort von OpenRouter");
    const slice = raw.slice(start);
    const attempts = [slice, closeTruncatedJson(slice)];
    let lastError;
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
  function extractNarration(text) {
    const parsed = parseJsonLoose(text);
    const projects = Array.isArray(parsed.projects) ? parsed.projects.map((item) => {
      const record = item || {};
      return {
        projectId: String(record.projectId || ""),
        projectName: String(record.projectName || ""),
        summary: String(record.summary || "")
      };
    }) : [];
    return {
      dayOverview: String(parsed.dayOverview || "").trim(),
      projects
    };
  }

  // src/config.ts
  var DEFAULT_EXCLUDED = [];
  var DEFAULT_EXTRA_SEGMENTS = [];
  function parseNameList(raw) {
    return (raw || "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  function resolveRecipients(props) {
    return parseNameList(props.getProperty("BRIEFING_RECIPIENTS"));
  }
  function getConfig() {
    const props = PropertiesService.getScriptProperties();
    const recipients = resolveRecipients(props);
    const folderRaw = (props.getProperty("ROOT_FOLDER_ID") || "").trim();
    const excluded = parseNameList(props.getProperty("EXCLUDED_FOLDER_NAMES"));
    const extras = parseNameList(props.getProperty("EXTRA_SEGMENT_NAMES"));
    return {
      rootFolderId: folderRaw,
      openRouterApiKey: props.getProperty("OPENROUTER_API_KEY") || "",
      openRouterModel: props.getProperty("OPENROUTER_MODEL") || "google/gemini-2.5-flash-lite",
      recipients,
      windowHours: 24,
      excludedProjectNames: excluded.length > 0 ? excluded : DEFAULT_EXCLUDED,
      extraSegmentNames: extras.length > 0 ? extras : DEFAULT_EXTRA_SEGMENTS
    };
  }
  function assertConfigReady(config) {
    if (!config.rootFolderId.trim()) {
      throw new Error("ROOT_FOLDER_ID fehlt. Bitte Script Property setzen.");
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(config.rootFolderId)) {
      throw new Error("ROOT_FOLDER_ID ist ung\xFCltig.");
    }
    if (config.recipients.length === 0) {
      throw new Error(
        "BRIEFING_RECIPIENTS ist leer. Bitte Script Properties setzen."
      );
    }
  }

  // src/retry.ts
  function errorMessage(err) {
    if (typeof err === "object" && err && "message" in err) {
      return String(err.message || err);
    }
    return String(err);
  }
  function isRetryableError(err) {
    if (typeof err === "object" && err) {
      const record = err;
      const candidates = [record.statusCode, record.code, record.status];
      for (const candidate of candidates) {
        if (typeof candidate === "number" && shouldRetryHttpStatus(candidate)) return true;
      }
    }
    return isRetryableMessage(errorMessage(err));
  }
  function withGasRetry(label, fn, maxAttempts = 3) {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return fn();
      } catch (err) {
        lastError = err;
        if (!isRetryableError(err) || attempt === maxAttempts - 1) throw err;
        const wait = retryBackoffMs(attempt);
        console.warn(
          `${label} fehlgeschlagen (Versuch ${attempt + 1}/${maxAttempts}, ${errorMessage(err)}). Neuer Versuch in ${wait} ms.`
        );
        Utilities.sleep(wait);
      }
    }
    throw lastError;
  }
  function fetchWithRetry(label, url, options, maxAttempts = 3) {
    let lastResponse;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response;
      try {
        response = UrlFetchApp.fetch(url, { ...options, muteHttpExceptions: true });
      } catch (err) {
        if (!isRetryableError(err) || attempt === maxAttempts - 1) throw err;
        const wait = retryBackoffMs(attempt);
        console.warn(`${label}: Abruf fehlgeschlagen, neuer Versuch in ${wait} ms. ${errorMessage(err)}`);
        Utilities.sleep(wait);
        continue;
      }
      const code = response.getResponseCode();
      if (shouldRetryHttpStatus(code) && attempt < maxAttempts - 1) {
        const wait = retryBackoffMs(attempt);
        console.warn(`${label}: HTTP ${code}, neuer Versuch in ${wait} ms.`);
        Utilities.sleep(wait);
        lastResponse = response;
        continue;
      }
      return response;
    }
    if (!lastResponse) throw new Error(`${label}: kein Antwortversuch`);
    return lastResponse;
  }

  // src/driveService.ts
  var FOLDER_MIME = "application/vnd.google-apps.folder";
  var FILE_FIELDS = "id, name, mimeType, webViewLink, createdTime, modifiedTime, viewedByMeTime, parents";
  var TRASH_FIELDS = `${FILE_FIELDS}, trashedTime`;
  var PARENT_BATCH = 25;
  function quoteId(id) {
    return `'${id.replace(/'/g, "")}'`;
  }
  function driveQueryTime(iso) {
    return iso.replace(/\.\d{3}Z$/, "Z");
  }
  function chunkIds(ids, size) {
    const batches = [];
    for (let index = 0; index < ids.length; index += size) {
      batches.push(ids.slice(index, index + size));
    }
    return batches;
  }
  function listAll(query, fields, deadlineMs) {
    const out = [];
    let pageToken;
    do {
      if (Date.now() > deadlineMs) return { files: out, complete: false };
      const response = withGasRetry(
        "Drive.Files.list",
        () => Drive.Files.list({
          q: query,
          pageSize: 100,
          pageToken,
          fields: `nextPageToken, files(${fields})`,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          corpora: "allDrives"
        })
      );
      out.push(...response.files || []);
      pageToken = response.nextPageToken || void 0;
    } while (pageToken);
    return { files: out, complete: true };
  }
  function listFilesInFolders(folderIds, trashed, modifiedAfter, fields, deadlineMs) {
    const ids = folderIds.filter(Boolean);
    if (ids.length === 0) return { files: [], complete: true };
    const run = (withModified) => {
      const out = [];
      for (const batch of chunkIds(ids, PARENT_BATCH)) {
        const parts = [
          `(${batch.map((id) => `${quoteId(id)} in parents`).join(" or ")})`,
          `trashed = ${trashed ? "true" : "false"}`,
          `mimeType != '${FOLDER_MIME}'`
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
        `Drive-Query mit modifiedTime abgelehnt, Filter lokal (${String(err)}).`
      );
      return run(false);
    }
  }
  function listSubfolders(parentId, deadlineMs) {
    const query = [
      `${quoteId(parentId)} in parents`,
      "trashed = false",
      `mimeType = '${FOLDER_MIME}'`
    ].join(" and ");
    const listed = listAll(query, "id, name", deadlineMs);
    return {
      complete: listed.complete,
      folders: listed.files.map((file) => ({ id: file.id || "", name: file.name || "(Ordner)" })).filter((folder) => folder.id)
    };
  }
  function displaySegmentName(folderName) {
    return folderName.replace(/^A_/, "").trim() || folderName;
  }
  function fetchThumbnailBlob(fileId) {
    if (!fileId) return null;
    try {
      const meta = withGasRetry(
        `Thumbnail-Meta ${fileId}`,
        () => Drive.Files.get(fileId, {
          fields: "thumbnailLink",
          supportsAllDrives: true
        })
      );
      let url = meta.thumbnailLink;
      if (!url) return null;
      url = url.replace(/=s\d+/, "=s320");
      const response = fetchWithRetry(`Thumbnail ${fileId}`, url, {
        headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
        muteHttpExceptions: true
      });
      const code = response.getResponseCode();
      if (code < 200 || code >= 300) {
        console.error(`Thumbnail HTTP ${code} f\xFCr ${fileId}`);
        return null;
      }
      return response.getBlob().setName(`thumb-${fileId}.jpg`);
    } catch (err) {
      console.error(`Thumbnail fehlgeschlagen f\xFCr ${fileId}: ${String(err)}`);
      return null;
    }
  }
  function sortFilesForBriefing(files) {
    const byDate = sortByModifiedDesc(files);
    const regular = byDate.filter((file) => !isDwgFile(file));
    const dwgs = byDate.filter((file) => isDwgFile(file));
    return [...regular, ...dwgs];
  }
  function loadInventory(props, projectId, projectName, loaded) {
    if (loaded?.byProject) {
      const items = loaded.byProject.get(projectId) || [];
      return items.map((item) => ({
        ...item,
        projectId,
        projectName: item.projectName || projectName
      }));
    }
    try {
      return decodeInventoryRecord(
        props.getProperty(inventoryKey(projectId)),
        (key) => props.getProperty(key),
        { projectId, projectName }
      );
    } catch (err) {
      console.error(`Inventar ${projectId} laden fehlgeschlagen: ${String(err)}`);
      return [];
    }
  }
  function isMissingFile(err) {
    const message = String(err);
    return /\b404\b/.test(message) || /file not found/i.test(message);
  }
  function findHiddenInventoryFileId() {
    const listed = withGasRetry(
      "Inventar-Datei suchen",
      () => Drive.Files.list({
        q: `name = '${INVENTORY_FILE_NAME}' and trashed = false`,
        spaces: "appDataFolder",
        fields: "files(id,name)",
        pageSize: 10
      })
    );
    return listed.files?.find((file) => file.id)?.id || void 0;
  }
  function readHiddenInventoryText(fileId) {
    return withGasRetry(
      "Inventar-Datei lesen",
      () => Drive.Files.get(fileId, { alt: "media" })
    );
  }
  function loadHiddenInventory(props) {
    const storedId = props.getProperty(INVENTORY_FILE_ID_PROP) || void 0;
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
        byProject: new Map(projects.map((project) => [project.projectId, project.items]))
      };
    } catch (err) {
      if (storedId && isMissingFile(err)) {
        console.warn("Inventar-Datei fehlt. Script Properties werden verwendet.");
        return { byProject: null };
      }
      console.error(
        `Verstecktes Inventar nicht lesbar, Script Properties bleiben aktiv: ${String(err)}`
      );
      return { byProject: null };
    }
  }
  function saveHiddenInventory(props, inventories, knownFileId) {
    const body = encodeInventoryFile(inventories);
    const blob = Utilities.newBlob(body, "application/json", INVENTORY_FILE_NAME);
    const existing = knownFileId || props.getProperty(INVENTORY_FILE_ID_PROP) || void 0;
    if (existing) {
      try {
        withGasRetry(
          "Inventar-Datei aktualisieren",
          () => Drive.Files.update({ mimeType: "application/json" }, existing, blob)
        );
        return existing;
      } catch (err) {
        if (!isMissingFile(err)) throw err;
      }
    }
    const created = withGasRetry(
      "Inventar-Datei anlegen",
      () => Drive.Files.create(
        {
          name: INVENTORY_FILE_NAME,
          mimeType: "application/json",
          parents: ["appDataFolder"]
        },
        blob
      )
    );
    if (!created.id) throw new Error("Inventar-Datei ohne ID");
    return created.id;
  }
  function propertyInventoryId(key, value) {
    if (!key.startsWith(INVENTORY_PREFIX)) return null;
    const projectId = key.slice(INVENTORY_PREFIX.length);
    if (!projectId) return null;
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return projectId;
      if (parsed && parsed.v === 2 && typeof parsed.chunks === "number" && typeof parsed.gen === "string") {
        return projectId;
      }
    } catch {
      return null;
    }
    return null;
  }
  function mergeInventorySnapshot(props, pending, loaded) {
    const byId = /* @__PURE__ */ new Map();
    if (loaded.byProject) {
      for (const [projectId, items] of loaded.byProject) {
        byId.set(projectId, {
          projectId,
          projectName: items.find((item) => item.projectName)?.projectName || "",
          items
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
          items
        });
      }
    }
    for (const inventory of pending) byId.set(inventory.projectId, inventory);
    return [...byId.values()];
  }
  function deleteInventoryProperties(props) {
    const keys = Object.keys(props.getProperties());
    for (const key of keys) {
      if (key === LEGACY_INVENTORY_PROP || key.startsWith(INVENTORY_PREFIX)) {
        props.deleteProperty(key);
      }
    }
  }
  function newInventoryGen() {
    return `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  }
  function writeInventory(props, projectId, projectName, chunks) {
    const gen = newInventoryGen();
    const manifest = encodeManifest(chunks.length, projectName, gen);
    if (utf8ByteLength(manifest) > PROPERTY_VALUE_MAX_BYTES) {
      throw new Error(`Inventar-Manifest ${projectId} zu gro\xDF`);
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
      gen
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
  function persistInventory(props, projectId, projectName, items) {
    const attempts = [
      items,
      shrinkInventoryItems(items, 80, 40),
      shrinkInventoryItems(items, 40, 16)
    ];
    let lastError = "unbekannt";
    for (const candidate of attempts) {
      try {
        writeInventory(
          props,
          projectId,
          projectName,
          splitInventoryChunks(candidate, PROPERTY_VALUE_MAX_BYTES)
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
      splitInventoryChunks(survivors, PROPERTY_VALUE_MAX_BYTES)
    );
    console.warn(
      `Inventar ${projectId} nur reduziert gespeichert (${lastError}). Neue Dateien fehlen im Snapshot, bereits erkannte L\xF6schungen werden nicht wiederholt.`
    );
  }
  function setOrDelete(props, key, value) {
    if (value === null) props.deleteProperty(key);
    else props.setProperty(key, value);
  }
  function commitBriefingState(pending) {
    const props = PropertiesService.getScriptProperties();
    const hadHiddenFile = Boolean(
      pending.inventoryFileId || props.getProperty(INVENTORY_FILE_ID_PROP)
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
        `Verstecktes Inventar noch nicht verf\xFCgbar, Script Properties werden verwendet: ${String(err)}`
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
          "Zyklus-Liste passt nicht in ein Script-Property. lastSuccessfulRunAt bleibt, bis ein Lauf alle Ordner schafft."
        );
        cycleSeen = null;
        cycleStartedAt = null;
        lastSuccessfulRunAt = void 0;
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
      console.error(`Legacy-Inventar l\xF6schen fehlgeschlagen: ${String(err)}`);
    }
  }
  function readOffset(raw, total) {
    if (total <= 0) return 0;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) return 0;
    return value % total;
  }
  function readSeen(raw) {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item) => typeof item === "string" && item.length > 0);
    } catch (err) {
      console.error(`BRIEFING_CYCLE_SEEN ung\xFCltig: ${String(err)}`);
      return [];
    }
  }
  function readCycleStart(raw) {
    if (!raw) return null;
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) return null;
    return new Date(parsed).toISOString();
  }
  function toProject(root, files) {
    if (files.length === 0) return null;
    const latestActivity = files.reduce(
      (max, file) => (file.modifiedTime || "") > max ? file.modifiedTime : max,
      ""
    );
    const groupMap = /* @__PURE__ */ new Map();
    for (const file of files) {
      const groupName = file.parentFolderId === root.id ? "Dateien" : file.parentFolderName;
      const list = groupMap.get(groupName) || [];
      list.push(file);
      groupMap.set(groupName, list);
    }
    const groups = [...groupMap.entries()].map(([folderName, groupFiles]) => ({
      folderName,
      files: sortFilesForBriefing(groupFiles)
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
      segmentKind: root.segmentKind
    };
  }
  function attributeParent(file, folders, root) {
    const names = new Map(folders.map((folder) => [folder.id, folder.name]));
    const parentId = (file.parents || []).find((id) => names.has(id)) || root.id;
    const parentFolderName = parentId === root.id ? "Dateien" : names.get(parentId) || "Dateien";
    return { parentFolderId: parentId, parentFolderName };
  }
  function consumeDeletedChanges(folderToRoot, inventoryByFileId, windowStartIso, deadlineMs) {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty(CHANGES_TOKEN_PROP);
    if (!token) {
      try {
        const start = withGasRetry(
          "Drive.Changes.getStartPageToken",
          () => Drive.Changes.getStartPageToken({ supportsAllDrives: true })
        );
        if (start.startPageToken) {
          console.log(
            "Drive-Changes-Token vorgemerkt. Er wird nach erfolgreichem Versand gespeichert."
          );
          return { files: [], nextToken: start.startPageToken, incomplete: false };
        }
      } catch (err) {
        console.error(`Changes-Token fehlgeschlagen: ${String(err)}`);
        if (isRetryableError(err)) return { files: [], incomplete: true };
      }
      return { files: [], incomplete: false };
    }
    const deleted = [];
    let pageToken = token;
    let resumeToken;
    try {
      do {
        if (Date.now() > deadlineMs) {
          console.warn("Changes-Abruf wegen Zeitbudget abgebrochen.");
          return { files: deleted, nextToken: resumeToken, incomplete: true };
        }
        const currentToken = pageToken;
        const resp = withGasRetry(
          "Drive.Changes.list",
          () => Drive.Changes.list(currentToken, {
            pageSize: 100,
            includeRemoved: true,
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            fields: "nextPageToken,newStartPageToken,changes(fileId,removed,time,file(id,name,mimeType,parents,trashed,trashedTime,webViewLink,createdTime,modifiedTime))"
          })
        );
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
          let root;
          let parentFolderId = "";
          let parentFolderName = "Dateien";
          for (const parentId of parents) {
            const hit = folderToRoot.get(parentId);
            if (!hit) continue;
            root = hit;
            parentFolderId = parentId;
            parentFolderName = parentId === hit.id ? "Dateien" : inv?.parentFolderName || "Dateien";
            break;
          }
          if (!root && inv) {
            root = folderToRoot.get(inv.projectId) || {
              id: inv.projectId,
              folderName: inv.projectName,
              displayName: inv.projectName,
              segmentKind: "project"
            };
            parentFolderId = inv.parentFolderId;
            parentFolderName = inv.parentFolderName;
          }
          if (!root) continue;
          deleted.push(
            toBriefingFile(
              {
                id: fileId,
                name: file?.name || inv?.name || "(gel\xF6scht)",
                mimeType: file?.mimeType || inv?.mimeType || "application/octet-stream",
                webViewLink: file?.webViewLink,
                createdTime: file?.createdTime || "",
                modifiedTime: stamp || (/* @__PURE__ */ new Date()).toISOString(),
                trashedTime: file?.trashedTime || stamp
              },
              parentFolderId || root.id,
              parentFolderName,
              windowStartIso,
              "deleted"
            )
          );
        }
        pageToken = resp.nextPageToken || void 0;
        if (pageToken) resumeToken = pageToken;
        else if (resp.newStartPageToken) resumeToken = resp.newStartPageToken;
      } while (pageToken);
      console.log(`Drive Changes: ${deleted.length} L\xF6schung(en) im Fenster`);
      return { files: deleted, nextToken: resumeToken, incomplete: false };
    } catch (err) {
      console.error(`Drive Changes fehlgeschlagen: ${String(err)}`);
      if (isRetryableError(err)) {
        return { files: deleted, nextToken: resumeToken, incomplete: true };
      }
      return { files: deleted, incomplete: false };
    }
  }
  function buildRoots(folders, config) {
    const extra = new Set(config.extraSegmentNames.map((name) => name.trim().toLowerCase()));
    const skip = new Set(
      [...config.excludedProjectNames, ...config.extraSegmentNames].map(
        (name) => name.trim().toLowerCase()
      )
    );
    const projects = folders.filter(
      (folder) => folder.id && !skip.has(folder.name.trim().toLowerCase())
    );
    const segments = folders.filter(
      (folder) => folder.id && extra.has(folder.name.trim().toLowerCase())
    );
    return [
      ...projects.map((folder) => ({
        id: folder.id,
        folderName: folder.name,
        displayName: folder.name,
        segmentKind: "project"
      })),
      ...segments.map((folder) => ({
        id: folder.id,
        folderName: folder.name,
        displayName: displaySegmentName(folder.name),
        segmentKind: "segment"
      }))
    ];
  }
  function scanRecentProjects(config, runStartedMs = Date.now()) {
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
        `lastSuccessfulRunAt ung\xFCltig (${storedCursor}), Fallback ${config.windowHours}h ab ${window.startIso}`
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
    const folderToRoot = /* @__PURE__ */ new Map();
    const activityByRoot = /* @__PURE__ */ new Map();
    const inventoryByFileId = /* @__PURE__ */ new Map();
    const pendingInventories = [];
    const visited = [];
    let snapshotDeletes = 0;
    let trashDeletes = 0;
    let inventoryFileCount = 0;
    let rootsPartial = !rootListing.complete;
    if (!rootListing.complete) {
      console.warn("Projektliste unvollst\xE4ndig (Zeitbudget). Es werden nur gelesene Ordner gepr\xFCft.");
    }
    for (let step = 0; step < ordered.length; step += 1) {
      if (Date.now() > deadlineMs) {
        rootsPartial = true;
        console.warn(
          `Scan-Zeitbudget erreicht nach ${visited.length}/${ordered.length} Ordnern.`
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
          `Unterordner von ${root.displayName} unvollst\xE4ndig. Scan gestoppt, n\xE4chster Lauf setzt hier fort.`
        );
        break;
      }
      const folders = [{ id: root.id, name: root.folderName }, ...subs.folders];
      const live = listFilesInFolders(
        folders.map((folder) => folder.id),
        false,
        void 0,
        FILE_FIELDS,
        deadlineMs
      );
      if (!live.complete) {
        rootsPartial = true;
        console.warn(
          `Dateiliste von ${root.displayName} unvollst\xE4ndig. Scan gestoppt, n\xE4chster Lauf setzt hier fort.`
        );
        break;
      }
      const trash = listFilesInFolders(
        folders.map((folder) => folder.id),
        true,
        window.startIso,
        TRASH_FIELDS,
        deadlineMs
      );
      if (!trash.complete) {
        rootsPartial = true;
        console.warn(
          `Papierkorb von ${root.displayName} unvollst\xE4ndig. Scan gestoppt, n\xE4chster Lauf setzt hier fort.`
        );
        break;
      }
      folderToRoot.set(root.id, root);
      for (const folder of folders) folderToRoot.set(folder.id, root);
      const inventory = [];
      const liveIds = /* @__PURE__ */ new Set();
      const bucket = [];
      for (const file of live.files) {
        if (!file.id || liveIds.has(file.id)) continue;
        liveIds.add(file.id);
        const parent = attributeParent(file, folders, root);
        const item = {
          id: file.id,
          name: file.name || "(ohne Namen)",
          mimeType: file.mimeType || "application/octet-stream",
          projectId: root.id,
          projectName: root.displayName,
          parentFolderId: parent.parentFolderId,
          parentFolderName: parent.parentFolderName
        };
        inventory.push(item);
        inventoryByFileId.set(item.id, item);
        const mod = file.modifiedTime || "";
        const viewed = file.viewedByMeTime || "";
        if (mod > window.startIso || viewed > window.startIso) {
          bucket.push(
            toBriefingFile(file, parent.parentFolderId, parent.parentFolderName, window.startIso)
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
            "deleted"
          )
        );
      }
      const fromSnapshot = deletedFromSnapshot(
        previous,
        liveIds,
        root.id,
        window.startIso,
        nowIso
      );
      snapshotDeletes += fromSnapshot.length;
      bucket.push(...fromSnapshot);
      inventoryFileCount += inventory.length;
      pendingInventories.push({
        projectId: root.id,
        projectName: root.displayName,
        items: inventory
      });
      activityByRoot.set(root.id, bucket);
      visited.push(root);
    }
    let changesToken;
    let changesIncomplete = false;
    let changeFiles = [];
    if (!rootsPartial && rootListing.complete && Date.now() <= deadlineMs) {
      const changes = consumeDeletedChanges(
        folderToRoot,
        inventoryByFileId,
        window.startIso,
        deadlineMs
      );
      changeFiles = changes.files;
      changesToken = changes.nextToken;
      changesIncomplete = changes.incomplete;
      for (const file of changeFiles) {
        const inv = inventoryByFileId.get(file.id);
        const root = folderToRoot.get(file.parentFolderId) || (inv ? folderToRoot.get(inv.projectId) : void 0);
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
      `L\xF6sch-Quellen: trash=${trashDeletes}, snapshot=${snapshotDeletes}, changes=${changeFiles.length}; Inventar ${inventoryFileCount} Dateien / ${visited.length} von ${ordered.length} Roots`
    );
    const builtProjects = [];
    const builtSegments = [];
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
      allowCycleAdvance: rootListing.complete && !changesIncomplete
    });
    const data = {
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      windowHours: elapsedWindowHours(
        window.startIso,
        Date.now(),
        config.windowHours,
        window.usedFallback
      ),
      windowStartIso: window.startIso,
      usedFallbackWindow: window.usedFallback,
      partialScan: incomplete,
      projects: orderedBlocks.projects,
      segments: orderedBlocks.segments
    };
    return {
      data,
      pending: {
        ...progress,
        inventories: mergeInventorySnapshot(props, pendingInventories, hiddenInventory),
        changesPageToken: changesToken,
        inventoryFileId: hiddenInventory.fileId
      }
    };
  }

  // src/mailService.ts
  var FONT = "system-ui,-apple-system,'Segoe UI',sans-serif";
  var BLACK = "#000000";
  var PANEL = "#121212";
  var TEXT = "#f5f5f5";
  var MUTED = "rgba(255,255,255,0.55)";
  var HAIRLINE = "rgba(255,255,255,0.08)";
  var RED = "#ef4444";
  var RED_SOFT = "rgba(239,68,68,0.55)";
  var RADIUS = "16px";
  var ADD_BG = "rgba(34,197,94,0.16)";
  var ADD_FG = "#4ade80";
  var ADD_BD = "rgba(34,197,94,0.35)";
  var MOD_BG = "rgba(245,158,11,0.18)";
  var MOD_FG = "#fbbf24";
  var MOD_BD = "rgba(245,158,11,0.4)";
  var VIEW_BG = "rgba(255,255,255,0.08)";
  var VIEW_FG = "#a3a3a3";
  var VIEW_BD = "rgba(255,255,255,0.08)";
  var DEL_BG = "rgba(239,68,68,0.16)";
  var DEL_FG = "#f87171";
  var DEL_BD = "rgba(239,68,68,0.4)";
  var VIEW_MARK = "&#128065;";
  var HEADER_BG = [
    "radial-gradient(ellipse 90% 70% at 18% 0%, rgba(239,68,68,0.38), transparent 58%)",
    "radial-gradient(ellipse 70% 55% at 88% 75%, rgba(185,28,28,0.28), transparent 60%)",
    "linear-gradient(180deg, #0a0a0a 0%, #000000 100%)"
  ].join(", ");
  var CARD_BG = [
    "radial-gradient(ellipse 70% 45% at 100% 0%, rgba(239,68,68,0.14), transparent 65%)",
    "linear-gradient(180deg, #161616 0%, #101010 100%)"
  ].join(", ");
  var STAGE_BG = [
    "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px)",
    "linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)",
    "radial-gradient(ellipse 80% 50% at 50% -10%, rgba(239,68,68,0.16), transparent 55%)",
    "radial-gradient(ellipse 60% 40% at 90% 100%, rgba(185,28,28,0.1), transparent 50%)",
    "linear-gradient(180deg, #050505 0%, #000000 40%, #000000 100%)"
  ].join(", ");
  var STAGE_BG_SIZE = "48px 48px, 48px 48px, auto, auto, auto";
  var CONTENT_MAX = "760px";
  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function antiTel(value) {
    return escapeHtml(value).replace(/\d/g, (digit) => `${digit}&#8203;`);
  }
  function scriptTz() {
    return Session.getScriptTimeZone() || "Etc/UTC";
  }
  function formatDigestDate(iso) {
    if (!iso) return "-";
    const d = new Date(iso);
    return Utilities.formatDate(d, scriptTz(), "d. MMM yyyy '\xB7' HH:mm");
  }
  function allBriefingBlocks(data) {
    return [...data.projects, ...data.segments];
  }
  function collectPreviewFiles(data) {
    const files = [];
    for (const project of allBriefingBlocks(data)) {
      for (const group of project.groups) {
        for (const file of group.files) {
          if (file.hasPreview && file.id) files.push(file);
        }
      }
    }
    return files;
  }
  function loadInlinePreviews(data, thumbnailDeadlineMs) {
    const cidByFileId = /* @__PURE__ */ new Map();
    const inlineImages = {};
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
      console.warn(`Previews \xFCbersprungen wegen Zeitbudget: ${skipped}`);
    }
    return { cidByFileId, inlineImages };
  }
  function renderHeader(day, introText) {
    return [
      `<tr><td style="padding:0 0 18px;border-radius:${RADIUS};background:${BLACK};background-image:${HEADER_BG}">`,
      `<div style="padding:28px 24px 24px">`,
      `<div style="font-size:11px;letter-spacing:0.2em;font-weight:700;color:rgba(255,255,255,0.85)">DRIVE DIGEST</div>`,
      `<div class="briefing-title" style="font-size:26px;font-weight:800;letter-spacing:-0.02em;color:#ffffff;margin:10px 0 0;line-height:1.15">Drive Digest</div>`,
      `<div style="font-size:13px;color:rgba(255,255,255,0.7);margin:10px 0 16px;line-height:1.5">${antiTel(day)}</div>`,
      `<div style="height:1px;width:96px;background:${RED_SOFT};border-radius:1px"></div>`,
      `<div style="font-size:14px;line-height:1.55;color:rgba(255,255,255,0.72);margin:18px 0 0">${antiTel(introText)}</div>`,
      `</div>`,
      `</td></tr>`
    ].join("");
  }
  function formatAiHtml(text) {
    return antiTel(text).replace(/\n/g, "<br>");
  }
  function renderAiBlock(text) {
    return [
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 14px">`,
      `<tr>`,
      `<td width="4" style="width:4px;background:${RED};border-radius:2px;font-size:0;line-height:0">&nbsp;</td>`,
      `<td style="padding:2px 0 2px 14px;font-size:15px;line-height:1.55;color:rgba(255,255,255,0.88);font-weight:500">`,
      formatAiHtml(text),
      `</td>`,
      `</tr>`,
      `</table>`
    ].join("");
  }
  function renderNamePill(file, kind) {
    const style = kind === "added" ? { bg: ADD_BG, fg: ADD_FG, bd: ADD_BD, mark: "+" } : kind === "modified" ? { bg: MOD_BG, fg: MOD_FG, bd: MOD_BD, mark: "~" } : kind === "viewed" ? { bg: VIEW_BG, fg: VIEW_FG, bd: VIEW_BD, mark: VIEW_MARK } : { bg: DEL_BG, fg: DEL_FG, bd: DEL_BD, mark: "\u2212" };
    return [
      `<a href="${escapeHtml(file.webViewLink)}" style="display:inline-block;text-decoration:none;margin:0 6px 6px 0">`,
      `<span style="display:inline-block;padding:4px 9px;border-radius:6px;background:${style.bg};border:1px solid ${style.bd};color:${style.fg};font-size:12px;font-weight:600;line-height:1.3;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">`,
      `<span style="opacity:0.85;margin-right:4px">${style.mark}</span>${antiTel(file.name)}`,
      `</span>`,
      `</a>`
    ].join("");
  }
  function renderChangeColumn(title, files, kind) {
    if (files.length === 0) return "";
    const pills = files.map((f) => renderNamePill(f, kind)).join("");
    const titleColor = kind === "added" ? ADD_FG : kind === "modified" ? MOD_FG : kind === "viewed" ? VIEW_FG : DEL_FG;
    return [
      `<div style="font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${titleColor};margin:0 0 8px">${escapeHtml(title)}</div>`,
      `<div>${pills}</div>`
    ].join("");
  }
  function renderChangeDiff(project) {
    const files = project.groups.flatMap((g) => g.files);
    const added = files.filter((f) => f.changeKind === "added");
    const modified = files.filter((f) => f.changeKind === "modified");
    const viewed = files.filter((f) => f.changeKind === "viewed");
    const deleted = files.filter((f) => f.changeKind === "deleted");
    if (added.length === 0 && modified.length === 0 && viewed.length === 0 && deleted.length === 0) {
      return "";
    }
    const neu = renderChangeColumn("Neu", added, "added");
    const geaendert = renderChangeColumn("Ge\xE4ndert", modified, "modified");
    const angesehen = renderChangeColumn("Angesehen", viewed, "viewed");
    const geloescht = renderChangeColumn("Gel\xF6scht", deleted, "deleted");
    const topRow = neu && geaendert ? [
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 10px">`,
      `<tr>`,
      `<td width="50%" valign="top" style="width:50%;padding:0 10px 0 0">${neu}</td>`,
      `<td width="50%" valign="top" style="width:50%;padding:0 0 0 10px">${geaendert}</td>`,
      `</tr>`,
      `</table>`
    ].join("") : neu || geaendert ? `<div style="margin:0 0 10px">${neu || geaendert}</div>` : "";
    const viewBlock = angesehen ? `<div style="margin:0 0 10px">${angesehen}</div>` : "";
    const delBlock = geloescht ? `<div style="margin:0 0 16px">${geloescht}</div>` : "";
    return `${topRow}${viewBlock}${delBlock}` || `<div style="margin:0 0 16px"></div>`;
  }
  function renderDayOverview(text) {
    if (!text.trim()) return "";
    return [
      `<tr><td style="padding:0 0 18px">`,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" `,
      `style="width:100%;border-radius:${RADIUS};border:1px solid ${HAIRLINE};background:${PANEL};background-image:${CARD_BG}">`,
      `<tr><td style="padding:20px 20px 18px">`,
      `<div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${MUTED};margin:0 0 12px">Tages\xFCberblick</div>`,
      renderAiBlock(text),
      `</td></tr></table>`,
      `</td></tr>`
    ].join("");
  }
  function chunkPairs(items) {
    const rows = [];
    for (let i = 0; i < items.length; i += 2) {
      rows.push(items.slice(i, i + 2));
    }
    return rows;
  }
  function previewMedia(file, cid) {
    const label = typeLabel(file.mimeType);
    if (cid) {
      return [
        `<img src="cid:${cid}" alt="" width="340" height="150" `,
        `style="display:block;width:100%;max-width:100%;height:150px;object-fit:cover;border-radius:12px;background:#1a1a1a;border:0" />`
      ].join("");
    }
    const badgeBg = label === "PDF" ? RED : "#2a2a2a";
    return [
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" `,
      `style="width:100%;height:150px;border-radius:12px;background:#1a1a1a">`,
      `<tr><td align="center" valign="middle" style="height:150px;border-radius:12px">`,
      `<span style="display:inline-block;padding:6px 10px;border-radius:6px;background:${badgeBg};color:#ffffff;font-size:10px;font-weight:700;letter-spacing:0.06em">${escapeHtml(label)}</span>`,
      `</td></tr></table>`
    ].join("");
  }
  function renderFileTile(file, cid) {
    const dateLabel = formatDigestDate(file.modifiedTime);
    const label = typeLabel(file.mimeType);
    const badgeStyle = label === "PDF" ? `background:${RED};color:#ffffff` : `background:#2a2a2a;color:#ffffff`;
    return [
      `<a href="${escapeHtml(file.webViewLink)}" style="display:block;text-decoration:none;color:${TEXT}">`,
      previewMedia(file, cid),
      `<div style="padding:8px 2px 0">`,
      `<div style="font-size:13px;font-weight:600;line-height:1.3;color:${TEXT};margin:0 0 3px;word-break:break-word">${antiTel(file.name)}</div>`,
      `<div style="font-size:10px;color:${MUTED};margin:0 0 5px">${antiTel(dateLabel)}</div>`,
      `<span style="display:inline-block;padding:2px 7px;border-radius:5px;font-size:9px;font-weight:700;letter-spacing:0.05em;${badgeStyle}">${escapeHtml(label)}</span>`,
      `</div>`,
      `</a>`
    ].join("");
  }
  function renderFileGrid(files, cidByFileId) {
    if (files.length === 0) return "";
    const rows = chunkPairs(files).map((pair) => {
      const cells = [0, 1].map((i) => {
        const file = pair[i];
        const pad = i === 0 ? "padding:0 8px 14px 0" : "padding:0 0 14px 8px";
        if (!file) {
          return `<td width="50%" valign="top" style="width:50%;${pad}">&nbsp;</td>`;
        }
        return [
          `<td width="50%" valign="top" style="width:50%;${pad}">`,
          renderFileTile(file, cidByFileId.get(file.id)),
          `</td>`
        ].join("");
      }).join("");
      return `<tr>${cells}</tr>`;
    }).join("");
    return [
      `<table role="presentation" class="file-grid" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:4px 0 0">`,
      rows,
      `</table>`
    ].join("");
  }
  function renderDwgCard(file) {
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
      `</a>`
    ].join("");
  }
  function renderDwgBand(files) {
    if (files.length === 0) return "";
    const cards = files.map(renderDwgCard).join("");
    return [
      `<div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};margin:18px 0 4px">CAD / DWG</div>`,
      cards
    ].join("");
  }
  function shellOpen() {
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
      `style="max-width:${CONTENT_MAX};width:100%;font-family:${FONT}">`
    ].join("");
  }
  function shellClose() {
    return [
      `<tr><td style="padding:20px 8px 0;font-size:11px;color:rgba(255,255,255,0.35);line-height:1.4;text-align:center">`,
      `Dateien \xF6ffnen in Google Drive.`,
      `</td></tr>`,
      `</table></td></tr></table>`,
      `</body></html>`
    ].join("");
  }
  function windowPhrase(data) {
    if (data.usedFallbackWindow) {
      return `in den letzten ${data.windowHours} Stunden`;
    }
    return `seit ${formatDigestDate(data.windowStartIso)}`;
  }
  function limitNotes(data) {
    const notes = [];
    if (data.partialScan) {
      notes.push(
        "Hinweis: Scan unvollst\xE4ndig wegen Zeitlimit. Der n\xE4chste Lauf holt den Rest nach."
      );
    }
    return notes.join(" ");
  }
  function changeLabel(kind) {
    if (kind === "added") return "Neu";
    if (kind === "modified") return "Ge\xE4ndert";
    if (kind === "viewed") return "Angesehen";
    return "Gel\xF6scht";
  }
  function buildPlainText(data, narration, day) {
    const lines = [`Drive Digest - ${day}`, ""];
    if (narration.dayOverview.trim()) {
      lines.push(narration.dayOverview.trim(), "");
    }
    const blocks = allBriefingBlocks(data);
    if (blocks.length === 0) {
      lines.push(`Keine Aktivit\xE4t ${windowPhrase(data)} im Scan-Ordner.`);
    } else {
      const parts = [
        data.projects.length ? `${data.projects.length} Projekt(e)` : null,
        data.segments.length ? `${data.segments.length} Segment(e)` : null
      ].filter(Boolean);
      lines.push(`${parts.join(", ")} mit Aktivit\xE4t ${windowPhrase(data)}.`, "");
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
    lines.push("Dateien \xF6ffnen in Google Drive.");
    return lines.join("\n");
  }
  function renderEmptyState(data, day) {
    const notes = limitNotes(data);
    const text = `Keine Aktivit\xE4t ${windowPhrase(data)} im Scan-Ordner.${notes ? ` ${notes}` : ""}`;
    return [shellOpen(), renderHeader(day, text), shellClose()].join("");
  }
  function buildBriefingMail(data, narration, thumbnailDeadlineMs) {
    const day = Utilities.formatDate(
      new Date(data.generatedAt),
      scriptTz(),
      "d. MMM yyyy"
    );
    const text = buildPlainText(data, narration, day);
    const blocks = allBriefingBlocks(data);
    if (blocks.length === 0) {
      return { html: renderEmptyState(data, day), inlineImages: {}, text };
    }
    const { cidByFileId, inlineImages } = loadInlinePreviews(data, thumbnailDeadlineMs);
    console.log(`Inline-Previews geladen: ${Object.keys(inlineImages).length}`);
    const sections = blocks.map((project) => {
      const ai = summaryFor(project, narration.projects);
      const dwgFiles = project.groups.flatMap((g) => g.files).filter(
        (f) => isDwgFile(f) && f.changeKind !== "deleted" && f.changeKind !== "viewed"
      );
      const groupsHtml = project.groups.map((group) => {
        const regular = group.files.filter(
          (f) => !isDwgFile(f) && f.changeKind !== "deleted" && f.changeKind !== "viewed"
        );
        if (regular.length === 0) return "";
        return [
          `<div style="display:inline-block;margin:16px 0 8px;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,0.06);border:1px solid ${HAIRLINE};font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED}">${antiTel(group.folderName)}</div>`,
          renderFileGrid(regular, cidByFileId)
        ].join("");
      }).join("");
      const eyebrow = project.segmentKind === "segment" ? `<div style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${RED_SOFT};margin:0 0 8px">Segment</div>` : "";
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
        `</td></tr>`
      ].join("");
    }).join("");
    const introParts = [
      data.projects.length ? `${data.projects.length} Projekt(e)` : null,
      data.segments.length ? `${data.segments.length} Segment(e)` : null
    ].filter(Boolean);
    const notes = limitNotes(data);
    const intro = `${introParts.join(", ")} mit Aktivit\xE4t ${windowPhrase(data)}.${notes ? ` ${notes}` : ""}`;
    const html = [
      shellOpen(),
      renderHeader(day, intro),
      renderDayOverview(narration.dayOverview),
      sections,
      shellClose()
    ].join("");
    return { html, inlineImages, text };
  }
  function sendBriefingEmail(recipients, data, mail) {
    if (recipients.length === 0) {
      throw new Error(
        "BRIEFING_RECIPIENTS ist leer. Bitte Script Properties setzen."
      );
    }
    const day = Utilities.formatDate(
      new Date(data.generatedAt),
      scriptTz(),
      "yyyy-MM-dd"
    );
    const options = {
      htmlBody: mail.html,
      name: "Drive Digest"
    };
    if (Object.keys(mail.inlineImages).length > 0) {
      options.inlineImages = mail.inlineImages;
    }
    const plain = mail.text.trim() || "Drive Digest";
    GmailApp.sendEmail(
      recipients.join(","),
      `Drive Digest - ${day}`,
      plain,
      options
    );
  }

  // src/openRouterService.ts
  function projectPayload(project) {
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
          type: file.mimeType.includes("pdf") ? "pdf" : file.mimeType.includes("dwg") || /\.dwg$/i.test(file.name) ? "dwg" : file.mimeType.startsWith("image/") ? "image" : "file",
          modifiedTime: file.modifiedTime
        }))
      }))
    };
  }
  function buildPrompt(data) {
    const payload = [
      ...data.projects.map(projectPayload),
      ...data.segments.map(projectPayload)
    ];
    return [
      "You write Drive Digest \u2014 a daily summary of Google Drive activity.",
      "Language: English. Voice: Caveman (juliusbrussee/caveman) \u2014 dense style, full facts.",
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
      "- Sparse data \u2192 short. Busy day \u2192 a few dense sentences / 2 short paragraphs (\\n\\n).",
      "- NEVER put filenames in the text (they appear separately: green New, amber Changed, grey Viewed, red Deleted).",
      "- Use folder and type names sensibly (plans, drawings, photos, docs, \u2026).",
      "",
      "Reply with JSON only:",
      '{"dayOverview":"...","projects":[{"projectId":"...","projectName":"...","summary":"..."}]}',
      "",
      "dayOverview: dense day overview (as long as the situation needs, typically 2-5 sentences).",
      "projects[].projectId: exact projectId from the data, do not change.",
      "projects[].summary: full project picture in Caveman English, no filenames.",
      "JSON must be complete. Prefer shorter over truncated.",
      "",
      "Data (changes since " + data.windowStartIso + ", ~" + data.windowHours + " h):",
      JSON.stringify(payload)
    ].join("\n");
  }
  function contentToText(content) {
    if (!content) return "";
    if (typeof content === "string") return content.trim();
    return content.map((part) => part.text || "").join("").trim();
  }
  function requestNarration(apiKey, model, prompt, maxTokens, hint) {
    const messages = [{ role: "user", content: hint ? `${prompt}
${hint}` : prompt }];
    const send = (withResponseFormat) => {
      const body = {
        model,
        temperature: 0.35,
        max_tokens: maxTokens,
        messages
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
            "X-Title": "Drive-Digest"
          },
          payload: JSON.stringify(body),
          muteHttpExceptions: true
        }
      );
      const raw = response.getContentText();
      const status = response.getResponseCode();
      let json = {};
      try {
        json = JSON.parse(raw);
      } catch {
        json = {};
      }
      return {
        status,
        text: contentToText(json.choices?.[0]?.message?.content),
        finishReason: json.choices?.[0]?.finish_reason || "",
        errorMessage: json.error?.message || "",
        raw
      };
    };
    const first = send(true);
    if (first.status === 400 && /response_format|json_object|structured/i.test(first.raw)) {
      console.warn("OpenRouter akzeptiert response_format nicht, neuer Versuch ohne.");
      return send(false);
    }
    return first;
  }
  function tryParseNarration(text) {
    if (!text) return null;
    try {
      return extractNarration(text);
    } catch (err) {
      console.error(
        `OpenRouter-JSON nicht lesbar: ${String(err)}; Auszug: ${text.slice(0, 180)}`
      );
      return null;
    }
  }
  function summarizeProjectsWithOpenRouter(data, apiKey, model) {
    const empty = { dayOverview: "", projects: [] };
    if (!apiKey || data.projects.length === 0 && data.segments.length === 0) {
      return empty;
    }
    const prompt = buildPrompt(data);
    try {
      const first = requestNarration(apiKey, model, prompt, 4e3, "");
      if (first.status < 200 || first.status >= 300) {
        console.error(
          `OpenRouter HTTP ${first.status}: ${first.errorMessage || first.raw.slice(0, 180)}`
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
        8e3,
        "Vorige Antwort war unvollst\xE4ndig. Antworte k\xFCrzer, aber als vollst\xE4ndiges JSON."
      );
      if (second.status < 200 || second.status >= 300) {
        console.error(
          `OpenRouter Retry HTTP ${second.status}: ${second.errorMessage || second.raw.slice(0, 180)}`
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

  // src/index.ts
  var LOCK_WAIT_MS = 15e3;
  var OPENROUTER_SKIP_AFTER_MS = 5 * 60 * 1e3;
  function emptyNarration() {
    return { dayOverview: "", projects: [] };
  }
  function runDailyBriefingJob() {
    const config = getConfig();
    assertConfigReady(config);
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_WAIT_MS)) {
      console.log("Anderer Briefing-Lauf ist aktiv. Dieser Lauf wird \xFCbersprungen.");
      return;
    }
    const runStartedMs = Date.now();
    try {
      try {
        installDailyTrigger(true);
      } catch (err) {
        console.error(`Trigger-Pr\xFCfung fehlgeschlagen: ${String(err)}`);
      }
      console.log(`Drive Digest Start - Root ${config.rootFolderId}`);
      const { data, pending } = scanRecentProjects(config, runStartedMs);
      console.log(
        `Aktivit\xE4t: ${data.projects.length} Projekt(e), ${data.segments.length} Segment(e), Fenster ab ${data.windowStartIso}`
      );
      let narration = emptyNarration();
      if (Date.now() > runStartedMs + OPENROUTER_SKIP_AFTER_MS) {
        console.warn("OpenRouter \xFCbersprungen wegen Zeitbudget.");
      } else {
        narration = summarizeProjectsWithOpenRouter(
          data,
          config.openRouterApiKey,
          config.openRouterModel
        );
        if (!narration.dayOverview && narration.projects.length === 0 && (data.projects.length > 0 || data.segments.length > 0)) {
          console.log(
            "OpenRouter-Zusammenfassung \xFCbersprungen oder fehlgeschlagen - HTML-Fallback."
          );
        }
      }
      const mail = buildBriefingMail(
        data,
        narration,
        runStartedMs + THUMBNAIL_DEADLINE_MS
      );
      sendBriefingEmail(config.recipients, data, mail);
      console.log(`Briefing gesendet an: ${config.recipients.join(", ")}`);
      commitBriefingState(pending);
      if (pending.lastSuccessfulRunAt) {
        console.log(`lastSuccessfulRunAt gesetzt: ${pending.lastSuccessfulRunAt}`);
      } else {
        console.log(
          "lastSuccessfulRunAt nicht verschoben (Scan unvollst\xE4ndig, n\xE4chster Lauf holt den Rest)."
        );
      }
    } finally {
      lock.releaseLock();
    }
  }
  function installDailyTrigger(quiet = false) {
    const tz = Session.getScriptTimeZone() || "Etc/UTC";
    const handlers = ScriptApp.getProjectTriggers().filter(
      (trigger) => trigger.getHandlerFunction() === "runDailyBriefing"
    );
    if (handlers.length === 1) {
      if (!quiet) {
        console.log(
          `T\xE4glicher Trigger f\xFCr runDailyBriefing um 05:00 ${tz} ist bereits gesetzt.`
        );
      }
      return;
    }
    handlers.forEach((trigger) => ScriptApp.deleteTrigger(trigger));
    ScriptApp.newTrigger("runDailyBriefing").timeBased().atHour(5).everyDays(1).inTimezone(tz).create();
    console.log(`T\xE4glicher Trigger f\xFCr runDailyBriefing um 05:00 ${tz} gesetzt.`);
  }
  function showBriefingConfig() {
    const config = getConfig();
    const props = PropertiesService.getScriptProperties().getProperties();
    console.log("--- Briefing Config ---");
    console.log(`BRIEFING_RECIPIENTS raw: ${props.BRIEFING_RECIPIENTS || "(nicht gesetzt)"}`);
    console.log(`Empf\xE4nger parsed: ${config.recipients.join(", ") || "(leer)"}`);
    console.log(`ROOT_FOLDER_ID: ${config.rootFolderId}`);
    console.log(
      `OPENROUTER_API_KEY: ${config.openRouterApiKey ? "(gesetzt)" : "(leer)"}`
    );
    console.log(`L\xE4ufer: ${Session.getActiveUser().getEmail() || "(unbekannt)"}`);
    console.log("Nur Script Properties z\xE4hlen - User Properties werden ignoriert.");
  }
  globalThis.__gasExports = {
    runDailyBriefing: runDailyBriefingJob,
    installDailyTrigger: () => installDailyTrigger(false),
    showBriefingConfig
  };
})();
function runDailyBriefing(){ return globalThis.__gasExports.runDailyBriefing(); }
function installDailyTrigger(){ return globalThis.__gasExports.installDailyTrigger(); }
function showBriefingConfig(){ return globalThis.__gasExports.showBriefingConfig(); }
