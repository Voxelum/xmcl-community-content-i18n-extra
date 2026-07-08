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
