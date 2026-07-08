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


### Required secret

The workflow needs a repository secret before it can run:

- `MONGO_CONNECION_STRING` — MongoDB / Cosmos connection string.
- `MONGODB_NAME` — optional, database name (defaults to `coturn`).

> [!WARNING]
> This is a **public** repository. Prefer a **read-only** connection string
> scoped to the `*_translation` collections — the sync only reads from the
> database. Anyone with write access to a public repo can alter the workflow to
> read its secrets, so do not store a full read/write production credential
> here.

Set it with:

```sh
gh secret set MONGO_CONNECION_STRING --repo Voxelum/xmcl-community-content-i18n-extra
```

