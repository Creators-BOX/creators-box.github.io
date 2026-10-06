// 送信ページ：ログイン（または登録済みの端末）→ 暗号化してDriveへ → 台帳に登録 → URLとパスワードを渡す
import { CONFIG } from './config.js';
import { $, callGas, copyText, formatBytes, formatDate, isConfigured, startBridge, toast } from './common.js';
import { createEncryptor, generatePassword, generateShareId } from './fcrypto.js';
import { uploadEncrypted, AuthExpiredError } from './upload.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';
const OWNER_HINT = 'feerepitol@gmail.com';
const FOLDER_NAME = '暗号化ファイル転送_データ';
const DEVICE_STORE = 'ft_device'; // この端末の合言葉 { id, key, name }

let tokenClient = null;
let token = null;
let tokenExpiresAt = 0;
let device = loadDevice();
let folderId = null;
let pickedFile = null;
let busy = false;
let abort = null;
let lastResult = null;

const dlUrl = (id) => new URL('./', location.href).href + '#' + id;

/** 送信ページの操作に付ける本人確認。登録した端末なら合言葉、そうでなければ Google のログイン */
const auth = () => (device ? { deviceKey: device.key } : { token });

function loadDevice() {
  try {
    const d = JSON.parse(localStorage.getItem(DEVICE_STORE) || 'null');
    return d && d.key ? d : null;
  } catch {
    return null;
  }
}

function saveDevice(d) {
  device = d;
  try {
    if (d) localStorage.setItem(DEVICE_STORE, JSON.stringify(d));
    else localStorage.removeItem(DEVICE_STORE);
  } catch {
    /* 保存できない環境では、このページを開いている間だけ有効 */
  }
}

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Androidスマホ' : 'Androidタブレット';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'この端末';
}

init();

function init() {
  if (!isConfigured()) {
    $('#setupMsg').classList.remove('hidden');
    $('#login').disabled = true;
    return;
  }
  startBridge(); // ログインを押すまでに通り道を用意しておく
  $('#login').addEventListener('click', login);
  $('#regName').value = guessDeviceName();
  if (matchMedia('(pointer: coarse)').matches) {
    // スマホ・タブレットはドラッグできないので、タップで選ぶ案内にする
    $('#drop strong').textContent = 'タップしてファイルを選ぶ';
    $('#drop .note').textContent = '1つだけ。複数のときはzipにまとめてください';
  }
  $('#register').addEventListener('click', registerDevice);
  $('#unregister').addEventListener('click', unregisterThisDevice);
  $('#reloadDevices').addEventListener('click', loadDevices);
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
  if (device) enterApp();
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
  await enterApp();
}

/** 本人確認が済んだら、設定を読み込んで画面を開く */
async function enterApp() {
  $('#loading').classList.remove('hidden');
  try {
    const cfg = await callGas({ action: 'config', ...auth() });
    if (!cfg.ok) {
      if (device && cfg.error === 'unauthorized') {
        saveDevice(null);
        showLoginError('この端末の登録は取り消されています。Googleでログインし、登録し直してください');
      } else {
        showLoginError(cfg.error === 'unauthorized' ? 'このアカウントでは使えません。feerepitol@gmail.com でログインしてください' : '設定を読み込めませんでした');
      }
      return;
    }
    folderId = cfg.folderId || (device ? null : await createFolder());
    fillDays(cfg.expiryDays || [3, 7, 14, 30, 60, 120, 180]);
    $('#who').textContent = device ? `この端末（${device.name}）は登録済み` : cfg.owner;
    $('#login').classList.toggle('hidden', Boolean(device));
    $('#login').textContent = 'ログインし直す';
    $('#login').classList.remove('primary');
    $('#unregister').classList.toggle('hidden', !device);
    $('#registerCard').classList.toggle('hidden', Boolean(device));
    $('#main').classList.remove('hidden');
    $('#loginMsg').classList.add('hidden');
    updateSendButton();
    loadList();
    loadDevices();
  } catch (err) {
    showLoginError('通信に失敗しました。時間をおいてもう一度お試しください');
    console.error(err);
  } finally {
    $('#loading').classList.add('hidden');
  }
}

function showLoginError(text) {
  token = null;
  $('#main').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#unregister').classList.add('hidden');
  $('#who').textContent = '';
  const m = $('#loginMsg');
  m.textContent = text;
  m.classList.remove('hidden');
}

