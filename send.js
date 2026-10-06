// 送信ページ：ログイン → 暗号化してDriveへ → 台帳に登録 → URLとパスワードを渡す
import { CONFIG } from './config.js';
import { $, callGas, copyText, formatBytes, formatDate, isConfigured, toast } from './common.js';
import { createEncryptor, generatePassword, generateShareId } from './fcrypto.js';
import { uploadEncrypted, AuthExpiredError } from './upload.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';
const OWNER_HINT = 'feerepitol@gmail.com';
const FOLDER_NAME = '暗号化ファイル転送_データ';

let tokenClient = null;
let token = null;
let tokenExpiresAt = 0;
let folderId = null;
let pickedFile = null;
let busy = false;
let abort = null;
let lastResult = null;

const dlUrl = (id) => new URL('./', location.href).href + '#' + id;

init();

function init() {
  if (!isConfigured()) {
    $('#setupMsg').classList.remove('hidden');
    $('#login').disabled = true;
    return;
  }
  $('#login').addEventListener('click', login);
  $('#pw').value = generatePassword();
  $('#regen').addEventListener('click', () => { $('#pw').value = generatePassword(); });
  $('#drop').addEventListener('click', () => $('#file').click());
  $('#drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') $('#file').click(); });
  $('#file').addEventListener('change', () => pick($('#file').files[0]));
  ['dragenter', 'dragover'].forEach((t) => $('#drop').addEventListener(t, (e) => { e.preventDefault(); $('#drop').classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => $('#drop').addEventListener(t, (e) => { e.preventDefault(); $('#drop').classList.remove('over'); }));
  $('#drop').addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 1) toast('1つだけ選んでください。複数のときはzipにまとめてください');
    else pick(files[0]);
  });
  $('#send').addEventListener('click', send);
  $('#cancel').addEventListener('click', () => abort && abort.abort());
  $('#reload').addEventListener('click', loadList);
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyResult(b.dataset.copy)));
  window.addEventListener('beforeunload', (e) => { if (busy) e.preventDefault(); });
}

function login() {
  if (CONFIG.DEV_TOKEN) return onToken({ access_token: CONFIG.DEV_TOKEN, expires_in: 3600 });
  if (!window.google || !google.accounts || !google.accounts.oauth2) {
    toast('ログインの準備中です。数秒後にもう一度押してください');
    return;
  }
  if (!tokenClient) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: SCOPE,
      login_hint: OWNER_HINT,
      callback: onToken,
      error_callback: () => toast('ログインできませんでした'),
    });
  }
  tokenClient.requestAccessToken({ prompt: token ? '' : 'select_account' });
}

async function onToken(resp) {
  if (resp.error) {
    toast('ログインできませんでした');
    return;
  }
  token = resp.access_token;
  tokenExpiresAt = Date.now() + Number(resp.expires_in || 3600) * 1000;
  try {
    const cfg = await callGas({ action: 'config', token });
    if (!cfg.ok) {
      showLoginError(cfg.error === 'unauthorized' ? 'このアカウントでは使えません。feerepitol@gmail.com でログインしてください' : '設定を読み込めませんでした');
      return;
    }
    folderId = cfg.folderId || (await createFolder());
    fillDays(cfg.expiryDays || [3, 7, 14, 30, 60, 120, 180]);
    $('#who').textContent = cfg.owner;
    $('#login').textContent = 'ログインし直す';
    $('#login').classList.remove('primary');
    $('#main').classList.remove('hidden');
    updateSendButton();
    loadList();
  } catch (err) {
    showLoginError('通信に失敗しました。時間をおいてもう一度お試しください');
    console.error(err);
  }
}

function showLoginError(text) {
  token = null;
  $('#main').classList.add('hidden');
  toast(text);
}

