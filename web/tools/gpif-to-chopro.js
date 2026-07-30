#!/usr/bin/env node
// GPIF (Guitar Pro Interchange Format) → ChordPro converter
// Parses Content/score.gpif from GP7 ZIP files downloaded from Ultimate Guitar.
// Extracts chord names from <Chord> definitions, lyrics from <Lyrics><Line><Text>,
// and beat-level chord mapping from the @$Chords$@ track.
//
// Usage:
//   node gpif-to-chopro.js <path-to-score.gpif>
//   node gpif-to-chopro.js <path-to-song.gp>    (auto-unzips if ZIP)

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ── Chord name from GPIF <Chord> element text ──
function chordNameFromXml(chordXml) {
  const keyStep = (chordXml.match(/<KeyNote[^>]*\sstep="([^"]+)"/) || [])[1] || "";
  const keyAcc = (chordXml.match(/<KeyNote[^>]*\saccidental="([^"]+)"/) || [])[1] || "";
  const bassStep = (chordXml.match(/<BassNote[^>]*\sstep="([^"]+)"/) || [])[1] || "";
  const bassAcc = (chordXml.match(/<BassNote[^>]*\saccidental="([^"]+)"/) || [])[1] || "";
  const degrees = [...chordXml.matchAll(/<Degree\s+interval="([^"]+)"\s+alteration="([^"]+)"/gm)];

  const accMap = { Natural: "", Sharp: "#", Flat: "b", DoubleSharp: "##", DoubleFlat: "bb" };
  const root = keyStep + (accMap[keyAcc] || "");
  const bass = bassStep + (accMap[bassAcc] || "");

  let suffix = "";
  for (const d of degrees) {
    const interval = d[1];
    const alt = d[2];
    if (interval === "Fifth" && alt === "Diminished") suffix = suffix.replace(/m?$/, "dim");
    else if (interval === "Fifth" && alt === "Augmented") suffix += "aug";
    else if (interval === "Seventh" && alt === "Minor") suffix += "7";
    else if (interval === "Third" && alt === "Minor") suffix = "m" + suffix;
    else if (interval === "Third" && alt === "Major") { /* default */ }
    else if (interval === "Ninth" && alt === "Major") suffix += "9";
    else if (interval === "Eleventh" && alt === "Perfect") suffix += "11";
    else if (interval === "Thirteenth" && alt === "Major") suffix += "13";
    else if (interval === "Second" && alt !== "Perfect") suffix += "sus2";
    else if (interval === "Fourth" && alt !== "Perfect") suffix += "sus4";
    else if (interval === "Sixth" && alt === "Major") suffix += "6";
    else if (interval === "Sixth" && alt === "Minor") suffix += "m6";
  }

  const name = root + suffix;
  if (bass && bass !== root) return name + "/" + bass;
  return name;
}

// ── Parse chord definitions from GPIF ──
function parseChords(gpifXml) {
  const chords = [];
  const chordBlocks = gpifXml.match(/<Chord>(.+?)<\/Chord>/gs) || [];
  for (const block of chordBlocks) {
    if (block.includes("<![CDATA[") || block.includes("0</Chord>")) continue;
    if (block.length < 50) continue;
    const name = chordNameFromXml(block);
    chords.push(name);
  }
  return chords;
}

// ── Extract lyrics from GPIF ──
// Lyrics are stored per-bar in <Lyrics><Line><Text> elements.
// Most implementations put all lyric text in the first non-empty element.
function parseLyrics(gpifXml) {
  const texts = [...gpifXml.matchAll(/<Text><!\[CDATA\[([^\]]*)\]\]><\/Text>/g)];
  const lines = [];
  for (const t of texts) {
    const content = t[1];
    if (content.trim()) {
      // Split on newlines, trim each line, but KEEP blank lines as separators
      const split = content.split("\n").map(s => s.trim());
      lines.push(...split);
    }
  }
  return lines;
}

