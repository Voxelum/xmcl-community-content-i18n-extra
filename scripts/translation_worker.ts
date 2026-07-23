// Processes the lightweight translation ledger produced by xmcl-web-api.
//
// The ledger deliberately contains only metadata and a bodyHash. This worker
// fetches the upstream description again before sending it to the translation
// model, so descriptions are never persisted in request records.
//
// Run with:
//   deno task translate -- --limit 25 --language zh-CN
//
// Configuration:
//   MONGO_CONNECION_STRING           MongoDB / Cosmos connection string (required)
//   MONGODB_NAME                     Database name (default: coturn)
//   AGNES_API_KEY                    OpenAI-compatible Agnes API key (required)
//   CURSEFORGE_KEY                   CurseForge API key (required for CurseForge)
//   TRANSLATION_REQUESTS_COLLECTION  Ledger collection (default: translation_requests)
//   TRANSLATIONS_OUT_DIR             Static-content output root (default: .)
//   AI_TRANSLATION_ENDPOINT          Chat-completions endpoint
//   AI_TRANSLATION_MODEL             Chat model (default: agnes-2.0-flash)
//   TRANSLATION_WORKER_LIMIT         Maximum requests per run (default: 25)
//   TRANSLATION_WORKER_LANGUAGE      Target locale filter
//   TRANSLATION_WORKER_DRY_RUN       Inspect only; never claim, translate, or write

import {
  MongoClient,
  type Collection,
  type Database,
  type Document,
} from "mongo";
import xxhash from "xxhash-wasm";

export const REQUEST_COLLECTION = "translation_requests";
const DEFAULT_AI_ENDPOINT = "https://apihub.agnes-ai.com/v1/chat/completions";
const DEFAULT_AI_MODEL = "agnes-2.0-flash";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 500;
const LEASE_MS = 25 * 60_000;
const SOURCE_TIMEOUT_MS = 30_000;
const AI_TIMEOUT_MS = 120_000;

export type TranslationType = "modrinth" | "curseforge";

export interface TranslationRequest {
  _id: string;
  lang: string;
  type: TranslationType;
  projectId: string;
  bodyHash: string;
  contentType: "text/markdown" | "text/html";
  claimToken: string;
}

interface TranslationCacheEntry extends Document {
  _id: string;
  bodyHash?: unknown;
  content?: unknown;
  contentType?: unknown;
  type?: unknown;
}

export interface WorkerOptions {
  connStr: string;
  dbName: string;
  agnesKey: string;
  curseforgeKey?: string;
  requestCollection: string;
  outDir: string;
  endpoint: string;
  model: string;
  limit: number;
  language?: string;
  dryRun: boolean;
}

interface SourceDescription {
  body: string;
  contentType: "text/markdown" | "text/html";
}

interface TranslationResult {
  content: string;
}

interface WorkOutcome {
  kind: "translated" | "cached" | "source-changed" | "deferred" | "failed";
  changedFile?: string;
}

interface WorkerStats {
  claimed: number;
  translated: number;
  cached: number;
  sourceChanged: number;
  deferred: number;
  failures: number;
  changedFiles: string[];
}

type FetchLike = typeof fetch;

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function isLocale(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9-]*$/.test(value);
}

function contentTypeFor(type: TranslationType): "text/markdown" | "text/html" {
  return type === "modrinth" ? "text/markdown" : "text/html";
}

