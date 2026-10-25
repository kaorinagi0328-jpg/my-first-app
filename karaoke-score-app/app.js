"use strict";
// カラオケ採点アプリ MVP
// 楽譜(MusicXML/内蔵サンプル) -> パート別音符リスト -> お手本再生 / マイク採点 / ピアノロール

const $ = (id) => document.getElementById(id);
const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTE_NAMES = ["ド", "ド#", "レ", "レ#", "ミ", "ファ", "ファ#", "ソ", "ソ#", "ラ", "ラ#", "シ"];

let song = null;        // {title, bpm, parts:[{name, notes:[{midi,start,dur}]}]} start/dur は拍単位
let audioCtx = null;
let playing = null;     // {stop()} 再生/採点セッション

// ---------- サンプル曲: かえるの合唱 (輪唱) ----------
// [midi, 拍数] の並び。主旋律と、2小節(8拍)遅れの輪唱パート
const FROG_MELODY = [
  [60,1],[62,1],[64,1],[65,1],[64,1],[62,1],[60,2],
  [64,1],[65,1],[67,1],[69,1],[67,1],[65,1],[64,2],
  [60,2],[60,2],
  [60,1],[60,1],[62,1],[62,1],[64,1],[64,1],[65,1],[65,1],
  [64,1],[62,1],[60,2],
];
function notesFromPairs(pairs, offset = 0) {
  let t = offset; const out = [];
  for (const [midi, dur] of pairs) { out.push({ midi, start: t, dur }); t += dur; }
  return out;
}
function sampleSong() {
  return {
    title: "かえるの合唱（サンプル）", bpm: 100,
    parts: [
      { name: "主旋律", notes: notesFromPairs(FROG_MELODY) },
      { name: "輪唱（2小節おくれ）", notes: notesFromPairs(FROG_MELODY, 8) },
    ],
  };
}

// ---------- MusicXML ----------
function parseMusicXML(text) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error("MusicXMLとして読めませんでした");
  const title = doc.querySelector("work-title")?.textContent || "読み込んだ曲";
  let bpm = 100;
  const soundTempo = doc.querySelector("sound[tempo]");
  if (soundTempo) bpm = parseFloat(soundTempo.getAttribute("tempo")) || 100;
  const names = {};
  doc.querySelectorAll("score-part").forEach((sp) => {
    names[sp.getAttribute("id")] = sp.querySelector("part-name")?.textContent || sp.getAttribute("id");
  });
  const parts = [];
  doc.querySelectorAll("part").forEach((partEl) => {
    const notes = []; let cursor = 0, divisions = 1;
    partEl.querySelectorAll("measure").forEach((measure) => {
      let mCursor = cursor; const mStart = cursor; let maxEnd = cursor;
      measure.querySelectorAll(":scope > *").forEach((el) => {
        if (el.tagName === "attributes") {
          const d = el.querySelector("divisions");
          if (d) divisions = parseFloat(d.textContent) || 1;
        } else if (el.tagName === "sound" && el.getAttribute("tempo")) {
          bpm = parseFloat(el.getAttribute("tempo")) || bpm;
        } else if (el.tagName === "backup") {
          mCursor -= (parseFloat(el.querySelector("duration")?.textContent || 0) / divisions);
        } else if (el.tagName === "forward") {
          mCursor += (parseFloat(el.querySelector("duration")?.textContent || 0) / divisions);
        } else if (el.tagName === "note") {
          const dur = (parseFloat(el.querySelector("duration")?.textContent || 0) / divisions);
          const isChord = !!el.querySelector("chord");
          const start = isChord ? notes.length ? notes[notes.length - 1].start : mCursor : mCursor;
          if (!el.querySelector("rest") && !isChord) {
            const step = el.querySelector("pitch > step")?.textContent;
            const alter = parseFloat(el.querySelector("pitch > alter")?.textContent || 0);
            const octave = parseFloat(el.querySelector("pitch > octave")?.textContent || 4);
            if (step && STEP[step] !== undefined) {
              notes.push({ midi: (octave + 1) * 12 + STEP[step] + alter, start, dur });
            }
          }
          if (!isChord) { mCursor += dur; if (mCursor > maxEnd) maxEnd = mCursor; }
        }
      });
      cursor = maxEnd > mStart ? maxEnd : cursor;
    });
    if (notes.length) parts.push({ name: names[partEl.getAttribute("id")] || partEl.getAttribute("id"), notes });
  });
  if (!parts.length) throw new Error("音符のあるパートが見つかりませんでした");
  return { title, bpm, parts };
}

