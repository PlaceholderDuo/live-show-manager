#!/usr/bin/env python3
# sync-lyric-to-audio.py — Align ChordPro lyrics to audio using Whisper
# ======================================================================
# Uses Whisper word timestamps on vocals stem to find WHERE each lyric
# line is sung in the audio, then rewrites @time=N @bar=N annotations
# with ground-truth timing from real audio.
#
# Usage:
#   python3 tools/sync-lyric-to-audio.py                # all songs with stems
#   python3 tools/sync-lyric-to-audio.py --song "Name"  # single song
#   python3 tools/sync-lyric-to-audio.py --limit 3      # test first N
#   python3 tools/sync-lyric-to-audio.py --dry-run      # preview, no writes

import os, sys, json, re, time, difflib
import whisper
import numpy as np

REAPER_SONGS = os.path.expanduser("~/ReaperSongs")
AUDIO_DIR = os.path.expanduser("~/Music/SongAudio")

args = sys.argv[1:]
SPECIFIC_SONG = None
LIMIT = None
DRY_RUN = "--dry-run" in args
MODEL = "base"

for i, a in enumerate(args):
    if a == "--song" and i + 1 < len(args):
        SPECIFIC_SONG = args[i + 1]
    if a == "--limit" and i + 1 < len(args):
        LIMIT = int(args[i + 1])
    if a == "--model" and i + 1 < len(args):
        MODEL = args[i + 1]

def normalize(text):
    """Strip everything except alphanumeric words, lowercase."""
    text = re.sub(r"[^a-zA-Z0-9\s]", "", text.lower())
    return " ".join(text.split())

def parse_chopro_lyrics(chopro_path):
    """Extract lyric lines (ignoring headers, chords, directives, metadata)."""
    if not os.path.exists(chopro_path):
        return []
    
    with open(chopro_path) as f:
        lines = f.readlines()
    
    lyrics = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("{"):
            continue
        
        # Skip section headers
        if stripped.startswith("##"):
            continue
        
        # Skip bare chord markers
        if re.match(r"^\/.+\/$", stripped):
            continue
        
        # Extract text (strip chords + annotations)
        text = re.sub(r"@\w+=[\d.\s]+", "", stripped)
        text = re.sub(r"\[[^\]]+\]", "", text)
        text = re.sub(r"/[A-G][^/\s]*/", "", text)
        # Strip trailing @N.N
        text = re.sub(r"\s@[\d]+\.?\d{1,2}\s*$", "", text)
        text = text.strip()
        
        if not text or len(text) < 3:
            continue
        
        # Skip metadata lines
        lower = text.lower()
        if re.match(r"^(song|artist|tuning|capo|tabbed|standard|no chords|let ring|palm mute|difficulty)[:\s]", lower):
            continue
        if re.match(r"^[A-G][b#]?(m|dim|aug|sus\d*|add\d+|maj\d*|m\d*|\d+)?$", text):
            continue
        
        # Rejoin syllable-separated words: "sa-tis-fac-tion" → "satisfaction"
        # Whisper outputs whole words, not syllables
        text = re.sub(r"(\w)-(\w)", r"\1\2", text)
        
        lyrics.append({
            "text": text,
            "normalized": normalize(text),
            "words": set(normalize(text).split()),
            "words_ordered": normalize(text).split(),  # preserves order for search
        })
    
    return lyrics

def find_lyric_positions(lyric_lines, whisper_words):
    """Align lyric lines to audio using difflib sequence matching.
    
    Uses Python's difflib.SequenceMatcher to find the longest matching
    subsequence between the full lyric word sequence and the Whisper
    transcript word sequence. This is robust against misheard words
    because it finds the best overall alignment, not exact substrings.
    """
    if not whisper_words:
        return []
    
    # Build the sequence as word tokens
    whisper_seq = [w["word"] for w in whisper_words]
    lyric_words_all = []
    lyric_line_map = []  # maps token index → lyric line index
    
    for li, ly in enumerate(lyric_lines):
        words = ly["words_ordered"]
        for w in words:
            lyric_words_all.append(w)
            lyric_line_map.append(li)
    
    if len(lyric_words_all) < 5 or len(whisper_seq) < 10:
        return [{"line": ly["text"][:80], "time": None, "match": 0} for ly in lyric_lines]
    
    # Run sequence matcher
    sm = difflib.SequenceMatcher(None, whisper_seq, lyric_words_all)
    blocks = sm.get_matching_blocks()
    
    # For each matched block, assign timestamps to lyric lines
    results = [{"line": ly["text"][:80], "time": None, "match": 0} for ly in lyric_lines]
    
    for block in blocks[:-1]:  # last block is always (len_a, len_b, 0)
        whisper_start, lyric_start, length = block
        if length < 3:
            continue
        
        # For each unique lyric line covered by this block, find its timestamp
        seen_lines = set()
        for lyric_token_pos in range(lyric_start, lyric_start + length):
            li = lyric_line_map[lyric_token_pos]
            if li in seen_lines:
                continue
            seen_lines.add(li)
            
            # The whisper position for this lyric token is at whisper_start
            # (first matched word in the block)
            token_whisper_pos = whisper_start + (lyric_token_pos - lyric_start)
            if token_whisper_pos < len(whisper_seq):
                t = whisper_words[token_whisper_pos]["start"]
                results[li] = {
                    "line": lyric_lines[li]["text"][:80],
                    "time": round(t, 2),
                    "match": 0.8,
                }
    
    return results