function stringField(doc: Document, key: string): string | undefined {
  const value = doc[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Convert a claimed ledger record to the strict worker contract. A request
 * cannot carry `body` or `content`: source descriptions belong only upstream
 * and in the final translation cache.
 */
export function parseRequest(doc: Document): TranslationRequest | Error {
  if ("body" in doc || "description" in doc || "content" in doc) {
    return new Error("request contains source or translated content");
  }

  const id = stringField(doc, "_id");
  const lang = stringField(doc, "lang");
  const type = stringField(doc, "type");
  const projectId = stringField(doc, "projectId");
  const bodyHash = stringField(doc, "bodyHash");
  const claimToken = stringField(doc, "claimToken");

  if (!id || !lang || !type || !projectId || !bodyHash || !claimToken) {
    return new Error(
      "request is missing _id, lang, type, projectId, bodyHash, or claimToken",
    );
  }
  if (!isSafeSegment(projectId) || !isLocale(lang)) {
    return new Error("request has an unsafe projectId or lang");
  }
  if (type !== "modrinth" && type !== "curseforge") {
    return new Error("request type must be modrinth or curseforge");
  }

  const contentType = contentTypeFor(type);
  if (doc.contentType !== undefined && doc.contentType !== contentType) {
    return new Error(`request contentType must be ${contentType}`);
  }

  return {
    _id: id,
    lang,
    type,
    projectId,
    bodyHash,
    contentType,
    claimToken,
  };
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_LIMIT)
    : fallback;
}

function flagValue(args: string[], name: string): string | undefined {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function optionsFromEnvironment(
  env: Record<string, string | undefined> = Deno.env.toObject(),
  args: string[] = Deno.args,
): WorkerOptions {
  const dryRun = args.includes("--dry-run") ||
    /^(1|true|yes)$/i.test(env.TRANSLATION_WORKER_DRY_RUN ?? "");
  const language = flagValue(args, "--language") ??
    env.TRANSLATION_WORKER_LANGUAGE;
  if (language && !isLocale(language)) {
    throw new Error("language must be a locale such as zh-CN");
  }

  const connStr = env.MONGO_CONNECION_STRING;
  const agnesKey = env.AGNES_API_KEY;
  if (!connStr) throw new Error("MONGO_CONNECION_STRING is not set");
  if (!agnesKey && !dryRun) throw new Error("AGNES_API_KEY is not set");

  return {
    connStr,
    dbName: env.MONGODB_NAME || "coturn",
    agnesKey: agnesKey || "",
    curseforgeKey: env.CURSEFORGE_KEY,
    requestCollection: env.TRANSLATION_REQUESTS_COLLECTION ||
      REQUEST_COLLECTION,
    outDir: env.TRANSLATIONS_OUT_DIR || ".",
    endpoint: env.AI_TRANSLATION_ENDPOINT || DEFAULT_AI_ENDPOINT,
    model: env.AI_TRANSLATION_MODEL || DEFAULT_AI_MODEL,
    limit: numberFromEnv(
      flagValue(args, "--limit") ?? env.TRANSLATION_WORKER_LIMIT,
      DEFAULT_LIMIT,
    ),
    language,
    dryRun,
  };
}

export function claimableRequestFilter(now: Date, language?: string): Document {
  const filter: Document = {
    $and: [
      {
        $or: [
          {
            $and: [
              { status: "pending" },
              {
                $or: [
                  { notBefore: { $exists: false } },
                  { notBefore: null },
                  { notBefore: { $lte: now } },
                ],
              },
            ],
          },
          {
            $and: [
              { status: "failed" },
              { notBefore: { $lte: now } },
            ],
          },
        ],
      },
      {
        $or: [
          { leaseExpiresAt: { $exists: false } },
          { leaseExpiresAt: { $lte: now } },
        ],
      },
    ],
  };
  if (language) filter.lang = language;
  return filter;
}

async function claimRequest(
  requests: Collection<Document>,
  workerId: string,
  language?: string,
): Promise<Document | undefined> {
  const now = new Date();
  const claimToken = crypto.randomUUID();
  // deno_mongo v0.31 exposes Mongo/Cosmos's atomic find-and-update operation
  // as findAndModify; it does not implement findOneAndUpdate.
  return await requests.findAndModify(
    claimableRequestFilter(now, language),
    claimOptions(workerId, claimToken, now),
  ) as Document | undefined;
}

export function claimOptions(
  workerId: string,
  claimToken: string,
  now: Date,
): Document {
  return {
    new: true,
    update: claimUpdate(workerId, claimToken, now),
  };
}

export function claimUpdate(
  workerId: string,
  claimToken: string,
  now: Date,
): Document {
  return {
    $set: {
      status: "pending",
      claimedBy: workerId,
      claimToken,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      claimedAt: now,
      updatedAt: now,
    },
    $unset: { notBefore: "" },
    $inc: { attempts: 1 },
  };
}

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Errors must remain diagnostics, never a copy of an upstream description.
  return message.replace(/\s+/g, " ").slice(0, 500);
}

export function completionFilter(request: TranslationRequest): Document {
  return {
    _id: request._id,
    bodyHash: request.bodyHash,
    status: "pending",
    claimToken: request.claimToken,
  };
}

async function updateClaim(
  requests: Collection<Document>,
  request: TranslationRequest,
  update: Document,
): Promise<void> {
  const result = await requests.updateOne(
    completionFilter(request),
    update,
  );
  if (result.matchedCount !== 1) {
    throw new Error(`lost claim for request ${request._id}`);
  }
}

async function markSucceeded(
  requests: Collection<Document>,
  request: TranslationRequest,
): Promise<void> {
  const now = new Date();
  await updateClaim(requests, request, {
    $set: {
      status: "succeeded",
      completedAt: now,
      updatedAt: now,
    },
    $unset: {
      claimedBy: "",
      claimToken: "",
      leaseExpiresAt: "",
      notBefore: "",
      lastError: "",
    },
  });
}

async function requeueSourceChange(
  requests: Collection<Document>,
  request: TranslationRequest,
  bodyHash: string,
): Promise<void> {
  const now = new Date();
  await updateClaim(requests, request, {
    $set: {
      status: "pending",
      bodyHash,
      updatedAt: now,
    },
    $unset: {
      claimedBy: "",
      claimToken: "",
      leaseExpiresAt: "",
      notBefore: "",
      lastError: "",
    },
  });
}

async function markFailed(
  requests: Collection<Document>,
  request: TranslationRequest,
  message: string,
  defer: boolean,
): Promise<void> {
  const now = new Date();
  const set: Document = {
    status: "failed",
    lastError: message,
    updatedAt: now,
  };
  if (defer) {
    set.notBefore = new Date(now.getTime() + 5 * 60_000);
  } else {
    set.failedAt = now;
  }
  await updateClaim(requests, request, {
    $set: set,
    $unset: {
      claimedBy: "",
      claimToken: "",
      leaseExpiresAt: "",
      ...(defer ? {} : { notBefore: "" }),
    },
  });
}

export async function fetchSource(
  request: TranslationRequest,
  curseforgeKey: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<SourceDescription> {
  let url: string;
  let headers: HeadersInit | undefined;

  if (request.type === "modrinth") {
    url = `https://api.modrinth.com/v2/project/${
      encodeURIComponent(request.projectId)
    }`;
    headers = { "User-Agent": "xmcl-community-content-i18n-extra/translation-worker" };
  } else {
    if (!curseforgeKey) {
      throw new SourceFetchError("CURSEFORGE_KEY is not set", false);
    }
    url = `https://api.curseforge.com/v1/mods/${
      encodeURIComponent(request.projectId)
    }/description`;
    headers = { "x-api-key": curseforgeKey };
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`${request.type} source request failed`);
  }
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 ||
      response.status >= 500;
    throw new SourceFetchError(
      `${request.type} source returned HTTP ${response.status}`,
      retryable,
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(`${request.type} source returned invalid JSON`);
  }

  const body = request.type === "modrinth"
    ? (data as { body?: unknown }).body
    : (data as { data?: unknown }).data;
  if (typeof body !== "string") {
    throw new Error(`${request.type} source response has no description body`);
  }
  return { body, contentType: request.contentType };
}

class SourceFetchError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

function translationPrompt(contentType: SourceDescription["contentType"]): string {
  const format = contentType === "text/html" ? "HTML" : "Markdown";
  return [
    "You translate Minecraft community project descriptions.",
    `Translate into the requested locale while preserving ${format} structure, URLs,`,
    "image links, code, placeholders, and formatting.",
    "Return only the translated content; do not add commentary or a code fence.",
  ].join(" ");
}

export function cleanTranslation(content: string, locale?: string): string {
  const localeFence = locale?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fenced = localeFence
    ? content.match(new RegExp(
      "^```" + localeFence + "\\s*\\n?([\\s\\S]*?)\\n?```$",
    ))
    : undefined;
  return (fenced?.[1] ?? content).replace(/^\uFEFF/, "");
}

export async function translateSource(
  request: TranslationRequest,
  source: SourceDescription,
  options: Pick<WorkerOptions, "agnesKey" | "endpoint" | "model">,
  fetchImpl: FetchLike = fetch,
): Promise<TranslationResult> {
  let response: Response;
  try {
    response = await fetchImpl(options.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${options.agnesKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "system", content: translationPrompt(source.contentType) },
          {
            role: "user",
            content: `Translate the following ${source.contentType} into ${request.lang}:\n${source.body}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
  } catch {
    throw new Error("translation model request failed");
  }

  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 ||
      response.status >= 500;
    throw new TranslationApiError(
      `translation model returned HTTP ${response.status}`,
      retryable,
    );
  }

  let data: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    data = await response.json();
  } catch {
    throw new Error("translation model returned invalid JSON");
  }
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("translation model returned no content");
  }

  const cleaned = cleanTranslation(content, request.lang);
  if (source.body.length > 0 && cleaned.length === 0) {
    throw new Error("translation model returned an empty translation");
  }
  return { content: cleaned };
}

class TranslationApiError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

function cacheBodyHash(entry: TranslationCacheEntry | undefined): string | undefined {
  return typeof entry?.bodyHash === "string" ? entry.bodyHash : undefined;
}

function cacheContent(entry: TranslationCacheEntry | undefined): string | undefined {
  return typeof entry?.content === "string" ? entry.content : undefined;
}

export function staticContent(
  request: TranslationRequest,
  bodyHash: string,
  content: string,
): string {
  return JSON.stringify({
    bodyHash,
    content,
    contentType: request.contentType,
    type: request.type,
  }, null, 2) + "\n";
}

export async function writeStaticContent(
  outDir: string,
  request: TranslationRequest,
  bodyHash: string,
  content: string,
): Promise<string | undefined> {
  const localeDir = `${outDir}/${request.lang}`;
  const path = `${localeDir}/${request.projectId}.json`;
  const next = staticContent(request, bodyHash, content);
  try {
    if (await Deno.readTextFile(path) === next) return undefined;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.mkdir(localeDir, { recursive: true });
  await Deno.writeTextFile(path, next);
  return `${request.lang}/${request.projectId}.json`;
}

function isRetryable(error: unknown): boolean {
  return (error instanceof SourceFetchError || error instanceof TranslationApiError)
    ? error.retryable
    : true;
}

async function hashBody(body: string): Promise<string> {
  const hasher = await xxhash();
  return hasher.h64ToString(body);
}

async function processClaim(
  requests: Collection<Document>,
  db: Database,
  rawRequest: Document,
  options: WorkerOptions,
): Promise<WorkOutcome> {
  const parsed = parseRequest(rawRequest);
  if (parsed instanceof Error) {
    const id = stringField(rawRequest, "_id");
    const bodyHash = stringField(rawRequest, "bodyHash");
    const claimToken = stringField(rawRequest, "claimToken");
    if (id && bodyHash && claimToken) {
      const synthetic = {
        _id: id,
        bodyHash,
        claimToken,
      } as TranslationRequest;
      await markFailed(requests, synthetic, parsed.message, false);
    }
    return { kind: "failed" };
  }
  const request = parsed;

  let source: SourceDescription;
  try {
    source = await fetchSource(request, options.curseforgeKey);
  } catch (error) {
    const message = truncateError(error);
    if (isRetryable(error)) {
      await markFailed(requests, request, message, true);
      return { kind: "deferred" };
    }
    await markFailed(requests, request, message, false);
    return { kind: "failed" };
  }

  const currentBodyHash = await hashBody(source.body);
  const cache = db.collection<TranslationCacheEntry>(
    `${request.lang}_translation`,
  );
  const existing = await cache.findOne({ _id: request.projectId });
  const cachedContent = cacheBodyHash(existing) === currentBodyHash
    ? cacheContent(existing)
    : undefined;

  if (currentBodyHash !== request.bodyHash) {
    await requeueSourceChange(requests, request, currentBodyHash);
    return { kind: "source-changed" };
  }

  if (cachedContent !== undefined) {
    const changedFile = await writeStaticContent(
      options.outDir,
      request,
      currentBodyHash,
      cachedContent,
    );
    await markSucceeded(requests, request);
    return { kind: "cached", changedFile };
  }

  let result: TranslationResult;
  try {
    result = await translateSource(request, source, options);
  } catch (error) {
    const message = truncateError(error);
    if (isRetryable(error)) {
      await markFailed(requests, request, message, true);
      return { kind: "deferred" };
    }
    await markFailed(requests, request, message, false);
    return { kind: "failed" };
  }

  await cache.replaceOne(
    { _id: request.projectId },
    {
      _id: request.projectId,
      bodyHash: currentBodyHash,
      content: result.content,
      contentType: request.contentType,
      type: request.type,
    },
    { upsert: true },
  );
  const changedFile = await writeStaticContent(
    options.outDir,
    request,
    currentBodyHash,
    result.content,
  );
  await markSucceeded(requests, request);
  return { kind: "translated", changedFile };
}

async function inspectPending(
  db: Database,
  rawRequest: Document,
  options: WorkerOptions,
): Promise<void> {
  const parsed = parseRequest(rawRequest);
  if (parsed instanceof Error) {
    console.log(`[dry-run] ${String(rawRequest._id)}: invalid (${parsed.message})`);
    return;
  }
  try {
    const source = await fetchSource(parsed, options.curseforgeKey);
    const currentBodyHash = await hashBody(source.body);
    const cache = await db.collection<TranslationCacheEntry>(
      `${parsed.lang}_translation`,
    ).findOne({ _id: parsed.projectId });
    const cacheHit = cacheBodyHash(cache) === currentBodyHash &&
      cacheContent(cache) !== undefined;
    const action = currentBodyHash !== parsed.bodyHash && !cacheHit
      ? "will requeue with the current bodyHash"
      : cacheHit
      ? "will refresh static content from cache"
      : "will translate";
    console.log(`[dry-run] ${parsed._id}: ${action}`);
  } catch (error) {
    console.log(`[dry-run] ${parsed._id}: source check failed (${truncateError(error)})`);
  }
}

function emitChangedFiles(changedFiles: string[]): void {
  const githubOutput = Deno.env.get("GITHUB_OUTPUT");
  if (!githubOutput) return;
  const value = changedFiles.join(" ");
  Deno.writeTextFileSync(
    githubOutput,
    `changed=${changedFiles.length > 0}\nfiles=${value}\n`,
    { append: true },
  );
}

export async function runWorker(options: WorkerOptions): Promise<WorkerStats> {
  const client = new MongoClient();
  await client.connect(options.connStr);
  try {
    const db = client.database(options.dbName);
    const requests = db.collection<Document>(options.requestCollection);
    const stats: WorkerStats = {
      claimed: 0,
      translated: 0,
      cached: 0,
      sourceChanged: 0,
      deferred: 0,
      failures: 0,
      changedFiles: [],
    };

    if (options.dryRun) {
      const pending = await requests.find(
        claimableRequestFilter(new Date(), options.language),
        { limit: options.limit },
      ).toArray();
      for (const request of pending) {
        await inspectPending(db, request, options);
      }
      console.log(`[dry-run] inspected ${pending.length} pending request(s).`);
      return stats;
    }

    const workerId = `github-actions:${crypto.randomUUID()}`;
    while (stats.claimed < options.limit) {
      const rawRequest = await claimRequest(requests, workerId, options.language);
      if (!rawRequest) break;
      stats.claimed++;

      let outcome: WorkOutcome;
      try {
        outcome = await processClaim(requests, db, rawRequest, options);
      } catch (error) {
        const parsed = parseRequest(rawRequest);
        if (!(parsed instanceof Error)) {
          await markFailed(requests, parsed, truncateError(error), true);
        }
        outcome = { kind: "deferred" };
      }
      if (outcome.changedFile) stats.changedFiles.push(outcome.changedFile);
      switch (outcome.kind) {
        case "translated":
          stats.translated++;
          break;
        case "cached":
          stats.cached++;
          break;
        case "source-changed":
          stats.sourceChanged++;
          break;
        case "deferred":
          stats.deferred++;
          break;
        case "failed":
          stats.failures++;
          break;
      }
    }

    emitChangedFiles(stats.changedFiles);
    console.log(
      `Processed ${stats.claimed}: translated ${stats.translated}, cached ${stats.cached}, ` +
        `source changed ${stats.sourceChanged}, deferred ${stats.deferred}, failed ${stats.failures}.`,
    );
    return stats;
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  try {
    await runWorker(optionsFromEnvironment());
  } catch (error) {
    console.error(`Translation worker failed: ${truncateError(error)}`);
    Deno.exit(1);
  }
}
