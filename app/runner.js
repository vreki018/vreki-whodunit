'use strict';
// runner.js — plays one game of "ใครคือฆาตกร?" inside the server (the clip's run.js without the command line).
// The timeline + stats are rewritten after every tick and every meeting, so the viewer can follow the game live.
// Meeting lines get their character voice as soon as they exist (<id>_voice/manifest.json, same lines and
// file names as the clip's voice_game.js). A company that keeps failing stops the game with a Thai "halt" event.
const fs = require('fs');
const path = require('path');
const G = require('./game.js');
const { decideTick, runMeeting } = require('./agent.js');
const { explainError } = require('./detect');
const P = require('./paths');

const ID_RE = /^(w_[0-9_]+|clip_g[12])$/;
const ABORT_MESSAGE = 'หยุดเกมแล้ว';
const pad = (n, k = 2) => String(n).padStart(k, '0');

// w_YYYYMMDD_HHMMSS (local time) · taken already in outDir → _2, _3, …
function newId(outDir, now = new Date()) {
  const base = `w_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let id = base;
  for (let k = 2; fs.existsSync(path.join(outDir, id + '.json')); k++) id = `${base}_${k}`;
  return id;
}

class GameRun {
  // opts: { providers:{claude:2,…}|null, mock, mockDelay, rules:'g1'|'g2', seed?, voice:{say(char,text,out)}|null,
  //         voiceMode:'off'|'free'|'gemini', outDir, id?, callOverride? (tests only) }
  constructor(config, opts = {}) {
    const app = JSON.parse(JSON.stringify(config));
    this.app = app;
    this.mock = !!opts.mock;
    this.rules = opts.rules === 'g2' ? 'g2' : 'g1';
    this.voice = opts.voice || null;
    this.voiceMode = opts.voiceMode || (this.voice ? 'free' : 'off');
    this.outDir = path.resolve(opts.outDir || P.LOGS);
    fs.mkdirSync(this.outDir, { recursive: true });
    if (opts.id != null && !ID_RE.test(opts.id)) throw new Error(`bad game id ${opts.id}`);
    this.id = opts.id || newId(this.outDir);
    this.file = path.join(this.outDir, this.id + '.json');
    this.statsFile = path.join(this.outDir, this.id + '.stats.json');
    this.voiceDir = path.join(this.outDir, this.id + '_voice');

    app.timeoutMs = (app.callTimeoutSec || 150) * 1000;
    if (!app.sandboxDir) app.sandboxDir = P.SANDBOX;
    if (this.mock) app.mockDelay = +opts.mockDelay || 0;
    if (opts.callOverride) app.callOverride = opts.callOverride;
    app.stats = [];
    app.onSay = (ev) => this.addLine(ev.id, ev.text);

    // seats: providers shuffled onto the six characters (seeded as in run.js, so a game can be repeated)
    this.seed = opts.seed != null ? +opts.seed : Date.now() % 100000;
    let s = this.seed || 1;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const providers = [];
    if (this.mock) for (let i = 0; i < app.characters.length; i++) providers.push('mock');
    else {
      if (!opts.providers || typeof opts.providers !== 'object') throw new Error('pick at least one company');
      for (const [prov, n] of Object.entries(opts.providers)) {
        if (!app.providers[prov]) throw new Error(`unknown company ${prov}`);
        for (let i = 0; i < n; i++) providers.push(prov);
      }
    }
    if (providers.length !== app.characters.length) throw new Error(`need ${app.characters.length} seats, got ${providers.length}`);
    for (let i = providers.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [providers[i], providers[j]] = [providers[j], providers[i]]; }
    this.seats = {};
    app.characters.forEach((c, i) => { this.seats[c.id] = { provider: providers[i], persona: c.persona }; });

    // rule sets: g1 = config "game" block · g2 = g1 + special roles (กัปตัน · ช่างซ่อม · ตัวตลก · สัปเหร่อ · ม่านเงา)
    const k = app.game || {};
    this.g = G.createGame({ players: app.characters.map((c) => ({ id: c.id, name: c.name, seat: this.seats[c.id].provider })), seed: this.seed,
      impostors: k.impostors || 1, tasksPer: k.tasksPer || 4, taskTicks: k.taskTicks || 4, killCooldown: k.killCooldown || 2,
      roles: this.rules === 'g2' ? 'g2' : null, undertakerQuota: 2, shadowTicks: 3 });
    this.maxTicks = app.maxTicks || 60;
    this.rounds = app.discussionRounds || 2;

    this.steps = [];
    this.running = false;
    this.done = false;
    this.halted = null;
    this.aborted = false;
    this.statsSeen = 0;
    this.failStreak = {}; // company → consecutive ticks/meetings in which every one of its calls failed
    this.lastError = {};
    // meeting lines (voice_game.js order): m = meeting index, i = line index in that meeting
    this.m = -1; this.i = 0;
    this.lines = [];      // finished voice entries
    this.pending = [];    // voice promises still running
    this.scanned = 0;     // timeline events already checked for report/emergency
    this.save();
  }

  summary() {
    const app = this.app, g = this.g, by = {};
    for (const c of app.stats) {
      const b = by[c.provider] || (by[c.provider] = { calls: 0, bad: 0, retried: 0, costUsd: 0, input: 0, output: 0, msTotal: 0, msMax: 0 });
      b.calls++; if (!c.ok) b.bad++; if (c.retried) b.retried++;
      b.costUsd += c.costUsd; b.input += c.input; b.output += c.output; b.msTotal += c.ms; b.msMax = Math.max(b.msMax, c.ms);
    }
    for (const b of Object.values(by)) { b.msAvg = Math.round(b.msTotal / Math.max(1, b.calls)); b.costUsd = +b.costUsd.toFixed(4); }
    const ticks = this.steps.filter((x) => x.kind === 'tick').map((x) => x.ms), meets = this.steps.filter((x) => x.kind === 'meeting').map((x) => x.ms);
    const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0);
    return { seed: this.seed, rules: this.rules, seats: this.seatMap(), winner: g.winner || null, halted: this.halted, ticks: g.tick, meetings: g.meetings,
      tickMsAvg: avg(ticks), tickMsMax: Math.max(0, ...ticks), meetingMsAvg: avg(meets), meetingMsMax: Math.max(0, ...meets),
      costUsdTotal: +Object.values(by).reduce((s, b) => s + b.costUsd, 0).toFixed(4), byProvider: by, steps: this.steps,
      errors: app.stats.filter((c) => !c.ok).map((c) => ({ provider: c.provider, kind: c.kind, error: c.error })) };
  }

  seatMap() { return Object.fromEntries(Object.entries(this.seats).map(([id, x]) => [id, x.provider])); }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.g.timeline, null, 1));
    fs.writeFileSync(this.statsFile, JSON.stringify(this.summary(), null, 1));
  }

  // ---------- voices ----------
  addLine(id, text) {
    if (this.m < 0) return;
    const L = { m: this.m, i: this.i++, id, text };
    if (!this.voice) return;
    const file = `m${L.m}_${pad(L.i)}_${L.id}.mp3`;
    fs.mkdirSync(this.voiceDir, { recursive: true });
    const p = Promise.resolve()
      .then(() => this.voice.say(L.id, L.text, path.join(this.voiceDir, file)))
      .catch((e) => ({ ok: false, error: String(e) }))
      .then((r) => {
        const ok = !!(r && r.ok);
        this.lines.push({ ...L, file: ok ? file : null, dur: ok ? (r.duration_sec || r.audio_sec || 0) : 0 });
        this.writeManifest();
      });
    this.pending.push(p);
  }

  writeManifest() {
    const lines = this.lines.slice().sort((a, b) => a.m - b.m || a.i - b.i);
    try { fs.writeFileSync(path.join(this.voiceDir, 'manifest.json'), JSON.stringify({ timeline: this.id + '.json', mode: this.voiceMode, lines }, null, 1)); } catch (_) {}
  }

  // a report / emergency opens a meeting: its opener is line 0 (voice_game.js text)
  scanOpeners() {
    const tl = this.g.timeline, players = tl[0].players;
    const nm = (id) => (players.find((p) => p.id === id) || {}).name || id;
    for (; this.scanned < tl.length; this.scanned++) {
      const e = tl[this.scanned];
      if (e.type !== 'report' && e.type !== 'emergency') continue;
      this.m++; this.i = 0;
      this.addLine(e.by, e.type === 'report' ? `เจอศพ${nm(e.body)}ที่${G.MAP.rooms[e.room]}!` : 'ทุกคนมาคุยกันก่อน!');
    }
  }

  // ---------- halt ----------
  // after a tick or meeting: a company whose every call failed (a bad choice is an answer, not a failure)
  // in 2 rounds in a row → the error it gives, in Thai
  checkFailures() {
    const fresh = this.app.stats.slice(this.statsSeen);
    this.statsSeen = this.app.stats.length;
    const by = {};
    for (const c of fresh) { const b = by[c.provider] || (by[c.provider] = { n: 0, bad: 0 }); b.n++; if (!c.ok) { b.bad++; this.lastError[c.provider] = c.error; } }
    for (const [prov, b] of Object.entries(by)) {
      if (prov === 'mock') continue;
      this.failStreak[prov] = b.bad === b.n ? (this.failStreak[prov] || 0) + 1 : 0;
      if (this.failStreak[prov] >= 2) {
        const pc = this.app.providers[prov] || {};
        return { provider: prov, message: explainError(prov, this.lastError[prov], pc.model) };
      }
    }
    return null;
  }

  halt(provider, message) {
    this.halted = { provider, message };
    this.g.timeline.push({ tick: this.g.tick, type: 'halt', provider, message });
    this.save();
  }

  // takes effect at once: agent.js asks no AI from now on (a call already under way finishes),
  // a meeting stops at its next speaker, and the loop writes the halt
  abort() {
    if (this.done) return;
    this.aborted = true;
    this.app.aborted = true;
  }

  status() {
    return { id: this.id, running: this.running, done: this.done, halted: this.halted, tick: this.g.tick, meetings: this.g.meetings, rules: this.rules, voiceMode: this.voiceMode };
  }

  // never rejects: an error becomes a halt
  async run() {
    if (this.running || this.done) return;
    this.running = true;
    const g = this.g, app = this.app;
    try {
      if (!this.mock && !app.callOverride) fs.mkdirSync(app.sandboxDir, { recursive: true });
      while (g.phase !== 'over' && g.tick < this.maxTicks) {
        if (this.aborted) { this.halt(null, ABORT_MESSAGE); break; }
        if (g.phase === 'play') {
          const ts = Date.now();
          const { actions } = await decideTick(g, app, this.seats);
          this.steps.push({ kind: 'tick', n: g.tick + 1, ms: Date.now() - ts });
          G.applyTick(g, actions);
          this.scanOpeners();
        } else {
          const ts = Date.now();
          await runMeeting(g, app, this.seats, this.rounds);
          this.steps.push({ kind: 'meeting', n: g.meetings, ms: Date.now() - ts });
        }
        this.save();
        const stop = this.checkFailures();
        if (stop && g.phase !== 'over') { this.halt(stop.provider, stop.message); break; }
      }
      if (!this.halted) {
        g.timeline.push({ tick: g.tick, type: 'seats', seats: this.seatMap() });
        this.save();
      }
    } catch (e) {
      const message = `ผิดพลาด: ${String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 120)}`;
      try { this.halt(null, message); } catch (_) { this.halted = { provider: null, message }; }
    }
    await Promise.all(this.pending);
    this.running = false;
    this.done = true;
  }
}

module.exports = { GameRun, newId, ID_RE };
