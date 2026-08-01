#!/usr/bin/env python3
# verify-lyric-audio.py — Compare chordpro @time/@bar annotations against real audio
# ======================================================================
# Uses OpenAI Whisper on vocals stem to get word-level timestamps,
# then checks if ChordPro lyric annotations align with actual singing.
#
# Usage:
#   python3 tools/verify-lyric-audio.py                    # all songs with stems
#   python3 tools/verify-lyric-audio.py --song "Name"      # single song
#   python3 tools/verify-lyric-audio.py --limit 3           # test first N
#   python3 tools/verify-lyric-audio.py --model tiny        # faster model (tiny/base/small/medium)

import os, sys, json, re, time, subprocess
import whisper
import numpy as np

REAPER_SONGS = os.path.expanduser("~/ReaperSongs")
AUDIO_DIR = os.path.expanduser("~/Music/SongAudio")

args = sys.argv[1:]
SPECIFIC_SONG = None
LIMIT = None
MODEL = "base"  # tiny=fastest, base=good, small=better, medium=best

for i, a in enumerate(args):
    if a == "--song" and i + 1 < len(args):
        SPECIFIC_SONG = args[i + 1]
    if a == "--limit" and i + 1 < len(args):
        LIMIT = int(args[i + 1])
    if a == "--model" and i + 1 < len(args):
        MODEL = args[i + 1]

def slugify(s):
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")

def parse_chopro_annotations(chopro_path):
    """Extract @time and lyric text from a ChordPro file (old + new format)."""
    if not os.path.exists(chopro_path):
        return []
    
    with open(chopro_path) as f:
        lines = f.readlines()
    
    # Detect format
    is_new_format = any(line.strip().startswith("##") for line in lines)
    
    annotations = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("{"):
            continue
        if stripped.startswith("##"):
            continue
        if re.match(r"^\/.+\/$", stripped):
            continue
        
        # Extract time from old prefix format: @time=N
        time_m = re.search(r"@time\s*=\s*([\d.]+)", stripped)
        time_sec = float(time_m.group(1)) if time_m else None
        
        # Extract time from new trailing format: @N.N at end of line
        if time_sec is None and is_new_format:
            trail_m = re.search(r"\s@([\d]+\.?\d{1,2})\s*$", stripped)
            if trail_m:
                time_sec = float(trail_m.group(1))
        
        if time_sec is None:
            continue
        
        bar_m = re.search(r"@bar\s*=\s*(\d+)", stripped)
        bar = int(bar_m.group(1)) if bar_m else 0
        
        # Strip annotations, chord brackets, and section markers
        text = re.sub(r"@\w+=[\d.\s]+", "", stripped)
        text = re.sub(r"\[[^\]]+\]", "", text)        # inline chords [D]
        text = re.sub(r"/[A-G][^/\s]*/", "", text)     # bare chords /A/
        text = re.sub(r"\s@[\d]+\.?\d{1,2}\s*$", "", text)  # trailing @N.N
        text = text.strip()
        
        # Skip if no real lyric content
        if not text or len(text) < 3:
            continue
        # Skip if it's just a chord name or section label
        if re.match(r"^[A-G][b#]?(m|dim|aug|sus\d*|add\d+|maj\d*|m\d*|\d+)?$", text):
            continue
        
        annotations.append({
            "time": time_sec,
            "bar": bar,
            "text": text,
            "raw": stripped
        })
    
    return annotations

def transcribe_vocals(vocals_path, model_name=MODEL):
    """Run Whisper on vocals stem, return list of {start, end, text} segments."""
    if not os.path.exists(vocals_path):
        return None
    
    print(f"  Loading Whisper ({model_name})...")
    model = whisper.load_model(model_name)
    
    print(f"  Transcribing...")
    result = model.transcribe(vocals_path, word_timestamps=True, language="en")
    
    words = []
    for segment in result.get("segments", []):
        for word_info in segment.get("words", []):
            words.append({
                "start": word_info["start"],
                "end": word_info["end"],
                "word": word_info["word"].strip().lower(),
            })
    
    return words, result["text"]

