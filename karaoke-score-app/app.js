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

// ---------- サンプル曲: きらきら星 ----------
// [midi, 拍数] の並び。C major の主旋律のみ
const TWINKLE_MELODY = [
  [60,1],[60,1],[67,1],[67,1],[69,1],[69,1],[67,2],
  [65,1],[65,1],[64,1],[64,1],[62,1],[62,1],[60,2],
  [67,1],[67,1],[65,1],[65,1],[64,1],[64,1],[62,2],
  [67,1],[67,1],[65,1],[65,1],[64,1],[64,1],[62,2],
  [60,1],[60,1],[67,1],[67,1],[69,1],[69,1],[67,2],
  [65,1],[65,1],[64,1],[64,1],[62,1],[62,1],[60,2],
];
function notesFromPairs(pairs, offset = 0) {
  let t = offset; const out = [];
  for (const [midi, dur] of pairs) { out.push({ midi, start: t, dur }); t += dur; }
  return out;
}
const TWINKLE_LYRICS = ["き","ら","き","ら","ひ","か","る","お","そ","ら","の","ほ","し","よ","ま","ば","た","き","し","て","は","み","ん","な","を","み","て","る","き","ら","き","ら","ひ","か","る","お","そ","ら","の","ほ","し","よ"];
function sampleSong() {
  const main = notesFromPairs(TWINKLE_MELODY).map((n, i) => ({ ...n, lyric: TWINKLE_LYRICS[i] || null }));
  return {
    title: "きらきら星（サンプル）", bpm: 100, beatsPerMeasure: 4,
    parts: [
      { name: "メロディー", notes: main },
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
  // 演奏順（繰り返し・D.S.・コーダ）の指定があれば読み取る: 例 "1-28:1,29:1,1-28:2,30:2,17-28:1,31-34:1"（範囲:歌詞の番）
  let order = null;
  const orderField = doc.querySelector('miscellaneous-field[name="performance-order"]');
  if (orderField && orderField.textContent.trim()) {
    order = orderField.textContent.trim().split(",").map((seg) => {
      const m = seg.trim().match(/^(\d+)(?:-(\d+))?(?::(\d+))?$/);
      return m ? { from: Number(m[1]), to: Number(m[2] || m[1]), verse: Number(m[3] || 1) } : null;
    }).filter(Boolean);
    if (!order.length) order = null;
  }
  const parts = [];
  doc.querySelectorAll("part").forEach((partEl) => {
    const notes = []; let cursor = 0, divisions = 1;
    const measureStarts = [0]; // 1小節目の開始拍=0。以降は1始まりで measureStarts[小節番号]
    partEl.querySelectorAll("measure").forEach((measure, mIdx) => {
      measureStarts[mIdx + 1] = cursor;
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
              const midi = (octave + 1) * 12 + STEP[step] + alter;
              // タイでつながった音は前の音にくっつけて1つの長い音にする
              // （多声部の曲では直前が別声部の音のことがあるので、同じ高さで
              // 　終わりが一致する直近の音を探してつなぐ）
              const tieStop = [...el.querySelectorAll("tie")].some((t) => t.getAttribute("type") === "stop");
              let prev = null;
              if (tieStop) {
                for (let i = notes.length - 1; i >= 0; i--) {
                  const cand = notes[i];
                  if (cand.midi === midi && Math.abs(cand.start + cand.dur - start) < 0.06) { prev = cand; break; }
                  if (cand.start + cand.dur < start - 0.06) break;
                }
              }
              if (prev) {
                prev.dur += dur;
                // タイの続きの音に別の音節がある場合（例: か→し）は、その音節も位置つきで残す
                // （歌詞表示で消えてしまわないように。音自体はタイとして1つにまとめる）
                const lyrics = {};
                el.querySelectorAll("lyric").forEach((ly) => { const t = ly.querySelector("text")?.textContent; if (t) lyrics[ly.getAttribute("number") || "1"] = t; });
                if (Object.keys(lyrics).length) { (prev.lyricSubs = prev.lyricSubs || []).push({ off: start - prev.start, lyrics }); }
              } else {
                const lyrics = {};
                el.querySelectorAll("lyric").forEach((ly) => { const t = ly.querySelector("text")?.textContent; if (t) lyrics[ly.getAttribute("number") || "1"] = t; });
                notes.push({ midi, start, dur, lyrics, lyric: lyrics["1"] || null, lyricSubs: [], measure: mIdx + 1 });
              }
            }
          }
          if (!isChord) { mCursor += dur; if (mCursor > maxEnd) maxEnd = mCursor; }
        }
      });
      cursor = maxEnd > mStart ? maxEnd : cursor;
    });
    measureStarts[measureStarts.length] = cursor;
    if (notes.length) parts.push({ name: names[partEl.getAttribute("id")] || partEl.getAttribute("id"), notes, measureStarts });
  });
  if (!parts.length) throw new Error("音符のあるパートが見つかりませんでした");
  // 演奏順に展開した音符列も用意する（元の並びは rawNotes として残す）
  if (order) {
    const pickVerse = (lyrics, v) => {
      if (!lyrics) return lyrics;
      const t = lyrics[String(v)] != null ? lyrics[String(v)] : (lyrics["1"] || null);
      return { "1": t, "2": t };
    };
    parts.forEach((p) => {
      p.rawNotes = p.notes;
      const byMeasure = {};
      p.notes.forEach((n) => { (byMeasure[n.measure] = byMeasure[n.measure] || []).push(n); });
      const expanded = []; let cur = 0;
      order.forEach((seg) => {
        for (let m = seg.from; m <= seg.to; m++) {
          const mStart = p.measureStarts[m] || 0;
          const mLen = (p.measureStarts[m + 1] != null ? p.measureStarts[m + 1] : mStart) - mStart;
          (byMeasure[m] || []).forEach((n) => {
            expanded.push({ ...n, start: cur + (n.start - mStart), lyrics: pickVerse(n.lyrics, seg.verse), lyricSubs: (n.lyricSubs || []).map((s) => ({ off: s.off, lyrics: pickVerse(s.lyrics, seg.verse) })) });
          });
          cur += mLen;
        }
      });
      p.orderedNotes = expanded;
      p.notes = expanded;
    });
  }
  // 演奏順の各区間が、展開後の何小節目〜何小節目にあたるか（練習範囲の選択肢に使う）
  let segRanges = null;
  if (order) {
    let perf = 1;
    segRanges = order.map((seg) => { const len = seg.to - seg.from + 1; const r = { ...seg, fromPerf: perf, toPerf: perf + len - 1 }; perf += len; return r; });
  }
  return { title, bpm, beatsPerMeasure, parts, order, segRanges };
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
function scheduleModel(notes, onEnded, endNotes) {
  const ctx = ensureCtx(); const spb = secPerBeat();
  const countIn = countInBeats();
  const startAt = ctx.currentTime + 0.15 + countIn * spb;
  // 終了タイミングの基準（ガイド音が短いパートでも、自分のパートの終わりまで続けるため）
  const lenNotes = (endNotes && endNotes.length) ? endNotes : notes;
  // 全ての音を1つのマスター音量経由にし、停止時はマスターを切断+全オシレータ停止で即時に音を止める
  // (予約済みの音は setTimeout を消すだけでは止まらないため)
  const master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
  const oscs = notes.map((n) => playTone(n.midi, startAt + n.start * spb, n.dur * spb, master, n.gain != null ? 0.18 * n.gain : 0.18));
  // メトロノーム: カウントインから曲の終わりまで全拍クリック (小節頭は高い音でアクセント)
  if ($("metronome") && $("metronome").checked) {
    const measure = song.beatsPerMeasure || 4;
    const totalBeats = Math.ceil(Math.max(...lenNotes.map((n) => n.start + n.dur)));
    for (let b = -countIn; b < totalBeats; b++) {
      const accent = ((b % measure) + measure) % measure === 0;
      oscs.push(clickTone(startAt + b * spb, accent, master));
    }
  }
  const totalSec = songLengthSec(lenNotes);
  let endTimer = null; let pausedFlag = false;
  const armEnd = (delaySec) => { endTimer = setTimeout(() => { try { master.disconnect(); } catch {} onEnded(); }, Math.max(0, delaySec) * 1000); };
  armEnd((startAt - ctx.currentTime) + totalSec + 0.3);
  let stopped = false;
  return {
    startAt, countIn,
    get paused() { return pausedFlag; },
    pause: () => {
      if (stopped || pausedFlag) return; pausedFlag = true;
      if (endTimer) clearTimeout(endTimer);
      ctx.suspend();
    },
    resume: () => {
      if (stopped || !pausedFlag) return; pausedFlag = false;
      ctx.resume();
      armEnd((startAt + totalSec) - ctx.currentTime + 0.3);
    },
    stop: () => {
      if (stopped) return; stopped = true;
      if (pausedFlag) { pausedFlag = false; ctx.resume(); }
      clearTimeout(endTimer);
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
function drawRoll(notes, sung, playheadBeat, overlayText, view) {
  const c = $("roll"), ctx = c.getContext("2d");
  const W = c.width, H = c.height; ctx.clearRect(0, 0, W, H);
  if (!notes.length) return;
  const totalBeats = Math.max(...notes.map((n) => n.start + n.dur));
  const midis = notes.map((n) => n.midi);
  const lo = Math.min(...midis) - 3, hi = Math.max(...midis) + 3;
  const PAD_L = 52, PAD_R = 10, PAD_T = 10, PAD_B = 10;
  // 再生中は4小節分だけを拡大表示して現在位置を追う (view={start,span})
  const vStart = view ? view.start : 0;
  const vSpan = view ? view.span : totalBeats;
  const x = (beat) => PAD_L + ((beat - vStart) / vSpan) * (W - PAD_L - PAD_R);
  const curIdx = (playheadBeat != null && playheadBeat >= 0) ? notes.findIndex((n) => playheadBeat >= n.start && playheadBeat < n.start + n.dur) : -1;
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
  notes.forEach((n) => drawNote(n, "#5b7fff"));
  if (sung && sung.scored) {
    sung.scored.forEach((s, i) => drawNote(notes[i], s.ok ? "rgba(34,197,94,.88)" : "rgba(239,68,68,.88)"));
  }
  // いま鳴っている音は大きく明るく描き直す
  if (curIdx >= 0) {
    const n = notes[curIdx];
    const nx = x(n.start) + 1, nw = Math.max(10, x(n.start + n.dur) - x(n.start) - 2);
    const ny = y(n.midi + 0.75), nh = y(n.midi - 0.75) - ny;
    ctx.save(); ctx.shadowColor = "#fde047"; ctx.shadowBlur = 18;
    roundRectPath(ctx, nx, ny, nw, nh, 7); ctx.fillStyle = "#facc15"; ctx.fill(); ctx.restore();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5; roundRectPath(ctx, nx, ny, nw, nh, 7); ctx.stroke();
    ctx.fillStyle = "#111"; ctx.font = "bold 15px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(NOTE_NAMES[((n.midi % 12) + 12) % 12], nx + nw / 2, ny + nh / 2 + 0.5);
    ctx.textAlign = "right"; ctx.font = "12px system-ui, sans-serif";
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
  if (playheadBeat != null && playheadBeat >= 0) {
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 3.5; ctx.beginPath(); ctx.moveTo(x(playheadBeat), PAD_T); ctx.lineTo(x(playheadBeat), H - PAD_B); ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.moveTo(x(playheadBeat) - 8, PAD_T); ctx.lineTo(x(playheadBeat) + 8, PAD_T); ctx.lineTo(x(playheadBeat), PAD_T + 12); ctx.closePath(); ctx.fill();
  }
  if (overlayText) {
    ctx.fillStyle = "rgba(0,0,0,.45)"; ctx.beginPath(); ctx.arc(W / 2, H / 2, 52, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "bold 64px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(overlayText, W / 2, H / 2 + 2);
    ctx.textAlign = "right"; ctx.font = "12px system-ui, sans-serif";
  }
}

// ---------- 採点 ----------
// 区間 [from,to] を0.1拍ごとのマスに分け、条件を満たす音声があるマスの割合を返す
function binCoverage(trace, from, to, qualify) {
  const bin = 0.1; const n = Math.max(1, Math.round((to - from) / bin));
  let hit = 0;
  for (let i = 0; i < n; i++) {
    const b0 = from + i * bin, b1 = b0 + bin;
    if (trace.some((p) => p.beat >= b0 && p.beat < b1 && qualify(p))) hit++;
  }
  return hit / n;
}
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
  const pitchTotal = Math.round(scored.reduce((s, r) => s + (r.points || 0), 0) / Math.max(1, scored.length));
  // 「のばす・きる」評価: 長い音を最後まで保てたか、休みのところでピタッと止まれたか
  const foldCents = (c) => { if ($("octaveOk").checked) { while (c > 600) c -= 1200; while (c < -600) c += 1200; } return c; };
  const isNear = (p, midi) => Math.abs(foldCents((p.midiF - midi) * 100)) <= 200;
  const gradeArt = (r) => r >= 0.75 ? 1 : r >= 0.5 ? 0.6 : r >= 0.3 ? 0.3 : 0;
  const holds = [];
  notes.forEach((n) => { if (n.dur >= 1.5) holds.push(gradeArt(binCoverage(trace, n.start + n.dur * 0.1, n.start + n.dur * 0.95, (p) => isNear(p, n.midi)))); });
  const cuts = [];
  for (let i = 0; i + 1 < notes.length; i++) {
    const end = notes[i].start + notes[i].dur, gap = notes[i + 1].start - end;
    if (gap >= 0.75) cuts.push(gradeArt(1 - binCoverage(trace, end + gap * 0.2, notes[i + 1].start - gap * 0.2, () => true)));
  }
  const avgA = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const holdScore = avgA(holds), cutScore = avgA(cuts);
  const aParts = [];
  if (holdScore != null) aParts.push({ w: 0.6, v: holdScore });
  if (cutScore != null) aParts.push({ w: 0.4, v: cutScore });
  const wSum = aParts.reduce((s, p) => s + p.w, 0);
  const bonus = aParts.length ? Math.round(10 * aParts.reduce((s, p) => s + p.w * p.v, 0) / wSum) : 0;
  const total = Math.min(100, pitchTotal + bonus);
  return { scored, total, pitchTotal, bonus, holdScore, cutScore, holdN: holds.length, cutN: cuts.length };
}

// ---------- 練習サポート（途中から・歌詞・現在位置） ----------
let practiceEnd = null; // 練習範囲の終わりの小節（その小節まで含む）。null=最後まで
function segmentNotesOf(part) {
  const all = part.notes;
  const bpp = song.beatsPerMeasure || 4;
  const sb = (Number($("startMeasure").value || 1) - 1) * bpp;
  const eb = practiceEnd ? practiceEnd * bpp : Infinity;
  if (!sb && !isFinite(eb)) return all;
  return all.filter((n) => n.start >= sb - 1e-9 && n.start < eb - 1e-9).map((n) => ({ ...n, start: n.start - sb }));
}
function segmentNotes() { return segmentNotesOf(selectedPart()); }
// ステージに応じたガイド音（採点対象は自分のパートのまま、聞こえる音だけ変える）
function guideNotesFor(target) {
  const stage = $("stageSelect") ? Number($("stageSelect").value || 1) : 1;
  if (!song || song.parts.length < 2 || stage === 1) return target;
  const selIdx = Number($("partSelect").value || 0);
  const other = song.parts[(selIdx + 1) % song.parts.length];
  const otherSeg = segmentNotesOf(other);
  if (stage === 3) return otherSeg; // 相手パートだけ
  return target.concat(otherSeg.map((n) => ({ ...n, gain: 0.5 }))); // 両パート（相手は小さめ）
}
function stageNote() {
  const stage = $("stageSelect") ? Number($("stageSelect").value || 1) : 1;
  if (!song || song.parts.length < 2) return "";
  return stage === 2 ? "（ステージ2：両パートが流れます）" : stage === 3 ? "（ステージ3：相手パートだけ流れます。自分のパートを歌ってね）" : "";
}
function pageView(beat, notes) {
  const total = Math.max(...notes.map((n) => n.start + n.dur));
  const span = (song.beatsPerMeasure || 4) * 4; // 4小節分を拡大表示
  if (total <= span) return null;
  let start = Math.floor(Math.max(0, beat) / span) * span;
  if (total - start < span) start = total - span;
  return { start, span };
}
let lyricNotes = [];
let lastCurKey = "";
function buildLyrics(notes) {
  lyricNotes = notes; lastCurKey = "";
  const v = $("verseSelect") ? $("verseSelect").value : "1";
  notes.forEach((n) => { if (n.lyrics) n.lyric = n.lyrics[v] || null; });
  const strip = $("lyricStrip");
  const items = [];
  notes.forEach((n, i) => {
    if (n.lyric) items.push({ i, sub: -1, text: n.lyric });
    (n.lyricSubs || []).forEach((s, k) => { const t = s.lyrics && s.lyrics[v]; if (t) items.push({ i, sub: k, text: t }); });
  });
  if (!items.length) { strip.innerHTML = '<span style="font-size:15px">(この楽譜には歌詞が入っていません)</span>'; $("nowInfo").textContent = ""; return; }
  strip.innerHTML = items.map(({ i, sub, text }) => `<span data-i="${i}" data-sub="${sub}">${text}</span>`).join("");
}
function updateCurrent(notes, beat) {
  const v = $("verseSelect") ? $("verseSelect").value : "1";
  const idx = beat >= 0 ? notes.findIndex((n) => beat >= n.start && beat < n.start + n.dur) : -1;
  let subPos = -1, curText = null;
  if (idx >= 0) {
    const n = notes[idx];
    (n.lyricSubs || []).forEach((s, k) => { if (s.lyrics && s.lyrics[v] && beat - n.start >= s.off - 1e-9) { subPos = k; curText = s.lyrics[v]; } });
    if (subPos < 0) curText = n.lyric;
  }
  const key = idx + ":" + subPos;
  if (key === lastCurKey) return; lastCurKey = key;
  document.querySelectorAll("#lyricStrip span[data-i]").forEach((s) => {
    const i = Number(s.dataset.i); const sk = Number(s.dataset.sub || -1);
    s.classList.toggle("on", i === idx && sk === subPos);
    s.classList.toggle("done", idx >= 0 && (i < idx || (i === idx && sk < subPos)));
  });
  const on = document.querySelector("#lyricStrip span.on");
  if (on) on.scrollIntoView({ inline: "center", block: "nearest" });
  const n = idx >= 0 ? notes[idx] : null;
  $("nowInfo").textContent = n ? "♪ " + NOTE_NAMES[((n.midi % 12) + 12) % 12] + (curText ? " ・ " + curText : "") : "";
}
// 演奏順の区間から「練習範囲」の選択肢を作る（1番だけ / 2番だけ / 2番から最後まで / D.S.から最後まで）
function buildRangeOptions() {
  const sel = $("rangeSelect"); if (!sel) return;
  sel.innerHTML = "";
  const add = (val, label) => { const o = document.createElement("option"); o.value = val; o.textContent = label; sel.appendChild(o); };
  add("all", "ぜんぶ（通し）");
  if (!song || !song.segRanges) return;
  const segs = song.segRanges;
  const total = segs[segs.length - 1].toPerf;
  const i2 = segs.findIndex((s) => s.verse === 2);
  if (i2 > 0) add("1-" + segs[i2 - 1].toPerf, "1番だけ");
  if (i2 >= 0) {
    let lastV2 = i2; segs.forEach((s, i) => { if (s.verse === 2) lastV2 = i; });
    add(segs[i2].fromPerf + "-" + segs[lastV2].toPerf, "2番だけ");
    add(segs[i2].fromPerf + "-" + total, "2番から最後まで");
    if (lastV2 < segs.length - 1) add(segs[lastV2 + 1].fromPerf + "-" + total, "D.S.から最後まで");
  }
  sel.value = "all";
}
function refreshStartMeasures() {
  if (!song) return;
  const meas = Math.max(1, Math.ceil(Math.max(...selectedPart().notes.map((n) => n.start + n.dur)) / (song.beatsPerMeasure || 4)));
  const sm = $("startMeasure"); const prev = sm.value;
  sm.innerHTML = "";
  for (let i = 1; i <= meas; i++) { const o = document.createElement("option"); o.value = i; o.textContent = i + "小節目から"; sm.appendChild(o); }
  if (Number(prev) >= 1 && Number(prev) <= meas) sm.value = prev;
}

// ---------- ゲーム要素（経験値・レベル） ----------
const SAVE_KEY = "karaoke-score-save-v1";
function loadSave() { try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || { xp: 0, best: {} }; } catch { return { xp: 0, best: {} }; } }
function storeSave(s) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch {} }
function levelOf(xp) { let lv = 1, rest = xp, need = 80; while (rest >= need) { rest -= need; lv++; need = lv * 80; } return { level: lv, into: rest, need }; }
function updateLevelInfo() {
  const s = loadSave(); const L = levelOf(s.xp);
  $("levelInfo").textContent = "⭐ レベル " + L.level + "（次のレベルまで あと " + (L.need - L.into) + " XP）";
}

// ---------- 音程合わせ練習（ウォームアップ） ----------
let wu = null; // {targets, idx, score, stream, timers, oscs, done}
function drawGauge(cents) {
  const c = $("wuGauge"), ctx = c.getContext("2d");
  const W = c.width, H = c.height; ctx.clearRect(0, 0, W, H);
  const cx = W / 2, px = (v) => cx + (v / 220) * (W / 2 - 30);
  ctx.fillStyle = "rgba(34,197,94,.30)"; ctx.fillRect(px(-50), 18, px(50) - px(-50), H - 46);
  ctx.fillStyle = "rgba(250,204,21,.30)"; ctx.fillRect(px(-100), 18, px(-50) - px(-100), H - 46); ctx.fillRect(px(50), 18, px(100) - px(50), H - 46);
  ctx.strokeStyle = "#94a3b8"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px(-200), H / 2 - 8); ctx.lineTo(px(200), H / 2 - 8); ctx.stroke();
  ctx.fillStyle = "#e5e7eb"; ctx.font = "16px system-ui, sans-serif"; ctx.textAlign = "center";
  ctx.fillText("ひくい", px(-160), H - 8); ctx.fillText("お手本", cx, H - 8); ctx.fillText("たかい", px(160), H - 8);
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx, 12); ctx.lineTo(cx, H - 34); ctx.stroke();
  if (cents != null && isFinite(cents)) {
    const v = Math.max(-210, Math.min(210, cents));
    ctx.fillStyle = Math.abs(cents) <= 50 ? "#22c55e" : Math.abs(cents) <= 100 ? "#facc15" : "#ef4444";
    ctx.beginPath(); ctx.moveTo(px(v), 26); ctx.lineTo(px(v) - 13, 6); ctx.lineTo(px(v) + 13, 6); ctx.closePath(); ctx.fill();
    ctx.fillRect(px(v) - 3, 24, 6, H - 62);
  }
}
function wuCleanup() {
  if (!wu) return;
  wu.timers.forEach((t) => clearTimeout(t));
  wu.oscs.forEach((o) => { try { o.stop(); } catch {} });
  if (wu.stream) wu.stream.getTracks().forEach((t) => t.stop());
  wu = null;
}
function cancelWarmup() { if (wu) { wuCleanup(); $("wuInfo").textContent = "やめました。また挑戦してね"; $("wuTarget").textContent = ""; $("wuResult").textContent = ""; drawGauge(null); } }
function wuTargets() {
  const notes = selectedPart() ? selectedPart().notes : [];
  // 読み取りミスの外れ値だけを外す（1回だけ・音域の端・隣の音から大きく離れた音）。
  // A♯のような本物の臨時記号の音（隣の音に近い）は出題に残す。
  const freq = {};
  notes.forEach((n) => { freq[n.midi] = (freq[n.midi] || 0) + 1; });
  let uniq = [...new Set(notes.map((n) => n.midi))].sort((a, b) => a - b);
  uniq = uniq.filter((m, i) => {
    if (freq[m] >= 2) return true;
    const near = Math.min(i > 0 ? m - uniq[i - 1] : 99, i < uniq.length - 1 ? uniq[i + 1] - m : 99);
    const atEdge = i === 0 || i === uniq.length - 1;
    return !(atEdge && near >= 4);
  });
  if (uniq.length < 5) uniq = [...new Set(notes.map((n) => n.midi))].sort((a, b) => a - b);
  if (uniq.length <= 5) return uniq.slice();
  const picks = [0, 0.25, 0.5, 0.75, 1].map((f) => uniq[Math.round(f * (uniq.length - 1))]);
  // 少しだけシャッフルして単調にならないようにする
  for (let i = picks.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [picks[i], picks[j]] = [picks[j], picks[i]]; }
  return picks;
}
async function startWarmup() {
  stopAll(); cancelWarmup();
  if (!song) { $("warmupCard").hidden = false; $("wuInfo").textContent = "先に楽譜を読み込んでね（サンプル曲でもOK）"; return; }
  $("warmupCard").hidden = false;
  $("warmupCard").scrollIntoView({ behavior: "smooth", block: "center" });
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { $("wuInfo").textContent = "マイクが使えませんでした。ブラウザのマイク許可を確認してください"; return; }
  const ctx = ensureCtx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  wu = { targets: wuTargets(), idx: 0, score: 0, ok: 0, stream, timers: [], oscs: [], analyser, buf, ctx };
  if (!wu.targets.length) { $("wuInfo").textContent = "先に楽譜を読み込んでね"; wuCleanup(); return; }
  $("wuResult").textContent = "";
  wuQuestion();
}
function wuQuestion() {
  if (!wu) return;
  const q = wu; const midi = q.targets[q.idx];
  $("wuInfo").textContent = (q.idx + 1) + "問目 / " + q.targets.length + "問 ― お手本をよく聞いてね";
  $("wuTarget").textContent = "♪ " + NOTE_NAMES[((midi % 12) + 12) % 12];
  $("wuResult").textContent = "";
  drawGauge(null);
  const ctx = q.ctx;
  const master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
  q.oscs.push(playTone(midi, ctx.currentTime + 0.15, 1.4, master));
  // 1.6秒後から2.6秒間聞き取り、後半の安定した部分で判定
  q.timers.push(setTimeout(() => {
    if (wu !== q) return;
    $("wuInfo").textContent = "いま歌って！ その高さをキープしてね";
    const samples = []; const recent = []; const t0 = ctx.currentTime;
    (function tick() {
      if (wu !== q) return;
      q.analyser.getFloatTimeDomainData(q.buf);
      const f = detectPitch(q.buf, ctx.sampleRate);
      const t = ctx.currentTime - t0;
      if (f && f >= 65 && f <= 1300) {
        recent.push(freqToMidiFloat(f)); if (recent.length > 5) recent.shift();
        const sorted = [...recent].sort((a, b) => a - b);
        const mf = sorted[Math.floor(sorted.length / 2)];
        samples.push({ t, mf });
        drawGauge((mf - midi) * 100);
      }
      if (t < 2.6) requestAnimationFrame(tick); else wuJudge(q, midi, samples);
    })();
  }, 1600));
}
function wuJudge(q, midi, samples) {
  if (wu !== q) return;
  const stable = samples.filter((s) => s.t >= 1.2).map((s) => s.mf).sort((a, b) => a - b);
  if (stable.length < 4) {
    $("wuResult").innerHTML = "声が取れなかった… 大きめの声で もう一度がんばろう（0点）";
    drawGauge(null);
  } else {
    const median = stable[Math.floor(stable.length / 2)];
    let cents = Math.round((median - midi) * 100);
    if ($("octaveOk") && $("octaveOk").checked) { while (cents > 600) cents -= 1200; while (cents < -600) cents += 1200; }
    const a = Math.abs(cents);
    const points = a <= 50 ? 100 : a <= 100 ? 70 : a <= 150 ? 40 : 0;
    q.score += points; if (a <= 100) q.ok++;
    drawGauge(cents);
    $("wuResult").innerHTML = (a <= 50 ? "◎ ぴったり！" : a <= 100 ? "○ ほぼ合っている！" : a <= 150 ? "△ あと少し！" : "× だいぶずれた…") + "　" + (cents > 0 ? "+" : "") + cents + "セント（" + points + "点）" + (a > 150 ? "" : cents > 30 ? "　少し低くしてみよう" : cents < -30 ? "　少し高くしてみよう" : "");
  }
  q.idx++;
  q.timers.push(setTimeout(() => { if (wu === q) { if (q.idx < q.targets.length) wuQuestion(); else wuFinish(q); } }, 2100));
}
function wuFinish(q) {
  const total = q.score; const xp = Math.round(total / 5);
  const save = loadSave(); const beforeLv = levelOf(save.xp).level;
  save.xp += xp; storeSave(save); const L = levelOf(save.xp);
  $("wuInfo").textContent = "おつかれさま！ ウォームアップ完了";
  $("wuTarget").textContent = total + "点";
  $("wuResult").innerHTML = "合っていたのは " + q.ok + " / " + q.targets.length + " 問　+" + xp + " XPゲット！" + (L.level > beforeLv ? "<br>🎉 レベルアップ！ レベル " + L.level + " になったよ！" : "") + "<br>この調子で歌の練習をはじめよう！";
  updateLevelInfo();
  wuCleanup();
}
$("warmupBtn").addEventListener("click", () => { $("wuInfo").textContent = "「スタート」を押してね。お手本の音が出て、そのあと歌う時間になるよ"; $("warmupCard").hidden = false; $("warmupCard").scrollIntoView({ behavior: "smooth", block: "center" }); drawGauge(null); });
$("wuStart").addEventListener("click", startWarmup);
$("wuQuit").addEventListener("click", cancelWarmup);

