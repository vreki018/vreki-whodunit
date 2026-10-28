'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-run-'));
process.env.VREKI_DATA_DIR = tmp;
const { GameRun } = require('../app/runner');
const { callProvider } = require('../app/providers');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'config.default.json'), 'utf8'));
const ID_RE = /^(w_[0-9_]+|clip_g[12])$/;
const newDir = () => fs.mkdtempSync(path.join(tmp, 'out-'));
const readTl = (r) => JSON.parse(fs.readFileSync(r.file, 'utf8'));
// a stand-in for a real company: answers like the mock seat, no AI call
const mockAnswer = (req) => callProvider('mock', {}, { mockDelay: 0 }, req);

// meeting lines as voice_game.js counts them: opener per report/emergency, then every say
function meetingLines(tl) {
  const per = []; let m = -1;
  for (const e of tl) {
    if (e.type === 'report' || e.type === 'emergency') { m++; per[m] = 1; }
    else if (e.type === 'say' && m >= 0) per[m]++;
  }
  return per;
}

// mock answers are random (Math.random), and about 1 mock g1 game in 5 runs out the 60 ticks with no winner
// (measured 2026-10-28: 45 of 200) → play up to 8 games: every one ends cleanly, at least one has a win event
test('mock g1 plays to the end', async () => {
  let wins = 0;
  for (let seed = 7; seed < 15; seed++) {
    const outDir = newDir();
    const r = new GameRun(CONFIG, { mock: true, mockDelay: 0, rules: 'g1', seed, voice: null, voiceMode: 'off', outDir });
    assert.match(r.id, ID_RE);
    assert.strictEqual(r.file, path.join(outDir, r.id + '.json'));
    await r.run();
    const tl = readTl(r);
    assert.strictEqual(tl[0].type, 'start');
    assert.strictEqual(tl[0].roles, null);
    assert.strictEqual(tl[tl.length - 1].type, 'seats');
    assert.ok(Object.values(tl[tl.length - 1].seats).every((s) => s === 'mock'));
    assert.ok(fs.existsSync(path.join(outDir, r.id + '.stats.json')));
    const st = r.status();
    assert.strictEqual(st.done, true);
    assert.strictEqual(st.running, false);
    assert.strictEqual(st.halted, null);
    assert.strictEqual(st.rules, 'g1');
    assert.strictEqual(st.voiceMode, 'off');
    assert.ok(tl.some((e) => e.type === 'win') || st.tick === 60, 'a win, or the 60-tick limit');
    if (tl.some((e) => e.type === 'win')) { wins++; break; }
  }
  assert.ok(wins >= 1, 'a mock game reached a win');
});

test('mock g2 plays to the end', async () => {
  const r = new GameRun(CONFIG, { mock: true, mockDelay: 0, rules: 'g2', seed: 11, voice: null, voiceMode: 'off', outDir: newDir() });
  await r.run();
  const tl = readTl(r);
  assert.strictEqual(tl[0].type, 'start');
  assert.strictEqual(tl[0].roles, 'g2');
  assert.strictEqual(tl[tl.length - 1].type, 'seats');
  assert.strictEqual(r.status().rules, 'g2');
});

test('ids are unique in one folder and keep the w_ pattern', () => {
  const outDir = newDir();
  const a = new GameRun(CONFIG, { mock: true, mockDelay: 0, rules: 'g1', outDir });
  const b = new GameRun(CONFIG, { mock: true, mockDelay: 0, rules: 'g1', outDir });
  assert.notStrictEqual(a.id, b.id);
  for (const r of [a, b]) { assert.match(r.id, ID_RE); assert.match(r.id, /^w_[0-9_]+$/); }
});

test('seats follow seatSplit', async () => {
  const calls = {};
  const r = new GameRun(CONFIG, { providers: { claude: 3, gemini: 3 }, mock: false, rules: 'g1', seed: 3, voice: null, voiceMode: 'off', outDir: newDir(),
    callOverride: (provider, req) => { calls[provider] = (calls[provider] || 0) + 1; return mockAnswer(req); } });
  await r.run();
  const tl = readTl(r);
  const seats = tl[tl.length - 1];
  assert.strictEqual(seats.type, 'seats');
  const n = {};
  for (const s of Object.values(seats.seats)) n[s] = (n[s] || 0) + 1;
  assert.deepStrictEqual(n, { claude: 3, gemini: 3 });
  assert.deepStrictEqual(Object.keys(calls).sort(), ['claude', 'gemini']);
  // the start event shows the same seats
  for (const p of tl[0].players) assert.strictEqual(p.seat, seats.seats[p.id]);
});

