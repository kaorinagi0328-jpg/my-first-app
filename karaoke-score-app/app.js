"use strict";
// カラオケ採点アプリ MVP
// 楽譜(MusicXML/内蔵サンプル) -> パート別音符リスト -> お手本再生 / マイク採点 / ピアノロール

const $ = (id) => document.getElementById(id);
const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTE_NAMES = ["ド", "ド#", "レ", "レ#", "ミ", "ファ", "ファ#", "ソ", "ソ#", "ラ", "ラ#", "シ"];

let song = null;        // {title, bpm, parts:[{name, notes:[{midi,start,dur}]}]} start/dur は拍単位
let audioCtx = null;
let playing = null;     // {stop()} 再生/採点セッション
let mode = null;        // "model" | "sing" 最後に始めたモード（最初からやり直す用）

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
    title: "かえるの合唱（サンプル）", bpm: 100, beatsPerMeasure: 4,
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
  let beatsPerMeasure = 4;
  const beatsEl = doc.querySelector("time > beats");
  if (beatsEl) beatsPerMeasure = parseInt(beatsEl.textContent, 10) || 4;
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
  return { title, bpm, beatsPerMeasure, parts };
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
function playTone(midi, at, dur, dest, gainVal = 0.18) {
  const ctx = ensureCtx(); const f = 440 * Math.pow(2, (midi - 69) / 12);
  const osc = ctx.createOscillator(); const g = ctx.createGain();
  osc.type = "triangle"; osc.frequency.value = f;
  g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(gainVal, at + 0.02);
  g.gain.setValueAtTime(gainVal, at + Math.max(0.05, dur - 0.05));
  g.gain.linearRampToValueAtTime(0, at + dur);
  osc.connect(g).connect(dest || ctx.destination); osc.start(at); osc.stop(at + dur + 0.05);
  return osc;
}
function selectedPart() { return song.parts[Number($("partSelect").value || 0)]; }
function secPerBeat() { return 60 / (song.bpm * (Number($("tempo").value) / 100)); }
function songLengthSec(notes) { return Math.max(...notes.map((n) => n.start + n.dur)) * secPerBeat(); }

function clickTone(at, accent, dest) {
  const ctx = ensureCtx();
  const osc = ctx.createOscillator(); const g = ctx.createGain();
  osc.type = "sine"; osc.frequency.value = accent ? 1760 : 1180;
  const vol = accent ? 0.22 : 0.13;
  g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vol, at + 0.004);
  g.gain.exponentialRampToValueAtTime(0.001, at + 0.07);
  osc.connect(g).connect(dest); osc.start(at); osc.stop(at + 0.09);
  return osc;
}
function countInBeats() { return $("countIn") && $("countIn").checked ? (song.beatsPerMeasure || 4) : 0; }
function scheduleModel(notes, onEnded) {
  const ctx = ensureCtx(); const spb = secPerBeat();
  const countIn = countInBeats();
  const startAt = ctx.currentTime + 0.15 + countIn * spb;
  // 全ての音を1つのマスター音量経由にし、停止時はマスターを切断+全オシレータ停止で即時に音を止める
  // (予約済みの音は setTimeout を消すだけでは止まらないため)
  const master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
  const oscs = notes.map((n) => playTone(n.midi, startAt + n.start * spb, n.dur * spb, master));
  // メトロノーム: カウントインから曲の終わりまで全拍クリック (小節頭は高い音でアクセント)
  if ($("metronome") && $("metronome").checked) {
    const measure = song.beatsPerMeasure || 4;
    const totalBeats = Math.ceil(Math.max(...notes.map((n) => n.start + n.dur)));
    for (let b = -countIn; b < totalBeats; b++) {
      const accent = ((b % measure) + measure) % measure === 0;
      oscs.push(clickTone(startAt + b * spb, accent, master));
    }
  }
  const timer = setTimeout(() => { try { master.disconnect(); } catch {} onEnded(); }, ((startAt - ctx.currentTime) + songLengthSec(notes) + 0.3) * 1000);
  let stopped = false;
  return {
    startAt, countIn,
    stop: () => {
      if (stopped) return; stopped = true;
      clearTimeout(timer);
      try { master.gain.cancelScheduledValues(ctx.currentTime); master.gain.setValueAtTime(0, ctx.currentTime); } catch {}
      oscs.forEach((o) => { try { o.stop(); } catch {} });
      try { master.disconnect(); } catch {}
    },
  };
}

