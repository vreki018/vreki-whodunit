'use strict';
// agent.js — turns game.js observations into AI calls (providers.js, copied from the werewolf game) and back into moves.
// Every decision is a numbered menu built from game.legal(), so a model can only pick a legal action;
// answers use the werewolf game's "target" / "speak" schemas (aside + target / aside + say + suspect).
// Own asides are never fed back into prompts: Opus 5.5 safeguards read that as reasoning extraction (werewolf game, 2026-10-18).
const G = require('./game.js');
const { callProvider } = require('./providers');

const R = G.MAP.rooms;
const SYSTEM = 'คุณกำลังเล่นเกมปาร์ตี้หาคนร้าย (แนวเดียวกับเกมหมาป่า) กับผู้เล่นคนอื่นที่เป็น AI · เล่นตามนิสัยตัวละคร พูดภาษาไทยแบบคนจริง · ตอบเป็น JSON อย่างเดียว';

function rulesText(g) {
  const imps = g.players.filter((p) => p.role === 'imp').length, g2 = g.opts.roles === 'g2';
  return [
    `เกม "ใครคือคนร้าย" บนสถานีอวกาศ · ผู้เล่น ${g.players.length} คน · คนร้าย ${imps} คน` + (g2 ? ' · ที่เหลือเป็นลูกเรือหรือตัวป่วน' : ' · ที่เหลือเป็นลูกเรือ') + ' (แต่ละคนรู้แค่บทตัวเอง)',
    `ทุกตาทุกคนเลือกทำ 1 อย่างพร้อมกัน: เดินไปห้องที่ติดกัน · ทำภารกิจในห้องที่มีภารกิจของตัวเอง (ภารกิจละ ${g.opts.taskTicks} ตา) · รอ · แจ้งพบศพถ้ามีศพในห้อง · กดปุ่มประชุมฉุกเฉินที่${R[G.MAP.meetingRoom]} (คนละครั้ง)`,
    'คนร้าย: ฆ่าคนที่อยู่ห้องเดียวกันได้ (มีคูลดาวน์) · มุดท่อระหว่างห้องที่มีท่อ · แกล้งทำภารกิจได้ คนอื่นเห็นเหมือนทำจริง' +
      (g2 ? ` · มี "ม่านเงา" รอบละครั้ง: ${g.opts.shadowTicks} ตาทุกคนกลายเป็นเงาดำ จำหน้าใครไม่ได้เลย` : ''),
    ...(g2 ? [
      'บทบาทในเกมนี้ (มีอย่างละ 1 คน): กัปตัน = ลูกเรือที่มีปืน 1 นัด ยิงคนในห้องเดียวกันได้ ถ้าคนที่ยิงไม่ใช่คนร้าย กัปตันตายเองทันที · ช่างซ่อม = ลูกเรือที่มุดท่อได้เหมือนคนร้าย · ลูกเรือธรรมดา = ทำภารกิจ',
      `ตัวป่วน (ไม่ใช่ลูกเรือ ไม่ใช่คนร้าย มีเป้าหมายของตัวเอง ไม่มีภารกิจจริง): ตัวตลก = ชนะทันทีถ้าถูกโหวตโยนออก · สัปเหร่อ = ชนะทันทีเมื่อเก็บศพครบ ${g.opts.undertakerQuota} ศพ (ศพที่ถูกเก็บจะหายไป แจ้งพบศพไม่ได้)`,
    ] : []),
    'ทุกคนเห็นแค่คนในห้องเดียวกัน · ใครอยู่ในห้องตอนฆ่าหรือมุดท่อจะเห็นกับตา',
    'แจ้งศพหรือกดปุ่ม → ประชุม คุยกันแล้วโหวตโยน 1 คน (เสมอหรือข้าม = ไม่มีใครออก) · หลังประชุมทุกคนกลับห้องประชุม ศพถูกเก็บ',
    g2 ? 'ลูกเรือชนะเมื่อภารกิจรวมครบ หรือคนร้ายตายหมด · คนร้ายชนะเมื่อจำนวนคนร้ายเท่ากับคนที่เหลือทั้งหมด · ตัวป่วนชนะตามเป้าของตัวเอง · ทุกคนโกหกได้'
      : 'ลูกเรือชนะเมื่อภารกิจรวมครบ หรือโหวตโยนคนร้ายออกหมด · คนร้ายชนะเมื่อจำนวนคนร้ายเท่ากับลูกเรือที่เหลือ · คนร้ายโกหกได้ทุกอย่าง',
    'ทางเดิน: ' + G.MAP.halls.map(([a, b]) => `${R[a]}–${R[b]}`).join(' · '),
    'ท่อ: ' + G.MAP.vents.map(([a, b]) => `${R[a]}↔${R[b]}`).join(' · '),
  ].join('\n');
}

