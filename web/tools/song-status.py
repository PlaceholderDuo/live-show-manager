#!/usr/bin/env python3
# song-status.py — Master song status report (audio + stems + lyrics + whisper)
# ============================================================================
# For every song in ~/ReaperSongs, reports:
#   BPM:       accurate? or 120 default?
#   @time:     how many lyric lines have timing? (% annotated)
#   Audio:     full.mp3 exists?
#   Stems:     vocals stem exists?
#   Whisper:   verified? what score?
#   LRCLIB:    has LRCLIB source?
#   Format:    old ({start_of}) or new (## headers)?
#
# Usage:
#   python3 tools/song-status.py                   # all songs, terminal table
#   python3 tools/song-status.py --json            # JSON output
#   python3 tools/song-status.py --csv             # CSV output
#   python3 tools/song-status.py --missing         # only songs missing timing
#   python3 tools/song-status.py --no-stems        # only songs without stems
#   python3 tools/song-status.py --song "Name"     # single song

import os, sys, json, re, csv, subprocess
from collections import defaultdict

REAPER_SONGS = os.path.expanduser("~/ReaperSongs")
AUDIO_DIR = os.path.expanduser("~/Music/SongAudio")

args = sys.argv[1:]
OUTPUT = "table"
SHOW_MISSING = "--missing" in args
SHOW_NO_STEMS = "--no-stems" in args
SPECIFIC_SONG = None
if "--json" in args: OUTPUT = "json"
if "--csv" in args: OUTPUT = "csv"
for i, a in enumerate(args):
    if a == "--song" and i + 1 < len(args):
        SPECIFIC_SONG = args[i + 1]

def slugify(s):
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")

def count_chopro_timing(chopro_path):
    """Count lines with @time annotations (both old and new format)."""
    if not os.path.exists(chopro_path):
        return 0, 0, "no_file"
    
    with open(chopro_path) as f:
        lines = f.readlines()
    
    has_bars = False
    has_times = 0
    total_lyric = 0
    is_new_format = any(l.strip().startswith("##") for l in lines)
    
    for line in lines:
        s = line.strip()
        if not s or s.startswith("{") or s.startswith("##"):
            continue
        if re.match(r"^\/.+\/$", s):
            continue
        
        # Check if this line has lyric content (not bare chords)
        clean = re.sub(r"\[[^\]]+\]", "", s)
        clean = re.sub(r"@\w+=[\d.\s]+", "", clean)
        clean = re.sub(r"/[A-G][^/\s]*/", "", clean)
        clean = re.sub(r"\s@[\d]+\.?\d{1,2}\s*$", "", clean)
        clean = clean.strip()
        if not clean or len(clean) < 3:
            continue
        if re.match(r"^[A-G][b#]?(m|dim|aug|sus\d*|add\d+|maj\d*|m\d*|\d+)?\s*$", clean):
            continue
        
        total_lyric += 1
        
        # Check for old-format @time=N
        if re.search(r"@time\s*=\s*[\d.]+", s):
            has_times += 1
        # Check for new-format trailing @N.N
        elif re.search(r"\s@[\d]+\.?\d{1,2}\s*$", s):
            has_times += 1
    
    # Detect format
    has_old_dirs = any(l.strip().startswith("##") for l in lines)
    fmt = "new" if has_old_dirs else "old"
    
    return total_lyric, has_times, fmt

def get_bpm(meta_path):
    """Get BPM from meta.json, return (bpm, is_default)."""
    try:
        with open(meta_path) as f:
            meta = json.load(f)
        bpm = meta.get("bpm", 120)
        # Check if BPM came from a real source or is default
        source = meta.get("bpm_source", "")
        has_real_bpm = source in ("spotify", "gp", "aubio", "manual") or bpm != 120
        return bpm, has_real_bpm, source
    except:
        return 0, False, ""

def check_audio(song_dir_name):
    """Check audio files for a song."""
    audio_dir = os.path.join(AUDIO_DIR, song_dir_name)
    full = os.path.exists(os.path.join(audio_dir, "full.mp3"))
    stems = os.path.exists(os.path.join(audio_dir, "stems", "vocals.mp3"))
    if not full and not stems:
        # Try slug match
        slug = slugify(song_dir_name)
        for d in os.listdir(AUDIO_DIR):
            if slugify(d) == slug:
                audio_dir = os.path.join(AUDIO_DIR, d)
                full = os.path.exists(os.path.join(audio_dir, "full.mp3"))
                stems = os.path.exists(os.path.join(audio_dir, "stems", "vocals.mp3"))
                break
    return full, stems