// ---------- ピアノロール ----------
// 生の検出値は細かく震えるので、表示と採点の前に中央値フィルタでならす
function smoothTrace(trace, windowSize = 7) {
  if (!trace || trace.length < 3) return trace || [];
  const half = Math.floor(windowSize / 2);
  return trace.map((p, i) => {
    const vals = [];
    for (let j = Math.max(0, i - half); j <= Math.min(trace.length - 1, i + half); j++) vals.push(trace[j].midiF);
    vals.sort((a, b) => a - b);
    return { beat: p.beat, midiF: vals[Math.floor(vals.length / 2)] };
  });
}
function roundRectPath(ctx, rx, ry, rw, rh, r) {
  const rr = Math.min(r, rw / 2, rh / 2);
  ctx.beginPath();
  ctx.moveTo(rx + rr, ry);
  ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, rr);
  ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, rr);
  ctx.arcTo(rx, ry + rh, rx, ry, rr);
  ctx.arcTo(rx, ry, rx + rw, ry, rr);
  ctx.closePath();
}
function drawRoll(notes, sung, playheadBeat, overlayText) {
  const c = $("roll"), ctx = c.getContext("2d");
  const W = c.width, H = c.height; ctx.clearRect(0, 0, W, H);
  if (!notes.length) return;
  const totalBeats = Math.max(...notes.map((n) => n.start + n.dur));
  const midis = notes.map((n) => n.midi);
  const lo = Math.min(...midis) - 3, hi = Math.max(...midis) + 3;
  const PAD_L = 52, PAD_R = 10, PAD_T = 10, PAD_B = 10;
  const x = (beat) => PAD_L + (beat / totalBeats) * (W - PAD_L - PAD_R);
  const y = (midiF) => PAD_T + (1 - (midiF - lo) / (hi - lo)) * (H - PAD_T - PAD_B);
  // 目盛り: 横=1半音ごとの線と音名、縦=1拍ごとの線
  ctx.font = "12px system-ui, sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
    const isC = ((m % 12) + 12) % 12 === 0;
    ctx.strokeStyle = isC ? "rgba(255,255,255,.35)" : "rgba(255,255,255,.10)";
    ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD_L, y(m)); ctx.lineTo(W - PAD_R, y(m)); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.fillText(NOTE_NAMES[((m % 12) + 12) % 12], PAD_L - 6, y(m));
  }
  ctx.strokeStyle = "rgba(255,255,255,.14)";
  for (let b = 0; b <= totalBeats; b++) { ctx.beginPath(); ctx.moveTo(x(b), PAD_T); ctx.lineTo(x(b), H - PAD_B); ctx.stroke(); }
  // お手本の音符: 角丸ブロック + ドレミ表記
  const drawNote = (n, fill) => {
    const nx = x(n.start) + 1, nw = Math.max(6, x(n.start + n.dur) - x(n.start) - 2);
    const ny = y(n.midi + 0.42), nh = y(n.midi - 0.42) - ny;
    roundRectPath(ctx, nx, ny, nw, nh, 5); ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 1; ctx.stroke();
    if (nw >= 26) {
      ctx.fillStyle = "#fff"; ctx.font = "bold 12px system-ui, sans-serif"; ctx.textAlign = "center";
      ctx.fillText(NOTE_NAMES[((n.midi % 12) + 12) % 12], nx + nw / 2, ny + nh / 2 + 0.5);
      ctx.textAlign = "right"; ctx.font = "12px system-ui, sans-serif";
    }
  };
  notes.forEach((n) => drawNote(n, "#64748b"));
  if (sung && sung.scored) {
    sung.scored.forEach((s, i) => drawNote(notes[i], s.ok ? "rgba(34,197,94,.88)" : "rgba(239,68,68,.88)"));
  }
  // 歌った音: なめらかにした太い線。無音や大きな跳躍では線を切る
  if (sung && sung.trace && sung.trace.length) {
    const trace = smoothTrace(sung.trace);
    const segments = []; let cur = [trace[0]];
    for (let i = 1; i < trace.length; i++) {
      const gap = trace[i].beat - trace[i - 1].beat;
      const jump = Math.abs(trace[i].midiF - trace[i - 1].midiF);
      if (gap > 0.45 || jump > 4) { segments.push(cur); cur = []; }
      cur.push(trace[i]);
    }
    segments.push(cur);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (const seg of segments) {
      if (!seg.length) continue;
      for (const [width, style] of [[8, "rgba(0,0,0,.5)"], [4.5, "#fde047"]]) {
        ctx.strokeStyle = style; ctx.lineWidth = width; ctx.beginPath();
        seg.forEach((p, i) => { const px = x(p.beat), py = y(p.midiF); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
        if (seg.length === 1) ctx.lineTo(x(seg[0].beat) + 0.1, y(seg[0].midiF));
        ctx.stroke();
      }
      ctx.fillStyle = "#fde047";
      seg.forEach((p) => { ctx.beginPath(); ctx.arc(x(p.beat), y(p.midiF), 2.2, 0, Math.PI * 2); ctx.fill(); });
    }
  }
  if (playheadBeat != null && playheadBeat >= 0) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x(playheadBeat), PAD_T); ctx.lineTo(x(playheadBeat), H - PAD_B); ctx.stroke(); }
  if (overlayText) {
    ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.beginPath(); ctx.arc(W / 2, H / 2, 52, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "bold 64px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(overlayText, W / 2, H / 2 + 2);
    ctx.textAlign = "right"; ctx.font = "12px system-ui, sans-serif";
  }
}