// what a player may call someone: under ม่านเงา only "เงาดำคนที่ N" (VreKi: nobody can be identified)
function who(g, p, id) {
  if (!g.shadow) return g.players.find((q) => q.id === id).name;
  const here = g.players.filter((q) => q.alive && q.room === p.room && q.id !== p.id).map((q) => q.id);
  return `เงาดำคนที่ ${here.indexOf(id) + 1}`;
}

function optText(g, p, a) {
  const nm = (id) => g.players.find((q) => q.id === id).name;
  switch (a.action) {
    case 'wait': return 'รออยู่กับที่';
    case 'move': return `เดินไป${R[a.target]}`;
    case 'task': return p.role !== 'crew' ? `แกล้งทำภารกิจที่${R[p.room]} (ไม่นับจริง)` : `ทำภารกิจที่${R[p.room]}`;
    case 'kill': return `ฆ่า ${who(g, p, a.target)}`;
    case 'shoot': return `ยิง ${who(g, p, a.target)} (ถ้าไม่ใช่คนร้าย คุณตายเองทันที · มีกระสุนนัดเดียว)`;
    case 'collect': return `เก็บศพ ${nm(a.target)}`;
    case 'shadow': return `ใช้ม่านเงา (${g.opts.shadowTicks} ตาทุกคนเป็นเงาดำ จำหน้าใครไม่ได้)`;
    case 'vent': return `มุดท่อไป${R[a.target]}`;
    case 'report': return 'แจ้งพบศพ (เรียกประชุม)';
    case 'emergency': return 'กดปุ่มประชุมฉุกเฉิน';
    default: return a.action;
  }
}

function roleLine(g, p, o) {
  const mates = g.players.filter((q) => q.role === 'imp' && q.id !== p.id).map((q) => q.name);
  if (p.role === 'imp') return 'คนร้าย (ห้ามให้ใครรู้)' + (mates.length ? ' · พวกเดียวกัน: ' + mates.join(', ') : '') +
    (g.opts.roles ? ` · ม่านเงา: ${p.shadowLeft > 0 ? 'ใช้ได้ 1 ครั้งในรอบนี้' : 'ใช้แล้วในรอบนี้'}` : '');
  if (p.role === 'joker') return 'ตัวตลก (ตัวป่วน) · เป้าหมาย: ทำให้คนอื่นโหวตโยนคุณออก แต่อย่าให้ดูจงใจเกินไป';
  if (p.role === 'undertaker') return `สัปเหร่อ (ตัวป่วน) · เป้าหมาย: เก็บศพให้ครบ ${g.opts.undertakerQuota} ศพ (เก็บแล้ว ${p.collected}) · ถ้ามีคนเห็นตอนเก็บจะโดนสงสัย`;
  if (p.job === 'captain') return `กัปตัน (ลูกเรือ) · กระสุน ${p.bullets} นัด · ยิงพลาดคนที่ไม่ใช่คนร้าย = คุณตายเอง`;
  if (p.job === 'engineer') return 'ช่างซ่อม (ลูกเรือ) · มุดท่อได้ แต่ถ้ามีคนเห็นจะโดนสงสัยว่าเป็นคนร้าย';
  return 'ลูกเรือ';
}