def align_annotations(annotations, whisper_words):
    """Check how well @time annotations align with Whisper word timestamps."""
    if not annotations or not whisper_words:
        return None
    
    results = []
    for ann in annotations:
        target_time = ann["time"]
        lyric_words = ann["text"].lower().split()
        
        # Find Whisper words near this time
        window = 3.0  # seconds tolerance
        nearby = [w for w in whisper_words 
                  if abs(w["start"] - target_time) < window 
                  or abs(w["end"] - target_time) < window]
        
        # Check word overlap
        matches = 0
        for lw in lyric_words[:5]:  # check first few words
            for w in nearby:
                if lw in w["word"] or w["word"] in lw:
                    matches += 1
                    break
        
        word_ratio = matches / min(len(lyric_words[:5]), 5) if lyric_words[:5] else 0
        
        # Time offset: closest whisper word to target
        offsets = [abs(w["start"] - target_time) for w in nearby] if nearby else [window]
        min_offset = min(offsets)
        
        results.append({
            "time": target_time,
            "bar": ann["bar"],
            "text": ann["text"][:80],
            "nearby_words": len(nearby),
            "word_match": round(word_ratio, 2),
            "offset_sec": round(min_offset, 2),
            "aligned": min_offset < 2.0 and word_ratio > 0.3,
        })
    
    return results

def verify_song(folder_name):
    """Verify one song's lyric sync against audio."""
    song_dir = os.path.join(REAPER_SONGS, folder_name)
    audio_dir = os.path.join(AUDIO_DIR, folder_name)
    chopro_path = os.path.join(song_dir, "song.chopro")
    vocals_path = os.path.join(audio_dir, "stems", "vocals.mp3")
    
    if not os.path.exists(chopro_path):
        return {"status": "skip", "reason": "no chordpro"}
    if not os.path.exists(vocals_path):
        return {"status": "skip", "reason": "no vocals stem"}
    
    annotations = parse_chopro_annotations(chopro_path)
    if not annotations:
        return {"status": "skip", "reason": "no @time annotations"}
    
    whisper_result = transcribe_vocals(vocals_path)
    if not whisper_result:
        return {"status": "skip", "reason": "transcription failed"}
    
    words, full_text = whisper_result
    alignment = align_annotations(annotations, words)
    
    if not alignment:
        return {"status": "skip", "reason": "alignment failed"}
    
    aligned = sum(1 for a in alignment if a["aligned"])
    total = len(alignment)
    score = aligned / total if total > 0 else 0
    
    return {
        "status": "ok",
        "song": folder_name,
        "annotations": total,
        "aligned": aligned,
        "score": round(score * 100),
        "avg_offset": round(np.mean([a["offset_sec"] for a in alignment]), 2),
        "details": alignment,
    }

def main():
    print(f"Whisper model: {MODEL}")
    print(f"Songs: {'all with stems' if not SPECIFIC_SONG else SPECIFIC_SONG}")
    print()
    
    folders = sorted([
        d for d in os.listdir(REAPER_SONGS)
        if os.path.isdir(os.path.join(REAPER_SONGS, d))
        and not d.startswith(".") and not d.startswith("_")
    ])
    
    if SPECIFIC_SONG:
        slug = slugify(SPECIFIC_SONG)
        folders = [f for f in folders if slugify(f) == slug]
    
    # Only process songs with stems
    folders = [f for f in folders 
               if os.path.exists(os.path.join(AUDIO_DIR, f, "stems", "vocals.mp3"))]
    
    if LIMIT:
        folders = folders[:LIMIT]
    
    print(f"Found {len(folders)} songs with stems\n")
    
    for i, folder in enumerate(folders, 1):
        print(f"[{i}/{len(folders)}] {folder}")
        result = verify_song(folder)
        
        if result["status"] == "ok":
            print(f"  Score: {result['score']}% aligned ({result['aligned']}/{result['annotations']})")
            print(f"  Avg offset: {result['avg_offset']}s")
            
            # Show a few misalignments
            bad = [d for d in result["details"] if not d["aligned"]][:3]
            for b in bad:
                print(f"  ✗ bar={b['bar']} time={b['time']:.1f}s offset={b['offset_sec']}s: \"{b['text'][:60]}\"")
            
            good = [d for d in result["details"] if d["aligned"]][:2]
            for g in good:
                print(f"  ✓ bar={g['bar']} time={g['time']:.1f}s offset={g['offset_sec']}s: \"{g['text'][:60]}\"")
        else:
            print(f"  {result['reason']}")
        
        print()

if __name__ == "__main__":
    main()