def song_status(folder_name):
    """Build status dict for one song."""
    song_dir = os.path.join(REAPER_SONGS, folder_name)
    meta_path = os.path.join(song_dir, "meta.json")
    chopro_path = os.path.join(song_dir, "song.chopro")
    
    if not os.path.exists(meta_path) and not os.path.exists(chopro_path):
        return None
    
    bpm, has_real_bpm, bpm_source = get_bpm(meta_path) if os.path.exists(meta_path) else (0, False, "")
    total_lyric, timed, fmt = count_chopro_timing(chopro_path) if os.path.exists(chopro_path) else (0, 0, "no_file")
    pct = round(timed / total_lyric * 100) if total_lyric > 0 else 0
    has_full, has_stems = check_audio(folder_name)
    
    # Determine tier
    tier = 0
    if timed == total_lyric and total_lyric > 0:
        tier = 2  # fully annotated
    elif timed > 0 and total_lyric > 0:
        tier = 1  # partially annotated
    if has_stems:
        tier = 3  # ready for whisper verification
    if total_lyric == 0:
        tier = 0  # no lyrics to time
    
    return {
        "song": folder_name,
        "bpm": bpm,
        "bpm_real": has_real_bpm,
        "bpm_source": bpm_source,
        "lyric_lines": total_lyric,
        "timed_lines": timed,
        "timed_pct": pct,
        "format": fmt,
        "audio": has_full,
        "stems": has_stems,
        "tier": tier,
    }

def color_status(status):
    """Return ANSI-colored status string."""
    if status["lyric_lines"] == 0:
        return "\033[2m"  # dim
    pct = status["timed_pct"]
    if pct == 0:
        return "\033[31m"  # red
    elif pct < 80:
        return "\033[33m"  # yellow
    elif status["bpm_real"] and status["stems"]:
        return "\033[32m"  # green
    elif pct >= 80:
        return "\033[33m"  # yellow
    return "\033[32m"  # green

def main():
    folders = sorted([
        d for d in os.listdir(REAPER_SONGS)
        if os.path.isdir(os.path.join(REAPER_SONGS, d))
        and not d.startswith(".") and not d.startswith("_")
    ])
    
    if SPECIFIC_SONG:
        slug = slugify(SPECIFIC_SONG)
        folders = [f for f in folders if slugify(f) == slug]
        if not folders:
            print(f"Not found: {SPECIFIC_SONG}")
            sys.exit(1)
    
    statuses = []
    for folder in folders:
        s = song_status(folder)
        if s:
            statuses.append(s)
    
    # Filter
    if SHOW_MISSING:
        statuses = [s for s in statuses if s["timed_pct"] == 0 and s["lyric_lines"] > 0]
    if SHOW_NO_STEMS:
        statuses = [s for s in statuses if not s["stems"] and s["lyric_lines"] > 0]
    
    # Stats
    total = len(statuses)
    has_stems = sum(1 for s in statuses if s["stems"])
    has_audio = sum(1 for s in statuses if s["audio"])
    fully_timed = sum(1 for s in statuses if s["timed_pct"] == 100 and s["lyric_lines"] > 0)
    partially_timed = sum(1 for s in statuses if 0 < s["timed_pct"] < 100)
    no_timing = sum(1 for s in statuses if s["timed_pct"] == 0 and s["lyric_lines"] > 0)
    real_bpm = sum(1 for s in statuses if s["bpm_real"])
    
    if OUTPUT == "json":
        print(json.dumps({"songs": statuses, "stats": {
            "total": total, "has_stems": has_stems, "has_audio": has_audio,
            "fully_timed": fully_timed, "partial": partially_timed,
            "no_timing": no_timing, "real_bpm": real_bpm,
        }}, indent=2))
        return
    
    if OUTPUT == "csv":
        writer = csv.DictWriter(sys.stdout, fieldnames=[
            "song", "bpm", "bpm_real", "bpm_source", "lyric_lines",
            "timed_lines", "timed_pct", "format", "audio", "stems", "tier"
        ])
        writer.writeheader()
        for s in statuses:
            writer.writerow(s)
        return
    
    # Table output
    RESET = "\033[0m"
    BOLD = "\033[1m"
    
    print(f"\n{BOLD}═══ Song Status Report ═══{RESET}")
    print(f"Total: {BOLD}{total}{RESET}  |  Stems: {BOLD}{has_stems}{RESET}  |  Audio: {BOLD}{has_audio}{RESET}  |  Real BPM: {BOLD}{real_bpm}{RESET}")
    print(f"Fully timed: {BOLD}{fully_timed}{RESET}  |  Partial: {BOLD}{partially_timed}{RESET}  |  No timing: {BOLD}{no_timing}{RESET}")
    print()
    print(f"{'Song':<40} {'BPM':>4} {'Timed':>6} {'Audio':>6} {'Stems':>6} {'Tier':>5}")
    print("-" * 70)
    
    for s in statuses:
        c = color_status(s)
        name = s["song"][:38]
        bpm_str = f"{s['bpm']}" if s["bpm_real"] else f"{s['bpm']}*"
        timed_str = f"{s['timed_pct']}%" if s["lyric_lines"] > 0 else "—"
        audio_str = "✓" if s["audio"] else "—"
        stems_str = "✓" if s["stems"] else "—"
        tier_str = str(s["tier"]) if s["lyric_lines"] > 0 else "—"
        
        print(f"{c}{name:<40} {bpm_str:>4} {timed_str:>6} {audio_str:>6} {stems_str:>6} {tier_str:>5}{RESET}")
    
    print()
    print("BPM* = default 120 (not verified)  |  Tier: 0=none 1=partial 2=timed 3=whisper-ready")

if __name__ == "__main__":
    main()
