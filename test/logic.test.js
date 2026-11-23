const test = require("node:test");
const assert = require("node:assert/strict");
const logic = require("../.test-dist/briefingLogic.js");

function file(partial) {
  return {
    id: partial.id,
    name: partial.name || partial.id,
    mimeType: partial.mimeType || "application/pdf",
    webViewLink: `https://drive.google.com/file/d/${partial.id}/view`,
    createdTime: partial.createdTime || "",
    modifiedTime: partial.modifiedTime || "",
    parentFolderId: partial.parentFolderId || "root",
    parentFolderName: partial.parentFolderName || "Dateien",
    hasPreview: false,
    changeKind: partial.changeKind || "modified",
  };
}

function item(id, extra = {}) {
  return {
    id,
    name: extra.name || id,
    mimeType: extra.mimeType || "application/pdf",
    projectId: extra.projectId || "proj",
    projectName: extra.projectName || "Projekt",
    parentFolderId: extra.parentFolderId || "proj",
    parentFolderName: extra.parentFolderName || "Dateien",
  };
}

function project(id, activity, fileCount, kind = "project") {
  return {
    id,
    name: id,
    latestActivity: activity,
    segmentKind: kind,
    groups: [
      {
        folderName: "Dateien",
        files: Array.from({ length: fileCount }, (_, index) =>
          file({
            id: `${id}-${index}`,
            modifiedTime: activity,
            parentFolderId: id,
          }),
        ),
      },
    ],
  };
}

test("typeLabel marks DWG before the generic image bucket", () => {
  assert.equal(logic.typeLabel("image/vnd.dwg"), "DWG");
  assert.equal(logic.typeLabel("image/x-dwg"), "DWG");
  assert.equal(logic.typeLabel("application/acad"), "Datei");
  assert.equal(logic.typeLabel("IMAGE/PNG"), "Bild");
  assert.equal(logic.typeLabel("application/pdf"), "PDF");
});

test("resolveWindowStart falls back to 24h and ignores garbage", () => {
  const now = Date.parse("2026-11-23T05:00:00.000Z");
  const missing = logic.resolveWindowStart(null, now, 24);
  assert.equal(missing.usedFallback, true);
  assert.equal(missing.startIso, "2026-11-22T05:00:00.000Z");

  const stored = logic.resolveWindowStart("2026-11-20T05:00:00.000Z", now, 24);
  assert.equal(stored.usedFallback, false);
  assert.equal(stored.startIso, "2026-11-20T05:00:00.000Z");

  const future = logic.resolveWindowStart("2026-12-01T00:00:00.000Z", now, 24);
  assert.equal(future.usedFallback, true);

  const junk = logic.resolveWindowStart("gestern", now, 24);
  assert.equal(junk.usedFallback, true);
});

test("deleted files are reported once, then dropped from the survivor snapshot", () => {
  const previous = [item("a", { name: "alt.pdf" }), item("b", { name: "bleibt.pdf" })];
  const live = new Set(["b"]);
  const deleted = logic.deletedFromSnapshot(
    previous,
    live,
    "proj",
    "2026-11-22T05:00:00.000Z",
    "2026-11-23T05:00:00.000Z",
  );
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].id, "a");
  assert.equal(deleted[0].changeKind, "deleted");
  assert.equal(deleted[0].name, "alt.pdf");
  assert.equal(deleted[0].modifiedTime, "2026-11-23T05:00:00.000Z");

  const survivors = logic.inventoryKeepingSurvivors(previous, live);
  assert.deepEqual(
    survivors.map((entry) => entry.id),
    ["b"],
  );
  const again = logic.deletedFromSnapshot(
    survivors,
    live,
    "proj",
    "2026-11-22T05:00:00.000Z",
    "2026-11-24T05:00:00.000Z",
  );
  assert.equal(again.length, 0);
});

test("mergeFiles keeps a live file when a deletion for the same id is also present", () => {
  const merged = logic.mergeFiles([
    file({ id: "1", changeKind: "deleted", modifiedTime: "2026-11-23T06:00:00.000Z" }),
    file({ id: "1", changeKind: "modified", modifiedTime: "2026-11-23T05:00:00.000Z" }),
    file({ id: "2", changeKind: "deleted", modifiedTime: "2026-11-23T04:00:00.000Z" }),
  ]);
  const byId = new Map(merged.map((entry) => [entry.id, entry.changeKind]));
  assert.equal(byId.get("1"), "modified");
  assert.equal(byId.get("2"), "deleted");
});