def recompute_annotations(positions, bpm):
    """Given audio timestamps for each line, compute @time @bar."""
    annotations = []
    for pos in positions:
        if pos["time"] is not None and pos["match"] > 0:
            t = pos["time"]
            bar = int(t * bpm / (4 * 60)) + 1
            annotations.append({
                "text": pos["line"],
                "time": round(t, 2),
                "bar": bar,
                "match": pos["match"],
            })
    return annotations

def sync_song(folder_name):
    """Sync one song's lyrics to audio."""
    song_dir = os.path.join(REAPER_SONGS, folder_name)
    audio_dir = os.path.join(AUDIO_DIR, folder_name)
    chopro_path = os.path.join(song_dir, "song.chopro")
    vocals_path = os.path.join(audio_dir, "stems", "vocals.mp3")
    full_path = os.path.join(audio_dir, "full.mp3")
    meta_path = os.path.join(song_dir, "meta.json")
    
    if not os.path.exists(chopro_path):
        return {"status": "skip", "reason": "no chordpro"}
    if not os.path.exists(full_path):
        return {"status": "skip", "reason": "no full.mp3 (or vocals stem)"}
    
    # Prefer full.mp3 — Whisper handles full mix better than compressed stems
    audio_path = full_path
    
    # Load BPM (use existing or detect)
    with open(meta_path) as f:
        meta = json.load(f)
    bpm = meta.get("bpm", 120)
    
    lyric_lines = parse_chopro_lyrics(chopro_path)
    if len(lyric_lines) < 5:
        return {"status": "skip", "reason": f"only {len(lyric_lines)} lyric lines"}
    
    # Transcribe
    model = whisper.load_model(MODEL)
    result = model.transcribe(audio_path, word_timestamps=True, language="en")
    
    whisper_words = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            whisper_words.append({
                "start": w["start"],
                "end": w["end"],
                "word": w["word"].strip().lower(),
            })
    
    # Find positions
    positions = find_lyric_positions(lyric_lines, whisper_words)
    annotations = recompute_annotations(positions, bpm)
    
    matched = sum(1 for p in positions if p["time"] is not None and p["match"] > 0)
    score = matched / len(positions) * 100 if positions else 0
    
    # Write new annotations to chopro if not dry-run
    if not DRY_RUN and annotations:
        # Detect file format: old ({start_of_*}) or new (## headers)
        with open(chopro_path) as f:
            lines = f.readlines()
        
        is_new_format = any(line.strip().startswith("##") for line in lines)
        
        annotation_idx = 0
        new_lines = []
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("{") or stripped.startswith("##"):
                new_lines.append(line)
                continue
            
            # Check if this line has lyric content
            text = re.sub(r"@\w+=[\d.\s]+", "", stripped)
            text = re.sub(r"\[[^\]]+\]", "", text)
            text = re.sub(r"/[A-G][^/\s]*/", "", text)
            # Also strip new-format trailing @N.N
            text = re.sub(r"\s@[\d]+\.?\d{1,2}\s*$", "", text)
            text = text.strip()
            
            if text and len(text) >= 3 and annotation_idx < len(annotations):
                ann = annotations[annotation_idx]
                annotation_idx += 1
                
                chords = "".join(re.findall(r"\[[^\]]+\]", stripped))
                bare = "".join(re.findall(r"/[A-G][^/]*/", stripped))
                indent = line[:len(line) - len(line.lstrip())] if line else ""
                
                if is_new_format:
                    # New format: trailing @N.N after the lyric text
                    bare_str = f" {bare}" if bare else ""
                    new_lines.append(f"{indent}{chords}{text} @{ann['time']}{bare_str}\n")
                else:
                    # Old format: @time=N @bar=N prefix before chords
                    timing = f"@time={ann['time']} @bar={ann['bar']}"
                    new_lines.append(f"{indent}{timing}  {chords}{bare}{text}\n")
            else:
                new_lines.append(line)
        
        with open(chopro_path + ".synced.bak", "w") as f:
            f.write("".join(lines))
        with open(chopro_path, "w") as f:
            f.write("".join(new_lines))
    
    return {
        "status": "ok",
        "song": folder_name,
        "lyrics": len(lyric_lines),
        "matched": matched,
        "score": round(score),
        "annotations": len(annotations),
    }

def main():
    print(f"Whisper model: {MODEL}")
    print(f"Mode: {'DRY RUN' if DRY_RUN else 'LIVE'}")
    print()
    
    folders = sorted([
        d for d in os.listdir(REAPER_SONGS)
        if os.path.isdir(os.path.join(REAPER_SONGS, d))
        and not d.startswith(".") and not d.startswith("_")
    ])
    
    if SPECIFIC_SONG:
        folders = [f for f in folders if SPECIFIC_SONG.lower() in f.lower()]
    
    folders = [f for f in folders 
               if os.path.exists(os.path.join(AUDIO_DIR, f, "full.mp3"))]
    
    if LIMIT:
        folders = folders[:LIMIT]
    
    print(f"Found {len(folders)} songs with audio\n")
    
    for i, folder in enumerate(folders, 1):
        print(f"[{i}/{len(folders)}] {folder}")
        result = sync_song(folder)
        if result["status"] == "ok":
            print(f"  Lyrics: {result['lyrics']} lines")
            print(f"  Matched: {result['matched']}/{result['lyrics']} ({result['score']}%)")
            print(f"  Annotations written: {result['annotations']}")
        else:
            print(f"  {result['reason']}")
        print()

if __name__ == "__main__":
    main()
