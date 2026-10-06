// 暗号化ファイル転送：暗号化と復号の共通処理（送信側・受け取り側・テストで共有）
//
// ファイル形式（ビッグエンディアン）
//   0  "KSFT"            4バイト
//   4  版 = 1            1バイト ＋ 予約 3バイト
//   8  チャンクの平文サイズ uint32
//  12  ソルト            16バイト
//  28  ノンスの前半       8バイト
//  36  メタ情報の長さ     uint32（暗号文＋タグ16バイト）
//  40  メタ情報（ファイル名・サイズ・種類のJSON）の暗号文
//  以降 チャンクの暗号文（平文＋タグ16バイト）を順に並べる
//
// 鍵：パスワード → PBKDF2-SHA256（60万回）→ 512ビット
//   前半256ビット＝AES-256-GCMの鍵（サーバーへは出さない）
//   後半256ビット＝本人確認用の値（サーバーはこのハッシュだけを持つ）
// チャンクのIV＝ノンス前半8バイト＋チャンク番号4バイト。AAD＝「最後のチャンクか」の1バイト（途中で切られたファイルを検出する）

export const MAGIC = [0x4b, 0x53, 0x46, 0x54]; // "KSFT"
export const VERSION = 1;
export const CHUNK_SIZE = 8 * 1024 * 1024;
export const TAG_SIZE = 16;
export const HEADER_FIXED = 40;
export const PBKDF2_ITERATIONS = 600000;
const META_INDEX = 0xffffffff;

// 見間違えやすい 0 O o 1 l I を除いた文字
const PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** 16文字のパスワードを作り、4文字ごとにハイフンで区切って返す */
export function generatePassword(length = 16) {
  const out = [];
  const limit = 256 - (256 % PW_CHARS.length);
  while (out.length < length) {
    const buf = new Uint8Array(length * 2);
    globalThis.crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit && out.length < length) out.push(PW_CHARS[b % PW_CHARS.length]);
    }
  }
  return out.join('').replace(/(.{4})(?=.)/g, '$1-');
}

/** 入力のゆれ（ハイフン・空白・全角）を除いた鍵の元になる文字列 */
export function normalizePassword(s) {
  return String(s)
    .normalize('NFKC')
    .replace(/[\s\-‐－ー_]/g, '');
}

/** 推測できない配布ID（16バイト、URLに使える文字） */
export function generateShareId() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return toBase64Url(b);
}

export function toBase64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** パスワードとソルトから、暗号の鍵と本人確認用の値を作る */
export async function deriveKeys(password, salt) {
  const base = await subtle.importKey('raw', enc.encode(normalizePassword(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, base, 512),
  );
  const key = await subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, authHex: toHex(bits.slice(32)) };
}

function chunkIv(noncePrefix, index) {
  const iv = new Uint8Array(12);
  iv.set(noncePrefix, 0);
  new DataView(iv.buffer).setUint32(8, index >>> 0);
  return iv;
}

export function chunkCount(size, chunkSize = CHUNK_SIZE) {
  return Math.max(1, Math.ceil(size / chunkSize));
}

/**
 * 暗号化の準備。返り値の parts() を順に読むと、アップロードするバイト列が先頭から出てくる。
 * totalSize はアップロード前に確定している（Driveの再開可能アップロードで必要）。
 */