// ---------- 音程検出（自己相関） ----------
function detectPitch(buf, sampleRate) {
  let rms = 0; for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / buf.length);
  if (rms < 0.01) return null;
  let r1 = 0, r2 = buf.length - 1;
  const th = 0.2;
  for (let i = 0; i < buf.length / 2; i++) if (Math.abs(buf[i]) < th) { r1 = i; break; }
  for (let i = 1; i < buf.length / 2; i++) if (Math.abs(buf[buf.length - i]) < th) { r2 = buf.length - i; break; }
  const b = buf.slice(r1, r2); if (b.length < 16) return null;
  const corr = new Array(b.length).fill(0);
  for (let lag = 0; lag < b.length; lag++)
    for (let i = 0; i < b.length - lag; i++) corr[lag] += b[i] * b[i + lag];
  let d = 0; while (d < corr.length - 1 && corr[d] > corr[d + 1]) d++;
  let maxVal = -1, maxLag = -1;
  for (let i = d; i < corr.length; i++) if (corr[i] > maxVal) { maxVal = corr[i]; maxLag = i; }
  if (maxLag <= 0) return null;
  return sampleRate / maxLag;
}
const freqToMidiFloat = (f) => 69 + 12 * Math.log2(f / 440);

// ---------- 再生 ----------
function ensureCtx() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); return audioCtx; }
function playTone(midi, at, dur, gainVal = 0.18) {
  const ctx = ensureCtx(); const f = 440 * Math.pow(2, (midi - 69) / 12);
  const osc = ctx.createOscillator(); const g = ctx.createGain();
  osc.type = "triangle"; osc.frequency.value = f;
  g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(gainVal, at + 0.02);
  g.gain.setValueAtTime(gainVal, at + Math.max(0.05, dur - 0.05));
  g.gain.linearRampToValueAtTime(0, at + dur);
  osc.connect(g).connect(ctx.destination); osc.start(at); osc.stop(at + dur + 0.05);
}
function selectedPart() { return song.parts[Number($("partSelect").value || 0)]; }
function secPerBeat() { return 60 / (song.bpm * (Number($("tempo").value) / 100)); }
function songLengthSec(notes) { return Math.max(...notes.map((n) => n.start + n.dur)) * secPerBeat(); }

function scheduleModel(notes, onEnded) {
  const ctx = ensureCtx(); const startAt = ctx.currentTime + 0.1; const spb = secPerBeat();
  notes.forEach((n) => playTone(n.midi, startAt + n.start * spb, n.dur * spb));
  const timer = setTimeout(onEnded, (songLengthSec(notes) + 0.3) * 1000);
  return { startAt, stop: () => clearTimeout(timer) };
}

// ---------- ピアノロール ----------
function drawRoll(notes, sung, playheadBeat) {
  const c = $("roll"), ctx = c.getContext("2d");
  const W = c.width, H = c.height; ctx.clearRect(0, 0, W, H);
  if (!notes.length) return;
  const totalBeats = Math.max(...notes.map((n) => n.start + n.dur));
  const midis = notes.map((n) => n.midi);
  const lo = Math.min(...midis) - 3, hi = Math.max(...midis) + 3;
  const x = (beat) => (beat / totalBeats) * W;
  const y = (midiF) => H - ((midiF - lo) / (hi - lo)) * H;
  ctx.fillStyle = "#374151";
  notes.forEach((n) => { ctx.fillRect(x(n.start), y(n.midi + 0.5), x(n.start + n.dur) - x(n.start) - 1, y(n.midi - 0.5) - y(n.midi + 0.5)); });
  if (sung && sung.scored) {
    sung.scored.forEach((s, i) => {
      ctx.fillStyle = s.ok ? "rgba(34,197,94,.75)" : "rgba(239,68,68,.75)";
      const n = notes[i];
      ctx.fillRect(x(n.start), y(n.midi + 0.5), x(n.start + n.dur) - x(n.start) - 1, y(n.midi - 0.5) - y(n.midi + 0.5));
    });
  }
  if (sung && sung.trace && sung.trace.length) {
    ctx.strokeStyle = "#facc15"; ctx.lineWidth = 2; ctx.beginPath();
    sung.trace.forEach((p, i) => { const px = x(p.beat), py = y(p.midiF); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
  }
  if (playheadBeat != null) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x(playheadBeat), 0); ctx.lineTo(x(playheadBeat), H); ctx.stroke(); }
}

// ---------- 採点 ----------
function scorePerformance(notes, trace) {
  const scored = notes.map((n) => {
    const samples = trace.filter((p) => p.beat >= n.start + n.dur * 0.2 && p.beat <= n.start + n.dur * 0.9)
      .map((p) => p.midiF).sort((a, b) => a - b);
    if (!samples.length) return { cents: null, ok: false, label: "声が取れませんでした" };
    const median = samples[Math.floor(samples.length / 2)];
    let cents = Math.round((median - n.midi) * 100);
    if ($("octaveOk").checked) { while (cents > 600) cents -= 1200; while (cents < -600) cents += 1200; }
    const a = Math.abs(cents);
    const points = a <= 50 ? 100 : a <= 100 ? 70 : a <= 150 ? 40 : 0;
    return { cents, ok: a <= 100, points, label: a <= 50 ? "◎ ぴったり" : a <= 100 ? "○ ほぼ合っている" : "× " + (cents > 0 ? "高すぎ" : "低すぎ") };
  });
  const total = Math.round(scored.reduce((s, r) => s + (r.points || 0), 0) / Math.max(1, scored.length));
  return { scored, total };
}

