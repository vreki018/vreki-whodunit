'use strict';
// game.js — rules of "ใครคือคนร้าย" (the clip game). Pure state machine: no UI, no AI calls, no I/O.
// Turn model: every living player picks one action per tick at the same time (applyTick).
// Everything that happens goes to game.timeline so the viewer can replay any frame.
// Map ids match public/proto.html (ROOMS / EDGES / VENTS).
//
// Game 2 roles (VreKi 2026-10-28, opts.roles = 'g2'):
//   ลูกเรือ team (role 'crew', with a job): กัปตัน = one bullet, shoots anyone in the room; a non-คนร้าย target means the captain dies instead
//                                          ช่างซ่อม = may use the vents like the คนร้าย · ลูกเรือธรรมดา = tasks only
//   ตัวป่วน (neutral, own win, fake tasks): ตัวตลก = wins if voted out · สัปเหร่อ = wins after collecting `undertakerQuota` bodies
//                                          (a collected body is gone and cannot be reported)
//   คนร้าย: + ม่านเงา = once per round, for `shadowTicks` ticks everybody is an unrecognisable black shadow to everybody

const MAP = {
  rooms: { A: 'ห้องเครื่องยนต์', B: 'ห้องพยาบาล', C: 'ห้องประชุม', D: 'ห้องออกซิเจน', E: 'ห้องกล้อง',
    F: 'ห้องนำทาง', G: 'ห้องไฟฟ้า', H: 'คลังสินค้า', I: 'ห้องสื่อสาร' },
  halls: [['A', 'B'], ['A', 'G'], ['A', 'E'], ['B', 'C'], ['C', 'D'], ['C', 'H'], ['E', 'H'], ['G', 'H'], ['H', 'I'], ['D', 'F'], ['I', 'F'], ['F', 'H']],
  vents: [['B', 'E'], ['G', 'I']],
  meetingRoom: 'C',
  taskRooms: ['A', 'B', 'D', 'E', 'F', 'G', 'H', 'I'],
};
const ROLE_NAME = { imp: 'คนร้าย', crew: 'ลูกเรือ', captain: 'กัปตัน', engineer: 'ช่างซ่อม', joker: 'ตัวตลก', undertaker: 'สัปเหร่อ' };
const NEUTRAL = ['joker', 'undertaker'];
const SHADOW = 'เงาดำ';

const linked = (pairs, room) => pairs.flatMap(([a, b]) => (a === room ? [b] : b === room ? [a] : []));
const neighbors = (room) => linked(MAP.halls, room);
const ventTo = (room) => linked(MAP.vents, room);

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const P = (g, id) => g.players.find((p) => p.id === id);
const nameOf = (g, id) => P(g, id).name;
const alive = (g) => g.players.filter((p) => p.alive);
const inRoom = (g, room) => alive(g).filter((p) => p.room === room);
const isNeutral = (p) => NEUTRAL.includes(p.role);
const roleName = (p) => ROLE_NAME[p.role === 'crew' ? p.job || 'crew' : p.role];
// under ม่านเงา nobody can tell who is who
const seen = (g, q) => (g.shadow ? SHADOW : q.name);
function log(g, e) { const ev = { tick: g.tick, ...e }; g.timeline.push(ev); return ev; }
function remember(g, p, txt) { p.memory.push(`[ตา ${g.tick}] ${txt}`); if (p.memory.length > 40) p.memory.shift(); }

