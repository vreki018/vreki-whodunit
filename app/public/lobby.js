// lobby.js — the first page of "ใครคือฆาตกร?": rule choice, start / test mode, the running-game
// box, the replay list and "ปิดเกม". Company / model / voice settings live in setup.js (SETUP).
// A game opens the watch page in this same tab (location.href): the click that got us there
// lets that page play sound. The lobby never shows who won a game.
'use strict';

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  // the six players (same ids / names / colours as app/config.default.json "characters")
  const CAST = [
    { id: 'jaem', name: 'ป้าแจ่ม', color: '#C2566B' },
    { id: 'perm', name: 'ลุงเพิ่ม', color: '#8A9A5B' },
    { id: 'fah', name: 'น้องฟ้า', color: '#4FA3D1' },
    { id: 'wit', name: 'ครูวิทย์', color: '#7C6BC4' },
    { id: 'muay', name: 'เจ๊หมวย', color: '#D08B3E' },
    { id: 'tee', name: 'ตี๋', color: '#3FA88B' },
  ];
  const RULE_TH = { g1: 'เกม 1 · ธรรมดา', g2: 'เกม 2 · บทบาทพิเศษ' };
  const MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

  $('#cast').innerHTML = CAST.map((c) => `
    <div class="cast-item" style="--c:${c.color}">
      <div class="disc">${window.faceSVG ? faceSVG(c.id, c.color) : ''}</div>
      <div class="nm">${esc(c.name)}</div>
    </div>`).join('');

  const watchUrl = (g) => `/watch.html?t=/games/${encodeURIComponent(g.id)}.json&live=1&voice=${g.voiceMode && g.voiceMode !== 'off' ? 1 : 0}`;
  let running = null; // status.game of a game still being played

  async function refreshStatus() {
    const st = await fetch('/api/status').then((r) => r.json()).catch(() => null);
    running = st?.game && !st.game.done ? st.game : null;
    $('#runningBox').hidden = !running;
  }

  // rule choice: saved in settings.json as `rules`
  // (index.html paints g1 checked; the saved choice replaces it once /api/setup answers)
  function showRules(rules) {
    if (!RULE_TH[rules]) rules = 'g1';
    for (const r of document.querySelectorAll('input[name="rules"]')) r.checked = r.value === rules;
    $('#stripRules').textContent = `กติกา: ${RULE_TH[rules]}`; // echoed next to seats + voice, so the start choice is visible
  }
  SETUP.loaded.then((s) => { if (s) showRules(s.rules); });
  document.addEventListener('change', (e) => {
    if (e.target.name === 'rules') {
      showRules(e.target.value);
      const s = SETUP.settings(); if (s) s.rules = e.target.value;
      SETUP.save({ rules: e.target.value }, true);
    }
  });
  // what the cards show is what the game uses (a card is always checked: g1 on first paint)
  const pickedRules = () => document.querySelector('input[name="rules"]:checked')?.value || 'g1';

  function showError(text) {
    const err = $('#startError');
    err.textContent = text || '';
    err.hidden = !text;
  }

  let starting = false;
  async function start(mock) {
    if (starting) return;
    showError('');
    if (!mock && !SETUP.ready()) {
      showError('ยังไม่ได้เลือกค่าย AI ที่พร้อมใช้ — กด "ตั้งค่า AI และเสียง" ก่อน (หรือกดโหมดทดสอบเพื่อลองเกมโดยไม่เรียก AI)');
      return;
    }
    starting = true;
    for (const b of document.querySelectorAll('[data-act="start"], [data-act="start-mock"]')) b.disabled = true;
    try {
      const body = mock ? { mock: true, rules: pickedRules() } : { ...SETUP.current(), rules: pickedRules() };
      let r = await post('/api/new', body).catch(() => null);
      if (r && r.status === 409) {
        const pick = await SETUP.ask({
          title: 'มีเกมเล่นอยู่',
          buttons: [
            { id: 'force', label: 'หยุดเกมเดิมแล้วเริ่มใหม่', primary: true },
            { id: 'watch', label: 'ดูเกมที่เล่นอยู่' },
            { id: 'cancel', label: 'ยกเลิก' },
          ],
        });
        if (pick === 'watch') { await openRunning(); return; }
        if (pick !== 'force') return;
        r = await post('/api/new', { ...body, force: true }).catch(() => null);
      }
      const j = r ? await r.json().catch(() => ({})) : {};
      if (!r || !r.ok || !j.watch) { showError(j.error || 'เริ่มเกมไม่ได้ — ลองเปิด start.bat ใหม่'); return; }
      location.href = j.watch;
    } finally {
      starting = false;
      for (const b of document.querySelectorAll('[data-act="start"], [data-act="start-mock"]')) b.disabled = false;
    }
  }

  async function openRunning() {
    await refreshStatus();
    if (running) location.href = watchUrl(running);
    else showError('เกมนั้นจบไปแล้ว · ดูได้ใน "เกมย้อนหลัง"');
  }

  // the running-game box: stop the game (same question as the watch page). The game stops asking
  // the AIs at once; the box goes away once the game has written its last file.
  async function stopRunning() {
    const pick = await SETUP.ask({
      title: 'หยุดเกมนี้เลยไหม?',
      buttons: [{ id: 'stop', label: 'หยุดเกม', primary: true }, { id: 'cancel', label: 'ดูต่อ' }],
    });
    if (pick !== 'stop') return;
    const b = $('[data-act="stop-running"]');
    b.disabled = true; b.textContent = 'กำลังหยุด…';
    try {
      const r = await post('/api/abort', {}).catch(() => null);
      if (!r || !r.ok) { showError('หยุดเกมไม่ได้ — ลองใหม่อีกครั้ง'); return; }
      for (let i = 0; i < 600; i++) { // up to ~10 min: an AI call already under way finishes first
        await refreshStatus();
        if (!running) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
    } finally { b.disabled = false; b.textContent = 'หยุดเกม'; }
    if (!$('#historyBox').hidden) { $('#historyBox').hidden = true; toggleHistory(); } // the stopped game is a replay now
  }

  // w_YYYYMMDD_HHMMSS → "28 ต.ค. 14:05"
  function whenText(id) {
    const m = String(id).match(/^w_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
    return m ? `${+m[3]} ${MONTH[+m[2] - 1] || ''} ${m[4]}:${m[5]}` : id;
  }
  function rowHtml(g) {
    if (g.fromClip) {
      return `<button data-replay="${esc(g.id)}" class="clip"><span>${esc(g.label)}</span><span class="tag">จากคลิป</span></button>`;
    }
    const parts = [whenText(g.id), RULE_TH[g.rules] || '', g.mock ? 'ทดสอบ' : ''].filter(Boolean);
    // the game still being played opens live (a plain replay of a half-written file would end mid-way)
    if (running && g.id === running.id) return `<button data-live="${esc(g.id)}"><span>${esc(parts.join(' · '))}</span><span class="tag live">กำลังเล่นอยู่ · ดูสด</span></button>`;
    const ai = !g.mock && g.durationSec ? `AI คิดรวม ${Math.max(1, Math.round(g.durationSec / 60))} นาที` : '';
    return `<button data-replay="${esc(g.id)}"><span>${esc(parts.join(' · '))}</span><span class="tag">${esc(ai)}</span></button>`;
  }
  async function toggleHistory() {
    const box = $('#historyBox');
    if (!box.hidden) { box.hidden = true; return; }
    const games = await fetch('/api/games').then((r) => r.json()).catch(() => null);
    await refreshStatus();
    if (!Array.isArray(games)) { showError('โหลดรายการเกมไม่ได้'); return; }
    box.innerHTML = games.length ? games.map(rowHtml).join('') : '<p class="hint">ยังไม่มีเกม</p>';
    box.hidden = false;
  }

  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-live]')) { openRunning(); return; }
    const rep = e.target.closest('[data-replay]');
    if (rep) { location.href = `/watch.html?t=/games/${encodeURIComponent(rep.dataset.replay)}.json`; return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'start') start(false);
    if (act === 'start-mock') start(true);
    if (act === 'watch-running') openRunning();
    if (act === 'stop-running') stopRunning();
    if (act === 'history') toggleHistory();
    if (act === 'shutdown') {
      if (!(await SETUP.confirm('ปิดเกม? (เกมที่เล่นอยู่จะหยุด)'))) return;
      await post('/api/shutdown').catch(() => {});
      $('#closedNote').hidden = false;
    }
  });

  refreshStatus();
})();
