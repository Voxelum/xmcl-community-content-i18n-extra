# xmcl-community-content-i18n-extra

Machine-translated localizations for community content (Modrinth / CurseForge
project descriptions, etc.) used by XMCL.

## Layout

```
<locale>/<id>.json
```

- `<locale>` — target language (e.g. `zh-CN`, `zh-TW`, `ru`).
- `<id>` — the content id.

Each file mirrors the stored translation document:

```json
{
  "bodyHash": "<hash of the source text the translation was made from>",
  "content": "<translated text>",
  "contentType": "text/markdown",
  "type": "modrinth"
}
```

`bodyHash` lets a consumer detect when the upstream source text has changed and
the translation is stale.

## Automated sync

[`.github/workflows/sync.yml`](.github/workflows/sync.yml) incrementally syncs
every `<locale>_translation` collection from MongoDB into this repo and commits
the diff. It runs weekly (Monday 03:00 UTC) and can be triggered manually from the
Actions tab.

The sync ([`scripts/sync_translations.ts`](scripts/sync_translations.ts)) scans
only a lightweight `{ _id, bodyHash }` projection, compares each hash against
what is already on disk, and downloads full content **only** for entries that
are new or whose translation changed — so a run touches just the delta. Deleted
documents are left in place. Use
[`scripts/dump_translations.ts`](scripts/dump_translations.ts) for a full
re-dump / reseed.

## Pending-request translation worker

[`.github/workflows/translate-pending.yml`](.github/workflows/translate-pending.yml)
runs daily at **02:20 UTC** and can also be started manually. It claims a small
batch of records from the `translation_requests` ledger, re-fetches each
Modrinth or CurseForge description, and verifies the current `bodyHash` with
the same xxHash64 algorithm used by `xmcl-web-api`. It only calls the model when
`<lang>_translation` does not already contain the current hash. The final cache
and this repository's `<locale>/<id>.json` file are then updated; unchanged
files are not committed.

The worker atomically leases each record before work starts. Ledger statuses
are only `pending`, `succeeded`, and `failed`: temporary errors become
`failed` with `notBefore`, while terminal errors are `failed` without
`notBefore`. A source change atomically releases the claim and returns the
record to `pending` with the newly observed hash. The workflow shares a
concurrency group with the full sync so two workflows cannot write or commit
the same content files at once.

### Ledger contract

`xmcl-web-api` must enqueue one metadata-only document per translation request
in `translation_requests` (or the collection named by
`TRANSLATION_REQUESTS_COLLECTION`):

```json
{
  "_id": "zh-CN:modrinth:project-id",
  "status": "pending",
  "lang": "zh-CN",
  "type": "modrinth",
  "projectId": "project-id",
  "bodyHash": "<xxhash64 h64ToString of the current source body>",
  "contentType": "text/markdown",
  "createdAt": "<Mongo Date>"
}
```

For CurseForge, use `type: "curseforge"` and `contentType: "text/html"`.
`body`, `description`, and `content` **must not** be put in ledger records.
The worker obtains the source directly from the upstream API and persists
translated content only in `<lang>_translation` and the static JSON file.

To claim work, the worker atomically claims any eligible unleased (or expired
lease) `pending` record with no/lapsed `notBefore`, or a `failed` record whose
`notBefore` has elapsed; it does not require FIFO ordering. It sets
`status: "pending"`, `claimedBy`,
`claimToken`, and `leaseExpiresAt`. Completion and failure updates require
`_id`, `bodyHash`, `status: "pending"`, and `claimToken`; they clear the lease
fields. A temporary failure sets `status: "failed"` and a future `notBefore`;
a terminal failure removes `notBefore`.

### Required secrets and manual options

Set these repository or environment secrets; do not add their values to this
repository:

- `MONGO_CONNECION_STRING` — read/write MongoDB/Cosmos connection string. The
  spelling is legacy and intentional.
- `AGNES_API_KEY` — key for the OpenAI-compatible translation service.
- `CURSEFORGE_KEY` — required when CurseForge records can be processed.
- `MONGODB_NAME` — optional database name; defaults to `coturn`.

`AI_TRANSLATION_ENDPOINT` and `AI_TRANSLATION_MODEL` are optional repository
variables for a compatible endpoint or model. Modrinth's public project API
needs no key.

Use **Run workflow** to choose `dry_run`, `limit` (1–500), and an optional
exact `language`. Dry runs inspect current sources and cache state but do not
claim records, call the model, update Cosmos, write files, or commit. Locally:

```sh
deno task translate -- --dry-run --limit 10 --language zh-CN
deno task translate -- --limit 25
```

## Prebuilt databases (`dist/<locale>.db`)

For the app to ship, each locale is compiled into a single read-only,
random-access database with [`scripts/build_db.mjs`](scripts/build_db.mjs):

```sh
npm run build            # build every locale into dist/
node scripts/build_db.mjs zh-TW ru   # build only the given locales
```

> **Runtime:** Node (not Deno), matching the Electron version that reads the
> files. The zstd `dictionary` option is only honoured on **Node ≥ 24** (older
> Node and Deno silently ignore it), so the build refuses to run on older Node.

The [`Build DB`](.github/workflows/build.yml) workflow rebuilds after each
successful sync and publishes the databases to the rolling **`db-latest`**
GitHub release (stable download URLs). Each locale ships as:

- `<locale>.db` — the queryable database (random access, read directly).
- `<locale>.db.br` — the same file brotli-compressed for download; decompress
  once to `<locale>.db` before querying.

The `dist/` folder is git-ignored — the databases are distributed via releases,
not committed.

### File format

Little-endian, single file per locale, `id -> { content, bodyHash }`:

```
Header(32B) | Dictionary | KeyOffsets((N+1)*4) | KeyBlob |
BlockOffset((blocks+1)*4) | Data(zstd blocks)
```

- **Keys** — record ids (numeric CurseForge / base62 Modrinth / longer),
  sorted; looked up by binary search (`O(log N)`).
- **Dictionary** — a raw content dictionary (~256 KB) sampled from the locale;
  no separate training step, so the build is pure Node.
- **Data** — records grouped `G = 4` per block; each block is zstd-compressed
  with the dictionary. A lookup decompresses a single block. Each record's
  `bodyHash` is inlined into its payload (both ids and hashes are
  variable-length), so `content` and `bodyHash` come out together.
- `bodyHash` lets a consumer detect when the upstream source changed and the
  translation is stale.

Approximate sizes: `zh-TW` ~15 MB (17 k records), `zh-CN` ~7 MB (8 k),
`ru` ~44 MB (47 k).

### Required secret


The sync workflow needs a repository secret before it can run:

- `MONGO_CONNECION_STRING` — MongoDB / Cosmos connection string.
- `MONGODB_NAME` — optional, database name (defaults to `coturn`).

> [!WARNING]
> This is a **public** repository. Prefer a **read-only** connection string
> scoped to the `*_translation` collections — the sync only reads from the
> database. Anyone with write access to a public repo can alter the workflow to
> read its secrets, so do not store a full read/write production credential
> here.

> [!WARNING]
> The pending-request worker also updates `translation_requests` and
> `<locale>_translation`, so its connection needs only those narrowly scoped
> write permissions in addition to read access. Do not reuse a broad production
> credential.

Set it with:

```sh
gh secret set MONGO_CONNECION_STRING --repo Voxelum/xmcl-community-content-i18n-extra
```
