// 送信ページ・受け取りページの共通処理
import { CONFIG } from './config.js';

export const $ = (sel, root = document) => root.querySelector(sel);

export function isConfigured() {
  return Boolean(CONFIG.GAS_URL && CONFIG.CLIENT_ID && CONFIG.API_KEY);
}

// ───────── Apps Script とのやり取り ─────────
// 早い道：Apps Script の小さなページ（?bridge=1）を見えない枠で読み込み、google.script.run 経由で呼ぶ。
// 予備の道：doPost へ直接送る。結果が Google の中継を通るため、遅い・落ちることがある（2026-10-06 実測 10〜27秒）。
// 早い道が使えないとき（枠が開けない・応答がない）は、自動で予備の道に切り替える。

const BRIDGE_READY_MS = 10000;
const BRIDGE_CALL_MS = 25000;
let bridgePromise = null;
let bridgeResolve = null;
const pending = new Map();

function trustedBridgeOrigin(origin) {
  return origin === new URL(CONFIG.GAS_URL).origin || /^https:\/\/[a-z0-9-]+\.googleusercontent\.com$/.test(origin);
}

window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || typeof d !== 'object' || !trustedBridgeOrigin(ev.origin)) return;
  if (d.type === 'ft-ready' && bridgeResolve) {
    bridgeResolve({ win: ev.source, origin: ev.origin });
    bridgeResolve = null;
  } else if (d.type === 'ft-result' && pending.has(d.id)) {
    const p = pending.get(d.id);
    pending.delete(d.id);
    if (d.error) p.reject(new Error(d.error));
    else p.resolve(d.out);
  }
});

/** 早い道の準備を始める（ページを開いた時点で呼んでおくと、最初の呼び出しを待たせない） */
export function startBridge() {
  if (bridgePromise) return bridgePromise;
  bridgePromise = new Promise((resolve) => {
    bridgeResolve = resolve;
    const f = document.createElement('iframe');
    f.src = `${CONFIG.GAS_URL}?bridge=1`;
    f.title = '通信用';
    f.setAttribute('aria-hidden', 'true');
    f.tabIndex = -1;
    f.style.cssText = 'position:absolute;width:1px;height:1px;border:0;left:-9999px;top:0';
    document.body.appendChild(f);
    setTimeout(() => {
      if (bridgeResolve) {
        bridgeResolve(null);
        bridgeResolve = null;
      }
    }, BRIDGE_READY_MS);
  });
  return bridgePromise;
}

function callViaBridge(bridge, req) {
  return new Promise((resolve, reject) => {
    const id = randomId();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('bridge_timeout'));
    }, BRIDGE_CALL_MS);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    bridge.win.postMessage({ type: 'ft-call', id, payload: req }, bridge.origin);
  });
}

/**
 * Apps Script へ送る。早い道を先に試し、だめなら予備の道で最大5回まで送り直す。
 * どちらの道でも同じ rid を使うので、Apps Script 側で二重に実行されることはない
 */
export async function callGas(payload) {
  const req = { ...payload, rid: randomId() };
  const bridge = await startBridge();
  if (bridge) {
    try {
      return await callViaBridge(bridge, req);
    } catch (err) {
      console.warn('早い道で失敗したため予備の道に切り替えます', err);
    }
  }
  const body = JSON.stringify(req);
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(CONFIG.GAS_URL, { method: 'POST', body });
      if (!res.ok) throw new Error('gas_http_' + res.status);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function randomId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const num = i === 0 ? String(v) : v.toFixed(v < 10 ? 1 : 0);
  return `${num} ${units[i]}`;
}

export function formatDate(iso, lang = 'ja') {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  if (lang === 'en') {
    return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** fetch の本文を Uint8Array の流れとして読む（Safari でも動く書き方） */
export async function* readBody(res) {
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** 画面下に短く出す通知 */
export function toast(message) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2200);
}
