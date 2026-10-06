// 受け取りページ：配布IDの確認 → パスワード確認 → Driveから暗号文を読み、ブラウザ内で復号して保存
import { CONFIG } from './config.js';
import { $, callGas, formatBytes, formatDate, isConfigured, readBody } from './common.js';
import { decryptMeta, decryptStream, deriveKeys, fromBase64Url, parseHeader, HEADER_FIXED } from './fcrypto.js';

const T = {
  ja: {
    title: 'ファイルの受け取り', langBtn: 'English', langTitle: 'Switch to English',
    loading: '確認しています…', pwLabel: 'パスワード', pwPlaceholder: '送り主から届いたパスワード',
    checkBtn: '確認する', checkTitle: 'パスワードを確認します', checking: '確認しています…',
    fileName: 'ファイル名', fileSize: 'サイズ', saveBtn: '保存する', saveTitle: '保存先を選んでダウンロードします',
    browserNote: '大きいファイルは、パソコンの Chrome か Edge で開くと確実に保存できます。',
    footer: 'ファイルは送り主のパソコンで暗号化されています。パスワードを入れると、このブラウザの中で元に戻します。',
    expiry: (d, s) => `ダウンロード期限：${d} まで ・ サイズ：${s}`,
    badLink: 'URLが正しくありません。届いたURLをもう一度ご確認ください。',
    notFound: 'このファイルは見つかりませんでした。URLをご確認ください。',
    expired: 'ダウンロード期限が過ぎたため、このファイルは削除されました。送り主にご連絡ください。',
    revoked: '送り主がこのファイルの公開を停止しました。送り主にご連絡ください。',
    badPw: (n) => `パスワードが違います（あと${n}回まちがえると、しばらく入力できなくなります）。`,
    locked: (d) => `入力をまちがえた回数が多いため、${d} まで受け付けを停止しています。`,
    network: '通信に失敗しました。時間をおいてもう一度お試しください。',
    unready: 'まだ準備中のページです。',
    enterPw: 'パスワードを入力して「確認する」を押してください。',
    readyMsg: 'パスワードを確認しました。「保存する」を押してください。',
    saving: (a, b) => `保存中… ${a} / ${b}`,
    done: '保存しました。',
    broken: 'ファイルを元に戻せませんでした。通信が途中で切れたか、ファイルが壊れています。もう一度「保存する」を押してください。',
    canceled: '保存を取りやめました。',
    noDiskSave: 'このブラウザでは、ファイルをいったんメモリに読み込んでから保存します。',
  },
  en: {
    title: 'Receive a file', langBtn: '日本語', langTitle: '日本語に切り替えます',
    loading: 'Checking…', pwLabel: 'Password', pwPlaceholder: 'Password from the sender',
    checkBtn: 'Verify', checkTitle: 'Verify the password', checking: 'Verifying…',
    fileName: 'File name', fileSize: 'Size', saveBtn: 'Save', saveTitle: 'Choose where to save and download',
    browserNote: 'For large files, Chrome or Edge on a computer is the most reliable.',
    footer: 'The file was encrypted on the sender’s computer. It is decrypted inside this browser with your password.',
    expiry: (d, s) => `Available until ${d} ・ Size: ${s}`,
    badLink: 'This link is not valid. Please check the URL you received.',
    notFound: 'This file could not be found. Please check the URL.',
    expired: 'The download period has ended and the file has been deleted. Please contact the sender.',
    revoked: 'The sender has stopped sharing this file. Please contact the sender.',
    badPw: (n) => `Incorrect password (${n} attempt(s) left before a temporary lock).`,
    locked: (d) => `Too many incorrect attempts. Please try again after ${d}.`,
    network: 'Connection failed. Please try again later.',
    unready: 'This page is not set up yet.',
    enterPw: 'Enter the password and press “Verify”.',
    readyMsg: 'Password verified. Press “Save”.',
    saving: (a, b) => `Saving… ${a} / ${b}`,
    done: 'Saved.',
    broken: 'The file could not be decrypted. The connection may have been interrupted. Please press “Save” again.',
    canceled: 'Saving was canceled.',
    noDiskSave: 'In this browser, the file is loaded into memory before saving.',
  },
};

let lang = 'ja';
try { if (localStorage.getItem('ft_lang') === 'en') lang = 'en'; } catch { /* 保存できない環境では日本語のまま */ }

const id = location.hash.slice(1);
let info = null;
let key = null;
let auth = null;
let fileId = null;
let meta = null;
let lastStatus = null; // 言語を切り替えたときに出し直すため

const t = (k, ...a) => (typeof T[lang][k] === 'function' ? T[lang][k](...a) : T[lang][k]);
const mediaUrl = () => `${CONFIG.DRIVE_BASE}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(CONFIG.API_KEY)}`;

applyLang();
$('#lang').addEventListener('click', () => {
  lang = lang === 'ja' ? 'en' : 'ja';
  try { localStorage.setItem('ft_lang', lang); } catch { /* 無視 */ }
  applyLang();
});
$('#pwForm').addEventListener('submit', (e) => { e.preventDefault(); verify(); });
$('#save').addEventListener('click', save);
start();