// ---------- 画面の動作 ----------
function setSong(s) {
  song = s;
  $("songTitle").textContent = "曲: " + s.title + "（" + s.parts.length + "パート）";
  const sel = $("partSelect"); sel.innerHTML = "";
  s.parts.forEach((p, i) => { const o = document.createElement("option"); o.value = i; o.textContent = p.name + "（" + p.notes.length + "音）"; sel.appendChild(o); });
  sel.disabled = false; $("playModel").disabled = false; $("singBtn").disabled = false;
  $("status").textContent = "パートを選んで「お手本を聞く」か「歌って採点」を押してください";
  $("resultCard").hidden = true;
  drawRoll(selectedPart().notes, null, null);
}
$("partSelect").addEventListener("change", () => { if (song) drawRoll(selectedPart().notes, null, null); });
$("tempo").addEventListener("input", () => { $("tempoVal").textContent = $("tempo").value; });
$("loadSample").addEventListener("click", () => setSong(sampleSong()));
$("fileInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { setSong(parseMusicXML(await f.text())); }
  catch (err) { $("status").textContent = "読み込み失敗: " + err.message + "（.mxl 圧縮形式は未対応です。.musicxml で書き出してください）"; }
});
function stopAll() { if (playing) { playing.stop(); playing = null; } $("stopBtn").disabled = true; }
$("stopBtn").addEventListener("click", () => { stopAll(); $("status").textContent = "止めました"; });
$("playModel").addEventListener("click", () => {
  stopAll(); const notes = selectedPart().notes;
  $("status").textContent = "お手本を再生中…";
  const s = scheduleModel(notes, () => { $("status").textContent = "再生が終わりました"; $("stopBtn").disabled = true; });
  playing = s; $("stopBtn").disabled = false;
  const spb = secPerBeat(); const t0 = performance.now();
  (function tick() {
    if (playing !== s) return;
    const beat = ((performance.now() - t0) / 1000 - 0.1) / spb;
    drawRoll(notes, null, Math.max(0, beat));
    if (beat <= Math.max(...notes.map((n) => n.start + n.dur))) requestAnimationFrame(tick);
  })();
});
$("singBtn").addEventListener("click", async () => {
  stopAll(); const notes = selectedPart().notes;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { $("status").textContent = "マイクが使えませんでした。ブラウザのマイク許可を確認してください"; return; }
  const ctx = ensureCtx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  $("status").textContent = "用意… お手本に合わせて歌ってください";
  const s = scheduleModel(notes, finish);
  playing = s; $("stopBtn").disabled = false;
  const trace = []; const spb = secPerBeat(); let done = false;
  function finish() {
    if (done) return; done = true;
    stream.getTracks().forEach((t) => t.stop()); $("stopBtn").disabled = true;
    const result = scorePerformance(notes, trace);
    drawRoll(notes, { trace, scored: result.scored }, null);
    $("scoreNum").textContent = result.total;
    const ul = $("noteResults"); ul.innerHTML = "";
    result.scored.forEach((r, i) => {
      const li = document.createElement("li");
      const n = notes[i];
      li.textContent = (i + 1) + "音目 " + NOTE_NAMES[((n.midi % 12) + 12) % 12] + ": " + r.label + (r.cents == null ? "" : "（" + (r.cents > 0 ? "+" : "") + r.cents + "セント）");
      ul.appendChild(li);
    });
    $("resultCard").hidden = false;
    $("status").textContent = "採点が終わりました";
    playing = null;
  }
  s.stopOrig = s.stop; s.stop = () => { s.stopOrig(); finish(); };
  (function tick() {
    if (done || playing !== s) return;
    analyser.getFloatTimeDomainData(buf);
    const f = detectPitch(buf, ctx.sampleRate);
    const beat = (ctx.currentTime - s.startAt) / spb;
    if (f && beat >= 0) {
      const midiF = freqToMidiFloat(f); trace.push({ beat, midiF });
      $("livePitch").textContent = "いまの音: " + NOTE_NAMES[Math.round(midiF) % 12] + "（" + Math.round(f) + "Hz）";
    }
    drawRoll(notes, { trace }, Math.max(0, beat));
    requestAnimationFrame(tick);
  })();
});
