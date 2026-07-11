/* ===== サブスク管理 ローカルPWA ===== */
(() => {
  'use strict';

  /* ---------- ストレージキー ---------- */
  const K_ITEMS = 'subs:items';
  const K_THEME = 'subs:theme';

  /* ---------- 状態 ---------- */
  let items = [];
  let editingId = null;  // 編集中のサブスクID(null=新規)
  let detailId = null;   // 詳細表示中のサブスクID

  /* ---------- カテゴリ ---------- */
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
  const todayStr = () => new Date().toISOString().slice(0, 10);

  function addMonthsClamped(dateStr, months) {
    const d = new Date(dateStr + 'T00:00:00');
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + months);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
    return d.toISOString().slice(0, 10);
  }
  function addYears(dateStr, years) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setFullYear(d.getFullYear() + years);
    return d.toISOString().slice(0, 10);
  }
  function daysUntil(dateStr) {
    const today = new Date(todayStr() + 'T00:00:00');
    const target = new Date(dateStr + 'T00:00:00');
    return Math.round((target - today) / 86400000);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- 永続化 ---------- */
  function loadItems() {
    try {
      const raw = localStorage.getItem(K_ITEMS);
      items = raw ? JSON.parse(raw) : [];
    } catch (e) {
      items = [];
    }
    // 旧バージョンで保存された暗号化ID/パスワード(cred)は使わないため取り除く
    let cleaned = false;
    for (const it of items) {
      if ('cred' in it) { delete it.cred; cleaned = true; }
    }
    if (cleaned) saveItems();
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
      $('#sum-next-label').textContent = items.length ? '更新日未設定' : '登録なし';
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
      return a.name.localeCompare(b.name, 'ja');
    });
    wrap.innerHTML = sorted.map(it => {
      let badgeClass = 'badge-normal', badgeText = '更新日未設定';
      if (it.nextDate) {
        const d = daysUntil(it.nextDate);
        badgeText = d <= 0 ? '本日更新' : `あと${d}日`;
        if (d <= 3) badgeClass = 'badge-danger';
        else if (d <= 7) badgeClass = 'badge-warn';
      }
      return `
      <article class="card" style="--cat-color:${colorForCategory(it.category)}" data-id="${it.id}" role="button" tabindex="0" aria-label="${escapeHtml(it.name)}の詳細を開く">
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
        </div>
        <div class="card-chevron">›</div>
      </article>`;
    }).join('');
  }

  function renderAll() {
    renderSummary();
    renderCategoryBreakdown();
    renderList();
    $('#count-label').textContent = `登録中のサブスク(${items.length}件)`;
  }

  /* ---------- 詳細表示 ---------- */
  function openDetail(id) {
    const it = items.find(x => x.id === id);
    if (!it) return;
    detailId = id;
    $('#d-name').textContent = it.name;
    $('#d-amount').textContent = `${yen(it.amount)} ${it.cycle === 'yearly' ? '/ 年' : '/ 月'}`;
    $('#d-category').textContent = it.category;
    if (it.nextDate) {
      const d = daysUntil(it.nextDate);
      $('#d-nextdate').textContent = `${it.nextDate}(${d <= 0 ? '本日更新' : 'あと' + d + '日'})`;
    } else {
      $('#d-nextdate').textContent = '未設定';
    }
    $('#d-payment').textContent = it.payment || '未設定';
    if (it.memo) {
      $('#d-memo-wrap').style.display = '';
      $('#d-memo').textContent = it.memo;
    } else {
      $('#d-memo-wrap').style.display = 'none';
    }
    openModal('modal-detail');
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
    $('#f-date').value = (it && it.nextDate) ? it.nextDate : '';
    $('#f-payment').value = it ? (it.payment || '') : '';
    $('#f-memo').value = it ? (it.memo || '') : '';
    openModal('modal-form');
    setTimeout(() => $('#f-name').focus(), 50);
  }

  function submitForm(e) {
    e.preventDefault();
    const name = $('#f-name').value.trim();
    const amount = parseFloat($('#f-amount').value);
    const cycle = $('#f-cycle').value;
    const category = $('#f-category').value.trim() || 'その他';
    const nextDate = $('#f-date').value || null;
    const payment = $('#f-payment').value.trim();
    const memo = $('#f-memo').value.trim();

    if (!name || isNaN(amount) || amount < 0) {
      toast('名称と金額を確認してください');
      return;
    }

    if (editingId) {
      const it = items.find(x => x.id === editingId);
      Object.assign(it, { name, amount, cycle, category, nextDate, payment, memo });
    } else {
      items.push({ id: uid(), name, amount, cycle, category, nextDate, payment, memo });
    }
    saveItems();
    rollForwardDates();
    renderAll();
    closeAllModals();
    toast('保存しました');
  }

  function deleteItem(id) {
    if (!confirm('このサブスクを削除しますか?この操作は取り消せません。')) return;
    items = items.filter(x => x.id !== id);
    saveItems();
    renderAll();
    closeAllModals();
    toast('削除しました');
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
    const payload = {
      app: 'sub-manager-backup',
      version: 2,
      exportedAt: new Date().toISOString(),
      items: items
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
    const header = ['名称', '金額', '周期', 'カテゴリ', '次回更新日', '支払い方法', 'メモ'];
    const rows = items.map(it => [
      it.name, it.amount, it.cycle === 'yearly' ? '年額' : '月額', it.category,
      it.nextDate || '', it.payment || '', it.memo || ''
    ]);
    const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
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
      // 旧バージョンのバックアップに含まれるcred(暗号化ID/PW)は破棄
      for (const it of items) { if ('cred' in it) delete it.cred; }
      saveItems();
      rollForwardDates();
      renderAll();
      closeModal('modal-data');
      toast('復元しました');
    };
    reader.readAsText(file);
  }

  /* ---------- イベント結線 ---------- */
  function wireEvents() {
    $('#theme-toggle').addEventListener('click', toggleTheme);
    $('#fab-add').addEventListener('click', () => openForm(null));
    $('#overlay').addEventListener('click', closeAllModals);
    $$('.modal-close').forEach(b => b.addEventListener('click', (e) => closeModal(e.target.closest('.modal').id)));

    $('#sub-form').addEventListener('submit', submitForm);

    // カードタップで詳細を開く
    $('#sub-list').addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (card) openDetail(card.dataset.id);
    });
    $('#sub-list').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('.card');
      if (card) { e.preventDefault(); openDetail(card.dataset.id); }
    });

    // 詳細モーダル内の編集・削除
    $('#d-edit').addEventListener('click', () => {
      if (!detailId) return;
      closeModal('modal-detail');
      openForm(detailId);
    });
    $('#d-delete').addEventListener('click', () => {
      if (detailId) deleteItem(detailId);
    });

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
  function init() {
    const savedTheme = localStorage.getItem(K_THEME) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(savedTheme);
    loadItems();
    rollForwardDates();
    wireEvents();
    renderAll();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