// ---------- 採点 ----------
function scorePerformance(notes, rawTrace) {
  const trace = smoothTrace(rawTrace);
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
  sel.disabled = false; $("playModel").disabled = false; $("singBtn").disabled = false; $("restartBtn").disabled = false;
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
function startModel() {
  stopAll(); mode = "model"; const notes = selectedPart().notes;
  const s = scheduleModel(notes, () => { $("status").textContent = "再生が終わりました"; $("stopBtn").disabled = true; });
  playing = s; $("stopBtn").disabled = false;
  $("status").textContent = s.countIn ? "カウントイン… 数字が0になったら始まります" : "お手本を再生中…";
  const spb = secPerBeat(); const ctx = ensureCtx();
  (function tick() {
    if (playing !== s) return;
    const beat = (ctx.currentTime - s.startAt) / spb;
    if (beat >= 0 && $("status").textContent.startsWith("カウントイン")) $("status").textContent = "お手本を再生中…";
    drawRoll(notes, null, Math.max(0, beat), beat < 0 ? String(Math.ceil(-beat)) : null);
    if (beat <= Math.max(...notes.map((n) => n.start + n.dur))) requestAnimationFrame(tick);
  })();
}
$("playModel").addEventListener("click", startModel);
async function startSing() {
  stopAll(); mode = "sing"; const notes = selectedPart().notes;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { $("status").textContent = "マイクが使えませんでした。ブラウザのマイク許可を確認してください"; return; }
  const ctx = ensureCtx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const s = scheduleModel(notes, finish);
  $("status").textContent = s.countIn ? "カウントイン… 大きな数字が0になったら歌い始めてください" : "お手本に合わせて歌ってください";
  playing = s; $("stopBtn").disabled = false;
  const trace = []; const spb = secPerBeat(); let done = false; const recent = [];
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
  s.stopOrig = s.stop;
  s.stop = () => {
    s.stopOrig();
    if (s.noScore) { // 最初からやり直すときは採点せずにマイクだけ止める
      if (!done) { done = true; stream.getTracks().forEach((t) => t.stop()); }
      return;
    }
    finish();
  };
  (function tick() {
    if (done || playing !== s) return;
    analyser.getFloatTimeDomainData(buf);
    const f = detectPitch(buf, ctx.sampleRate);
    const beat = (ctx.currentTime - s.startAt) / spb;
    if (f && f >= 65 && f <= 1300 && beat >= 0) {
      // 直近5回の中央値で1回だけの検出ミス(オクターブ跳び等)を消す
      recent.push(freqToMidiFloat(f)); if (recent.length > 5) recent.shift();
      const sorted = [...recent].sort((a, b) => a - b);
      const midiF = sorted[Math.floor(sorted.length / 2)];
      trace.push({ beat, midiF });
      $("livePitch").textContent = "いまの音: " + NOTE_NAMES[((Math.round(midiF) % 12) + 12) % 12];
    }
    if (beat < 0) $("livePitch").textContent = "あと " + Math.ceil(-beat) + " 拍でスタート";
    else if (beat >= 0 && $("status").textContent.startsWith("カウントイン")) $("status").textContent = "歌ってください！";
    drawRoll(notes, { trace }, Math.max(0, beat), beat < 0 ? String(Math.ceil(-beat)) : null);
    requestAnimationFrame(tick);
  })();
}
$("singBtn").addEventListener("click", startSing);
// 練習用: 再生中でも録音中でも、カウントインから最初に戻ってやり直す
$("restartBtn").addEventListener("click", () => {
  if (!song) return;
  if (playing) playing.noScore = true; // 歌っている途中なら採点せずに切り替える
  if (mode === "sing") startSing(); else startModel();
});