function createGame(opts) {
  // 3 tasks × 2 ticks ended every mock game on tasks within ~15 ticks (40/40 crew wins) → 4 × 3, cooldown 2
  const o = { impostors: 1, tasksPer: 4, taskTicks: 3, killCooldown: 2, seed: 1, roles: null, undertakerQuota: 2, shadowTicks: 3, ...opts };
  const rand = rng(o.seed);
  const players = o.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat || 'mock', role: 'crew', job: null, room: MAP.meetingRoom,
    alive: true, tasks: [], emergencyLeft: 1, cooldown: o.killCooldown, memory: [], bullets: 0, collected: 0, shadowLeft: 0 }));
  const take = () => { const free = players.filter((p) => p.role === 'crew' && !p.job); return free[Math.floor(rand() * free.length)]; };
  const imps = o.impostorIds ? o.impostorIds.slice() : [];
  while (imps.length < o.impostors) { const c = players[Math.floor(rand() * players.length)].id; if (!imps.includes(c)) imps.push(c); }
  for (const p of players) if (imps.includes(p.id)) { p.role = 'imp'; p.shadowLeft = o.roles ? 1 : 0; }
  if (o.roles === 'g2') {
    const fixed = o.roleIds || {}; // tests: { captain:'wit', … }
    for (const r of ['joker', 'undertaker', 'captain', 'engineer']) {
      const p = fixed[r] ? P({ players }, fixed[r]) : take();
      if (NEUTRAL.includes(r)) p.role = r; else p.job = r;
      if (r === 'captain') p.bullets = 1;
    }
  }
  for (const p of players) {
    if (p.role !== 'crew') continue;
    const pool = MAP.taskRooms.slice();
    for (let i = 0; i < o.tasksPer; i++) p.tasks.push({ room: pool.splice(Math.floor(rand() * pool.length), 1)[0], done: 0 });
  }
  const g = { opts: o, rand, players, bodies: [], tick: 0, phase: 'play', winner: null, meeting: null, meetings: 0, timeline: [], shadow: 0 };
  log(g, { type: 'start', roles: o.roles || null,
    players: players.map((p) => ({ id: p.id, name: p.name, seat: p.seat, role: p.role, job: p.job, tasks: p.tasks.map((t) => t.room) })) });
  for (const p of players) {
    const mates = imps.filter((i) => i !== p.id).map((i) => nameOf(g, i));
    let s;
    if (p.role === 'imp') s = `คุณคือคนร้าย${mates.length ? ` · พวกเดียวกัน: ${mates.join(', ')}` : ''}` + (o.roles ? ' · มีม่านเงา 1 ครั้งต่อรอบ' : '');
    else if (p.role === 'joker') s = 'คุณคือตัวตลก (ตัวป่วน) · ชนะเมื่อถูกโหวตโยนออก · ไม่มีภารกิจจริง';
    else if (p.role === 'undertaker') s = `คุณคือสัปเหร่อ (ตัวป่วน) · ชนะเมื่อเก็บศพครบ ${o.undertakerQuota} ศพ · ไม่มีภารกิจจริง`;
    else s = `คุณคือ${roleName(p)} · ภารกิจ: ${p.tasks.map((t) => MAP.rooms[t.room]).join(', ')}` +
      (p.job === 'captain' ? ' · มีปืน 1 นัด' : p.job === 'engineer' ? ' · มุดท่อได้' : '');
    remember(g, p, s);
  }
  return g;
}

function legal(g, id) {
  const p = P(g, id);
  if (!p || !p.alive || g.phase !== 'play') return [];
  const acts = [{ action: 'wait' }, ...neighbors(p.room).map((r) => ({ action: 'move', target: r }))];
  const others = inRoom(g, p.room).filter((q) => q.id !== p.id);
  if (p.role === 'crew') { if (p.tasks.some((t) => t.room === p.room && t.done < g.opts.taskTicks)) acts.push({ action: 'task' }); }
  else acts.push({ action: 'task' }); // fake — looks the same to everyone else (คนร้าย + ตัวป่วน)
  if (p.role === 'imp' || p.job === 'engineer') for (const r of ventTo(p.room)) acts.push({ action: 'vent', target: r });
  if (p.role === 'imp') {
    if (p.cooldown <= 0) for (const q of others) if (q.role !== 'imp') acts.push({ action: 'kill', target: q.id });
    if (p.shadowLeft > 0 && !g.shadow) acts.push({ action: 'shadow' });
  }
  if (p.job === 'captain' && p.bullets > 0) for (const q of others) acts.push({ action: 'shoot', target: q.id });
  const bodiesHere = g.bodies.filter((b) => b.room === p.room);
  if (p.role === 'undertaker') for (const b of bodiesHere) acts.push({ action: 'collect', target: b.id });
  if (bodiesHere.length) acts.push({ action: 'report' });
  if (p.room === MAP.meetingRoom && p.emergencyLeft > 0) acts.push({ action: 'emergency' });
  return acts;
}
const isLegal = (g, id, a) => legal(g, id).some((x) => x.action === a.action && (x.target || null) === (a.target || null));

