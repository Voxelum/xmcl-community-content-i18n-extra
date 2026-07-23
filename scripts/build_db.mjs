// Build read-only translation DBs, one per locale, using zstd + a raw content
// dictionary (Node 24 built-in zstd honours the `dictionary` option).
//
// MUST run on Node >= 24 (older Node / Deno silently ignore the zstd dictionary).
//
//   node scripts/build_db.mjs            # build every locale into dist/
//   node scripts/build_db.mjs zh-TW ru   # build only the given locales
//
// File format (little-endian), see README section for details:
//   Header(32B) | Dictionary | KeyOffsets((N+1)*4) | KeyBlob |
//   BlockOffset((blocks+1)*4) | Data(zstd blocks)
// Each record's bodyHash is inlined into its (compressed) payload so both
// variable-length ids and variable-length hashes are handled uniformly.
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST = path.join(ROOT, 'dist')

const MAGIC = 0x42445458 // 'XTDB'
const VERSION = 1
const CODEC_ZSTD = 1
const GROUP = 4
const DICT_TARGET = 256 * 1024
const LEVEL = 19
const Z = zlib.constants

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 24) {
  console.error(`ERROR: Node ${process.versions.node} detected. zstd dictionaries require Node >= 24.`)
  process.exit(1)
}

const zstdComp = (buf, dict) =>
  zlib.zstdCompressSync(buf, { dictionary: dict, params: { [Z.ZSTD_c_compressionLevel]: LEVEL } })
const zstdDecomp = (buf, dict) => zlib.zstdDecompressSync(buf, { dictionary: dict })

const LOCALE_RE = /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/

function listLocales() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && LOCALE_RE.test(e.name))
    .map((e) => e.name)
    .sort()
}

/** Load one locale into records sorted by id. payload = [bhLen:u8][bodyHash][content]. */
function loadRecords(locale) {
  const dir = path.join(ROOT, locale)
  const files = fs.readdirSync(dir)
  const records = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const id = f.slice(0, -5)
    let j
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f))) } catch { continue }
    let content = j.content
    if (typeof content !== 'string') content = JSON.stringify(content ?? '')
    const bh = Buffer.from(String(j.bodyHash ?? ''), 'latin1')
    if (bh.length > 255) continue // hashes are tiny; guard the u8 length prefix
    const contentBuf = Buffer.from(content, 'utf8')
    const payload = Buffer.concat([Buffer.from([bh.length]), bh, contentBuf])
    records.push({ id, payload })
  }
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return records
}

/** Raw content dictionary: spread sample of record heads, ~DICT_TARGET bytes. */
function buildDict(records) {
  const N = records.length
  if (N === 0) return Buffer.alloc(0)
  const step = Math.max(1, Math.floor(N / 2400))
  const parts = []
  let total = 0
  for (let i = 0; i < N && total < DICT_TARGET; i += step) {
    // skip the [bhLen][bodyHash] header so the dict is pure content bytes
    const p = records[i].payload
    const head = p.subarray(1 + p[0], 1 + p[0] + 320)
    parts.push(head)
    total += head.length
  }
  return Buffer.concat(parts).subarray(0, DICT_TARGET)
}

function build(records, dict) {
  const N = records.length
  const blockCount = Math.ceil(N / GROUP)

  // Data: group records into blocks; each record = [u32 len][payload]; block zstd-compressed.
  const blocks = []
  const blockOffset = new Uint32Array(blockCount + 1)
  let dataLen = 0
  for (let b = 0; b < blockCount; b++) {
    const recs = []
    for (let k = b * GROUP; k < Math.min((b + 1) * GROUP, N); k++) {
      const p = records[k].payload
      const len = Buffer.allocUnsafe(4); len.writeUInt32LE(p.length, 0)
      recs.push(len, p)
    }
    const comp = zstdComp(Buffer.concat(recs), dict)
    blockOffset[b] = dataLen
    dataLen += comp.length
    blocks.push(comp)
  }
  blockOffset[blockCount] = dataLen

  // Keys: sorted id strings + offset table.
  const keyOffset = new Uint32Array(N + 1)
  const keyBufs = []
  let kLen = 0
  for (let i = 0; i < N; i++) {
    keyOffset[i] = kLen
    const kb = Buffer.from(records[i].id, 'utf8')
    keyBufs.push(kb)
    kLen += kb.length
  }
  keyOffset[N] = kLen
  const keyBlob = Buffer.concat(keyBufs)

  const header = Buffer.alloc(32)
  header.writeUInt32LE(MAGIC, 0)
  header.writeUInt8(VERSION, 4)
  header.writeUInt8(CODEC_ZSTD, 5)
  header.writeUInt8(0, 6)
  header.writeUInt8(0, 7)
  header.writeUInt32LE(GROUP, 8)
  header.writeUInt32LE(N, 12)
  header.writeUInt32LE(dict.length, 16)
  header.writeUInt32LE(keyBlob.length, 20)
  header.writeUInt32LE(blockCount, 24)
  header.writeUInt32LE(0, 28)

  return Buffer.concat([
    header,
    dict,
    Buffer.from(keyOffset.buffer, keyOffset.byteOffset, keyOffset.byteLength),
    keyBlob,
    Buffer.from(blockOffset.buffer, blockOffset.byteOffset, blockOffset.byteLength),
    ...blocks,
  ])
}