// ---------- 画面の動作 ----------
function setSong(s) {
  song = s;
  $("songTitle").textContent = "曲: " + s.title + "（" + s.parts.length + "パート）";
  const sel = $("partSelect"); sel.innerHTML = "";
  s.parts.forEach((p, i) => { const o = document.createElement("option"); o.value = i; o.textContent = p.name + "（" + p.notes.length + "音）"; sel.appendChild(o); });
  sel.disabled = false; $("playModel").disabled = false; $("singBtn").disabled = false; $("restartBtn").disabled = false; $("warmupBtn").disabled = false;
  const ow = $("orderWrap");
  if (ow) { ow.hidden = !s.order; if (s.order) $("orderMode").checked = true; }
  practiceEnd = null; buildRangeOptions();
  const rw = $("rangeWrap"); if (rw) rw.hidden = !s.order;
  $("status").textContent = "パートを選んで「お手本を聞く」か「歌ってバトル！」を押してください" + (s.order ? "（演奏順モード：繰り返し・コーダまで通して再生します）" : "");
  $("resultCard").hidden = true;
  stopReviewLoop(); if (lastReview && lastReview.url) URL.revokeObjectURL(lastReview.url); lastReview = null;
  const rb = $("reviewBox"); if (rb) rb.hidden = true; const ra = $("reviewAudio"); if (ra) { ra.pause(); ra.removeAttribute("src"); }
  refreshStartMeasures(); buildLyrics(selectedPart().notes); updateLevelInfo(); updateForgetBtn();
  const ss = $("stageSelect"); if (ss) ss.disabled = s.parts.length < 2;
  drawRoll(selectedPart().notes, null, null);
}
$("partSelect").addEventListener("change", () => { if (song) { practiceEnd = null; if ($("rangeSelect")) $("rangeSelect").value = "all"; $("startMeasure").value = "1"; refreshStartMeasures(); buildLyrics(selectedPart().notes); drawRoll(selectedPart().notes, null, null); } });
$("rangeSelect").addEventListener("change", () => {
  if (!song) return;
  stopAll();
  const val = $("rangeSelect").value;
  if (val === "all") { practiceEnd = null; $("startMeasure").value = "1"; }
  else { const ab = val.split("-").map(Number); $("startMeasure").value = String(ab[0]); practiceEnd = ab[1]; }
  const notes = segmentNotes(); buildLyrics(notes); drawRoll(notes, null, null);
  const label = $("rangeSelect").selectedOptions[0].textContent;
  $("status").textContent = "練習範囲: " + label + (practiceEnd ? "（演奏順の " + $("startMeasure").value + "〜" + practiceEnd + " 小節目）" : "（最初から最後まで）") + "。お手本を聞くか、歌ってバトル！を押してね";
});
$("startMeasure").addEventListener("change", () => {
  // 「練習のはじめ」を手で変えたら、範囲指定は外して『その小節から最後まで』にする
  practiceEnd = null; const rs = $("rangeSelect"); if (rs) rs.value = "all";
});
$("verseSelect").addEventListener("change", () => { if (lyricNotes.length) buildLyrics(lyricNotes); });
$("orderMode").addEventListener("change", () => {
  if (!song || !song.order) return;
  stopAll();
  const on = $("orderMode").checked;
  song.parts.forEach((p) => { p.notes = on ? p.orderedNotes : p.rawNotes; });
  practiceEnd = null; if ($("rangeSelect")) $("rangeSelect").value = "all";
  const rw = $("rangeWrap"); if (rw) rw.hidden = !on;
  $("startMeasure").value = "1";
  refreshStartMeasures(); buildLyrics(selectedPart().notes); drawRoll(selectedPart().notes, null, null);
  $("status").textContent = on ? "演奏順で再生します（繰り返し・コーダあり）" : "楽譜の並びどおり（繰り返しなし）で再生します";
});
$("tempo").addEventListener("input", () => { $("tempoVal").textContent = $("tempo").value; });
$("loadSample").addEventListener("click", () => setSong(sampleSong()));
// 読み込んだ曲はこの端末のブラウザ内にだけ保存し、次に開いたとき自動で復元する（外部送信はしない）
const LAST_SONG_KEY = "karaoke-score-last-song-v1";
function rememberSong(text) {
  try { localStorage.setItem(LAST_SONG_KEY, text); } catch {}
  updateForgetBtn();
}
function updateForgetBtn() {
  const b = $("forgetSong"); if (!b) return;
  let has = false; try { has = !!localStorage.getItem(LAST_SONG_KEY); } catch {}
  b.hidden = !has;
}
$("forgetSong").addEventListener("click", () => {
  try { localStorage.removeItem(LAST_SONG_KEY); } catch {}
  updateForgetBtn();
  $("status").textContent = "この端末に保存した曲を消しました（今ひらいている曲はそのまま使えます）";
});
$("fileInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { const text = await f.text(); setSong(parseMusicXML(text)); rememberSong(text); }
  catch (err) { $("status").textContent = "読み込み失敗: " + err.message + "（.mxl 圧縮形式は未対応です。.musicxml で書き出してください）"; }
});
$("pasteLoad").addEventListener("click", () => {
  let text = $("pasteArea").value.trim();
  const i = text.indexOf("<");
  if (i > 0) text = text.slice(i); // 先頭に余分な文字（ブラウザの表示注記など）が混ざっても読み込めるように
  if (!text) { $("pasteStatus").textContent = "まず楽譜の中身を貼り付けてください"; return; }
  try { setSong(parseMusicXML(text)); rememberSong(text); $("pasteStatus").textContent = "読み込みました"; $("pasteArea").value = ""; }
  catch (err) { $("pasteStatus").textContent = "読み込み失敗: " + err.message; }
});
async function loadFromDrive(idOrUrl) {
  const m = String(idOrUrl).match(/[-\w]{25,}/);
  if (!m) throw new Error("リンクからファイルIDが取れませんでした");
  const res = await fetch("https://drive.google.com/uc?export=download&id=" + m[0]);
  if (!res.ok) throw new Error("ドライブから取得できませんでした (HTTP " + res.status + ")");
  const text = await res.text();
  if (!text.includes("<score-partwise")) throw new Error("楽譜データが返ってきませんでした。共有設定が「リンクを知っている全員が閲覧可」になっているか確認してください");
  setSong(parseMusicXML(text)); rememberSong(text);
}
$("driveLoad").addEventListener("click", async () => {
  const v = $("driveUrl").value.trim();
  if (!v) { $("driveStatus").textContent = "まず共有リンクを貼ってください"; return; }
  $("driveStatus").textContent = "読み込み中…";
  try { await loadFromDrive(v); $("driveStatus").textContent = "読み込みました"; }
  catch (err) { $("driveStatus").textContent = "読み込み失敗: " + err.message; }
});
const songParam = new URLSearchParams(location.search).get("song");
if (songParam) loadFromDrive(songParam).catch(() => {});
function resetPauseBtn() { const b = $("pauseBtn"); if (b) { b.disabled = true; b.textContent = "⏸ 一時停止"; } }
function stopAll() { if (playing) { playing.stop(); playing = null; } $("stopBtn").disabled = true; resetPauseBtn(); if (typeof cancelWarmup === "function") cancelWarmup(); stopReviewLoop(); const ra = $("reviewAudio"); if (ra) ra.pause(); }
$("pauseBtn").addEventListener("click", () => {
  if (!playing || typeof playing.pause !== "function") return;
  if (playing.paused) { playing.resume(); if (playing.onResume) playing.onResume(); $("pauseBtn").textContent = "⏸ 一時停止"; $("status").textContent = "再開しました"; }
  else { playing.pause(); if (playing.onPause) playing.onPause(); $("pauseBtn").textContent = "▶ 再開"; $("status").textContent = "一時停止中（再開ボタンで続きから）"; }
});

