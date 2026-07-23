import {
  assertEquals,
  assertRejects,
  assertMatch,
} from "@std/assert";
import {
  claimOptions,
  claimUpdate,
  claimableRequestFilter,
  cleanTranslation,
  completionFilter,
  fetchSource,
  optionsFromEnvironment,
  parseRequest,
  staticContent,
  type TranslationRequest,
} from "./translation_worker.ts";

const request: TranslationRequest = {
  _id: "modrinth:abc:zh-CN",
  lang: "zh-CN",
  type: "modrinth",
  projectId: "abc",
  bodyHash: "1234",
  contentType: "text/markdown",
  claimToken: "claim-token",
};

Deno.test("parseRequest accepts the metadata-only ledger contract", () => {
  const result = parseRequest({ ...request });
  if (result instanceof Error) throw result;
  assertEquals(result._id, request._id);
  assertEquals(result.lang, request.lang);
  assertEquals(result.contentType, "text/markdown");
  assertEquals(result.claimToken, "claim-token");
});

Deno.test("claim filter follows the backend pending/failed lease contract", () => {
  const now = new Date("2026-07-23T00:00:00.000Z");
  assertEquals(claimableRequestFilter(now, "zh-CN"), {
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
    lang: "zh-CN",
  });
});

Deno.test("completion filter requires the hash and claim token", () => {
  assertEquals(completionFilter(request), {
    _id: "modrinth:abc:zh-CN",
    bodyHash: "1234",
    status: "pending",
    claimToken: "claim-token",
  });
});

Deno.test("claim update records the lease timestamp and attempt", () => {
  const now = new Date("2026-07-23T00:00:00.000Z");
  assertEquals(claimUpdate("worker-1", "claim-1", now), {
    $set: {
      status: "pending",
      claimedBy: "worker-1",
      claimToken: "claim-1",
      leaseExpiresAt: new Date("2026-07-23T00:25:00.000Z"),
      claimedAt: now,
      updatedAt: now,
    },
    $unset: { notBefore: "" },
    $inc: { attempts: 1 },
  });
});

Deno.test("claim options atomically claim any eligible record without sorting", () => {
  const now = new Date("2026-07-23T00:00:00.000Z");
  assertEquals(claimOptions("worker-1", "claim-1", now), {
    new: true,
    update: claimUpdate("worker-1", "claim-1", now),
  });
});

Deno.test("parseRequest rejects descriptions in a request record", () => {
  const result = parseRequest({ ...request, body: "do not persist this" });
  assertMatch((result as Error).message, /source or translated content/);
});

Deno.test("parseRequest rejects unsafe static-content paths", () => {
  const result = parseRequest({ ...request, projectId: "../escape" });
  assertMatch((result as Error).message, /unsafe/);
});

Deno.test("fetchSource uses the Modrinth project endpoint", async () => {
  let requestedUrl = "";
  const source = await fetchSource(
    request,
    undefined,
    (input) => {
      requestedUrl = String(input);
      return Promise.resolve(new Response(JSON.stringify({ body: "# Description" })));
    },
  );

  assertEquals(requestedUrl, "https://api.modrinth.com/v2/project/abc");
  assertEquals(source, { body: "# Description", contentType: "text/markdown" });
});

Deno.test("fetchSource requires a CurseForge key", async () => {
  const curseforge = { ...request, type: "curseforge" as const, contentType: "text/html" as const };
  await assertRejects(
    () => fetchSource(curseforge, undefined),
    Error,
    "CURSEFORGE_KEY is not set",
  );
});

Deno.test("static content follows the locale/id JSON layout", () => {
  assertEquals(
    staticContent(request, "abcd", "翻译"),
    '{\n  "bodyHash": "abcd",\n  "content": "翻译",\n  "contentType": "text/markdown",\n  "type": "modrinth"\n}\n',
  );
});

Deno.test("cleanTranslation removes only a locale-labelled model fence", () => {
  assertEquals(cleanTranslation("```zh-CN\n你好\n```", "zh-CN"), "你好");
  assertEquals(cleanTranslation("```\ncode\n```", "zh-CN"), "```\ncode\n```");
  assertEquals(cleanTranslation("# Already markdown"), "# Already markdown");
});

Deno.test("manual options override environment defaults", () => {
  const options = optionsFromEnvironment(
    {
      MONGO_CONNECION_STRING: "mongodb://example",
      AGNES_API_KEY: "key",
      TRANSLATION_WORKER_LIMIT: "12",
    },
    ["--dry-run", "--limit", "3", "--language=ru"],
  );
  assertEquals(options.dryRun, true);
  assertEquals(options.limit, 3);
  assertEquals(options.language, "ru");
});