test('voice manifest matches the meeting lines', async () => {
  const said = [];
  const voice = { say: async (char, text, out) => { said.push({ char, text, out }); fs.writeFileSync(out, 'x'); return { ok: true, duration_sec: 1, engine: 'edge', model: null }; } };
  // seed with at least one meeting: try a few seeds (mock answers are random)
  let r, tl;
  for (let seed = 1; seed < 40; seed++) {
    r = new GameRun(CONFIG, { mock: true, mockDelay: 0, rules: 'g1', seed, voice, voiceMode: 'free', outDir: newDir() });
    await r.run();
    tl = readTl(r);
    if (meetingLines(tl).length) break;
  }
  const per = meetingLines(tl);
  assert.ok(per.length >= 1, 'a meeting happened');
  const mf = JSON.parse(fs.readFileSync(path.join(path.dirname(r.file), r.id + '_voice', 'manifest.json'), 'utf8'));
  assert.strictEqual(mf.timeline, r.id + '.json');
  assert.strictEqual(mf.mode, 'free');
  per.forEach((count, m) => assert.strictEqual(mf.lines.filter((l) => l.m === m).length, count, `meeting ${m}`));
  assert.strictEqual(mf.lines.length, said.length);
  // opener text and file naming as voice_game.js
  const first = tl.find((e) => e.type === 'report' || e.type === 'emergency');
  const L0 = mf.lines.find((l) => l.m === 0 && l.i === 0);
  assert.strictEqual(L0.id, first.by);
  if (first.type === 'emergency') assert.strictEqual(L0.text, 'ทุกคนมาคุยกันก่อน!');
  else assert.match(L0.text, /^เจอศพ.+ที่.+!$/);
  for (const l of mf.lines) {
    assert.strictEqual(l.file, `m${l.m}_${String(l.i).padStart(2, '0')}_${l.id}.mp3`);
    assert.strictEqual(l.dur, 1);
    assert.ok(fs.existsSync(path.join(path.dirname(r.file), r.id + '_voice', l.file)));
  }
  // the say lines are the say events, in order
  const says = tl.filter((e) => e.type === 'say').map((e) => e.text);
  const mfSays = mf.lines.slice().sort((a, b) => a.m - b.m || a.i - b.i).filter((l) => l.i > 0).map((l) => l.text);
  assert.deepStrictEqual(mfSays, says);
});

test('a failed voice line gets file null, dur 0', async () => {
  let k = 0;
  const voice = { say: async (char, text, out) => { k++; if (k % 3 === 0) return { ok: false, error: 'boom' }; fs.writeFileSync(out, 'x'); return { ok: true, duration_sec: 1 }; } };
  let r, tl;
  for (let seed = 1; seed < 40; seed++) {
    k = 0;
    r = new GameRun(CONFIG, { mock: true, mockDelay: 0, rules: 'g1', seed, voice, voiceMode: 'gemini', outDir: newDir() });
    await r.run();
    tl = readTl(r);
    if (meetingLines(tl).reduce((s, x) => s + x, 0) >= 3) break;
  }
  const mf = JSON.parse(fs.readFileSync(path.join(path.dirname(r.file), r.id + '_voice', 'manifest.json'), 'utf8'));
  assert.strictEqual(mf.mode, 'gemini');
  assert.strictEqual(mf.lines.length, k);
  const failed = mf.lines.filter((l) => l.file === null);
  assert.strictEqual(failed.length, Math.floor(k / 3));
  for (const l of failed) assert.strictEqual(l.dur, 0);
  for (const l of mf.lines.filter((x) => x.file)) assert.strictEqual(l.dur, 1);
});

test('halt when a company keeps failing', async () => {
  const r = new GameRun(CONFIG, { providers: { claude: 2, codex: 2, gemini: 2 }, mock: false, rules: 'g1', seed: 5, voice: null, voiceMode: 'off', outDir: newDir(),
    callOverride: (provider, req) => (provider === 'codex' ? Promise.resolve({ ok: false, ms: 1, error: "You've hit your usage limit" }) : mockAnswer(req)) });
  await r.run();
  const tl = readTl(r);
  const last = tl[tl.length - 1];
  assert.strictEqual(last.type, 'halt');
  assert.strictEqual(last.provider, 'codex');
  assert.ok(last.tick <= 3, `halted at tick ${last.tick}`);
  assert.match(last.message, /โควต้าเต็ม \(Codex\)/);
  const st = r.status();
  assert.deepStrictEqual(st.halted, { provider: 'codex', message: last.message });
  assert.strictEqual(st.done, true);
  assert.strictEqual(st.running, false);
});