// ---------- 歌声の聞き直し（録音は端末内のみ・送信しない） ----------
let lastReview = null; // {url, notes, scored, trace, spb, offset}
let reviewAnim = null;
function stopReviewLoop() { if (reviewAnim) cancelAnimationFrame(reviewAnim); reviewAnim = null; const b = $("reviewStop"); if (b) b.disabled = true; }
function playReview(fromBeat) {
  if (!lastReview) return;
  const audio = $("reviewAudio"); if (!audio) return;
  stopReviewLoop();
  if (fromBeat != null) audio.currentTime = Math.max(0, lastReview.offset + fromBeat * lastReview.spb);
  audio.play().catch(() => {});
  $("reviewStop").disabled = false;
  const notes = lastReview.notes;
  (function loop() {
    if (audio.paused || audio.ended) { stopReviewLoop(); return; }
    const beat = (audio.currentTime - lastReview.offset) / lastReview.spb;
    updateCurrent(notes, beat);
    drawRoll(notes, { trace: lastReview.trace, scored: lastReview.scored }, Math.max(0, beat), null, pageView(beat, notes));
    reviewAnim = requestAnimationFrame(loop);
  })();
}
$("reviewPlay").addEventListener("click", () => playReview(null));
$("reviewStop").addEventListener("click", () => { const a = $("reviewAudio"); if (a) a.pause(); stopReviewLoop(); });
$("stopBtn").addEventListener("click", () => { stopAll(); $("status").textContent = "止めました"; });
function startModel() {
  stopAll(); mode = "model"; const notes = segmentNotes(); buildLyrics(notes);
  const s = scheduleModel(guideNotesFor(notes), () => { $("status").textContent = "再生が終わりました"; $("stopBtn").disabled = true; resetPauseBtn(); }, notes);
  playing = s; $("stopBtn").disabled = false; { const pb = $("pauseBtn"); pb.disabled = false; pb.textContent = "⏸ 一時停止"; }
  $("status").textContent = (s.countIn ? "カウントイン… 数字が0になったら始まります" : "お手本を再生中…") + stageNote();
  const spb = secPerBeat(); const ctx = ensureCtx();
  (function tick() {
    if (playing !== s) return;
    const beat = (ctx.currentTime - s.startAt) / spb;
    if (beat >= 0 && $("status").textContent.startsWith("カウントイン")) $("status").textContent = "お手本を再生中…";
    updateCurrent(notes, beat);
    drawRoll(notes, null, Math.max(0, beat), beat < 0 ? String(Math.ceil(-beat)) : null, pageView(beat, notes));
    if (beat <= Math.max(...notes.map((n) => n.start + n.dur))) requestAnimationFrame(tick);
  })();
}
$("playModel").addEventListener("click", startModel);
async function startSing() {
  stopAll(); mode = "sing"; const notes = segmentNotes(); buildLyrics(notes);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { $("status").textContent = "マイクが使えませんでした。ブラウザのマイク許可を確認してください"; return; }
  const ctx = ensureCtx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const s = scheduleModel(guideNotesFor(notes), finish, notes);
  $("status").textContent = (s.countIn ? "カウントイン… 大きな数字が0になったら歌い始めてください" : "お手本に合わせて歌ってください") + stageNote();
  playing = s; $("stopBtn").disabled = false; { const pb = $("pauseBtn"); pb.disabled = false; pb.textContent = "⏸ 一時停止"; }
  const trace = []; const spb = secPerBeat(); let done = false; const recent = [];
  // 聞き直し用に歌声を録音する（端末内のみ。外部送信はしない）
  let recorder = null; const recChunks = []; const recT0 = ctx.currentTime; let recDiscard = false;
  const recOffset = s.startAt - recT0; // 録音の何秒目が曲の0拍目か
  if (window.MediaRecorder) {
    const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"].find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
      recorder.start(250);
    } catch { recorder = null; }
  }
  s.onPause = () => { try { if (recorder && recorder.state === "recording") recorder.pause(); } catch {} };
  s.onResume = () => { try { if (recorder && recorder.state === "paused") recorder.resume(); } catch {} };
  function finalizeRecording(keep, scored) {
    if (!recorder) return;
    const rec = recorder; recorder = null;
    rec.onstop = () => {
      if (!keep || recDiscard || !recChunks.length) return;
      const blob = new Blob(recChunks, { type: rec.mimeType || "audio/webm" });
      if (lastReview && lastReview.url) URL.revokeObjectURL(lastReview.url);
      const url = URL.createObjectURL(blob);
      lastReview = { url, notes, scored, trace, spb, offset: recOffset };
      const audio = $("reviewAudio"); if (audio) audio.src = url;
      $("reviewBox").hidden = false;
    };
    try { rec.stop(); } catch {}
  }
  function finish() {
    if (done) return; done = true;
    stream.getTracks().forEach((t) => t.stop()); $("stopBtn").disabled = true; resetPauseBtn();
    const result = scorePerformance(notes, trace);
    finalizeRecording(true, result.scored);
    drawRoll(notes, { trace, scored: result.scored }, null);
    $("scoreNum").textContent = result.total;
    const ul = $("noteResults"); ul.innerHTML = "";
    result.scored.forEach((r, i) => {
      const li = document.createElement("li");
      const n = notes[i];
      li.textContent = (i + 1) + "音目 " + NOTE_NAMES[((n.midi % 12) + 12) % 12] + ": " + r.label + (r.cents == null ? "" : "（" + (r.cents > 0 ? "+" : "") + r.cents + "セント）");
      if (!r.ok) { // ずれた音はタップでその場所から聞き直せる
        li.className = "miss"; li.title = "タップすると、その音の場所から聞き直せます";
        li.addEventListener("click", () => { if (lastReview) { playReview(n.start); $("reviewBox").scrollIntoView({ behavior: "smooth", block: "nearest" }); } });
      }
      ul.appendChild(li);
    });
    $("resultCard").hidden = false;
    // ゲーム要素: 達成率・スター・最大コンボ・経験値とレベルアップ
    const okCount = result.scored.filter((r) => r.ok).length;
    const achieve = Math.round((okCount / Math.max(1, notes.length)) * 100);
    let combo = 0, maxCombo = 0; result.scored.forEach((r) => { combo = r.ok ? combo + 1 : 0; if (combo > maxCombo) maxCombo = combo; });
    const stars = result.total >= 90 ? 3 : result.total >= 70 ? 2 : result.total >= 50 ? 1 : 0;
    const save = loadSave(); const beforeLv = levelOf(save.xp).level;
    save.xp += result.total;
    const bestKey = song.title + "|" + selectedPart().name + "|" + $("startMeasure").value;
    const prevBest = save.best[bestKey] || 0; const isBest = result.total > prevBest;
    if (isBest) save.best[bestKey] = result.total;
    storeSave(save); const L = levelOf(save.xp);
    const praise = result.total >= 90 ? "すごい！完璧にちかいよ！" : result.total >= 70 ? "とても上手！" : result.total >= 50 ? "よくがんばった！" : "れんしゅうあるのみ！次はもっとできるよ";
    // ランク分けと、良かったところ・レベルアップへのコメント
    const rank = result.total >= 90 ? "Sランク：カラオケ★マスター" : result.total >= 75 ? "Aランク：うたの達人" : result.total >= 60 ? "Bランク：うたうまさん" : result.total >= 40 ? "Cランク：がんばりやさん" : "Dランク：れんしゅう中";
    const good = [], tips = [];
    const perfectN = result.scored.filter((r) => r.points === 100).length;
    const missedN = result.scored.filter((r) => r.cents == null).length;
    if (perfectN >= Math.max(3, notes.length / 3)) good.push("音程ぴったり（◎）が " + perfectN + " 個もあったよ");
    if (maxCombo >= 8) good.push(maxCombo + " コンボ続いたのがすごい");
    if (result.holdScore != null && result.holdScore >= 0.8) good.push("長く伸ばす音を、最後までしっかり保てていたよ");
    if (result.cutScore != null && result.cutScore >= 0.8) good.push("休むところでピタッと止められていたよ");
    if (notes.length >= 8) {
      const half = Math.floor(result.scored.length / 2);
      const avgPts = (arr) => arr.length ? arr.reduce((s, r) => s + (r.points || 0), 0) / arr.length : 0;
      if (avgPts(result.scored.slice(half)) - avgPts(result.scored.slice(0, half)) >= 12) good.push("後半にかけてどんどん上手くなったよ");
    }
    let worstI = -1, worstA = 100;
    result.scored.forEach((r, i) => { if (r.cents != null && Math.abs(r.cents) > worstA) { worstA = Math.abs(r.cents); worstI = i; } });
    if (worstI >= 0) tips.push((worstI + 1) + "音目（♪" + NOTE_NAMES[((notes[worstI].midi % 12) + 12) % 12] + "）が一番ずれていたよ（" + (result.scored[worstI].cents > 0 ? "高すぎ" : "低すぎ") + "）。そこを何回か練習しよう");
    if (missedN > 0) tips.push("声が取れなかった音が " + missedN + " 個あったよ。もう少し大きな声で歌ってみよう");
    if (result.holdScore != null && result.holdScore < 0.5) tips.push("長く伸ばす音が途中で切れがち。息をたっぷり吸って、音符の最後まで伸ばそう");
    if (result.cutScore != null && result.cutScore < 0.5) tips.push("休むところで声が残りがち。切れ目でピタッと止めるのを意識しよう");
    if (!good.length) good.push("最後まで歌い切ったのがえらい");
    if (!tips.length) tips.push("この調子！ もっと難しいステージや速いテンポにも挑戦してみよう");
    const artLine = (result.holdN || result.cutN)
      ? "<br>音程 " + result.pitchTotal + "点 ＋ のばす・きるボーナス +" + result.bonus + "点" +
        (result.holdScore != null ? "（のばす: " + (result.holdScore >= 0.8 ? "◎" : result.holdScore >= 0.5 ? "○" : result.holdScore >= 0.3 ? "△" : "×") : "") +
        (result.holdScore != null && result.cutScore != null ? " ／ " : "") +
        (result.cutScore != null ? "きる: " + (result.cutScore >= 0.8 ? "◎" : result.cutScore >= 0.5 ? "○" : result.cutScore >= 0.3 ? "△" : "×") + "）" : (result.holdScore != null ? "）" : ""))
      : "";
    $("gameResult").innerHTML = "🏆 " + rank + "<br>" + praise + "<br>" + "★".repeat(stars) + "☆".repeat(3 - stars) + "　達成率 " + achieve + "% ・ 最大コンボ " + maxCombo + " ・ +" + result.total + " XPゲット！" + artLine +
      "<br>👏 よかったところ: " + good.slice(0, 2).join("／") +
      "<br>🎯 レベルアップには: " + tips.slice(0, 2).join("／") +
      (L.level > beforeLv ? "<br>🎉 レベルアップ！ レベル " + L.level + " になったよ！" : "") + (isBest && prevBest > 0 ? "<br>🏆 自己ベスト更新！（前: " + prevBest + "点）" : "");
    $("xpBar").style.width = Math.round((L.into / L.need) * 100) + "%";
    $("xpInfo").textContent = "レベル " + L.level + " ・ 経験値 " + save.xp + " XP（次のレベルまで あと " + (L.need - L.into) + " XP）";
    updateLevelInfo();
    $("status").textContent = "採点が終わりました";
    playing = null;
  }
  s.stopOrig = s.stop;
  s.stop = () => {
    s.stopOrig();
    if (s.noScore) { // 最初からやり直すときは採点せずにマイクだけ止める
      if (!done) { done = true; recDiscard = true; finalizeRecording(false); stream.getTracks().forEach((t) => t.stop()); }
      return;
    }
    finish();
  };
  (function tick() {
    if (done || playing !== s) return;
    if (ctx.state === "suspended") { requestAnimationFrame(tick); return; } // 一時停止中は採点データを集めない
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
    updateCurrent(notes, beat);
    drawRoll(notes, { trace }, Math.max(0, beat), beat < 0 ? String(Math.ceil(-beat)) : null, pageView(beat, notes));
    requestAnimationFrame(tick);
  })();
}
$("singBtn").addEventListener("click", startSing);
// 音程バーの高さを画面の高さに合わせて調整（バーと歌詞が1画面に収まるように）
function fitRoll() {
  const c = $("roll"); if (!c) return;
  const h = Math.round(Math.min(230, Math.max(140, window.innerHeight * 0.30)));
  if (c.height !== h) { c.height = h; if (song) drawRoll(selectedPart().notes, null, null); }
}
window.addEventListener("resize", fitRoll);
fitRoll();
// 練習用: 再生中でも録音中でも、カウントインから最初に戻ってやり直す
$("restartBtn").addEventListener("click", () => {
  if (!song) return;
  if (playing) playing.noScore = true; // 歌っている途中なら採点せずに切り替える
  if (mode === "sing") startSing(); else startModel();
});
updateLevelInfo();
// 前回読み込んだ曲がこの端末に保存されていれば復元する（?song= 指定があるときは、そちらを優先）
if (!songParam) {
  try {
    const savedText = localStorage.getItem(LAST_SONG_KEY);
    if (savedText) {
      setSong(parseMusicXML(savedText));
      $("status").textContent = "前回読み込んだ曲を自動で復元しました（別の曲を読み込むと入れ替わります）";
    }
  } catch { try { localStorage.removeItem(LAST_SONG_KEY); } catch {} }
}
updateForgetBtn();
