#!/usr/bin/env python3
# audio-pipeline.py — Download, downsample, BPM detect, and stem songs
# ======================================================================
# For each song in ~/ReaperSongs/:
#   1. Search YouTube via yt-dlp for the song
#   2. Download best audio (m4a/opus)
#   3. ffmpeg downsample → mono 22kHz 48kbps full.mp3
#   4. aubio BPM detection → update meta.json
#   5. demucs stem separation (vocals, drums, bass, other)
#   6. ffmpeg downsample each stem
#
# Output: ~/Music/SongAudio/<Song Name>/
#   ├── full.mp3
#   └── stems/
#       ├── vocals.mp3
#       ├── drums.mp3
#       ├── bass.mp3
#       └── other.mp3
#
# Usage:
#   python3 tools/audio-pipeline.py                    # all songs (no stems)
#   python3 tools/audio-pipeline.py --stems            # also create stems
#   python3 tools/audio-pipeline.py --bpm-only         # only BPM extraction
#   python3 tools/audio-pipeline.py --song "Name"      # single song
#   python3 tools/audio-pipeline.py --dry-run          # preview only
#   python3 tools/audio-pipeline.py --limit 3          # test first N
#   python3 tools/audio-pipeline.py --no-download      # skip download, use existing audio

import os, sys, json, subprocess, time, shutil, re, hashlib
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import numpy as np

REAPER_SONGS = os.path.expanduser("~/ReaperSongs")
AUDIO_DIR = os.path.expanduser("~/Music/SongAudio")
# ffmpeg downsample params (from audio_import.lua)
FFMPEG_DOWNSAMPLE = ["-ac", "1", "-ar", "22050", "-b:a", "48k", "-f", "mp3"]

args = sys.argv[1:]
DRY_RUN = "--dry-run" in args or "--dry" in args
DO_STEMS = "--stems" in args
BPM_ONLY = "--bpm-only" in args
NO_DOWNLOAD = "--no-download" in args
LIMIT = None
SPECIFIC_SONG = None

for i, a in enumerate(args):
    if a == "--limit" and i + 1 < len(args):
        LIMIT = int(args[i + 1])
    if a == "--song" and i + 1 < len(args):
        SPECIFIC_SONG = args[i + 1]

def slugify(s):
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")

def format_time(sec):
    return f"{int(sec//60)}:{int(sec%60):02d}"

