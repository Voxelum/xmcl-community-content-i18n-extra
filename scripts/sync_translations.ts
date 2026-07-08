// Incremental sync of the `<locale>_translation` MongoDB collections into this
// repo (`<locale>/<id>.json`).
//
// The documents have no "updated at" field, so detecting changes requires
// looking at every document. To keep that cheap we scan only a lightweight
// `{ _id, bodyHash }` projection (the big `content` field is skipped), compare
// each `bodyHash` against what is already on disk, and download the full
// document *only* for ids that are new or whose translation changed. Unchanged
// entries are never re-fetched or re-written, so a run touches just the delta.
//
// Note: this is additive/update-only. Documents deleted from the database are
// left on disk (harmless: the API validates `bodyHash` and falls through). Use
// `dump_translations.ts` for a full re-dump / reseed.
//
// Run with:
//   deno run --allow-net --allow-read --allow-write --allow-env scripts/sync_translations.ts
//
// Options (env):
//   MONGO_CONNECION_STRING  Mongo connection string (required)
//   MONGODB_NAME            Database name (default: "coturn")
//   TRANSLATIONS_OUT_DIR    Output directory (default: ".", the repo root)
//   TRANSLATIONS_SCAN_BATCH Ids scanned per round-trip (default: 2000)
//   TRANSLATIONS_FETCH_BATCH Docs fetched per content request (default: 200)
//   TRANSLATIONS_PAGE_TIMEOUT_MS  Per-request timeout (default: 60000)

import { MongoClient } from "mongo";

const connStr = Deno.env.get("MONGO_CONNECION_STRING");
if (!connStr) {
  console.error("MONGO_CONNECION_STRING is not set");
  Deno.exit(1);
}

const dbName = Deno.env.get("MONGODB_NAME") || "coturn";
const outDir = Deno.env.get("TRANSLATIONS_OUT_DIR") || ".";
// The scan payload is tiny (id + hash), so large pages mean fewer round-trips.
const SCAN_BATCH = Number(Deno.env.get("TRANSLATIONS_SCAN_BATCH")) || 2000;
const FETCH_BATCH = Number(Deno.env.get("TRANSLATIONS_FETCH_BATCH")) || 200;
const PAGE_TIMEOUT_MS = Number(Deno.env.get("TRANSLATIONS_PAGE_TIMEOUT_MS")) ||
  60000;

const SUFFIX = "_translation";

/** Reject if a promise does not settle within `ms`. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
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

/**
 * The `bodyHash` currently stored on disk for a file, or undefined if the file
 * is missing. `bodyHash` is the first key of every file, so a short prefix read
 * avoids parsing the (potentially large) `content`.
 */
async function diskBodyHash(path: string): Promise<string | undefined> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
  try {
    const buf = new Uint8Array(256);
    const n = await file.read(buf) ?? 0;
    const head = new TextDecoder().decode(buf.subarray(0, n));
    return head.match(/"bodyHash"\s*:\s*"([^"]*)"/)?.[1];
  } finally {
    file.close();
  }
}

function* chunks<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

const client = new MongoClient();
await client.connect(connStr);
const db = client.database(dbName);

const names = await db.listCollectionNames();
const collections = names.filter((n) => n.endsWith(SUFFIX));

console.log(
  `Found ${collections.length} translation collection(s) in "${dbName}".`,
);

let totalWritten = 0;
let totalScanned = 0;

for (const name of collections) {
  const locale = name.slice(0, -SUFFIX.length);
  const coll = db.collection<Record<string, unknown>>(name);
  const localeDir = `${outDir}/${locale}`;
  await Deno.mkdir(localeDir, { recursive: true });

  // Phase 1: scan every `{ _id, bodyHash }` and collect ids whose translation
  // is missing or stale on disk.
  const changed: string[] = [];
  let scanned = 0;
  let lastId: string | undefined;
  while (true) {
    const filter = lastId === undefined ? {} : { _id: { $gt: lastId } };
    const page = await withTimeout(
      coll
        .find(
          filter,
          {
            projection: { bodyHash: 1 },
            batchSize: SCAN_BATCH,
          } as unknown as Parameters<typeof coll.find>[1],
        )
        .sort({ _id: 1 })
        .limit(SCAN_BATCH)
        .toArray(),
      PAGE_TIMEOUT_MS,
      `[${locale}] scan after ${JSON.stringify(lastId ?? "<start>")}`,
    );
    if (page.length === 0) break;

    for (const doc of page) {
      const id = String(doc._id);
      if (!isSafeId(id)) {
        console.warn(`  [${locale}] skipping unsafe id: ${JSON.stringify(id)}`);
        continue;
      }
      const bodyHash = typeof doc.bodyHash === "string" ? doc.bodyHash : "";
      if (await diskBodyHash(`${localeDir}/${id}.json`) !== bodyHash) {
        changed.push(id);
      }
    }

    scanned += page.length;
    lastId = String(page[page.length - 1]._id);
    if (page.length < SCAN_BATCH) break;
  }

  // Phase 2: download full documents only for the changed/new ids and write.
  let written = 0;
  for (const batch of chunks(changed, FETCH_BATCH)) {
    const docs = await withTimeout(
      coll
        .find(
          { _id: { $in: batch } },
          { batchSize: batch.length } as unknown as Parameters<
            typeof coll.find
          >[1],
        )
        .toArray(),
      PAGE_TIMEOUT_MS,
      `[${locale}] fetch ${batch.length} doc(s)`,
    );
    for (const doc of docs) {
      const id = String(doc._id);
      if (!isSafeId(id)) continue;
      const { _id: _ignored, ...rest } = doc;
      await Deno.writeTextFile(
        `${localeDir}/${id}.json`,
        JSON.stringify(rest, null, 2) + "\n",
      );
      written++;
    }
  }

  totalScanned += scanned;
  totalWritten += written;
  console.log(
    `  [${locale}] scanned ${scanned}, updated ${written} -> ${localeDir}`,
  );
}

console.log(
  `Done. Scanned ${totalScanned} document(s), updated ${totalWritten} across ` +
    `${collections.length} locale(s).`,
);

await client.close();