/** 初回だけ：暗号化ファイルの保管フォルダを作って登録する */
async function createFolder() {
  const res = await fetch(`${CONFIG.DRIVE_BASE}/drive/v3/files?fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  if (!res.ok) throw new Error('folder_create_' + res.status);
  const { id } = await res.json();
  const r = await callGas({ action: 'setFolder', token, folderId: id });
  if (!r.ok) throw new Error('folder_register');
  return id;
}

function fillDays(days) {
  const sel = $('#days');
  if (sel.options.length) return;
  for (const d of days) {
    const o = document.createElement('option');
    o.value = d;
    o.textContent = `${d}日`;
    if (d === 7) o.selected = true;
    sel.appendChild(o);
  }
}

function pick(file) {
  if (!file || busy) return;
  pickedFile = file;
  $('#picked').textContent = `${file.name}（${formatBytes(file.size)}）`;
  $('#picked').classList.remove('hidden');
  $('#result').classList.add('hidden');
  updateSendButton();
}

function updateSendButton() {
  $('#send').disabled = busy || !pickedFile || !token;
}

async function send() {
  if (!pickedFile || busy) return;
  if (Date.now() > tokenExpiresAt - 5 * 60 * 1000) {
    toast('ログインの有効期限が近いため、もう一度ログインしてください');
    login();
    return;
  }
  const file = pickedFile;
  const password = $('#pw').value;
  const days = Number($('#days').value);
  const memo = $('#memo').value.trim();
  const shareId = generateShareId();

  busy = true;
  abort = new AbortController();
  updateSendButton();
  $('#sendErr').classList.add('hidden');
  $('#prog').classList.remove('hidden');
  $('#cancel').classList.remove('hidden');
  $('#regen').disabled = true;
  setProgress(0, '暗号化の準備中…');

  try {
    const enc = await createEncryptor(file, password);
    const started = Date.now();
    const fileId = await uploadEncrypted(enc, folderId, token, (done, total) => {
      const sec = (Date.now() - started) / 1000;
      const speed = sec > 1 ? ` ・ ${formatBytes(done / sec)}/秒` : '';
      setProgress(done / total, `暗号化して送信中… ${formatBytes(done)} / ${formatBytes(total)}${speed}`);
    }, abort.signal);

    setProgress(1, '台帳に登録中…');
    const r = await callGas({
      action: 'create', token, shareId, fileId, days, memo, password,
      name: file.name, size: file.size, authHex: enc.authHex, salt: enc.salt,
    });
    if (!r.ok) throw new Error(r.message || r.error);

    lastResult = { url: dlUrl(shareId), password, expiresAt: r.expiresAt };
    $('#rUrl').textContent = lastResult.url;
    $('#rPw').textContent = password;
    $('#rExp').textContent = `${formatDate(r.expiresAt)} まで`;
    $('#result').classList.remove('hidden');
    $('#prog').classList.add('hidden');
    pickedFile = null;
    $('#picked').classList.add('hidden');
    $('#file').value = '';
    $('#memo').value = '';
    $('#pw').value = generatePassword();
    loadList();
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    $('#prog').classList.add('hidden');
    const m = $('#sendErr');
    if (err.name === 'AbortError') m.textContent = '送信を中止しました。';
    else if (err instanceof AuthExpiredError) m.textContent = 'ログインの有効期限が切れました。「ログインし直す」を押してから、もう一度送ってください。';
    else m.textContent = `送信できませんでした（${err.message}）。もう一度お試しください。`;
    m.classList.remove('hidden');
  } finally {
    busy = false;
    abort = null;
    $('#cancel').classList.add('hidden');
    $('#regen').disabled = false;
    updateSendButton();
  }
}

function setProgress(ratio, text) {
  $('#bar').style.width = `${Math.round(ratio * 1000) / 10}%`;
  $('#progText').textContent = text;
}

function shareText(url, password, expiresAt) {
  return `URL：${url}\nパスワード：${password}\n期限：${formatDate(expiresAt)} まで`;
}

async function copyResult(kind) {
  if (!lastResult) return;
  const { url, password, expiresAt } = lastResult;
  const text = kind === 'url' ? url : kind === 'pw' ? password : shareText(url, password, expiresAt);
  toast((await copyText(text)) ? 'コピーしました' : 'コピーできませんでした');
}

async function loadList() {
  const box = $('#list');
  try {
    const r = await callGas({ action: 'list', token });
    if (!r.ok) throw new Error(r.error);
    box.textContent = '';
    if (!r.items.length) {
      box.innerHTML = '<p class="note">まだありません。</p>';
      return;
    }
    for (const it of r.items) box.appendChild(renderItem(it));
  } catch (err) {
    console.error(err);
    box.innerHTML = '<p class="msg err">一覧を読み込めませんでした。「更新」を押してください。</p>';
  }
}

function renderItem(it) {
  const active = it.status === '有効';
  const el = document.createElement('div');
  el.className = 'item';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = it.name;
  const badge = document.createElement('span');
  badge.className = 'badge' + (active ? ' active' : '');
  badge.textContent = it.status;
  const head = document.createElement('div');
  head.className = 'row';
  head.style.justifyContent = 'space-between';
  head.append(name, badge);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const lines = [
    it.memo ? `宛先メモ：${it.memo}` : '',
    `${formatBytes(it.size)} ・ 作成 ${formatDate(it.createdAt)} ・ 期限 ${formatDate(it.expiresAt)}`,
    `ダウンロード ${it.dlCount}回` + (it.lastDl ? `（最終 ${formatDate(it.lastDl)}）` : ''),
  ].filter(Boolean);
  meta.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  el.append(head, meta);

  if (active) {
    const actions = document.createElement('div');
    actions.className = 'row actions';
    const copy = document.createElement('button');
    copy.className = 'small';
    copy.textContent = 'URLとパスワードをコピー';
    copy.title = 'URL・パスワード・期限をまとめてコピーします';
    copy.addEventListener('click', async () => {
      toast((await copyText(shareText(dlUrl(it.id), it.password, it.expiresAt))) ? 'コピーしました' : 'コピーできませんでした');
    });
    const revoke = document.createElement('button');
    revoke.className = 'small danger';
    revoke.textContent = '無効にする';
    revoke.title = '期限前でもリンクを無効にし、ファイルを完全に削除します（元に戻せません）';
    let timer = null;
    revoke.addEventListener('click', async () => {
      if (!revoke.classList.contains('armed')) {
        revoke.classList.add('armed');
        revoke.textContent = 'もう一度押すと削除';
        timer = setTimeout(() => { revoke.classList.remove('armed'); revoke.textContent = '無効にする'; }, 4000);
        return;
      }
      clearTimeout(timer);
      revoke.disabled = true;
      revoke.textContent = '削除中…';
      try {
        const r = await callGas({ action: 'revoke', token, id: it.id });
        if (!r.ok) throw new Error(r.error);
        toast('無効にしました');
      } catch (err) {
        console.error(err);
        toast('無効にできませんでした');
      }
      loadList();
    });
    actions.append(copy, revoke);
    el.append(actions);
  }
  return el;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