def run(cmd, timeout=120, env=None):
    """Run a command, return (ok, stdout)."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        return r.returncode == 0, r.stdout + r.stderr
    except Exception as e:
        return False, str(e)

# ── yt-dlp search + download ──

def search_youtube(artist, title):
    """Search YouTube for a song, return list of (video_id, title, duration_str)."""
    queries = [
        f"{artist} {title}",
        f"{artist} - {title}",
        f"{artist} {title} official audio",
        f"{title} {artist} lyrics",
    ]
    
    for query in queries:
        ok, out = run([
            "yt-dlp", "--no-playlist", "--flat-playlist",
            "--print", "%(id)s|%(title)s|%(duration_string)s",
            f"ytsearch5:{query}"
        ], timeout=25)
        if ok and out.strip():
            break
    else:
        return []

    results = []
    for line in out.strip().split("\n"):
        parts = line.strip().split("|", 2)
        if len(parts) >= 2:
            vid = parts[0]
            vtitle = parts[1]
            dur = parts[2] if len(parts) > 2 else "?"
            if vid and len(vid) == 11:
                results.append((vid, vtitle, dur))
    return results

def download_audio(video_id, output_path):
    """Download audio from YouTube via yt-dlp, return downloaded file path."""
    tmp = output_path + ".tmp.%(ext)s"
    for attempt in range(3):
        if attempt > 0:
            time.sleep(2)  # brief backoff
        ok, out = run([
            "yt-dlp", "--no-playlist", "--no-progress",
            "-f", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
            "-o", tmp,
            f"https://www.youtube.com/watch?v={video_id}"
        ], timeout=180)
        if ok:
            break
    if not ok:
        return None
    # Find the downloaded file
    for ext in ["m4a", "webm", "opus", "mp3"]:
        candidate = output_path + f".tmp.{ext}"
        if os.path.exists(candidate):
            return candidate
    # yt-dlp might have renamed to a different pattern
    import glob
    pattern = output_path + ".tmp.*"
    files = glob.glob(pattern)
    return files[0] if files else None

# ── ffmpeg downsample ──

def downsample(input_path, output_path):
    """Downsample audio to mono 22kHz 48kbps mp3."""
    ok, _ = run([
        "ffmpeg", "-y", "-i", input_path,
        *FFMPEG_DOWNSAMPLE, output_path
    ], timeout=60)
    return ok

# ── BPM detection via aubio ──

def detect_bpm(audio_path):
    """Detect BPM using aubio beat tracking. Returns (bpm, confidence) or (None, None)."""
    try:
        import aubio
        source = aubio.source(audio_path, 0, 512)
        tempo = aubio.tempo("default", 1024, 512, source.samplerate)
        bpms = []
        while True:
            samples, read = source()
            is_beat = tempo(samples)
            if is_beat:
                bpms.append(tempo.get_bpm())
            if read < source.hop_size:
                break
        if not bpms:
            return None, None
        # Use median of stable BPMS (last 75%)
        stable = bpms[len(bpms)//4:] if len(bpms) > 10 else bpms
        bpm = sorted(stable)[len(stable)//2]
        # Confidence: how stable were the readings?
        std = np.std(stable[-20:]) if len(stable) >= 20 else np.std(stable)
        conf = max(0, 1.0 - std / 10)
        return round(bpm), round(conf, 2)
    except Exception as e:
        return None, None

# ── Demucs stem separation ──

def separate_stems(audio_path, output_dir, song_name):
    """Run demucs with all cores for overnight processing. Returns dict of stem_name -> wav_path."""
    safe_name = re.sub(r"[^a-zA-Z0-9]", "_", song_name)[:40]
    stem_dir = os.path.join(output_dir, "stems_raw")
    os.makedirs(stem_dir, exist_ok=True)

    ok, out = run([
        "python3", "-m", "demucs",
        "-n", "htdemucs_ft",   # lighter model
        "-o", stem_dir,
        audio_path
    ], timeout=900)

    if not ok:
        return {}

    import glob
    stems = {}
    for pattern in [f"{stem_dir}/htdemucs_ft/**/*.wav", f"{stem_dir}/**/*vocals*.wav"]:
        for wav in glob.glob(pattern, recursive=True):
            name = os.path.basename(wav).replace(".wav", "").lower()
            for stem_type in ["vocals", "drums", "bass", "other"]:
                if stem_type in name:
                    stems[stem_type] = wav
    return stems

# ── Main pipeline ──

def process_song(folder_name, meta, total, idx):
    title = meta.get("title", folder_name)
    artist = meta.get("artist", "")
    audio_folder = os.path.join(AUDIO_DIR, folder_name)
    stem_folder = os.path.join(audio_folder, "stems")
    full_path = os.path.join(audio_folder, "full.mp3")
    song_dir = os.path.join(REAPER_SONGS, folder_name)

    status = []
    bpm_result = None

    # Check for existing audio in ReaperSongs folder
    existing_audio = None
    if not os.path.exists(full_path):
        for ext in ["*.mp3", "*.wav", "*.m4a", "*.flac", "*.ogg"]:
            import glob
            matches = glob.glob(os.path.join(song_dir, ext))
            if matches:
                existing_audio = matches[0]
                break

    # ── Step 1: Download / Import ──
    if not BPM_ONLY and not NO_DOWNLOAD:
        if os.path.exists(full_path):
            status.append("audio exists")
        elif existing_audio:
            if DRY_RUN:
                status.append("would import existing audio")
            else:
                os.makedirs(audio_folder, exist_ok=True)
                if downsample(existing_audio, full_path):
                    status.append("imported from ReaperSongs")
                else:
                    return {"status": "failed", "reason": "import downsample failed"}
        elif not DRY_RUN:
            tag = f"[{idx}/{total}]"
            sys.stdout.write(f"\r{tag} Downloading: {title[:40]}\n")
            sys.stdout.flush()

            results = search_youtube(artist, title)
            if not results:
                return {"status": "failed", "reason": "no search results"}

            vid, vtitle, dur = results[0]
            dl_path = download_audio(vid, full_path)
            if not dl_path:
                return {"status": "failed", "reason": "download failed"}

            # Downsample
            os.makedirs(audio_folder, exist_ok=True)
            if downsample(dl_path, full_path):
                os.remove(dl_path)
                orig_size = os.path.getsize(full_path)
                status.append(f"downloaded ({orig_size//1024}KB)")
            else:
                if os.path.exists(dl_path):
                    os.remove(dl_path)
                return {"status": "failed", "reason": "downsample failed"}
        else:
            if existing_audio:
                status.append("would import existing audio")
            else:
                status.append("would download")

    # ── Step 2: BPM ──
    if os.path.exists(full_path) and (meta.get("bpm", 120) == 120 or BPM_ONLY):
        if DRY_RUN:
            status.append("would detect BPM")
        else:
            bpm, conf = detect_bpm(full_path)
            if bpm and 30 <= bpm <= 300 and conf >= 0.3:
                meta["bpm"] = bpm
                meta["bpm_source"] = "aubio"
                meta["bpm_confidence"] = conf
                bpm_result = bpm
                meta_path = os.path.join(REAPER_SONGS, folder_name, "meta.json")
                with open(meta_path, "w") as f:
                    json.dump(meta, f, indent=2)
                status.append(f"BPM={bpm} (conf={conf})")
            else:
                status.append(f"BPM failed")

    # ── Step 3: Stems ──
    if DO_STEMS and os.path.exists(full_path):
        os.makedirs(stem_folder, exist_ok=True)
        stems_needed = any(
            not os.path.exists(os.path.join(stem_folder, f"{s}.mp3"))
            for s in ["vocals", "drums", "bass", "other"]
        )
        if stems_needed and not DRY_RUN:
            raw_stems = separate_stems(full_path, audio_folder, folder_name)
            for stem_type, wav_path in raw_stems.items():
                mp3_path = os.path.join(stem_folder, f"{stem_type}.mp3")
                if downsample(wav_path, mp3_path):
                    os.remove(wav_path)
            # Clean up demucs raw directory
            raw_dir = os.path.join(audio_folder, "stems_raw")
            if os.path.exists(raw_dir):
                shutil.rmtree(raw_dir, ignore_errors=True)
            status.append("stems created")
        elif stems_needed:
            status.append("would create stems")

    return {
        "status": "ok",
        "actions": status,
        "bpm": bpm_result,
    }

def main():
    # Build song list
    folders = sorted([
        d for d in os.listdir(REAPER_SONGS)
        if os.path.isdir(os.path.join(REAPER_SONGS, d))
        and not d.startswith(".") and not d.startswith("_")
    ])

    if SPECIFIC_SONG:
        slug = slugify(SPECIFIC_SONG)
        folders = [f for f in folders if slugify(f) == slug]
        if not folders:
            print(f"Song not found: {SPECIFIC_SONG}")
            sys.exit(1)

    total = len(folders)
    if LIMIT:
        folders = folders[:LIMIT]
        total = len(folders)

    print(f"Songs: {total}")
    print(f"Mode: {'DRY RUN' if DRY_RUN else 'LIVE'}")
    print(f"Stems: {'YES' if DO_STEMS else 'NO'}")
    print(f"BPM only: {'YES' if BPM_ONLY else 'NO'}")
    print()

    # Load all metas upfront
    song_data = []
    for folder in folders:
        mp = os.path.join(REAPER_SONGS, folder, "meta.json")
        if not os.path.exists(mp):
            continue
        with open(mp) as f:
            meta = json.load(f)
        song_data.append((folder, meta))

    results = {"downloaded": 0, "bpm_fixed": 0, "stemmed": 0, "failed": 0, "skipped": 0}
    start = time.time()

    for i, (folder, meta) in enumerate(song_data, 1):
        r = process_song(folder, meta, total, i)
        actions = " | ".join(r.get("actions", []))
        bpm = r.get("bpm")
        bpm_str = f" → BPM={bpm}" if bpm else ""
        sys.stdout.write(f"\r\x1b[K[{i}/{total}] {folder[:45]}: {actions}{bpm_str}\n")
        sys.stdout.flush()

        if r["status"] == "ok":
            if "downloaded" in str(r.get("actions")):
                results["downloaded"] += 1
            if r.get("bpm"):
                results["bpm_fixed"] += 1
            if "stems created" in str(r.get("actions")):
                results["stemmed"] += 1
        elif r["status"] == "failed":
            results["failed"] += 1
        else:
            results["skipped"] += 1

    elapsed = time.time() - start
    print(f"\nDone in {format_time(elapsed)}:")
    print(f"  Downloaded: {results['downloaded']}")
    print(f"  BPM fixed:  {results['bpm_fixed']}")
    print(f"  Stems:      {results['stemmed']}")
    print(f"  Failed:     {results['failed']}")
    print(f"  Skipped:    {results['skipped']}")

    if DRY_RUN:
        print("DRY RUN — no changes made.")

if __name__ == "__main__":
    main()