function taskTotals(g) {
  let need = 0, done = 0;
  for (const p of g.players) if (p.role === 'crew') for (const t of p.tasks) {
    const d = Math.min(t.done, g.opts.taskTicks);
    done += d; need += p.alive ? g.opts.taskTicks : d; // a dead crewmate's unfinished tasks drop out
  }
  return { need, done };
}

function die(g, v, room) { v.alive = false; g.bodies.push({ id: v.id, room, tick: g.tick }); }

function applyTick(g, actions) {
  if (g.phase !== 'play') throw new Error('applyTick outside play phase: ' + g.phase);
  const act = {};
  for (const p of alive(g)) {
    const a = actions[p.id];
    act[p.id] = a && isLegal(g, p.id, a) ? a : { action: 'wait' };
    if (a && a.action !== 'wait' && act[p.id].action === 'wait') log(g, { type: 'illegal', id: p.id, tried: a, tickNext: g.tick + 1 });
  }
  g.tick++;

  // 0) ม่านเงา goes up before anything else this tick
  for (const p of alive(g)) if (act[p.id].action === 'shadow') {
    p.shadowLeft--; g.shadow = g.opts.shadowTicks;
    log(g, { type: 'shadow', by: p.id, ticks: g.shadow });
    for (const q of alive(g)) remember(g, q, q.id === p.id ? `คุณใช้ม่านเงา · ${g.shadow} ตาจากนี้ทุกคนเป็นเงาดำ` : 'ไฟวูบ! ทุกคนกลายเป็นเงาดำ จำหน้าใครไม่ได้');
  }

  // 1) kills and the captain's shot land first
  for (const p of alive(g)) {
    const a = act[p.id];
    if (!p.alive || (a.action !== 'kill' && a.action !== 'shoot')) continue;
    const v = P(g, a.target);
    if (!v.alive || v.room !== p.room) continue;
    const room = p.room, wit = () => inRoom(g, room).filter((q) => q.id !== p.id).map((q) => q.id);
    if (a.action === 'kill') {
      die(g, v, room); p.cooldown = g.opts.killCooldown + 1; // +1: cooldown ticks down at the end of this tick
      const w = wit();
      log(g, { type: 'kill', by: p.id, victim: v.id, room, witnesses: w, shadow: !!g.shadow });
      for (const x of w) remember(g, P(g, x), g.shadow ? `เห็นกับตา! ${SHADOW}คนหนึ่งฆ่าอีกคนที่${MAP.rooms[room]} แต่มืดจนจำหน้าไม่ได้`
        : `เห็นกับตา! ${p.name} ฆ่า ${v.name} ที่${MAP.rooms[room]}`);
      remember(g, p, `คุณฆ่า ${v.name} ที่${MAP.rooms[room]} · ${w.length ? 'มีคนเห็น: ' + w.map((x) => seen(g, P(g, x))).join(', ') : 'ไม่มีใครเห็น'}`);
    } else {
      p.bullets--;
      const hit = v.role === 'imp', dead = hit ? v : p;
      die(g, dead, room);
      const w = inRoom(g, room).filter((q) => q.id !== p.id && q.id !== v.id).map((q) => q.id);
      log(g, { type: 'shoot', by: p.id, target: v.id, hit, dead: dead.id, room, witnesses: w, shadow: !!g.shadow });
      const told = hit ? `กัปตัน ${p.name} ยิง ${v.name} · ${v.name} ตาย` : `กัปตัน ${p.name} ยิง ${v.name} พลาด · ${p.name} ตายเอง`;
      for (const x of w) remember(g, P(g, x), g.shadow ? `เห็นกับตา! เสียงปืนดังในความมืดที่${MAP.rooms[room]}` : `เห็นกับตา! ${told}`);
      if (v.alive) remember(g, v, g.shadow ? `มีคนยิงปืนใส่คุณในความมืด แล้วเขาตายเอง` : `${p.name} ยิงคุณ แต่คุณไม่ใช่คนร้าย · ${p.name} ตายเอง`);
      if (p.alive) remember(g, p, `คุณยิง ${seen(g, v)} · ${hit ? 'โดนคนร้าย!' : ''}`);
    }
  }
  checkWin(g);
  if (g.phase === 'over') return { phase: g.phase, winner: g.winner };

  // 2) the สัปเหร่อ collects before anybody can report
  for (const p of alive(g)) {
    const a = act[p.id];
    if (a.action !== 'collect') continue;
    const b = g.bodies.find((x) => x.id === a.target && x.room === p.room);
    if (!b) continue;
    g.bodies = g.bodies.filter((x) => x !== b); p.collected++;
    const w = inRoom(g, p.room).filter((q) => q.id !== p.id).map((q) => q.id);
    log(g, { type: 'collect', by: p.id, body: b.id, room: p.room, n: p.collected, of: g.opts.undertakerQuota, witnesses: w });
    for (const x of w) remember(g, P(g, x), `เห็นกับตา! ${seen(g, p)} ลากศพ ${nameOf(g, b.id)} หายไป`);
    remember(g, p, `คุณเก็บศพ ${nameOf(g, b.id)} (${p.collected}/${g.opts.undertakerQuota})`);
    if (p.collected >= g.opts.undertakerQuota) { g.winner = 'undertaker'; g.phase = 'over'; log(g, { type: 'win', side: 'undertaker', by: 'collect', id: p.id }); return { phase: g.phase, winner: g.winner }; }
  }

  // 3) a report or the emergency button stops the tick
  for (const p of alive(g)) {
    const a = act[p.id];
    const body = g.bodies.find((b) => b.room === p.room);
    if (a.action === 'report' && body) { log(g, { type: 'report', by: p.id, body: body.id, room: p.room }); return startMeeting(g, p.id, 'report', body); }
    if (a.action === 'emergency' && p.room === MAP.meetingRoom && p.emergencyLeft > 0) {
      p.emergencyLeft--; log(g, { type: 'emergency', by: p.id }); return startMeeting(g, p.id, 'emergency', null);
    }
  }

  // 4) moves, vents, tasks
  const before = Object.fromEntries(alive(g).map((p) => [p.id, p.room]));
  const still = (q) => !['move', 'vent'].includes(act[q.id].action);
  for (const p of alive(g)) {
    const a = act[p.id];
    if (a.action === 'move') { log(g, { type: 'move', id: p.id, from: p.room, to: a.target }); p.room = a.target; }
    else if (a.action === 'vent') {
      const wit = alive(g).filter((q) => q.id !== p.id && still(q) && (before[q.id] === p.room || before[q.id] === a.target)).map((q) => q.id);
      log(g, { type: 'vent', id: p.id, from: p.room, to: a.target, witnesses: wit, shadow: !!g.shadow });
      for (const w of wit) remember(g, P(g, w), `เห็นกับตา! ${seen(g, p)} มุดท่อ ${MAP.rooms[p.room]} → ${MAP.rooms[a.target]}`);
      p.room = a.target;
    } else if (a.action === 'task') {
      if (p.role === 'crew') {
        const t = p.tasks.find((x) => x.room === p.room && x.done < g.opts.taskTicks);
        t.done++;
        const tt = taskTotals(g); // step = this task's progress · done/need = everyone's
        log(g, { type: 'task', id: p.id, room: p.room, step: t.done, of: g.opts.taskTicks, done: tt.done, need: tt.need });
      } else log(g, { type: 'task', id: p.id, room: p.room, fake: true });
    }
  }

  // 5) what each player sees at the end of the tick (under ม่านเงา: shadows only)
  for (const p of alive(g)) {
    const others = inRoom(g, p.room).filter((q) => q.id !== p.id);
    let s = `อยู่${MAP.rooms[p.room]}` + (others.length ? (g.shadow ? ` กับ${SHADOW} ${others.length} คน` : ` กับ ${others.map((q) => q.name).join(', ')}`) : ' คนเดียว');
    const doing = others.filter((q) => act[q.id].action === 'task').map((q) => q.name);
    if (doing.length && !g.shadow) s += ` · ${doing.join(', ')} กำลังทำภารกิจ`;
    const bs = g.bodies.filter((b) => b.room === p.room);
    if (bs.length) s += ` · เจอศพ ${bs.map((b) => nameOf(g, b.id)).join(', ')}!`;
    remember(g, p, s);
    if (p.cooldown > 0) p.cooldown--;
  }
  if (g.shadow) { g.shadow--; if (!g.shadow) { log(g, { type: 'shadow_off' }); for (const q of alive(g)) remember(g, q, 'ไฟกลับมาแล้ว มองเห็นหน้ากันตามปกติ'); } }
  return checkWin(g);
}