// ── Find the @$Chords$@ track and extract chord ID sequence ──
function parseChordTrack(gpifXml) {
  const trackMatch = gpifXml.match(/<Name><!\[CDATA\[@\$Chords\$@\]\]><\/Name>([\s\S]*?)(?=<\/Track>)/);
  if (!trackMatch) return [];
  const chordIds = [];
  const barBlocks = [...trackMatch[1].matchAll(/<Bar[^>]*>([\s\S]*?)<\/Bar>/g)];
  for (const barBlock of barBlocks) {
    const idMatch = barBlock[1].match(/<Chord>(\d+)<\/Chord>/);
    if (idMatch) chordIds.push(parseInt(idMatch[1]));
  }
  return chordIds;
}

// ── Extract MasterBar key signatures ──
function parseKey(gpifXml) {
  const masterBarMatch = gpifXml.match(/<MasterBar>([\s\S]*?)<\/MasterBar>/);
  if (!masterBarMatch) return "C";
  const accidentalCount = (masterBarMatch[1].match(/<AccidentalCount>(-?\d+)<\/AccidentalCount>/) || [])[1];
  const mode = (masterBarMatch[1].match(/<Mode>(\w+)<\/Mode>/) || [])[1];
  const majorKeys = { "-7": "Cb", "-6": "Gb", "-5": "Db", "-4": "Ab", "-3": "Eb", "-2": "Bb", "-1": "F", "0": "C", "1": "G", "2": "D", "3": "A", "4": "E", "5": "B", "6": "F#", "7": "C#" };
  const minorKeys = { "-7": "Ab", "-6": "Eb", "-5": "Bb", "-4": "F", "-3": "C", "-2": "G", "-1": "D", "0": "A", "1": "E", "2": "B", "3": "F#", "4": "C#", "5": "G#", "6": "D#", "7": "A#" };
  if (mode === "Minor") return minorKeys[accidentalCount] || "Am";
  return majorKeys[accidentalCount] || "C";
}

// ── Extract BPM from tempo automation ──
function parseBpm(gpifXml) {
  const tempoMatch = gpifXml.match(/<Automation[^>]*>\s*<Type>Tempo<\/Type>[\s\S]*?<Value>(\d+)/);
  if (tempoMatch) return parseInt(tempoMatch[1]);
  return 120;
}

// ── BCFZ/GPX decompressor for Guitar Pro 6 format ──
// Based on guitarpro-parser library's decodeGpxBinary (MIT license).