test("inventory chunks stay within a UTF-8 byte budget and round-trip", () => {
  const name = "ä".repeat(80);
  const items = Array.from({ length: 25 }, (_, index) =>
    item(`id-${index}`, { name, parentFolderName: "Plans" }),
  );
  const whole = logic.encodeChunk(items);
  assert.ok(logic.utf8ByteLength(whole) > whole.length);
  assert.ok(logic.utf8ByteLength(whole) > 500);

  const chunks = logic.splitInventoryChunks(items, 500);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(logic.utf8ByteLength(chunk) <= 500);
  }

  const store = {};
  const manifest = logic.encodeManifest(chunks.length, "Projekt", "gen1");
  store[logic.inventoryKey("proj")] = manifest;
  chunks.forEach((chunk, index) => {
    store[logic.inventoryChunkKey("proj", "gen1", index)] = chunk;
  });

  const decoded = logic.decodeInventoryRecord(store[logic.inventoryKey("proj")], (key) => store[key], {
    projectId: "proj",
    projectName: "Projekt",
  });
  assert.equal(decoded.length, items.length);
  assert.equal(decoded[0].name, name);
  assert.equal(decoded[0].parentFolderName, "Plans");
  assert.equal(decoded[0].projectId, "proj");
});

test("legacy inventory JSON still loads, and an unflipped generation does not hide it", () => {
  const legacy = [
    item("alt", { name: "alt.pdf", projectName: "Aus Bestand" }),
    item("neu"),
  ];
  const fromLegacy = logic.decodeInventoryRecord(JSON.stringify(legacy), () => {
    throw new Error("legacy load must not read chunks");
  }, { projectId: "proj", projectName: "Fallback" });
  assert.deepEqual(
    fromLegacy.map((entry) => entry.name),
    ["alt.pdf", "neu"],
  );
  assert.equal(fromLegacy[0].projectName, "Aus Bestand");

  const store = {
    [logic.inventoryKey("proj")]: logic.encodeManifest(1, "Projekt", "gen-old"),
    [logic.inventoryChunkKey("proj", "gen-old", 0)]: logic.encodeChunk([item("a"), item("b")]),
    [logic.inventoryChunkKey("proj", "gen-new", 0)]: logic.encodeChunk([item("b")]),
  };
  const visible = logic.decodeInventoryRecord(
    store[logic.inventoryKey("proj")],
    (key) => store[key],
    { projectId: "proj", projectName: "Projekt" },
  );
  assert.deepEqual(
    visible.map((entry) => entry.id),
    ["a", "b"],
  );
});

test("briefing order keeps every file and sorts by activity", () => {
  const ordered = logic.sortBriefingBlocks(
    [
      project("old", "2020-01-01T00:00:00.000Z", 5),
      project("new", "2026-01-01T00:00:00.000Z", 9),
    ],
    [project("seg", "2025-01-01T00:00:00.000Z", 5, "segment")],
  );
  assert.deepEqual(
    ordered.projects.map((entry) => entry.id),
    ["new", "old"],
  );
  assert.equal(ordered.projects[0].groups[0].files.length, 9);
  assert.equal(ordered.projects[1].groups[0].files.length, 5);
  assert.equal(ordered.segments[0].groups[0].files.length, 5);
});

test("scan progress advances the cursor only after a finished cycle", () => {
  const finished = logic.planScanProgress({
    orderedIds: ["a", "b"],
    startOffset: 0,
    visitedIds: ["a", "b"],
    previousSeen: [],
    previousCycleStartedAt: null,
    runStartedAt: "2026-11-23T04:00:00.000Z",
    incomplete: false,
    allowCycleAdvance: true,
  });
  assert.equal(finished.lastSuccessfulRunAt, "2026-11-23T04:00:00.000Z");
  assert.equal(finished.scanOffset, 0);
  assert.equal(finished.cycleSeen, null);

  const partial = logic.planScanProgress({
    orderedIds: ["a", "b", "c", "d"],
    startOffset: 2,
    visitedIds: ["c", "d"],
    previousSeen: [],
    previousCycleStartedAt: null,
    runStartedAt: "2026-11-23T04:00:00.000Z",
    incomplete: true,
    allowCycleAdvance: true,
  });
  assert.equal(partial.lastSuccessfulRunAt, undefined);
  assert.equal(partial.scanOffset, 0);
  assert.deepEqual(partial.cycleSeen, ["c", "d"]);
  assert.equal(partial.cycleStartedAt, "2026-11-23T04:00:00.000Z");

  const covered = logic.planScanProgress({
    orderedIds: ["a", "b", "c", "d"],
    startOffset: 0,
    visitedIds: ["a", "b"],
    previousSeen: ["c", "d"],
    previousCycleStartedAt: "2026-11-22T04:00:00.000Z",
    runStartedAt: "2026-11-23T04:00:00.000Z",
    incomplete: true,
    allowCycleAdvance: true,
  });
  assert.equal(covered.lastSuccessfulRunAt, "2026-11-22T04:00:00.000Z");
  assert.equal(covered.cycleSeen, null);

  const changesBlocked = logic.planScanProgress({
    orderedIds: ["a", "b"],
    startOffset: 0,
    visitedIds: ["a", "b"],
    previousSeen: [],
    previousCycleStartedAt: "2026-11-22T04:00:00.000Z",
    runStartedAt: "2026-11-23T04:00:00.000Z",
    incomplete: true,
    allowCycleAdvance: false,
  });
  assert.equal(changesBlocked.lastSuccessfulRunAt, undefined);

  const failedListing = logic.planScanProgress({
    orderedIds: [],
    startOffset: 0,
    visitedIds: [],
    previousSeen: [],
    previousCycleStartedAt: null,
    runStartedAt: "2026-11-23T04:00:00.000Z",
    incomplete: true,
    allowCycleAdvance: false,
  });
  assert.equal(failedListing.lastSuccessfulRunAt, undefined);
});

