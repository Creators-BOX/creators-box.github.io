// 暗号化したバイト列を、Drive の「再開可能アップロード」で直接送る
import { ByteQueue } from './fcrypto.js';
import { CONFIG } from './config.js';

const PIECE = 32 * 1024 * 1024; // 256KiB の倍数であること（Drive の決まり）
const MAX_RETRY = 6;

export class AuthExpiredError extends Error {}

/**
 * @param enc       createEncryptor の返り値
 * @param folderId  保管フォルダ
 * @param token     アクセストークン
 * @param onProgress(送った量, 全体)
 * @param signal    中止用
 * @returns Drive のファイルID
 */
export async function uploadEncrypted(enc, folderId, token, onProgress, signal) {
  const total = enc.totalSize;
  const init = await fetch(`${CONFIG.DRIVE_BASE}/upload/drive/v3/files?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/octet-stream',
      'X-Upload-Content-Length': String(total),
    },
    body: JSON.stringify({ name: `ft_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.bin`, parents: [folderId], mimeType: 'application/octet-stream' }),
    signal,
  });
  if (init.status === 401) throw new AuthExpiredError();
  if (!init.ok) throw new Error(`upload_init_${init.status}`);
  const session = init.headers.get('Location');
  if (!session) throw new Error('upload_no_session');

  let offset = 0; // Drive が受け取り済みのバイト数
  let fileId = null;
  const q = new ByteQueue();

  async function sendPiece(bytes) {
    const start = offset;
    let sent = 0; // bytes のうち受け取り済みの量
    let retry = 0;
    while (sent < bytes.length) {
      const body = bytes.subarray(sent);
      let r;
      try {
        r = await put(session, body, start + sent, total, (loaded) => onProgress(start + sent + loaded, total), signal);
      } catch (err) {
        if (signal && signal.aborted) throw err;
        r = { status: 0 };
      }
      if (r.status === 401) throw new AuthExpiredError();
      if (r.status === 200 || r.status === 201) {
        fileId = JSON.parse(r.text).id;
        sent = bytes.length;
        break;
      }
      if (r.status === 308) {
        sent = rangeEnd(r.range, start + sent + body.length) - start;
        retry = 0;
        continue;
      }
      // 通信の失敗・サーバー側の一時的な失敗：受け取り済みの位置を問い合わせてやり直す
      if (++retry > MAX_RETRY) throw new Error(`upload_failed_${r.status}`);
      await wait(1000 * 2 ** retry, signal);
      const s = await put(session, new Uint8Array(0), null, total, () => {}, signal).catch(() => ({ status: 0 }));
      if (s.status === 200 || s.status === 201) {
        fileId = JSON.parse(s.text).id;
        sent = bytes.length;
      } else if (s.status === 308) {
        sent = rangeEnd(s.range, start) - start;
      }
    }
    offset = start + bytes.length;
    onProgress(offset, total);
  }

  for await (const part of enc.parts()) {
    q.push(part);
    while (q.length >= PIECE) await sendPiece(q.take(PIECE));
  }
  if (q.length > 0) await sendPiece(q.take(q.length));
  if (!fileId) throw new Error('upload_no_file_id');
  return fileId;
}

/** Range: bytes=0-N の N+1。ヘッダーが読めないときは送った分すべて届いたとみなす */
function rangeEnd(range, fallback) {
  if (range === undefined) return fallback;
  if (!range) return 0;
  const m = /bytes=0-(\d+)/.exec(range);
  return m ? Number(m[1]) + 1 : fallback;
}

function put(url, body, start, total, onLoaded, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader(
      'Content-Range',
      start === null || body.length === 0 ? `bytes */${total}` : `bytes ${start}-${start + body.length - 1}/${total}`,
    );
    xhr.upload.onprogress = (e) => onLoaded(e.loaded);
    xhr.onload = () => {
      const exposed = xhr.getAllResponseHeaders().toLowerCase().includes('range:');
      resolve({ status: xhr.status, text: xhr.responseText, range: exposed ? xhr.getResponseHeader('Range') : undefined });
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal) signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  });
}