class BinaryReader {
  constructor(buffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.pos = 0;
    this.bitOffset = 0;
    this.byteLength = buffer.byteLength;
  }
  getUint32LE(offset) {
    this.bitOffset = 0;
    if (offset !== void 0) return this.view.getUint32(offset, true);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  getString(length) {
    this.bitOffset = 0;
    const chars = [];
    for (let i = 0; i < length; i++) chars.push(this.view.getUint8(this.pos + i));
    this.pos += length;
    return String.fromCharCode(...chars);
  }
  getZeroTerminatedString(offset, maxLength) {
    const chars = [];
    for (let i = 0; i < maxLength; i++) {
      const code = this.view.getUint8(offset + i) & 255;
      if (code === 0) break;
      chars.push(code);
    }
    return String.fromCharCode(...chars);
  }
  getBytes(length, offset) {
    this.bitOffset = 0;
    const start = offset !== void 0 ? offset : this.pos;
    if (offset === void 0) this.pos += length;
    return new Uint8Array(this.view.buffer, start, length);
  }
  getUnsigned(bitLength) {
    const startBit = (this.pos << 3) + this.bitOffset;
    const endBit = startBit + bitLength;
    const startByte = startBit >>> 3;
    const endByte = (endBit + 7) >>> 3;
    this.bitOffset = endBit & 7;
    this.pos = endBit >>> 3;
    let wideValue = 0;
    for (let i = startByte; i < endByte; i++) wideValue = (wideValue << 8) | (this.bytes[i] ?? 0);
    const trailingBits = (endByte << 3) - endBit;
    wideValue = wideValue >>> trailingBits;
    if (bitLength < 32) wideValue = wideValue & (1 << bitLength) - 1;
    return wideValue;
  }
}

function readBitsReversed(reader, count) {
  let bits = 0;
  for (let i = 0; i < count; i++) bits |= reader.getUnsigned(1) << i;
  return bits;
}

function isFileToStore(name) {
  return name === "score.gpif" || name === "misc.xml";
}

function decompressBlock(reader, skipHeader) {
  const expectedLength = reader.getUint32LE();
  const temp = new Uint8Array(expectedLength);
  let pos = 0;
  try {
    while (pos < expectedLength) {
      const flag = reader.getUnsigned(1);
      if (flag === 1) {
        const wordSize = reader.getUnsigned(4);
        const offset = readBitsReversed(reader, wordSize);
        const size = readBitsReversed(reader, wordSize);
        const sourcePosition = pos - offset;
        const readSize = Math.min(offset, size);
        for (let i = 0; i < readSize; i++) temp[pos + i] = temp[sourcePosition + i];
        pos += readSize;
      } else {
        const size = reader.getUnsigned(2);
        for (let i = 0; i < size; i++) temp[pos++] = reader.getUnsigned(8);
      }
    }
  } catch {}
  if (skipHeader) return temp.buffer.slice(4, temp.byteLength);
  return temp.buffer;
}

function parseBlockFilesystem(buffer) {
  const SECTOR_SIZE = 4096;
  const reader = new BinaryReader(buffer);
  let offset = SECTOR_SIZE;
  const files = [];
  while (offset + SECTOR_SIZE + 3 < reader.byteLength) {
    const entryType = reader.getUint32LE(offset);
    if (entryType === 2) {
      const name = reader.getZeroTerminatedString(offset + 4, 127);
      const size = reader.getUint32LE(offset + 140);
      const file = { name, size, data: null };
      files.push(file);
      const store = isFileToStore(name);
      const blocksOffset = offset + 148;
      const dataChunks = [];
      let blockCount = 0;
      let blockId;
      while ((blockId = reader.getUint32LE(blocksOffset + 4 * blockCount)) !== 0) {
        const blockOffset = blockId * SECTOR_SIZE;
        if (store) {
          const max = blockOffset + SECTOR_SIZE;
          const blockSize = max > reader.byteLength ? SECTOR_SIZE - (max - reader.byteLength) : SECTOR_SIZE;
          dataChunks.push(reader.getBytes(blockSize, blockOffset));
        }
        blockCount++;
      }
      if (store && dataChunks.length > 0) {
        const totalSize = dataChunks.reduce((s, c) => s + c.length, 0);
        const combined = new Uint8Array(Math.max(size, totalSize));
        let writePos = 0;
        for (const chunk of dataChunks) {
          combined.set(chunk, writePos);
          writePos += chunk.length;
        }
        file.data = combined.subarray(0, Math.min(size, totalSize));
      }
    }
    offset += SECTOR_SIZE;
  }
  return files;
}

function decodeGpxBinary(data) {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  const reader = new BinaryReader(buf);
  const header = reader.getString(4);
  let filesystemBuffer;
  switch (header) {
    case "BCFZ":
      filesystemBuffer = decompressBlock(reader, true);
      break;
    case "BCFS":
      {
        const raw = reader.getBytes(reader.byteLength - 4);
        const copy = new ArrayBuffer(raw.byteLength);
        new Uint8Array(copy).set(raw);
        filesystemBuffer = copy;
      }
      break;
    default:
      throw new Error(`Bad GPX header: "${header}" (unsupported format)`);
  }
  const files = parseBlockFilesystem(filesystemBuffer);
  const result = new Map();
  for (const file of files) {
    if (file.data && isFileToStore(file.name)) {
      const decoder = new TextDecoder("utf-8");
      result.set(file.name, decoder.decode(file.data));
    }
  }
  return result;
}

// ── Load GPIF XML from file, ZIP, or BCFZ/GPX ──
function loadGpif(inputPath) {
  const raw = fs.readFileSync(inputPath);
  // Check for BCFZ/BCFS header (GPX/GP6 format)
  if (raw.length >= 4) {
    const header = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
    if (header === "BCFZ" || header === "BCFS") {
      const files = decodeGpxBinary(raw);
      const gpifXml = files.get("score.gpif");
      if (gpifXml) return gpifXml;
      throw new Error("No score.gpif found in GPX archive");
    }
  }
  if (inputPath.endsWith(".gp") || inputPath.endsWith(".gp3") || inputPath.endsWith(".gp4") || inputPath.endsWith(".gp5") || inputPath.endsWith(".gpx")) {
    try {
      const xml = execSync(`unzip -p "${inputPath}" Content/score.gpif 2>/dev/null`, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      return xml;
    } catch (e) {
      throw new Error("Failed to extract score.gpif from ZIP: " + e.message);
    }
  }
  return raw.toString("utf-8");
}

// ── Generate ChordPro content from GPIF ──
function gpifToChopro(gpifXml) {
  const title = (gpifXml.match(/<Title><!\[CDATA\[([^\]]*)\]\]><\/Title>/) || [])[1] || "Untitled";
  const artist = (gpifXml.match(/<Artist><!\[CDATA\[([^\]]*)\]\]><\/Artist>/) || [])[1] || "";
  const key = parseKey(gpifXml);
  const bpm = parseBpm(gpifXml);
  const chords = parseChords(gpifXml);
  const lyrics = parseLyrics(gpifXml);
  const chordIds = parseChordTrack(gpifXml);
  const uniqueChords = [...new Set(chords)];