// meetings: people don't say "ตา 11" (VreKi 2026-10-28: "AI อาจจะเข้าใจได้ดีแต่คนไม่เข้าใจเลยว่าหมายถึงอะไร") →
// memory stamps become the words a person would use; the map prompts keep the tick numbers the AI plans with
function humanTime(g, line) {
  const last = [...g.timeline].reverse().find((e) => e.type === 'eject'), r0 = last ? last.tick : 0;
  return line.replace(/^\[ตา (\d+)\]/, (_, n) => {
    const t = +n, d = g.tick - t;
    return '[' + (t <= r0 && last ? 'รอบก่อน' : t <= r0 + 1 ? 'ตอนเริ่มรอบนี้' : d <= 1 ? 'เมื่อกี้' : d <= 4 ? 'ไม่นานมานี้' : 'ช่วงต้นรอบนี้') + ']';
  });
}

function header(g, p, persona, human = false) {
  const o = G.observe(g, p.id), nm = (id) => g.players.find((q) => q.id === id).name;
  // meetings: numbered (#1 = oldest) so a line can cite what it is about → "ref" → replay inserts in the edit
  if (human) o.memory = o.memory.map((l, i) => `#${i + 1} ${humanTime(g, l)}`);
  return [
    rulesText(g), '',
    `ตัวคุณ: ${p.name} — ${persona || ''}`,
    `บทของคุณ: ${roleLine(g, p, o)}`,
    `ยังอยู่: ${o.alive.map(nm).join(', ')}`,
    `ภารกิจรวมทั้งทีม: ${Math.round(o.tasks.done / Math.max(1, o.tasks.need) * 100)}%`,
    '', 'ความจำของคุณ (เก่า → ใหม่):', ...o.memory, '',
  ];
}

function actPrompt(g, p, persona) {
  const o = G.observe(g, p.id), nm = (id) => g.players.find((q) => q.id === id).name;
  const opts = o.legal.map((a, i) => `${i + 1}. ${optText(g, p, a)}`);
  return {
    opts: o.legal,
    prompt: [...header(g, p, persona),
      `ตอนนี้ตาที่ ${g.tick + 1} · คุณอยู่${o.you.roomName}` +
        (o.here.length ? (g.shadow ? ` กับเงาดำ ${o.here.length} คน (ม่านเงายังอยู่ จำหน้าใครไม่ได้)` : ` กับ ${o.here.map(nm).join(', ')}`) : ' คนเดียว') +
        (o.bodies.length ? ` · มีศพ ${o.bodies.map(nm).join(', ')} อยู่ตรงนี้!` : ''),
      p.role === 'crew' ? `ภารกิจที่เหลือของคุณ: ${o.you.tasksLeft.map((r) => R[r]).join(', ') || 'ครบแล้ว'}`
        : p.role === 'imp' ? `คูลดาวน์ฆ่า: ${o.you.cooldown > 0 ? `อีก ${o.you.cooldown} ตา` : 'พร้อมฆ่า'}` : `เป้าหมายของคุณ: ${roleLine(g, p, o)}`,
      '', 'เลือกทำ 1 อย่าง:', ...opts, '',
      'ตอบ JSON: {"aside":"คิดในใจสั้นๆ 1 ประโยค","target":"เลขข้อที่เลือก"}'].join('\n'),
  };
}

const pickNum = (json, n) => { const m = String(json && json.target || '').match(/\d+/); const k = m ? +m[0] : 0; return k >= 1 && k <= n ? k - 1 : -1; };

async function ask(app, seat, req) {
  // the game was stopped (stop button / new game forced): no more AI calls, and none is logged,
  // so the failure check never reads the stop as "this company keeps failing"
  if (app.aborted) return { ok: false, error: 'aborted', ms: 0 };
  const cfg = app.providers[seat.provider];
  // app.callOverride: test only (tests/runner.test.js stands in for a company without calling an AI)
  const r = app.callOverride ? await app.callOverride(seat.provider, { system: SYSTEM, ...req }) : await callProvider(seat.provider, cfg, app, { system: SYSTEM, ...req });
  // per-call log for run.js stats (time + cost per provider)
  if (app.stats) app.stats.push({ provider: seat.provider, kind: req.kind, ms: r.ms || 0, ok: !!r.ok, error: r.ok ? null : String(r.error || '').slice(0, 120),
    costUsd: (r.usage && r.usage.costUsd) || 0, input: (r.usage && r.usage.input) || 0, output: (r.usage && r.usage.output) || 0,
    retried: !!(r.meta && r.meta.retriedWithoutAside), path: (r.meta && r.meta.path) || null });
  return r;
}