test("summaryFor prefers the stable project id", () => {
  const summaries = [
    { projectId: "a", projectName: "Gleich", summary: "von A" },
    { projectId: "b", projectName: "Gleich", summary: "von B" },
  ];
  assert.equal(logic.summaryFor({ id: "b", name: "Gleich" }, summaries), "von B");
  assert.equal(logic.summaryFor({ id: "", name: "Gleich" }, summaries), "von A");
  assert.equal(logic.summaryFor({ id: "fehlt", name: "Gleich" }, summaries), "von A");
});

test("extractNarration reads fenced JSON and repairs a cut-off answer", () => {
  const fenced = logic.extractNarration(
    '```json\n{"dayOverview":"Ok","projects":[{"projectId":"x","projectName":"N","summary":"Kurz"}]}\n```',
  );
  assert.equal(fenced.dayOverview, "Ok");
  assert.equal(fenced.projects[0].projectId, "x");

  const cut = logic.extractNarration(
    '{"dayOverview":"Viel los.","projects":[{"projectId":"p1","projectName":"A","summary":"Plan neu."},{"projectId":"p2","projectName":"B","summary":"Foto geschn',
  );
  assert.equal(cut.dayOverview, "Viel los.");
  assert.equal(cut.projects.length, 2);
  assert.equal(cut.projects[1].projectId, "p2");
  assert.match(cut.projects[1].summary, /Foto/);

  const dangling = logic.extractNarration('{"dayOverview":"Hi","proj');
  assert.equal(dangling.dayOverview, "Hi");
  assert.equal(dangling.projects.length, 0);
});

test("hidden inventory file keeps every project and round-trips names", () => {
  const raw = logic.encodeInventoryFile([
    {
      projectId: "p1",
      projectName: "Nordbahn",
      items: [item("a", { name: "Plan ä.pdf", projectId: "p1", projectName: "Nordbahn" })],
    },
    {
      projectId: "p2",
      projectName: "Harbor",
      items: [item("b", { projectId: "p2", parentFolderName: "Plans" })],
    },
  ]);
  const decoded = logic.decodeInventoryFile(raw);
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].items[0].name, "Plan ä.pdf");
  assert.equal(decoded[1].items[0].parentFolderName, "Plans");
  assert.equal(logic.decodeInventoryFile("{"), null);
  assert.equal(logic.decodeInventoryFile("{\"v\":2}"), null);
});

test("inventory keys do not collide across folder ids", () => {
  assert.equal(logic.isInventoryKeyForProject("abc", logic.inventoryKey("abc_def")), false);
  assert.equal(
    logic.isInventoryKeyForProject("abc", logic.inventoryChunkKey("abc", "m5k2", 0)),
    true,
  );
  assert.equal(
    logic.isInventoryKeyForProject("abc", logic.inventoryChunkKey("abc_def", "m5k2", 0)),
    false,
  );
});

test("retry policy covers 429 and 5xx only", () => {
  assert.equal(logic.shouldRetryHttpStatus(429), true);
  assert.equal(logic.shouldRetryHttpStatus(503), true);
  assert.equal(logic.shouldRetryHttpStatus(408), true);
  assert.equal(logic.shouldRetryHttpStatus(404), false);
  assert.equal(logic.shouldRetryHttpStatus(400), false);
  assert.equal(logic.isRetryableMessage("User rate limit exceeded"), true);
  assert.equal(logic.isRetryableMessage("File not found"), false);

  const first = logic.retryBackoffMs(0, () => 0);
  const second = logic.retryBackoffMs(1, () => 0);
  assert.ok(second > first);
  assert.ok(logic.retryBackoffMs(10, () => 0) <= 8000);
});