function startMeeting(g, by, reason, body) {
  g.phase = 'meeting'; g.meetings++;
  if (g.shadow) { g.shadow = 0; log(g, { type: 'shadow_off' }); }
  g.meeting = { by, reason, body: body ? body.id : null, room: body ? body.room : MAP.meetingRoom };
  log(g, { type: 'meeting', n: g.meetings, by, reason, body: g.meeting.body, room: g.meeting.room });
  for (const p of alive(g)) remember(g, p, reason === 'report'
    ? `${nameOf(g, by)} แจ้งพบศพ ${nameOf(g, body.id)} ที่${MAP.rooms[body.room]} → ประชุม`
    : `${nameOf(g, by)} กดปุ่มฉุกเฉิน → ประชุม`);
  return { phase: g.phase, winner: null };
}

function say(g, id, text) {
  log(g, { type: 'say', id, text });
  for (const p of alive(g)) if (p.id !== id) remember(g, p, `${nameOf(g, id)} พูดในที่ประชุม: "${text}"`);
}

function resolveVote(g, votes) {
  if (g.phase !== 'meeting') throw new Error('resolveVote outside meeting');
  const tally = {};
  for (const p of alive(g)) {
    let v = votes[p.id];
    if (!v || (v !== 'skip' && !(P(g, v) && P(g, v).alive))) v = 'skip';
    log(g, { type: 'vote', voter: p.id, target: v });
    tally[v] = (tally[v] || 0) + 1;
  }
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const out = top[0][0] !== 'skip' && (top.length === 1 || top[0][1] > top[1][1]) ? top[0][0] : null;
  if (out) {
    const q = P(g, out); q.alive = false;
    log(g, { type: 'eject', id: out, wasImp: q.role === 'imp', role: q.role, job: q.job, tally });
    if (q.role === 'joker') { g.winner = 'joker'; g.phase = 'over'; log(g, { type: 'win', side: 'joker', by: 'vote', id: q.id }); return { phase: g.phase, winner: g.winner }; }
    for (const p of alive(g)) remember(g, p, `โหวตโยน ${q.name} ออก · ${q.role === 'imp' ? 'เป็นคนร้าย' : 'ไม่ใช่คนร้าย'}`);
  } else {
    log(g, { type: 'eject', id: null, tally });
    for (const p of alive(g)) remember(g, p, 'ไม่มีใครถูกโยนออก (คะแนนเสมอกันหรือส่วนใหญ่กดข้าม)');
  }
  g.bodies = []; g.meeting = null; g.phase = 'play';
  for (const p of alive(g)) { p.room = MAP.meetingRoom; if (p.role === 'imp') { p.cooldown = g.opts.killCooldown; if (g.opts.roles) p.shadowLeft = 1; } }
  return checkWin(g);
}

