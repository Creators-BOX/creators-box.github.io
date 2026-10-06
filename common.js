// 送信ページ・受け取りページの共通処理
import { CONFIG } from './config.js';

export const $ = (sel, root = document) => root.querySelector(sel);

export function isConfigured() {
  return Boolean(CONFIG.GAS_URL && CONFIG.CLIENT_ID && CONFIG.API_KEY);
}

/** Apps Script へ送る。text/plain で送り、事前確認（CORSのプリフライト）を起こさない */
export async function callGas(payload) {
  const res = await fetch(CONFIG.GAS_URL, { method: 'POST', body: JSON.stringify(payload) });
  if (!res.ok) throw new Error('gas_http_' + res.status);
  return res.json();
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