function applyLang() {
  document.documentElement.lang = lang;
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  if (info) $('#expiry').textContent = t('expiry', formatDate(info.expiresAt, lang), formatBytes(info.size));
  if (lastStatus) status(...lastStatus);
}

function status(kind, k, ...args) {
  lastStatus = [kind, k, ...args];
  const el = $('#status');
  el.className = `msg ${kind}`;
  el.textContent = t(k, ...args);
  el.classList.remove('hidden');
}

function errorKey(code) {
  return { not_found: 'notFound', expired: 'expired', revoked: 'revoked' }[code] || 'network';
}

async function start() {
  if (!isConfigured()) return status('err', 'unready');
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(id)) return status('err', 'badLink');
  try {
    const r = await callGas({ action: 'info', id });
    if (!r.ok) return status('err', errorKey(r.error));
    info = r;
    applyLang();
    $('#pwForm').classList.remove('hidden');
    if (r.lockedUntil) status('err', 'locked', formatDate(r.lockedUntil, lang));
    else status('info', 'enterPw');
    $('#pw').focus();
  } catch (err) {
    console.error(err);
    status('err', 'network');
  }
}

async function verify() {
  const pw = $('#pw').value.trim();
  if (!pw) return;
  const btn = $('#check');
  btn.disabled = true;
  $('#pwErr').classList.add('hidden');
  status('info', 'checking');
  try {
    const keys = await deriveKeys(pw, fromBase64Url(info.salt));
    const r = await callGas({ action: 'open', id, auth: keys.authHex });
    if (!r.ok) {
      if (r.error === 'bad_password') return showPwError('badPw', r.remaining);
      if (r.error === 'locked') return showPwError('locked', formatDate(r.lockedUntil, lang));
      return status('err', errorKey(r.error));
    }
    key = keys.key;
    auth = keys.authHex;
    fileId = r.fileId;
    meta = await readMeta();
    $('#fname').textContent = meta.name;
    $('#fsize').textContent = formatBytes(meta.size);
    $('#pwForm').classList.add('hidden');
    $('#ready').classList.remove('hidden');
    if (!window.showSaveFilePicker) $('#browserNote').classList.remove('hidden');
    status('ok', 'readyMsg');
  } catch (err) {
    console.error(err);
    status('err', 'network');
  } finally {
    btn.disabled = false;
  }
}

function showPwError(k, arg) {
  if (k === 'locked') return status('err', 'locked', arg);
  const el = $('#pwErr');
  el.textContent = t(k, arg);
  el.classList.remove('hidden');
  status('info', 'enterPw');
  $('#pw').select();
}

/** 先頭だけ読み、ファイル名とサイズを取り出す */
async function readMeta() {
  let res = await fetch(mediaUrl(), { headers: { Range: `bytes=0-${64 * 1024 - 1}` } });
  if (!res.ok) throw new Error('drive_' + res.status);
  let head = new Uint8Array(await res.arrayBuffer());
  const header = parseHeader(head.subarray(0, HEADER_FIXED));
  const need = HEADER_FIXED + header.metaLen;
  if (head.length < need) {
    res = await fetch(mediaUrl(), { headers: { Range: `bytes=0-${need - 1}` } });
    head = new Uint8Array(await res.arrayBuffer());
  }
  return decryptMeta(key, header, head.subarray(HEADER_FIXED, need));
}

async function save() {
  const btn = $('#save');
  const msg = $('#saveMsg');
  msg.classList.add('hidden');

  // Chrome / Edge：保存先を先に選び、復号しながら直接書き込む（大きなファイルでもメモリを使わない）
  let writable = null;
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: meta.name });
      writable = await handle.createWritable();
    } catch (err) {
      if (err.name === 'AbortError') return;
      writable = null;
    }
  }
  const parts = [];
  if (!writable) {
    msg.className = 'msg info';
    msg.textContent = t('noDiskSave');
  }

  btn.disabled = true;
  $('#prog').classList.remove('hidden');
  try {
    const res = await fetch(mediaUrl());
    if (!res.ok) throw new Error('drive_' + res.status);
    await decryptStream(key, readBody(res), async (plain, written) => {
      if (writable) await writable.write(plain);
      else parts.push(plain);
      $('#bar').style.width = `${meta.size ? Math.round((written / meta.size) * 1000) / 10 : 100}%`;
      $('#progText').textContent = t('saving', formatBytes(written), formatBytes(meta.size));
    });
    if (writable) await writable.close();
    else {
      const url = URL.createObjectURL(new Blob(parts, { type: meta.type || 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = meta.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    msg.className = 'msg ok';
    msg.textContent = t('done');
    callGas({ action: 'done', id, auth }).catch(() => {});
  } catch (err) {
    console.error(err);
    if (writable) await writable.abort().catch(() => {});
    msg.className = 'msg err';
    msg.textContent = t('broken');
  } finally {
    msg.classList.remove('hidden');
    btn.disabled = false;
  }
}