function checkWin(g) {
  if (g.winner) return { phase: g.phase, winner: g.winner };
  const a = alive(g), imps = a.filter((p) => p.role === 'imp').length, others = a.length - imps;
  const { need, done } = taskTotals(g);
  let side = null, by = null;
  if (imps === 0) { side = 'crew'; by = 'vote'; }
  else if (imps >= others) { side = 'imp'; by = 'kills'; }
  else if (need > 0 && done >= need) { side = 'crew'; by = 'tasks'; }
  if (side) { g.winner = side; g.phase = 'over'; log(g, { type: 'win', side, by }); }
  return { phase: g.phase, winner: g.winner };
}

function observe(g, id) {
  const p = P(g, id);
  return {
    tick: g.tick, phase: g.phase, shadow: g.shadow,
    you: { id: p.id, name: p.name, role: p.role, job: p.job, roleName: roleName(p), room: p.room, roomName: MAP.rooms[p.room], emergencyLeft: p.emergencyLeft,
      cooldown: p.role === 'imp' ? p.cooldown : undefined, bullets: p.bullets, collected: p.collected, shadowLeft: p.shadowLeft,
      tasksLeft: p.role === 'crew' ? p.tasks.filter((t) => t.done < g.opts.taskTicks).map((t) => t.room) : undefined },
    here: inRoom(g, p.room).filter((q) => q.id !== p.id).map((q) => q.id),
    bodies: g.bodies.filter((b) => b.room === p.room).map((b) => b.id),
    neighbors: neighbors(p.room), alive: alive(g).map((q) => q.id),
    memory: p.memory.slice(-25), legal: legal(g, id), tasks: taskTotals(g),
  };
}