// one tick: every living player decides at the same time
async function decideTick(g, app, seats) {
  const live = g.players.filter((p) => p.alive);
  const res = await Promise.all(live.map(async (p) => {
    const { opts, prompt } = actPrompt(g, p, seats[p.id].persona);
    const r = await ask(app, seats[p.id], { prompt, kind: 'target', names: opts.map((_, i) => String(i + 1)) });
    const k = r.ok ? pickNum(r.json, opts.length) : -1;
    return { id: p.id, action: k >= 0 ? opts[k] : { action: 'wait' }, aside: r.json && r.json.aside, ms: r.ms, ok: r.ok && k >= 0, error: r.ok ? (k < 0 ? 'bad choice: ' + JSON.stringify(r.json) : null) : r.error, usage: r.usage };
  }));
  for (const x of res) {
    g.timeline.push({ tick: g.tick + 1, type: 'thought', id: x.id, text: x.aside || '', ms: x.ms, ok: x.ok, ...(x.error ? { error: String(x.error).slice(0, 200) } : {}) });
  }
  return { actions: Object.fromEntries(res.map((x) => [x.id, x.action])), res };
}

// "ห้องพยาบาล:น้องฟ้า > ห้องประชุม:ลุงเพิ่ม,ศพตี๋" → [{ room:'B', people:[{id:'fah', body:false}] }, …] (max 4 rooms, unknown words dropped)
function parseScene(g, speaker, raw) {
  const rooms = Object.entries(G.MAP.rooms), bare = (n) => n.replace('ห้อง', '').trim();
  return String(raw || '').split('>').map((part) => {
    const k = part.indexOf(':'), rn = (k >= 0 ? part.slice(0, k) : part).trim(), ppl = k >= 0 ? part.slice(k + 1) : '';
    if (!rn) return null;
    const hit = rooms.find(([, n]) => rn === n || bare(rn) === bare(n)) || rooms.find(([, n]) => rn.includes(bare(n)));
    if (!hit) return null;
    const people = ppl.split(/[,，、]+/).map((x) => x.trim()).filter(Boolean).map((x) => {
      const body = x.startsWith('ศพ'), nm = body ? x.slice(2).trim() : x;
      const q = g.players.find((pl) => pl.id !== speaker && (nm === pl.name || nm.includes(pl.name)));
      return q ? { id: q.id, body } : null;
    }).filter(Boolean);
    return { room: hit[0], people };
  }).filter(Boolean).slice(-4);
}