  // Map chord IDs to lyric lines — each chord ID corresponds to one bar.
  // Compute which chord goes with each lyric line by averaging bar→line mapping.
  const chordForLine = [];
  const barForLine = [];  // bar number for each lyric line (for @time=N output)
  if (chordIds.length > 0 && chords.length > 0 && lyrics.length > 0) {
    const barsPerLine = Math.max(1, chordIds.length / lyrics.length);
    for (let li = 0; li < lyrics.length; li++) {
      const barIdx = Math.min(Math.floor(li * barsPerLine + barsPerLine / 2), chordIds.length - 1);
      const cid = chordIds[barIdx];
      const cn = cid > 0 && cid <= chords.length ? chords[cid - 1] : "";
      chordForLine.push(cn);
      barForLine.push(barIdx + 1); // bar numbers are 1-indexed
    }
  }

  // Build ChordPro output
  const output = [];
  output.push(`{title: ${title}}`);
  if (artist) output.push(`{artist: ${artist}}`);
  if (key) output.push(`{key: ${key}}`);
  output.push("");

  // Write lyrics with section detection
  // Strategy: group lyrics into stanzas at blank-line boundaries,
  // then label stanzas heuristically (Verse 1, Chorus 1, etc.)

  // Split lyrics into stanzas (groups separated by blank lines)
  const stanzas = [];
  let currentStanza = [];
  for (const rawLine of lyrics) {
    const trimmed = rawLine.trim();
    if (!trimmed && currentStanza.length > 0) {
      stanzas.push(currentStanza);
      currentStanza = [];
    } else if (trimmed) {
      // Check for explicit section markers in the line
      const isMarker = /^\[?(?:chorus|verse\s*\d*|bridge|solo|intro|outro|pre-chorus)\b/i.test(trimmed);
      if (isMarker) {
        if (currentStanza.length > 0) stanzas.push(currentStanza);
        currentStanza = [];
        const cleaned = trimmed.replace(/^\[?(?:chorus|verse\s*\d*|bridge|solo|intro|outro|pre-chorus)\s*\d*\]?[:.]?\s*/i, "").trim();
        if (cleaned) currentStanza.push(cleaned);
      } else {
        currentStanza.push(trimmed);
      }
    }
  }
  if (currentStanza.length > 0) stanzas.push(currentStanza);

  // Heuristic section labeling
  const stanzaSignatures = stanzas.map(st => {
    // Use first line's first 20 chars + stanza length as signature
    const key = st[0] ? st[0].substring(0, 20).toLowerCase() : "";
    return { lines: st, sig: key + "|" + st.length };
  });

  // Find repeated signatures (potential choruses)
  const sigCounts = {};
  for (const s of stanzaSignatures) {
    sigCounts[s.sig] = (sigCounts[s.sig] || 0) + 1;
  }

  let verseCount = 0, chorusCount = 0, globalLineIdx = 0;
  const seenTypes = [];

  for (let si = 0; si < stanzaSignatures.length; si++) {
    const { lines, sig } = stanzaSignatures[si];
    const repeatCount = sigCounts[sig] || 1;
    const isRepeated = repeatCount > 1;

    let type, label;

    if (lines.length === 0) continue;

    // First stanza = Verse 1
    if (si === 0) {
      type = "verse";
      verseCount++;
      label = "Verse " + verseCount;
    }
    // Repeated stanza = Chorus
    else if (isRepeated && chorusCount === 0) {
      type = "chorus";
      chorusCount++;
      label = "Chorus " + chorusCount;
    }
    else if (isRepeated && chorusCount > 0) {
      type = "chorus";
      chorusCount++;
      label = "Chorus " + chorusCount;
    }
    // Last stanza, short (1-2 lines) = Outro
    else if (si === stanzaSignatures.length - 1 && lines.length <= 2) {
      type = "outro";
      label = "Outro";
    }
    // Otherwise = next verse
    else {
      type = "verse";
      verseCount++;
      label = "Verse " + verseCount;
    }

    // Emit section directives
    if (si > 0) output.push("{end_of_" + (seenTypes[seenTypes.length - 1] || "verse") + "}");
    output.push(`{start_of_${type}: ${label}}`);

    for (const line of lines) {
      // Prepend chord from chordForLine if available
      const cIdx = globalLineIdx < chordForLine.length ? globalLineIdx : (chordForLine.length - 1);
      const chordName = (cIdx >= 0 && chordForLine[cIdx]) || "";

      // @time=N from GP bar position (accurate within GP tempo grid)
      const barNum = barForLine.length > globalLineIdx ? barForLine[globalLineIdx] : (barForLine.length > 0 ? barForLine[barForLine.length - 1] : 1);
      const lineTime = ((barNum - 1) * 4 * 60) / (bpm || 120);
      const timePrefix = `@time=${lineTime.toFixed(2)} @bar=${barNum}  `;

      if (chordName) {
        output.push(`${timePrefix}[${chordName}]${line}`);
      } else {
        output.push(`${timePrefix}${line}`);
      }
      globalLineIdx++;
    }
    seenTypes.push(type);
  }

  if (seenTypes.length > 0) output.push("{end_of_" + seenTypes[seenTypes.length - 1] + "}");

  return {
    title,
    artist,
    key,
    bpm,
    chopro: output.join("\n"),
    chords: uniqueChords,
  };
}

// ── Main ──
function main(inputPath) {
  try {
    const gpifXml = loadGpif(inputPath);
    const result = gpifToChopro(gpifXml);
    console.log("Title:", result.title);
    console.log("Artist:", result.artist);
    console.log("Key:", result.key);
    console.log("BPM:", result.bpm);
    console.log("Chords:", result.chords.join(", "));
    console.log("\n--- ChordPro ---\n");
    console.log(result.chopro);
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
}

if (require.main === module) {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: node gpif-to-chopro.js <score.gpif or song.gp>");
    process.exit(1);
  }
  main(input);
}

module.exports = { gpifToChopro, loadGpif, parseChords, parseLyrics, parseChordTrack, chordNameFromXml };