/* ---------- mock players (tests + viewer demo without AI) ---------- */
function nextStep(from, goals) {
  const prev = { [from]: null }, q = [from];
  while (q.length) {
    const c = q.shift();
    if (c !== from && goals.includes(c)) { let s = c; while (prev[s] !== from) s = prev[s]; return s; }
    for (const n of neighbors(c)) if (!(n in prev)) { prev[n] = c; q.push(n); }
  }
  return null;
}
function mockAct(g, id) {
  const p = P(g, id), L = legal(g, id), r = g.rand;
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const of = (a) => L.filter((x) => x.action === a);
  if (of('collect').length) return of('collect')[0];
  if (of('report').length && p.role !== 'undertaker') return { action: 'report' };
  if (p.role === 'imp') {
    const kills = of('kill');
    if (kills.length && inRoom(g, p.room).length === 2) return kills[0];
    if (of('shadow').length && kills.length && r() < 0.6) return { action: 'shadow' };
    if (of('vent').length && r() < 0.15) return pick(of('vent'));
    const lone = Object.keys(MAP.rooms).filter((rm) => rm !== p.room && inRoom(g, rm).length === 1);
    const hunt = nextStep(p.room, lone);
    if (hunt && r() < 0.75) return { action: 'move', target: hunt };
    if (r() < 0.25) return { action: 'task' };
    return pick(of('move'));
  }
  if (of('shoot').length) { // the mock captain shoots whoever it saw kill, if they are here
    const saw = p.memory.slice().reverse().find((m) => m.includes('เห็นกับตา!') && m.includes(' ฆ่า '));
    const t = saw && of('shoot').find((x) => saw.includes('! ' + nameOf(g, x.target) + ' '));
    if (t) return t;
  }
  if (p.job === 'engineer' && of('vent').length && r() < 0.1) return pick(of('vent'));
  if (isNeutral(p)) return r() < 0.3 ? { action: 'task' } : pick(of('move'));
  if (of('task').length) return { action: 'task' };
  const step = nextStep(p.room, p.tasks.filter((t) => t.done < g.opts.taskTicks).map((t) => t.room));
  return step ? { action: 'move', target: step } : pick(of('move'));
}
function mockVotes(g) {
  const v = {};
  for (const p of alive(g)) {
    const seenIt = p.memory.slice().reverse().find((m) => m.includes('เห็นกับตา'));
    const who = seenIt && alive(g).find((q) => q.id !== p.id && seenIt.includes(' ' + q.name + ' ') || (seenIt && seenIt.includes('! ' + q.name + ' ') && q.id !== p.id));
    v[p.id] = who ? who.id : 'skip';
  }
  return v;
}
function runMock(opts, maxSteps = 600) {
  const g = createGame(opts);
  for (let i = 0; i < maxSteps && g.phase !== 'over'; i++) {
    if (g.phase === 'play') applyTick(g, Object.fromEntries(alive(g).map((p) => [p.id, mockAct(g, p.id)])));
    else resolveVote(g, mockVotes(g));
  }
  return g;
}

module.exports = { MAP, ROLE_NAME, neighbors, ventTo, createGame, legal, applyTick, startMeeting, say, resolveVote, checkWin, observe, taskTotals,
  mockAct, mockVotes, runMock, nextStep, roleName };

if (require.main === module) {
  const CAST = [['jaem', 'ป้าแจ่ม'], ['perm', 'ลุงเพิ่ม'], ['fah', 'น้องฟ้า'], ['wit', 'ครูวิทย์'], ['muay', 'เจ๊หมวย'], ['tee', 'ตี๋']]
    .map(([id, name]) => ({ id, name }));
  const seed = +(process.argv[2] || 7);
  const g = runMock({ players: CAST, seed, roles: process.argv.includes('--g2') ? 'g2' : null });
  const out = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
  if (out) require('fs').writeFileSync(out, JSON.stringify(g.timeline, null, 1));
  const n = (t) => g.timeline.filter((e) => e.type === t).length;
  console.log(`seed ${seed}: winner=${g.winner} ticks=${g.tick} meetings=${g.meetings} kills=${n('kill')} vents=${n('vent')} shots=${n('shoot')} collects=${n('collect')} shadows=${n('shadow')} events=${g.timeline.length}`);
}
