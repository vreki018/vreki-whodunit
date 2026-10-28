'use strict';
// every script a page can load must at least parse (a syntax error in one script once hid a whole button)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'app', 'public');
const scripts = fs.readdirSync(PUB).filter((f) => f.endsWith('.js'));

test('the shared page scripts are there', () => {
  for (const s of ['avatars.js', 'sfx.js']) assert.ok(scripts.includes(s), s);
});

for (const s of scripts) {
  test(`${s} parses`, () => {
    assert.doesNotThrow(() => new Function(fs.readFileSync(path.join(PUB, s), 'utf8')));
  });
}

// pages are added by later tasks: each one may only load scripts that exist in public/
for (const page of fs.readdirSync(PUB).filter((f) => f.endsWith('.html'))) {
  test(`${page} loads only scripts that exist`, () => {
    const html = fs.readFileSync(path.join(PUB, page), 'utf8');
    for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) {
      if (/^https?:/.test(src)) continue;
      assert.ok(fs.existsSync(path.join(PUB, src)), `${page} → ${src}`);
    }
  });
}

test('the company logos are there', () => {
  for (const f of ['claude.svg', 'gemini.svg', 'openai_2025.svg']) assert.ok(fs.existsSync(path.join(PUB, 'logos', f)), f);
});

// inline <script> blocks are page code too
for (const page of fs.readdirSync(PUB).filter((f) => f.endsWith('.html'))) {
  test(`${page} inline scripts parse`, () => {
    const html = fs.readFileSync(path.join(PUB, page), 'utf8');
    for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(code), page);
  });
}

test('watch.html: release keys only, no debug label, a way home', () => {
  const html = fs.readFileSync(path.join(PUB, 'watch.html'), 'utf8');
  assert.ok(!html.includes('id="proto"'), 'file-name corner label');
  assert.ok(!/e\.key === 'i'/.test(html), 'I key (show killer)');
  assert.match(html, /Space หยุด · 1 2 3 ความเร็ว · T ความคิด AI · M เสียง · R เริ่มใหม่/);
  assert.match(html, /<a class="hud" id="home" href="\/">กลับหน้าแรก<\/a>/);
  for (const s of ['รอ AI คิดตาถัดไป…', 'เกมหยุดแล้ว', 'หมดเวลา · ไม่มีฝ่ายชนะ', 'โหลดเกมไม่ได้ ลองรีเฟรชหน้า', 'กำลังประชุม…',
    'เกมนี้ถูกหยุดกลางคัน', 'ติดต่อเกมไม่ได้ · เกมอาจถูกปิดไปแล้ว']) assert.ok(html.includes(s), s);
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Kanit/);
});

test('stop button: watch page and lobby ask first, then POST /api/abort as JSON', () => {
  const html = fs.readFileSync(path.join(PUB, 'watch.html'), 'utf8');
  assert.match(html, /<button id="stopBtn" type="button">หยุดเกม<\/button>/);
  assert.ok(html.includes('หยุดเกมนี้เลยไหม?') && html.includes('>ดูต่อ<'));
  assert.match(html, /fetch\('\/api\/abort', \{method:'POST', headers:\{'Content-Type':'application\/json'\}, body:'\{\}'\}\)/);
  assert.ok(!/\b(alert|confirm)\(/.test(html), 'no browser dialogs');
  const lobby = fs.readFileSync(path.join(PUB, 'lobby.js'), 'utf8'), index = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.match(index, /<div id="runningBox"[\s\S]*data-act="stop-running">หยุดเกม<\/button>[\s\S]*?<\/div>/);
  assert.ok(lobby.includes("title: 'หยุดเกมนี้เลยไหม?'") && lobby.includes("post('/api/abort', {})"));
});

// ?t= picks the game file: only the game's own /games/<id>.json may load (a crafted link must not fetch another site)
test('watch.html loads only /games/<id>.json and escapes AI text', () => {
  const html = fs.readFileSync(path.join(PUB, 'watch.html'), 'utf8');
  const src = html.match(/const T_OK = (\/.+\/);/);
  assert.ok(src, 'T_OK regex');
  const T_OK = new Function(`return ${src[1]}`)();
  for (const ok of ['/games/clip_g1.json', '/games/w_20261028_140501.json', '/games/w_20261028_140501_2.json']) assert.ok(T_OK.test(ok), ok);
  for (const bad of ['https://example.com/x.json', '//example.com/games/x.json', '/games/../app/server.js', '/games/x.json?y', '/games/x.json\n',
    '/games/a/b.json', 'games/x.json', '/games/x.js', '/data/x.json', 'javascript:alert(1)', ' /games/x.json', '/games/%2e%2e.json']) assert.ok(!T_OK.test(bad), bad);
  // every fetch of the timeline sits behind the check
  assert.match(html, /if \(tlUrl && T_OK\.test\(tlUrl\)\) loadGame\(/);
  assert.match(html, /else if \(tlUrl\) showCard\('โหลดเกมไม่ได้ ลองรีเฟรชหน้า'/);
  // the caption of a meeting line (AI text) is escaped
  assert.ok(html.includes('<div class="ftx"><b>${esc(c.name)}</b>${esc(txt)}</div>'));
  assert.ok(!/\$\{txt\}/.test(html), 'raw ${txt} in a template');
  const esc = new Function(`${html.match(/const esc = .+;/)[0]} return esc;`)();
  assert.strictEqual(esc('<img src=x onerror="a(1)">&\''), '&lt;img src=x onerror=&quot;a(1)&quot;&gt;&amp;&#39;');
});
