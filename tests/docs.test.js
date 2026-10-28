'use strict';
// README / INSTALL-FOR-AI / LICENSE / logo sources are part of the giveaway: a viewer's AI
// installs the game from INSTALL-FOR-AI.md, so its steps must name the real commands.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('README says what to type to install, links the clip and warns about quota', () => {
  const r = read('README.md');
  assert.ok(r.includes('เปิด Claude Code หรือ Codex ในโฟลเดอร์นี้ แล้วพิมพ์ว่า'));
  assert.ok(r.includes('อ่าน INSTALL-FOR-AI.md แล้วติดตั้งเกมนี้ให้หน่อย'));
  // the clip link is a placeholder until release day, then a YouTube URL
  assert.match(r, /\{\{CLIP_URL\}\}|https:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)/);
  assert.match(r, /93–125/);
  assert.match(r, /claude update/);
});

test('INSTALL-FOR-AI names the real install, shortcut and self-test commands', () => {
  const g = read('INSTALL-FOR-AI.md');
  for (const s of ['node -v', 'requirements.txt', 'scripts\\make-shortcut.ps1', 'node app/launch.js --selftest', 'data/gemini_key.txt', 'Thai']) {
    assert.ok(g.includes(s), `missing ${s}`);
  }
  for (const f of ['requirements.txt', 'scripts/make-shortcut.ps1', 'app/launch.js', 'start.bat']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test('INSTALL-FOR-AI keeps the Gemini key out of the chat and never starts the game itself', () => {
  const g = read('INSTALL-FOR-AI.md');
  assert.ok(g.includes('Never ask for it and never accept it here'));
  assert.ok(g.includes('ตั้งค่า AI และเสียง'));
  assert.ok(!/write it (only )?to `data\/gemini_key\.txt`/.test(g), 'the AI must not write the key from the chat');
  assert.ok(!/pastes? a key, write/i.test(g));
  assert.ok(g.includes('Do not start `start.bat` or the server yourself'));
  assert.ok(!/want you to start the game/.test(g));
});

test('LICENSE is MIT for VreKi_', () => {
  const l = read('LICENSE');
  assert.match(l, /^MIT License/);
  assert.ok(l.includes('Copyright (c) 2026 VreKi_'));
});

test('every logo file has its source and licence written down', () => {
  const dir = path.join(ROOT, 'app', 'public', 'logos');
  const src = read('app', 'public', 'logos', 'SOURCES.md');
  const logos = fs.readdirSync(dir).filter((f) => f.endsWith('.svg'));
  assert.ok(logos.length >= 3);
  for (const f of logos) assert.ok(src.includes(f), `${f} not in SOURCES.md`);
  assert.ok(src.includes('commons.wikimedia.org'));
});

test('the trademark name of the space-station party game appears nowhere in the game', () => {
  const bad = new RegExp('among' + '\\s*' + 'us', 'i');
  const SKIP = new Set(['.git', 'data', 'node_modules', '.superpowers', 'pylib', 'dist', '__pycache__']);
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); continue; }
      const buf = fs.readFileSync(p);
      if (buf.includes(0)) continue; // binary
      if (bad.test(buf.toString('utf8'))) hits.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  assert.deepStrictEqual(hits, []);
});

// episode numbers are internal: viewers never see one (the repo is public, so comments count too)
test('no episode number in any repo file', () => {
  const bad = new RegExp(String.raw`\b` + 'ep' + String.raw`\s*0*\d+\b`, 'i'); // in pieces, so this file does not match itself
  let files;
  try {
    files = require('child_process').execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch (_) { // a copy without git (the release ZIP): every file but the viewer's own data
    const SKIP = new Set(['.git', 'data', 'node_modules', '.superpowers', 'pylib', 'dist', '__pycache__']);
    const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? (SKIP.has(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
    files = walk('.');
  }
  assert.ok(files.length > 20);
  const hits = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    if (buf.includes(0)) continue; // binary (mp3 bytes can spell anything)
    buf.toString('utf8').split(/\r?\n/).forEach((l, i) => { if (bad.test(l)) hits.push(`${f}:${i + 1}`); });
  }
  assert.deepStrictEqual(hits, []);
});
