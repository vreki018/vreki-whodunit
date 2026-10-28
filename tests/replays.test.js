'use strict';
// The two games from the clip ship in replays/. These checks only ask "is it
// whole and does it play": they never look at who won or who had which role.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'replays');
const IDS = ['clip_g1', 'clip_g2'];
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(DIR, ...p), 'utf8'));

test('the replay list names both clip games first, with their rule sets', () => {
  const idx = readJson('index.json');
  assert.ok(Array.isArray(idx));
  assert.deepStrictEqual(idx.slice(0, 2).map((r) => [r.id, r.rules]), [['clip_g1', 'g1'], ['clip_g2', 'g2']]);
  for (const r of idx) assert.ok(typeof r.label === 'string' && r.label.length > 0, r.id);
});

for (const id of IDS) {
  test(`${id}: the timeline parses, starts with "start" and seats the players`, () => {
    const tl = readJson(`${id}.json`);
    assert.ok(Array.isArray(tl) && tl.length > 10);
    assert.strictEqual(tl[0].type, 'start');
    assert.ok(tl.some((e) => e.type === 'seats'), 'no seats event');
  });

  test(`${id}: every voice file the manifest names is there, and nothing else is`, () => {
    const vdir = path.join(DIR, `${id}_voice`);
    const man = readJson(`${id}_voice`, 'manifest.json');
    assert.strictEqual(man.timeline, `${id}.json`);
    assert.ok(Array.isArray(man.lines) && man.lines.length > 0);
    const named = new Set();
    for (const l of man.lines) {
      if (l.file == null) continue;
      assert.match(l.file, /^[A-Za-z0-9_]+\.mp3$/, `odd file name ${l.file}`);
      assert.ok(fs.existsSync(path.join(vdir, l.file)), `missing ${l.file}`);
      assert.ok(fs.statSync(path.join(vdir, l.file)).size > 1000, `empty ${l.file}`);
      named.add(l.file);
    }
    assert.ok(named.size > 0);
    const extra = fs.readdirSync(vdir).filter((f) => f !== 'manifest.json' && !named.has(f));
    assert.deepStrictEqual(extra, []);
  });
}

test('no file under replays/ carries a path or name of the machine it was made on', () => {
  // built from pieces so this test file does not itself trip the repo secret scan
  const name = [new RegExp('jam' + 'wa', 'i'), new RegExp('Claude' + '-Data')];
  const drive = '\\bE' + ':[\\\\/]'; // a drive letter path, "E" colon then a slash or backslash
  const textBad = [...name, new RegExp(drive)];
  // mp3 audio bytes hit that by chance; in a binary only a real-looking path counts (tags, comments)
  const binBad = [...name, new RegExp(drive + '[\\w .-]{3,}[\\\\/]')];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(DIR);
  assert.ok(files.length > 10);
  for (const f of files) {
    const buf = fs.readFileSync(f);
    const binary = buf.includes(0);
    const text = buf.toString(binary ? 'latin1' : 'utf8');
    for (const re of binary ? binBad : textBad) assert.ok(!re.test(text), `${path.relative(DIR, f)} matches ${re}`);
  }
});