// meeting: discussion rounds (say + suspect) then a vote
async function runMeeting(g, app, seats, rounds = 2) {
  for (let r = 1; r <= rounds; r++) {
    for (const p of g.players.filter((q) => q.alive)) {
      if (app.aborted) return null; // stopped mid-meeting: the lines so far stay, nobody else speaks or votes
      const others = g.players.filter((q) => q.alive && q.id !== p.id);
      const prompt = [...header(g, p, seats[p.id].persona, true),
        `ตอนนี้ประชุมอยู่ (รอบพูดที่ ${r}/${rounds}) · ถึงตาคุณพูด 1–2 ประโยคสั้นๆ ไม่เกิน 30 คำ ตามนิสัยตัวละคร · บอกสิ่งที่เห็น สงสัยใคร หรือแก้ตัวก็ได้`,
        'พูดเรื่องเวลาแบบคนทั่วไป เช่น "เมื่อกี้" "ตอนเริ่มรอบ" "ก่อนเจอศพ" "ตอนที่เจอใคร" · ห้ามพูดเลขตาหรือตัวเลขเวลา คนฟังจะไม่เข้าใจ',
        // bare room names ran together on screen and in the voice (VreKi 2026-10-28: "ไฟฟ้านำทาง … อย่างน้อยถ้าพูดถึงห้องให้พูดคำว่าห้องหน่อย")
        'พูดชื่อห้องเต็มทุกครั้ง มีคำว่า "ห้อง" นำหน้า เช่น "ห้องไฟฟ้า" "ห้องนำทาง" (ห้ามพูดแค่ "ไฟฟ้า" "นำทาง") · คลังสินค้าเรียกเต็มว่า "คลังสินค้า" · หลายห้องต่อกันให้มีคำเชื่อม เช่น "ผมไปห้องไฟฟ้า แล้วก็ไปห้องนำทาง"',
        'ใน "ref" ใส่เลขความจำ (#) ที่คำพูดนี้อ้างถึง เช่น "12,15" (ไม่ต้องพูดเลขนี้ออกมา) · ถ้าไม่ได้อ้างความจำข้อไหนใส่ ""',
        'ใน "scene" เล่าเส้นทางตามที่คุณพูดออกมา (จริงหรือโกหกก็ได้ แต่ต้องตรงกับที่พูด) เป็นห้องเรียงตามลำดับคั่นด้วย > และใส่ชื่อคนที่อยู่ในห้องนั้นหลัง : (ศพใส่ ศพ นำหน้าชื่อ) เช่น "ห้องพยาบาล:น้องฟ้า > ห้องประชุม:ลุงเพิ่ม,ศพตี๋" · ถ้าไม่ได้เล่าเส้นทางใส่ ""',
        'ตอบ JSON: {"aside":"คิดในใจสั้นๆ","say":"สิ่งที่พูดออกมา","suspect":"ชื่อคนที่สงสัยที่สุด หรือ ไม่มี","ref":"เลขความจำที่อ้างถึง หรือ ว่าง","scene":"เส้นทางที่เล่า หรือ ว่าง"}'].join('\n');
      const mem = G.observe(g, p.id).memory; // raw "[ตา N] …" lines in the same order header() numbered them
      const res = await ask(app, seats[p.id], { prompt, kind: 'speakscene', names: others.map((q) => q.name) });
      const text = res.ok && res.json && res.json.say ? String(res.json.say).slice(0, 220) : '…';
      if (res.json && res.json.aside) g.timeline.push({ tick: g.tick, type: 'thought', id: p.id, text: res.json.aside, ms: res.ms, ok: res.ok, meeting: true });
      G.say(g, p.id, text);
      // the cited memories → { tick, text } on the say event (viewer replays those ticks while the line is spoken)
      const ev = g.timeline[g.timeline.length - 1];
      if (ev && ev.type === 'say' && res.json && res.json.ref) {
        const refs = [...new Set(String(res.json.ref).match(/\d+/g) || [])].map((n) => mem[+n - 1]).filter(Boolean)
          .map((l) => { const m = l.match(/^\[ตา (\d+)\] (.*)$/); return m ? { tick: +m[1], text: m[2] } : null; }).filter(Boolean);
        if (refs.length) ev.refs = refs.slice(0, 6);
      }
      // the route as told (VreKi 2026-10-28: the replay should show each speaker's story, even a lie) → [{ room, people:[{id, body}] }]
      if (ev && ev.type === 'say' && res.json && res.json.scene) { const sc = parseScene(g, p.id, res.json.scene); if (sc.length) ev.scene = sc; }
      app.onSay && app.onSay(ev); // runner.js: voice this line now, while the meeting goes on
    }
  }
  if (app.aborted) return null;
  const votes = {};
  await Promise.all(g.players.filter((q) => q.alive).map(async (p) => {
    const cands = g.players.filter((q) => q.alive && q.id !== p.id);
    const opts = [...cands.map((q, i) => `${i + 1}. โหวต ${q.name}`), `${cands.length + 1}. ข้าม ไม่โหวตใคร`];
    const prompt = [...header(g, p, seats[p.id].persona, true), 'ถึงเวลาโหวตโยน 1 คนออกจากสถานี:', ...opts, '',
      'ตอบ JSON: {"aside":"คิดในใจสั้นๆ","target":"เลขข้อที่เลือก"}'].join('\n');
    const res = await ask(app, seats[p.id], { prompt, kind: 'target', names: opts.map((_, i) => String(i + 1)) });
    const k = res.ok ? pickNum(res.json, opts.length) : -1;
    votes[p.id] = k >= 0 && k < cands.length ? cands[k].id : 'skip';
  }));
  return G.resolveVote(g, votes);
}

module.exports = { rulesText, actPrompt, ask, decideTick, runMeeting, SYSTEM, header, humanTime };
