'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-prov-'));
process.env.VREKI_DATA_DIR = tmp;
const { callProvider, schemaFor, extractJson, softWords, shortHistory } = require('../app/providers');

const NAMES = ['ป้าแจ่ม', 'ลุงเพิ่ม', 'น้องฟ้า'];
const mock = (kind) => callProvider('mock', {}, { mockDelay: 0 }, { kind, names: NAMES, system: 's', prompt: 'p' });

test('speakscene schema: say, suspect, ref, scene (+ aside), all required', () => {
  const s = schemaFor('speakscene');
  for (const k of ['aside', 'say', 'suspect', 'ref', 'scene']) assert.deepStrictEqual(s.properties[k], { type: 'string' }, k);
  assert.deepStrictEqual(s.required.slice().sort(), ['aside', 'ref', 'say', 'scene', 'suspect']);
  assert.strictEqual(s.additionalProperties, false);
});

test('speakref schema: say, suspect, ref (no scene)', () => {
  const s = schemaFor('speakref');
  assert.deepStrictEqual(Object.keys(s.properties).sort(), ['aside', 'ref', 'say', 'suspect']);
  assert.deepStrictEqual(s.required.slice().sort(), ['aside', 'ref', 'say', 'suspect']);
});

test('the older kinds are still there', () => {
  assert.ok(schemaFor('target').properties.target);
  assert.ok(schemaFor('speak').properties.say);
});

test('softWords turns the role name into a softer word for Google', () => {
  const out = softWords('ใครคือฆาตกร');
  assert.ok(out.includes('ตัวร้าย'), out);
  assert.ok(!out.includes('ฆาตกร'), out);
  assert.strictEqual(softWords('ฆาตกร ฆาตกร'), 'ตัวร้าย ตัวร้าย');
});

test('shortHistory keeps only the newest memory lines', () => {
  const mem = Array.from({ length: 20 }, (_, i) => `#${i + 1} บรรทัดที่ ${i + 1}`).join('\n');
  const t = `หัวเรื่อง\nความจำของคุณ (เก่า → ใหม่):\n${mem}\n\nตอนนี้: เลือก`;
  const out = shortHistory(t, 5);
  assert.ok(out.startsWith('หัวเรื่อง\nความจำของคุณ (เก่า → ใหม่):\n'), out);
  assert.ok(out.includes('#16 บรรทัดที่ 16') && out.includes('#20 บรรทัดที่ 20'), out);
  assert.ok(!out.includes('#15 บรรทัดที่ 15'), out);
  assert.ok(out.endsWith('\n\nตอนนี้: เลือก'), out);
});

test('mock speakscene answer has a string scene and every schema field', async () => {
  const r = await mock('speakscene');
  assert.strictEqual(r.ok, true);
  for (const k of ['aside', 'say', 'suspect', 'ref', 'scene']) assert.strictEqual(typeof r.json[k], 'string', k);
  assert.ok(r.json.scene.length > 0);
  assert.ok(NAMES.includes(r.json.suspect));
});

test('mock speakref answer has a numeric ref', async () => {
  const r = await mock('speakref');
  assert.strictEqual(r.ok, true);
  assert.match(r.json.ref, /^\d+$/);
  assert.strictEqual(typeof r.json.say, 'string');
});

test('no backup Gemini CLI provider', async () => {
  const r = await callProvider('agy', {}, {}, { kind: 'target', names: NAMES, system: 's', prompt: 'p' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /unknown provider/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'providers.js'), 'utf8');
  assert.doesNotMatch(src, /callAgy|newestClaudeExe|keyFile|desktopDir/);
});

test('Gemini without a key file in data/ says so without calling Google', async () => {
  const r = await callProvider('gemini', { model: 'gemini-4-argon' }, { timeoutMs: 1000 }, { kind: 'target', names: NAMES, system: 's', prompt: 'p' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'no key file');
});

test('Claude / Codex without a found program report "not found"', async () => {
  for (const id of ['claude', 'codex']) {
    const r = await callProvider(id, { model: 'm' }, { timeoutMs: 1000, sandboxDir: tmp }, { kind: 'target', names: NAMES, system: 's', prompt: 'p' });
    assert.strictEqual(r.ok, false, id);
    assert.strictEqual(r.error, 'not found', id);
  }
});

test('extractJson takes the first balanced object', () => {
  assert.deepStrictEqual(extractJson('xx {"a":1} {"b":2} yy'), { a: 1 });
  assert.strictEqual(extractJson('no json'), null);
});

test('test-mode lines are space-station lines, not the werewolf village', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'providers.js'), 'utf8');
  const lines = src.match(/const MOCK_LINES = \[([\s\S]*?)\];/)[1].match(/'[^']+'/g);
  assert.strictEqual(lines.length, 6);
  for (const l of lines) assert.ok(!/ชาวบ้าน|หมาป่า|ท้ายซอย|เมื่อคืน|หมู่บ้าน/.test(l), l);
});