/** Google でログインした状態で、この端末を登録する（次回からログイン不要） */
async function registerDevice() {
  const name = $('#regName').value.trim() || guessDeviceName();
  const btn = $('#register');
  btn.disabled = true;
  try {
    const r = await callGas({ action: 'registerDevice', token, name });
    if (!r.ok) throw new Error(r.error);
    saveDevice({ id: r.deviceId, key: r.deviceKey, name: r.name });
    toast('この端末を登録しました。次回からログインなしで使えます');
    await enterApp();
  } catch (err) {
    console.error(err);
    toast('登録できませんでした。もう一度お試しください');
  } finally {
    btn.disabled = false;
  }
}

/** この端末の登録を解除する（サーバー側の登録も取り消す） */
async function unregisterThisDevice() {
  const btn = $('#unregister');
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = 'もう一度押すと解除';
    setTimeout(() => { btn.classList.remove('armed'); btn.textContent = 'この端末の登録を解除'; }, 4000);
    return;
  }
  btn.disabled = true;
  try {
    await callGas({ action: 'revokeDevice', ...auth(), id: device.id });
  } catch (err) {
    console.error(err);
  }
  saveDevice(null);
  btn.disabled = false;
  btn.classList.remove('armed');
  btn.textContent = 'この端末の登録を解除';
  showLoginError('この端末の登録を解除しました。使うときはGoogleでログインしてください');
}

async function loadDevices() {
  const box = $('#devices');
  try {
    const r = await callGas({ action: 'listDevices', ...auth() });
    if (!r.ok) throw new Error(r.error);
    box.textContent = '';
    if (!r.items.length) {
      box.innerHTML = '<p class="note">登録した端末はありません。</p>';
      return;
    }
    for (const d of r.items) {
      const el = document.createElement('div');
      el.className = 'item';
      const head = document.createElement('div');
      head.className = 'row';
      head.style.justifyContent = 'space-between';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = d.name + (device && device.id === d.id ? '（この端末）' : '');
      const btn = document.createElement('button');
      btn.className = 'small danger';
      btn.textContent = '登録を取り消す';
      btn.title = 'この端末からは、ログインなしで使えなくなります';
      btn.addEventListener('click', async () => {
        if (!btn.classList.contains('armed')) {
          btn.classList.add('armed');
          btn.textContent = 'もう一度押すと取り消し';
          setTimeout(() => { btn.classList.remove('armed'); btn.textContent = '登録を取り消す'; }, 4000);
          return;
        }
        btn.disabled = true;
        const self = device && device.id === d.id;
        try {
          const res = await callGas({ action: 'revokeDevice', ...auth(), id: d.id });
          if (!res.ok) throw new Error(res.error);
          toast('登録を取り消しました');
        } catch (err) {
          console.error(err);
          toast('取り消せませんでした');
        }
        if (self) {
          saveDevice(null);
          showLoginError('この端末の登録を取り消しました。使うときはGoogleでログインしてください');
        } else loadDevices();
      });
      head.append(name, btn);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `登録 ${formatDate(d.created)} ・ 最後に使用 ${formatDate(d.lastUsed)}`;
      el.append(head, meta);
      box.appendChild(el);
    }
  } catch (err) {
    console.error(err);
    box.innerHTML = '<p class="msg err">端末の一覧を読み込めませんでした。「更新」を押してください。</p>';
  }
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
  const r = await callGas({ action: 'setFolder', ...auth(), folderId: id });
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
  $('#send').disabled = busy || !pickedFile || !(token || device);
}

async function send() {
  if (!pickedFile || busy) return;
  if (!device && Date.now() > tokenExpiresAt - 5 * 60 * 1000) {
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
    // 登録した端末は、送り先を Apps Script に用意してもらう。Google でログイン中なら自分で用意する
    let target;
    if (device) {
      const s = await callGas({ action: 'startUpload', ...auth(), size: enc.totalSize });
      if (!s.ok) throw new Error(s.message || s.error);
      target = { sessionUrl: s.sessionUrl };
    } else {
      target = { folderId, token };
    }
    const fileId = await uploadEncrypted(enc, target, (done, total) => {
      const sec = (Date.now() - started) / 1000;
      const speed = sec > 1 ? ` ・ ${formatBytes(done / sec)}/秒` : '';
      setProgress(done / total, `暗号化して送信中… ${formatBytes(done)} / ${formatBytes(total)}${speed}`);
    }, abort.signal);

    setProgress(1, '台帳に登録中…');
    const r = await callGas({
      action: 'create', ...auth(), shareId, fileId, days, memo, password,
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
    const r = await callGas({ action: 'list', ...auth() });
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
        const r = await callGas({ action: 'revoke', ...auth(), id: it.id });
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