test('a bad choice is not a failure', async () => {
  const r = new GameRun(CONFIG, { providers: { claude: 3, gemini: 3 }, mock: false, rules: 'g1', seed: 5, voice: null, voiceMode: 'off', outDir: newDir(),
    callOverride: (provider, req) => (provider === 'gemini' ? Promise.resolve({ ok: true, ms: 1, json: { aside: '', target: '99', say: 'อืม', suspect: '', ref: '', scene: '' } }) : mockAnswer(req)) });
  await r.run();
  const tl = readTl(r);
  assert.ok(!tl.some((e) => e.type === 'halt'));
  assert.strictEqual(tl[tl.length - 1].type, 'seats');
});

// everyone always picks option 1 (wait): no meeting and no win can end the game before the abort lands
// (with random mock answers a tick-1 emergency meeting can end the game while the abort waits)
test('abort stops the game', async () => {
  const wait = () => new Promise((res) => setTimeout(() => res({ ok: true, ms: 10, json: { aside: '', target: '1' } }), 10));
  const r = new GameRun(CONFIG, { providers: { claude: 6 }, mock: false, rules: 'g1', seed: 9, voice: null, voiceMode: 'off', outDir: newDir(), callOverride: wait });
  const p = r.run();
  assert.strictEqual(r.status().running, true);
  await new Promise((res) => { const t = setInterval(() => { if (r.status().tick >= 1) { clearInterval(t); r.abort(); res(); } }, 5); });
  await p;
  const tl = readTl(r);
  const last = tl[tl.length - 1];
  assert.strictEqual(last.type, 'halt');
  assert.strictEqual(last.provider, null);
  assert.strictEqual(last.message, 'หยุดเกมแล้ว');
  assert.ok(!tl.some((e) => e.type === 'win'));
  assert.deepStrictEqual(r.status().halted, { provider: null, message: 'หยุดเกมแล้ว' });
});

test('an aborted game asks no AI: ask() returns a failed stub and logs no call', async () => {
  const { ask } = require('../app/agent');
  let called = 0;
  const app = { aborted: true, stats: [], providers: { claude: {} }, callOverride: () => { called++; return { ok: true, ms: 5, json: {} }; } };
  const r = await ask(app, { provider: 'claude' }, { prompt: 'x', kind: 'target', names: ['1'] });
  assert.deepStrictEqual(r, { ok: false, error: 'aborted', ms: 0 });
  assert.strictEqual(called, 0);
  assert.deepStrictEqual(app.stats, []); // no false "every call failed" → no quota halt
});

// abort while a meeting is under way: the speaker already asked finishes, nobody else is asked
test('abort during a meeting stops the AI calls at once', async () => {
  let r, after = 0, aborted = false, met = false;
  for (let k = 0; k < 20 && !met; k++) {
    after = 0; aborted = false;
    r = new GameRun(CONFIG, { providers: { claude: 6 }, mock: false, rules: 'g1', seed: 20 + k, voice: null, voiceMode: 'off', outDir: newDir(),
      callOverride: (provider, req) => {
        if (aborted) after++;
        if (req.kind === 'speakscene' && !aborted) { aborted = true; met = true; r.abort(); }
        return mockAnswer(req);
      } });
    await r.run();
  }
  assert.ok(met, 'a meeting happened');
  assert.strictEqual(after, 0, 'calls made after the abort');
  const tl = readTl(r);
  const last = tl[tl.length - 1];
  assert.strictEqual(last.type, 'halt');
  assert.strictEqual(last.message, 'หยุดเกมแล้ว');
  assert.ok(!tl.some((e) => e.type === 'vote'), 'no vote after the abort');
});

test('no halt is added after a win', async () => {
  // a company's failure streak reaches 2 in the very round that ends the game: the win stands, no halt card
  for (let seed = 1; seed < 30; seed++) {
    const r = new GameRun(CONFIG, { mock: true, mockDelay: 0, rules: 'g1', seed, voice: null, voiceMode: 'off', outDir: newDir() });
    r.checkFailures = () => (r.g.phase === 'over' ? { provider: 'codex', message: 'โควต้าเต็ม (Codex)' } : null);
    await r.run();
    const tl = readTl(r);
    if (!tl.some((e) => e.type === 'win')) continue;
    assert.ok(!tl.some((e) => e.type === 'halt'));
    return;
  }
  assert.fail('no mock game reached a win');
});

test('config has no seatsPerProvider / voice.enabled (seats and voice come from the lobby)', () => {
  assert.ok(!('seatsPerProvider' in CONFIG));
  assert.ok(!('enabled' in CONFIG.voice));
});