/** Reader — mirrors the Electron-side lookup: O(log N) binary search + single block decompress. */
export class TranslationDb {
  constructor(buf) {
    this.buf = buf
    if (buf.readUInt32LE(0) !== MAGIC) throw new Error('bad magic')
    this.version = buf.readUInt8(4)
    this.group = buf.readUInt32LE(8)
    this.N = buf.readUInt32LE(12)
    const dictLen = buf.readUInt32LE(16)
    const keyBlobLen = buf.readUInt32LE(20)
    this.blockCount = buf.readUInt32LE(24)
    let o = 32
    this.dict = buf.subarray(o, o + dictLen); o += dictLen
    this.keyOffStart = o; o += (this.N + 1) * 4
    this.keyBlobStart = o; o += keyBlobLen
    this.blockOffStart = o; o += (this.blockCount + 1) * 4
    this.dataStart = o
  }
  #keyAt(i) {
    const s = this.buf.readUInt32LE(this.keyOffStart + i * 4)
    const e = this.buf.readUInt32LE(this.keyOffStart + (i + 1) * 4)
    return this.buf.subarray(this.keyBlobStart + s, this.keyBlobStart + e)
  }
  /** @returns {{content:string, bodyHash:string}|undefined} */
  get(id) {
    const target = Buffer.from(id, 'utf8')
    let lo = 0, hi = this.N - 1, r = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const c = Buffer.compare(this.#keyAt(mid), target)
      if (c === 0) { r = mid; break }
      else if (c < 0) lo = mid + 1
      else hi = mid - 1
    }
    if (r < 0) return undefined
    const b = Math.floor(r / this.group)
    const bs = this.buf.readUInt32LE(this.blockOffStart + b * 4)
    const be = this.buf.readUInt32LE(this.blockOffStart + (b + 1) * 4)
    const block = zstdDecomp(this.buf.subarray(this.dataStart + bs, this.dataStart + be), this.dict)
    const pos = r % this.group
    let o = 0, rec
    for (let k = 0; ; k++) {
      const len = block.readUInt32LE(o); o += 4
      if (k === pos) { rec = block.subarray(o, o + len); break }
      o += len
    }
    const bhLen = rec[0]
    return {
      bodyHash: rec.subarray(1, 1 + bhLen).toString('latin1'),
      content: rec.subarray(1 + bhLen).toString('utf8'),
    }
  }
}

function verify(locale, records, dbBuf) {
  const db = new TranslationDb(dbBuf)
  if (db.N !== records.length) throw new Error(`count mismatch ${db.N} != ${records.length}`)
  const byId = new Map(records.map((r) => [r.id, r]))
  let checked = 0
  const N = records.length
  const step = Math.max(1, Math.floor(N / 400))
  for (let i = 0; i < N; i += step) {
    const id = records[i].id
    const got = db.get(id)
    if (!got) throw new Error(`missing ${id}`)
    const src = byId.get(id)
    const bhLen = src.payload[0]
    const expBh = src.payload.subarray(1, 1 + bhLen).toString('latin1')
    const expContent = src.payload.subarray(1 + bhLen).toString('utf8')
    if (got.bodyHash !== expBh) throw new Error(`bodyHash mismatch for ${id}`)
    if (got.content !== expContent) throw new Error(`content mismatch for ${id}`)
    checked++
  }
  // missing-key sanity
  if (db.get('\u0000__definitely_missing__') !== undefined) throw new Error('phantom hit')
  return checked
}

async function main() {
  const want = process.argv.slice(2)
  const locales = (want.length ? want : listLocales())
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true })
  console.log(`Node ${process.versions.node} | building: ${locales.join(', ')}`)
  for (const locale of locales) {
    const t0 = Date.now()
    const records = loadRecords(locale)
    if (records.length === 0) { console.log(`${locale}: no records, skip`); continue }
    const dict = buildDict(records)
    const dbBuf = build(records, dict)
    const outPath = path.join(DIST, `${locale}.db`)
    fs.writeFileSync(outPath, dbBuf)
    const checked = verify(locale, records, dbBuf)
    // Distribution artifact: the .db is already zstd-internally, so an extra
    // brotli pass mainly compresses the plaintext key index; clients download
    // the .db.br and decompress once to the queryable .db.
    const brBuf = zlib.brotliCompressSync(dbBuf, {
      params: {
        [Z.BROTLI_PARAM_QUALITY]: 11,
        [Z.BROTLI_PARAM_SIZE_HINT]: dbBuf.length,
      },
    })
    fs.writeFileSync(`${outPath}.br`, brBuf)
    console.log(
      `${locale.padEnd(6)} | ${String(records.length).padStart(6)} records | ` +
      `${(dbBuf.length / 1e6).toFixed(2)} MB | .db.br ${(brBuf.length / 1e6).toFixed(2)} MB | ` +
      `dict ${(dict.length / 1024) | 0}KB | verified ${checked} | ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    )
  }
}

if (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
