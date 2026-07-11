/* ===== サブスク管理 ローカルPWA ===== */
(() => {
  'use strict';

  /* ---------- ストレージキー ---------- */
  const K_ITEMS = 'subs:items';
  const K_THEME = 'subs:theme';
  const K_SALT = 'subs:salt';
  const K_VERIFIER = 'subs:verifier';

  /* ---------- 状態 ---------- */
  let items = [];
  let sessionKey = null; // CryptoKey、ロック解除中のみメモリ上に保持
  let pendingUnlockResolve = null;
  let editingId = null; // 編集中のサブスクID(null=新規)

  /* ---------- カテゴリ ---------- */
  const CATEGORY_SUGGESTIONS = ['動画', '音楽', 'クラウド', 'AI・ツール', '通信', 'ジム・健康', 'その他'];
  const CATEGORY_COLORS = {
    '動画': '#E3A636', '音楽': '#5B8DEF', 'クラウド': '#2F6F5E',
    'AI・ツール': '#8E6FD1', '通信': '#C8553D', 'ジム・健康': '#3FA98A'
  };
  function colorForCategory(cat) {
    if (CATEGORY_COLORS[cat]) return CATEGORY_COLORS[cat];
    let h = 0;
    for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) % 360;
    return `hsl(${h}, 55%, 50%)`;
  }

  /* ---------- ユーティリティ ---------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const yen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
  // 日付は常にローカルタイムで整形する(toISOStringはUTC変換で日付がずれるため使わない)
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const todayStr = () => fmtDate(new Date());

  function addMonthsClamped(dateStr, months) {
    const d = new Date(dateStr + 'T00:00:00');
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + months);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
    return fmtDate(d);
  }
  function addYears(dateStr, years) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setFullYear(d.getFullYear() + years);
    return fmtDate(d);
  }
  function daysUntil(dateStr) {
    const today = new Date(todayStr() + 'T00:00:00');
    const target = new Date(dateStr + 'T00:00:00');
    return Math.round((target - today) / 86400000);
  }

  /* ---------- 永続化 ---------- */
  function loadItems() {
    try {
      const raw = localStorage.getItem(K_ITEMS);
      items = raw ? JSON.parse(raw) : [];
    } catch (e) {
      items = [];
    }
  }
  function saveItems() {
    localStorage.setItem(K_ITEMS, JSON.stringify(items));
  }
  function rollForwardDates() {
    let changed = false;
    const t = todayStr();
    for (const it of items) {
      if (!it.nextDate) continue;
      let guard = 0;
      while (it.nextDate < t && guard < 600) {
        it.nextDate = it.cycle === 'yearly' ? addYears(it.nextDate, 1) : addMonthsClamped(it.nextDate, 1);
        changed = true;
        guard++;
      }
    }
    if (changed) saveItems();
  }

  /* ---------- 暗号化(Web Crypto / PBKDF2 + AES-GCM) ---------- */
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  async function deriveKey(passcode, saltB64) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(passcode), { name: 'PBKDF2' }, false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64ToBuf(saltB64), iterations: 150000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  async function encryptStr(key, str) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(str));
    return { iv: bufToB64(iv), data: bufToB64(ct) };
  }
  async function decryptStr(key, payload) {
    const dec = new TextDecoder();
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(payload.iv)) },
      key,
      b64ToBuf(payload.data)
    );
    return dec.decode(pt);
  }
  function hasPasscodeSetup() {
    return !!localStorage.getItem(K_SALT);
  }

  /* requireUnlock: sessionKey があればすぐ実行、なければモーダルを出して解決後に実行 */
  function requireUnlock(callback) {
    if (sessionKey) { callback(sessionKey); return; }
    if (hasPasscodeSetup()) {
      openModal('modal-unlock');
      $('#unlock-input').value = '';
      $('#unlock-error').textContent = '';
      pendingUnlockResolve = callback;
      setTimeout(() => $('#unlock-input').focus(), 50);
    } else {
      openModal('modal-setup');
      $('#setup-input1').value = '';
      $('#setup-input2').value = '';
      $('#setup-error').textContent = '';
      pendingUnlockResolve = callback;
      setTimeout(() => $('#setup-input1').focus(), 50);
    }
  }

  async function handleSetupSubmit() {
    const p1 = $('#setup-input1').value;
    const p2 = $('#setup-input2').value;
    if (p1.length < 4) { $('#setup-error').textContent = '4文字以上で設定してください'; return; }
    if (p1 !== p2) { $('#setup-error').textContent = '確認用と一致しません'; return; }
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const saltB64 = bufToB64(saltBytes);
    const key = await deriveKey(p1, saltB64);
    const verifier = await encryptStr(key, 'OK_VERIFIER');
    localStorage.setItem(K_SALT, saltB64);
    localStorage.setItem(K_VERIFIER, JSON.stringify(verifier));
    sessionKey = key;
    closeModal('modal-setup');
    const cb = pendingUnlockResolve; pendingUnlockResolve = null;
    updateLockButton();
    if (cb) cb(key);
  }

  async function handleUnlockSubmit() {
    const p = $('#unlock-input').value;
    const saltB64 = localStorage.getItem(K_SALT);
    const verifier = JSON.parse(localStorage.getItem(K_VERIFIER));
    try {
      const key = await deriveKey(p, saltB64);
      const check = await decryptStr(key, verifier);
      if (check !== 'OK_VERIFIER') throw new Error('mismatch');
      sessionKey = key;
      closeModal('modal-unlock');
      const cb = pendingUnlockResolve; pendingUnlockResolve = null;
      updateLockButton();
      if (cb) cb(key);
    } catch (e) {
      $('#unlock-error').textContent = 'パスコードが違います';
    }
  }

  function lockNow() {
    sessionKey = null;
    updateLockButton();
    toast('認証情報をロックしました');
  }
  function updateLockButton() {
    const btn = $('#lock-toggle');
    if (!btn) return;
    btn.textContent = sessionKey ? '🔓 ロックする' : '🔒 ロック中';
    btn.classList.toggle('is-unlocked', !!sessionKey);
  }

  /* ---------- モーダル ---------- */
  function openModal(id) { $('#' + id).classList.add('open'); $('#overlay').classList.add('open'); }
  function closeModal(id) {
    $('#' + id).classList.remove('open');
    if ($$('.modal.open').length === 0) $('#overlay').classList.remove('open');
  }
  function closeAllModals() { $$('.modal').forEach(m => m.classList.remove('open')); $('#overlay').classList.remove('open'); }

  /* ---------- テーマ ---------- */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(K_THEME, theme);
    $('#theme-toggle').textContent = theme === 'dark' ? '☀️ ライト' : '🌙 ダーク';
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  }

  /* ---------- トースト ---------- */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  /* ---------- 集計 ---------- */
  function monthlyEquivalent(it) { return it.cycle === 'yearly' ? it.amount / 12 : it.amount; }
  function yearlyEquivalent(it) { return it.cycle === 'yearly' ? it.amount : it.amount * 12; }

  function renderSummary() {
    const monthTotal = items.reduce((s, it) => s + monthlyEquivalent(it), 0);
    const yearTotal = items.reduce((s, it) => s + yearlyEquivalent(it), 0);
    $('#sum-month').textContent = items.length ? yen(monthTotal) : '¥0';
    $('#sum-year').textContent = items.length ? yen(yearTotal) : '¥0';

    const withDate = items.filter(it => it.nextDate);
    if (withDate.length === 0) {
      $('#sum-next-value').textContent = '−';
      $('#sum-next-label').textContent = '更新日未設定';
      return;
    }
    const sorted = [...withDate].sort((a, b) => a.nextDate.localeCompare(b.nextDate));
    const next = sorted[0];
    const d = daysUntil(next.nextDate);
    $('#sum-next-value').textContent = d <= 0 ? '本日' : `あと${d}日`;
    $('#sum-next-label').textContent = next.name;
  }

  function renderCategoryBreakdown() {
    const wrap = $('#category-breakdown');
    if (items.length === 0) { wrap.innerHTML = '<p class="muted">登録されたサブスクがありません</p>'; return; }
    const map = new Map();
    for (const it of items) {
      const v = monthlyEquivalent(it);
      map.set(it.category, (map.get(it.category) || 0) + v);
    }
    const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
    const max = rows[0][1] || 1;
    wrap.innerHTML = rows.map(([cat, val]) => `
      <div class="cat-row">
        <span class="cat-label">${escapeHtml(cat)}</span>
        <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${(val / max * 100).toFixed(1)}%;background:${colorForCategory(cat)}"></div></div>
        <span class="cat-value mono">${yen(val)}</span>
      </div>
    `).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderList() {
    const wrap = $('#sub-list');
    if (items.length === 0) {
      wrap.innerHTML = `<div class="empty">
        <p>まだサブスクが登録されていません。</p>
        <p class="muted">右下の「＋」から最初の1件を追加してください。</p>
      </div>`;
      return;
    }
    const sorted = [...items].sort((a, b) => {
      if (a.nextDate && b.nextDate) return a.nextDate.localeCompare(b.nextDate);
      if (a.nextDate) return -1;
      if (b.nextDate) return 1;
      return a.name.localeCompare(b.name);
    });
    wrap.innerHTML = sorted.map(it => {
      let badgeClass = '', badgeText = '';
      if (it.nextDate) {
        const d = daysUntil(it.nextDate);
        badgeClass = 'badge-normal'; badgeText = `あと${d}日`;
        if (d <= 0) { badgeClass = 'badge-danger'; badgeText = '本日更新'; }
        else if (d <= 3) { badgeClass = 'badge-danger'; }
        else if (d <= 7) { badgeClass = 'badge-warn'; }
      } else {
        badgeClass = 'badge-normal'; badgeText = '更新日未設定';
      }
      const hasCred = it.cred && (it.cred.id || it.cred.pw);
      return `
      <article class="card" style="--cat-color:${colorForCategory(it.category)}" data-id="${it.id}">
        <div class="card-main">
          <div class="card-top">
            <h3>${escapeHtml(it.name)}</h3>
            <div class="card-amount mono">${yen(it.amount)}<span class="cycle-tag">${it.cycle === 'yearly' ? '/年' : '/月'}</span></div>
          </div>
          <div class="card-meta">
            <span class="badge ${badgeClass}">${badgeText}</span>
            <span class="tag">${escapeHtml(it.category)}</span>
            ${it.payment ? `<span class="muted small">${escapeHtml(it.payment)}</span>` : ''}
          </div>
          <div class="card-cred-row">
            <span class="muted small">🔒 ID・パスワード</span>
            ${hasCred
              ? `<button class="btn-link" data-action="reveal" data-id="${it.id}">表示する</button>`
              : `<span class="muted small">未登録</span>`}
          </div>
          ${it.memo ? `<details class="memo"><summary>メモ(解約手順など)</summary><p>${escapeHtml(it.memo)}</p></details>` : ''}
        </div>
        <div class="card-actions">
          <button class="icon-btn" data-action="edit" data-id="${it.id}" title="編集">✏️</button>
          <button class="icon-btn" data-action="delete" data-id="${it.id}" title="削除">🗑️</button>
        </div>
      </article>`;
    }).join('');
  }

  function renderAll() {
    renderSummary();
    renderCategoryBreakdown();
    renderList();
    $('#count-label').textContent = `登録中のサブスク(${items.length}件)`;
  }

  /* ---------- フォーム(追加/編集) ---------- */
  function openForm(id) {
    editingId = id || null;
    const it = id ? items.find(x => x.id === id) : null;
    $('#form-title').textContent = it ? 'サブスクを編集' : 'サブスクを追加';
    $('#f-name').value = it ? it.name : '';
    $('#f-amount').value = it ? it.amount : '';
    $('#f-cycle').value = it ? it.cycle : 'monthly';
    $('#f-category').value = it ? it.category : '';
    $('#f-nextdate').value = it && it.nextDate ? it.nextDate : '';
    $('#f-payment').value = it ? (it.payment || '') : '';
    $('#f-memo').value = it ? (it.memo || '') : '';
    $('#f-id').value = '';
    $('#f-pw').value = '';
    $('#f-cred-note').textContent = (it && it.cred && (it.cred.id || it.cred.pw))
      ? '※ 既存のID/パスワードが保存されています。入力すると上書きされます(空欄のままなら変更されません)'
      : '';
    $('#f-delete').style.display = it ? 'inline-flex' : 'none';
    openModal('modal-form');
    setTimeout(() => $('#f-name').focus(), 50);
  }

  async function submitForm(e) {
    e.preventDefault();
    const name = $('#f-name').value.trim();
    const amount = parseFloat($('#f-amount').value);
    const cycle = $('#f-cycle').value;
    const category = $('#f-category').value.trim() || 'その他';
    const nextDate = $('#f-nextdate').value || undefined;
    const payment = $('#f-payment').value.trim();
    const memo = $('#f-memo').value.trim();
    const idVal = $('#f-id').value;
    const pwVal = $('#f-pw').value;

    if (!name || isNaN(amount) || amount < 0) {
      toast('名称と金額を確認してください');
      return;
    }

    const finalize = async (key) => {
      let cred = null;
      const existing = editingId ? items.find(x => x.id === editingId) : null;
      if (idVal || pwVal) {
        cred = { id: null, pw: null };
        cred.id = idVal ? await encryptStr(key, idVal) : (existing && existing.cred ? existing.cred.id : null);
        cred.pw = pwVal ? await encryptStr(key, pwVal) : (existing && existing.cred ? existing.cred.pw : null);
      } else if (existing && existing.cred) {
        cred = existing.cred;
      }

      if (editingId) {
        const it = items.find(x => x.id === editingId);
        Object.assign(it, { name, amount, cycle, category, nextDate, payment, memo, cred });
      } else {
        items.push({ id: uid(), name, amount, cycle, category, nextDate, payment, memo, cred });
      }
      saveItems();
      rollForwardDates(); // 過去日で登録された場合は次の更新日まで繰り越す
      renderAll();
      closeModal('modal-form');
      toast('保存しました');
    };

    if (idVal || pwVal) {
      requireUnlock(finalize);
    } else {
      finalize(null);
    }
  }

  function deleteItem(id) {
    if (!confirm('このサブスクを削除しますか?この操作は取り消せません。')) return;
    items = items.filter(x => x.id !== id);
    saveItems();
    renderAll();
    closeAllModals();
    toast('削除しました');
  }

  async function revealCredential(id) {
    const it = items.find(x => x.id === id);
    if (!it || !it.cred) return;
    requireUnlock(async (key) => {
      try {
        const idText = it.cred.id ? await decryptStr(key, it.cred.id) : '(未登録)';
        const pwText = it.cred.pw ? await decryptStr(key, it.cred.pw) : '(未登録)';
        $('#reveal-name').textContent = it.name;
        $('#reveal-id').textContent = idText;
        $('#reveal-pw').textContent = pwText;
        openModal('modal-reveal');
      } catch (e) {
        toast('復号に失敗しました。パスコードを確認してください');
        sessionKey = null;
        updateLockButton();
      }
    });
  }

  /* ---------- エクスポート/インポート ---------- */
  function todayCompact() { return todayStr().replace(/-/g, ''); }

  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJSON() {
    const verifierRaw = localStorage.getItem(K_VERIFIER);
    const payload = {
      app: 'sub-manager-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      items: items,
      salt: localStorage.getItem(K_SALT) || null,
      verifier: verifierRaw ? JSON.parse(verifierRaw) : null
    };
    downloadBlob(JSON.stringify(payload, null, 2), `subs-backup-${todayCompact()}.json`, 'application/json');
    toast('バックアップを書き出しました');
  }

  function csvEscape(val) {
    const s = String(val == null ? '' : val);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportCSV() {
    const header = ['名称', '金額', '周期', 'カテゴリ', '次回更新日', '支払い方法', 'メモ', 'ID・パスワード登録'];
    const rows = items.map(it => [
      it.name, it.amount, it.cycle === 'yearly' ? '年額' : '月額', it.category, it.nextDate,
      it.payment || '', it.memo || '', (it.cred && (it.cred.id || it.cred.pw)) ? '○' : ''
    ]);
    const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
    // 先頭にBOMを付けてExcelで開いたときの文字化けを防ぐ
    downloadBlob('\uFEFF' + csv, `subs-list-${todayCompact()}.csv`, 'text/csv');
    toast('CSVを書き出しました');
  }

  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (e) {
        toast('ファイルの読み込みに失敗しました');
        return;
      }
      if (!parsed || !Array.isArray(parsed.items)) {
        toast('バックアップ形式が正しくありません');
        return;
      }
      const ok = confirm(`現在の${items.length}件を、バックアップの${parsed.items.length}件で置き換えます。よろしいですか?この操作は取り消せません。`);
      if (!ok) return;

      items = parsed.items;
      saveItems();
      if (parsed.salt) localStorage.setItem(K_SALT, parsed.salt); else localStorage.removeItem(K_SALT);
      if (parsed.verifier) localStorage.setItem(K_VERIFIER, JSON.stringify(parsed.verifier)); else localStorage.removeItem(K_VERIFIER);
      sessionKey = null;
      updateLockButton();
      rollForwardDates();
      renderAll();
      closeModal('modal-data');
      toast('復元しました。ID/パスワードはバックアップ時のパスコードで開けます');
    };
    reader.readAsText(file);
  }

  function copyText(text, label) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => toast(`${label}をコピーしました`));
    }
  }

  /* ---------- イベント結線 ---------- */
  function wireEvents() {
    $('#theme-toggle').addEventListener('click', toggleTheme);
    $('#lock-toggle').addEventListener('click', () => {
      if (sessionKey) lockNow(); else requireUnlock(() => toast('ロックを解除しました'));
    });
    $('#fab-add').addEventListener('click', () => openForm(null));
    $('#overlay').addEventListener('click', closeAllModals);
    $$('.modal-close').forEach(b => b.addEventListener('click', (e) => closeModal(e.target.closest('.modal').id)));

    $('#sub-form').addEventListener('submit', submitForm);
    $('#f-delete').addEventListener('click', () => { if (editingId) deleteItem(editingId); });

    $('#sub-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.action === 'edit') openForm(id);
      if (btn.dataset.action === 'delete') deleteItem(id);
      if (btn.dataset.action === 'reveal') revealCredential(id);
    });

    $('#setup-submit').addEventListener('click', handleSetupSubmit);
    $('#unlock-submit').addEventListener('click', handleUnlockSubmit);
    $('#setup-input2').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSetupSubmit(); });
    $('#unlock-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleUnlockSubmit(); });

    $('#copy-id').addEventListener('click', () => copyText($('#reveal-id').textContent, 'ID'));
    $('#copy-pw').addEventListener('click', () => copyText($('#reveal-pw').textContent, 'パスワード'));

    $('#data-toggle').addEventListener('click', () => openModal('modal-data'));
    $('#export-json').addEventListener('click', exportJSON);
    $('#export-csv').addEventListener('click', exportCSV);
    $('#import-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) importJSON(file);
      e.target.value = '';
    });
  }

  /* ---------- 初期化 ---------- */
  function populateCategoryDatalist() {
    const dl = $('#category-list');
    dl.innerHTML = '';
    for (const c of CATEGORY_SUGGESTIONS) {
      const o = document.createElement('option');
      o.value = c;
      dl.appendChild(o);
    }
  }

  function init() {
    const savedTheme = localStorage.getItem(K_THEME) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(savedTheme);
    populateCategoryDatalist();
    loadItems();
    rollForwardDates();
    wireEvents();
    updateLockButton();
    renderAll();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