export async function createEncryptor(file, password, opts = {}) {
  const chunkSize = opts.chunkSize || CHUNK_SIZE;
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const noncePrefix = globalThis.crypto.getRandomValues(new Uint8Array(8));
  const { key, authHex } = await deriveKeys(password, salt);

  const metaPlain = enc.encode(JSON.stringify({ n: file.name || 'file', s: file.size, t: file.type || '' }));
  const metaLen = metaPlain.length + TAG_SIZE;

  const header = new Uint8Array(HEADER_FIXED);
  header.set(MAGIC, 0);
  header[4] = VERSION;
  const hv = new DataView(header.buffer);
  hv.setUint32(8, chunkSize);
  header.set(salt, 12);
  header.set(noncePrefix, 28);
  hv.setUint32(36, metaLen);

  const metaCipher = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: chunkIv(noncePrefix, META_INDEX), additionalData: header }, key, metaPlain),
  );

  const n = chunkCount(file.size, chunkSize);
  const totalSize = HEADER_FIXED + metaLen + file.size + n * TAG_SIZE;

  async function* parts() {
    const head = new Uint8Array(HEADER_FIXED + metaLen);
    head.set(header, 0);
    head.set(metaCipher, HEADER_FIXED);
    yield head;
    for (let i = 0; i < n; i++) {
      const plain = new Uint8Array(await file.slice(i * chunkSize, Math.min(file.size, (i + 1) * chunkSize)).arrayBuffer());
      const aad = new Uint8Array([i === n - 1 ? 1 : 0]);
      yield new Uint8Array(
        await subtle.encrypt({ name: 'AES-GCM', iv: chunkIv(noncePrefix, i), additionalData: aad }, key, plain),
      );
    }
  }

  return { salt: toBase64Url(salt), authHex, totalSize, parts };
}

/** 先頭の固定部分を読む。形式が違えば例外 */
export function parseHeader(bytes) {
  if (bytes.length < HEADER_FIXED) throw new Error('header_short');
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw new Error('not_ksft');
  if (bytes[4] !== VERSION) throw new Error('bad_version');
  const v = new DataView(bytes.buffer, bytes.byteOffset, HEADER_FIXED);
  return {
    chunkSize: v.getUint32(8),
    salt: bytes.slice(12, 28),
    noncePrefix: bytes.slice(28, 36),
    metaLen: v.getUint32(36),
    headerBytes: bytes.slice(0, HEADER_FIXED),
  };
}

/** メタ情報（ファイル名など）を復号する。パスワード違い・改ざんは例外 */
export async function decryptMeta(key, header, metaCipher) {
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: chunkIv(header.noncePrefix, META_INDEX), additionalData: header.headerBytes },
    key,
    metaCipher,
  );
  const m = JSON.parse(dec.decode(plain));
  return { name: m.n, size: m.s, type: m.t };
}

/** 受信したバイト列を少しずつ溜め、必要な長さだけ取り出す */
export class ByteQueue {
  constructor() {
    this.parts = [];
    this.length = 0;
  }
  push(u8) {
    if (u8.length) {
      this.parts.push(u8);
      this.length += u8.length;
    }
  }
  take(n) {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const p = this.parts[0];
      const need = n - off;
      if (p.length <= need) {
        out.set(p, off);
        off += p.length;
        this.parts.shift();
      } else {
        out.set(p.subarray(0, need), off);
        this.parts[0] = p.subarray(need);
        off += need;
      }
    }
    this.length -= n;
    return out;
  }
}

/**
 * 暗号文の流れ（Uint8Array を返す非同期イテレーター）を復号し、平文のチャンクを onPlain に渡す。
 * 先頭から全部を流す前提。途中で切れていたり改ざんがあれば例外。
 */
export async function decryptStream(key, source, onPlain) {
  const q = new ByteQueue();
  const it = source[Symbol.asyncIterator]();
  let done = false;
  async function fill(n) {
    while (q.length < n && !done) {
      const r = await it.next();
      if (r.done) done = true;
      else q.push(r.value);
    }
    return q.length >= n;
  }

  if (!(await fill(HEADER_FIXED))) throw new Error('header_short');
  const header = parseHeader(q.take(HEADER_FIXED));
  if (!(await fill(header.metaLen))) throw new Error('truncated');
  const meta = await decryptMeta(key, header, q.take(header.metaLen));

  const n = chunkCount(meta.size, header.chunkSize);
  let written = 0;
  for (let i = 0; i < n; i++) {
    const plainLen = Math.min(header.chunkSize, meta.size - i * header.chunkSize);
    const cLen = Math.max(0, plainLen) + TAG_SIZE;
    if (!(await fill(cLen))) throw new Error('truncated');
    const aad = new Uint8Array([i === n - 1 ? 1 : 0]);
    const plain = new Uint8Array(
      await subtle.decrypt({ name: 'AES-GCM', iv: chunkIv(header.noncePrefix, i), additionalData: aad }, key, q.take(cLen)),
    );
    written += plain.length;
    await onPlain(plain, written, meta);
  }
  return meta;
}
