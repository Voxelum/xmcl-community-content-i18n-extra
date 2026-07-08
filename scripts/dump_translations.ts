// Dump every `<locale>_translation` MongoDB collection into this repo as
// `<locale>/<id>.json` files (one document per file, minus `_id`).
//
// Each JSON file mirrors the stored document, i.e.
// `{ bodyHash, content, contentType, type }`.
//
// Run with:
//   deno run --allow-net --allow-read --allow-write --allow-env scripts/dump_translations.ts
//
// Options (env):
//   MONGO_CONNECION_STRING  Mongo connection string (required)
//   MONGODB_NAME            Database name (default: "coturn")
//   TRANSLATIONS_OUT_DIR    Output directory (default: ".", the repo root)
//   TRANSLATIONS_BATCH_SIZE Docs fetched per round-trip (default: 500)
//   TRANSLATIONS_OVERWRITE  Re-write files already on disk (default: off).
//                           By default the dump is resumable: existing files are
//                           skipped so re-runs only fetch what's missing.
//   TRANSLATIONS_NO_RESUME  Full scan from the start instead of resuming past
//                           the highest id on disk (default: off). Use to
//                           backfill docs inserted while a prior run was live.
//   TRANSLATIONS_PAGE_TIMEOUT_MS  Per-page fetch timeout (default: 60000).

import { MongoClient } from "mongo";

const connStr = Deno.env.get("MONGO_CONNECION_STRING");
if (!connStr) {
  console.error("MONGO_CONNECION_STRING is not set");
  Deno.exit(1);
}

const dbName = Deno.env.get("MONGODB_NAME") || "coturn";
const outDir = Deno.env.get("TRANSLATIONS_OUT_DIR") || ".";
// deno_mongo defaults the wire `batchSize` to 1, i.e. one network round-trip
// per document. Overriding it makes the server return whole pages at a time,
// so a collection with thousands of entries stays fast while never holding
// more than one page in memory.
const BATCH_SIZE = Number(Deno.env.get("TRANSLATIONS_BATCH_SIZE")) || 500;
// Resumable by default: only overwrite existing files when explicitly asked.
const OVERWRITE = /^(1|true|yes)$/i.test(
  Deno.env.get("TRANSLATIONS_OVERWRITE") ?? "",
);
// Resume normally skips straight past the highest `_id` already on disk. On a
// live collection that misses documents inserted below the high-water mark
// while a previous run was in flight. Set this to force a full scan from the
// start (still skipping files already written) to backfill those stragglers.
const NO_RESUME = /^(1|true|yes)$/i.test(
  Deno.env.get("TRANSLATIONS_NO_RESUME") ?? "",
);
// A single stalled Cosmos request would otherwise block the whole dump forever.
// Cap each page fetch so a stall fails fast; the caller can just re-run and
// resume from the last written `_id`.
const PAGE_TIMEOUT_MS = Number(Deno.env.get("TRANSLATIONS_PAGE_TIMEOUT_MS")) ||
  60000;

const SUFFIX = "_translation";

/** Reject if a promise does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Guard against ids that could escape the locale folder on disk. */
function isSafeId(id: string): boolean {
  return id.length > 0 && !id.includes("/") && !id.includes("\\") &&
    !id.includes("..") && !id.includes("\0");
}

const client = new MongoClient();
await client.connect(connStr);
const db = client.database(dbName);

const names = await db.listCollectionNames();
const collections = names.filter((n) => n.endsWith(SUFFIX));

console.log(`Found ${collections.length} translation collection(s) in "${dbName}".`);

let totalDocs = 0;
let totalSkipped = 0;
let totalExisting = 0;

/** Whether a file already exists on disk. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Highest `<id>` already dumped for a locale, or undefined if none. Files are
 * written in ascending `_id` order and every `_id` is a string, so the lexical
 * maximum of the file names is the high-water mark to resume after.
 */
async function maxExistingId(dir: string): Promise<string | undefined> {
  let max: string | undefined;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (max === undefined || id > max) max = id;
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
  return max;
}

for (const name of collections) {
  const locale = name.slice(0, -SUFFIX.length);
  const coll = db.collection<Record<string, unknown>>(name);

  const localeDir = `${outDir}/${locale}`;
  await Deno.mkdir(localeDir, { recursive: true });
  let written = 0;
  let existing = 0;
  let scanned = 0;

  // Resume from the highest `_id` already on disk so we never re-read a locale
  // that is already dumped. Because pages are written in ascending `_id` order,
  // this high-water mark lets an interrupted run continue in one cheap query
  // instead of re-scanning tens of thousands of documents.
  let lastId: string | undefined = (OVERWRITE || NO_RESUME)
    ? undefined
    : await maxExistingId(localeDir);
  if (lastId !== undefined) {
    console.log(`  [${locale}] resuming after _id ${JSON.stringify(lastId)}`);
  }

  // Page through the collection by `_id` range instead of a single server-side
  // cursor. Each page is one independent request (`batchSize == limit`, so the
  // whole page arrives in the first batch and no `getMore` is issued). This is
  // robust against Cosmos DB cursor expiry/throttling that can hang a long
  // `getMore` stream, while never holding more than one page in memory.
  // Every `_id` in these collections is a string, so a lexical `$gt` range walks
  // the whole collection exactly once.
  while (true) {
    const filter = lastId === undefined ? {} : { _id: { $gt: lastId } };
    const page = await withTimeout(
      coll
        .find(
          filter,
          { batchSize: BATCH_SIZE } as unknown as Parameters<typeof coll.find>[1],
        )
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .toArray(),
      PAGE_TIMEOUT_MS,
      `[${locale}] page after ${JSON.stringify(lastId ?? "<start>")}`,
    );

    if (page.length === 0) break;

    for (const doc of page) {
      const id = String(doc._id);
      if (!isSafeId(id)) {
        console.warn(`  [${locale}] skipping unsafe id: ${JSON.stringify(id)}`);
        totalSkipped++;
        continue;
      }

      const filePath = `${localeDir}/${id}.json`;

      // The goal is to dump every document once. Skip anything already on disk
      // so re-runs only fetch what's missing instead of redoing the export.
      if (!OVERWRITE && await fileExists(filePath)) {
        existing++;
        continue;
      }

      const { _id: _ignored, ...rest } = doc;
      await Deno.writeTextFile(filePath, JSON.stringify(rest, null, 2) + "\n");
      written++;
    }

    scanned += page.length;
    lastId = String(page[page.length - 1]._id);
    console.log(
      `  [${locale}] scanned ${scanned}, wrote ${written}, existing ${existing}`,
    );
    if (page.length < BATCH_SIZE) break;
  }

  totalDocs += written;
  totalExisting += existing;
  console.log(
    `  [${locale}] wrote ${written} document(s)` +
      (existing ? `, skipped ${existing} already on disk` : "") +
      ` -> ${localeDir}`,
  );
}

console.log(
  `Done. Wrote ${totalDocs} document(s) across ${collections.length} locale(s)` +
    (totalExisting ? `, ${totalExisting} already existed` : "") +
    (totalSkipped ? `, skipped ${totalSkipped}.` : "."),
);

await client.close();
