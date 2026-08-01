#!/usr/bin/env python3
# import-songs.py — Add songs to library with chord charts + audio + stems
# ========================================================================
# Takes a text list of "Artist — Title" lines, searches Ultimate Guitar
# for chord charts, downloads audio from YouTube, creates everything.
#
# Usage:
#   echo "Eagles — Hotel California" | python3 tools/import-songs.py
#   python3 tools/import-songs.py --file songs.txt
#   python3 tools/import-songs.py --artist "Eagles" --top 15  (auto search)
#   python3 tools/import-songs.py --dry-run

import os, sys, json, re, time, subprocess, shutil, glob, hashlib, random
import aubio, numpy as np

REAPER_SONGS = os.path.expanduser("~/ReaperSongs")
AUDIO_DIR = os.path.expanduser("~/Music/SongAudio")
COOKIE_FILE = os.path.join(os.path.dirname(__file__), "..", "logs", "ug-cookies.json")
TOOLS_DIR = os.path.dirname(__file__)

args = sys.argv[1:]
DRY_RUN = "--dry-run" in args or "--dry" in args
FILE_INPUT = None
ARTIST = None
TOP = None

for i, a in enumerate(args):
    if a == "--file" and i + 1 < len(args):
        FILE_INPUT = args[i + 1]
    if a == "--artist" and i + 1 < len(args):
        ARTIST = args[i + 1]
    if a == "--top" and i + 1 < len(args):
        TOP = int(args[i + 1])

# ── UG Mobile API client (same auth as fix-bpm-gp.js) ──
def load_ug_token():
    if not os.path.exists(COOKIE_FILE): return None
    with open(COOKIE_FILE) as f:
        cookies = json.load(f)
    for c in cookies:
        if c["name"] == "bbsessionhash":
            return c["value"]
    return None

_UG_TOKEN = None
def ug_request(path, binary=False):
    global _UG_TOKEN
    if not _UG_TOKEN:
        _UG_TOKEN = load_ug_token()
    if not _UG_TOKEN:
        return None
    
    import urllib.request, ssl
    device_id = hashlib.md5(str(random.random()).encode()).hexdigest()[:16]
    now = time.strftime("%Y-%m-%d:%H", time.gmtime())
    api_key = hashlib.md5(f"{device_id}{now}createLog()".encode()).hexdigest()
    
    url = f"https://api.ultimate-guitar.com/api/v1{path}&token={_UG_TOKEN}"
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={
        "X-UG-CLIENT-ID": device_id,
        "X-UG-API-KEY": api_key,
        "User-Agent": "UGT_ANDROID/4.11.1 (Pixel; 8.1.0)",
    })
    try:
        with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
            data = resp.read()
            if binary: return data
            return json.loads(data)
    except Exception as e:
        return None

def search_ug(artist, title, is_pro=False):
    """Search UG for a tab. Returns (tab_id, song_name, artist_name, key, content, has_gp)."""
    # Try the web search API first
    query = f"{artist} {title}"
    import urllib.parse
    q = urllib.parse.quote(query)
    
    # Use UG mobile search
    result = ug_request(f"/tab/search?query={q}&type=tab&limit=5")
    if not result or result.get("status") != 200:
        return None
    
    tabs = result.get("data", {}).get("tabs", [])
    if not tabs:
        return None
    
    # Pick best match: highest rating, prefer chords type
    best = None
    for tab in tabs:
        ttype = tab.get("type_name", "").lower()
        if "chords" in ttype or "tab" in ttype:
            if not best or tab.get("rating", 0) > best.get("rating", 0):
                best = tab
    
    if not best:
        return None
    
    tab_id = best["id"]
    
    # Get full tab info
    info = ug_request(f"/tab/info?tab_id={tab_id}&tab_access_type=public")
    if not info or info.get("status") != 200:
        return None
    
    d = info.get("data", {})
    content = d.get("content", "")
    has_gp = bool(d.get("content_urls") and d.get("content_urls", {}).get("source"))
    
    return {
        "tab_id": tab_id,
        "title": d.get("song_name", title),
        "artist": d.get("artist_name", artist),
        "key": d.get("tonality_name", ""),
        "content": content,
        "has_gp": has_gp,
        "tuning": d.get("tuning", ""),
        "capo": d.get("capo", ""),
        "difficulty": d.get("difficulty", ""),
    }

# ── ChordPro generation from UG content ──
def ug_to_chopro(ug_data):
    """Convert UG tab data to ChordPro format."""
    content = ug_data.get("content", "") or ""
    title = ug_data.get("title", "Unknown")
    artist = ug_data.get("artist", "")
    key = ug_data.get("key", "")
    
    lines = content.split("\n")
    out = []
    out.append(f"{{title: {title}}}")
    out.append(f"{{artist: {artist}}}")
    out.append(f"{{key: {key}}}")
    out.append("")
    
    # Simple conversion: [ch]X[/ch] → [X], section markers to directives
    section_counters = {}
    current_section = None
    
    for line in lines:
        t = line.strip()
        if not t:
            out.append("")
            continue
        
        # Convert [ch]X[/ch] → [X] (inline chord format)
        t = re.sub(r"\[ch\]([^\]]+)\[/ch\]", r"[\1]", t)
        
        # Section detection
        sec = re.match(r"^(?:\[)?(Verse|Chorus|Solo|Bridge|Intro|Outro|Pre-Chorus|Interlude)\s*(\d*)(?:\])?(?:\s*-?\s*(.+))?$", t, re.I)
        if sec:
            stype = sec.group(1).lower()
            slabel = sec.group(3) or f"{sec.group(1)} {sec.group(2) or ''}"
            section_counters[stype] = section_counters.get(stype, 0) + 1
            
            dir_type = stype if stype in ("chorus", "bridge") else "verse"
            out.append(f"{{start_of_{dir_type}: {slabel}}}")
            current_section = stype
            continue
        
        if current_section and t:
            out.append(f"  {t}")
    
    return "\n".join(out)

# ── YouTube search + download (reused from audio-pipeline.py) ──
def search_youtube(artist, title):
    queries = [
        f"{artist} {title}",
        f"{artist} - {title}",
        f"{artist} {title} official audio",
    ]
    for query in queries:
        r = subprocess.run([
            "yt-dlp", "--no-playlist", "--flat-playlist",
            "--print", "%(id)s|%(title)s",
            f"ytsearch3:{query}"
        ], capture_output=True, text=True, timeout=20)
        for line in r.stdout.strip().split("\n"):
            parts = line.split("|", 1)
            if len(parts) == 2 and len(parts[0]) == 11:
                return parts[0], parts[1]
    return None, None

def download_audio(video_id, output_path):
    tmp = output_path + ".tmp.%(ext)s"
    for attempt in range(3):
        r = subprocess.run([
            "yt-dlp", "--no-playlist", "--no-progress",
            "-f", "bestaudio[ext=m4a]/bestaudio",
            "-o", tmp,
            f"https://www.youtube.com/watch?v={video_id}"
        ], capture_output=True, timeout=180)
        if r.returncode == 0:
            break
        time.sleep(2)
    else:
        return False
    
    for ext in ["m4a", "webm", "opus"]:
        src = output_path + f".tmp.{ext}"
        if os.path.exists(src):
            r = subprocess.run([
                "ffmpeg", "-y", "-i", src,
                "-ac", "1", "-ar", "22050", "-b:a", "48k", "-f", "mp3", output_path
            ], capture_output=True, timeout=60)
            os.remove(src)
            return r.returncode == 0
    return False

# ── Main import flow ──
def import_song(artist, title):
    safe_name = re.sub(r'[<>:"/\\|?*]', '', f"{artist} - {title}")[:80].strip()
    
    # Check if already exists (fuzzy match on title)
    existing = False
    title_lower = title.lower().replace("'", "").replace("-", " ").replace(",", "").strip()
    for d in os.listdir(REAPER_SONGS):
        if d.startswith("_") or d.startswith("."): continue
        d_lower = d.lower().replace("'", "").replace("-", " ").replace(",", "").strip()
        # Match if title is subset or exact
        if title_lower == d_lower or title_lower in d_lower or d_lower in title_lower:
            print(f"  Already exists: {d}")
            return True
    
    song_dir = os.path.join(REAPER_SONGS, safe_name)
    audio_dir = os.path.join(AUDIO_DIR, safe_name)
    
    if DRY_RUN:
        print(f"  Would import: {artist} — {title}")
        return True
    
    # Step 1: Search UG for chord chart
    print(f"  Searching UG...")
    ug = search_ug(artist, title)
    if not ug:
        print(f"  ✗ Not found on UG")
        return False
    
    print(f"  Found: {ug['title']} by {ug['artist']} (key={ug['key']}, tab_id={ug['tab_id']})")
    
    # Step 2: Generate chordpro
    chopro = ug_to_chopro(ug)
    
    # Step 3: Download audio
    print(f"  Downloading audio...")
    vid, vtitle = search_youtube(artist, title)
    if not vid:
        print(f"  ✗ Not found on YouTube")
        return False
    
    os.makedirs(audio_dir, exist_ok=True)
    full_path = os.path.join(audio_dir, "full.mp3")
    if not download_audio(vid, full_path):
        print(f"  ✗ Audio download failed")
        return False
    
    # Step 4: Detect BPM
    source = aubio.source(full_path, 0, 512)
    tempo = aubio.tempo("default", 1024, 512, source.samplerate)
    bpms = []
    while True:
        samples, read = source()
        is_beat = tempo(samples)
        if is_beat: bpms.append(tempo.get_bpm())
        if read < 512: break
    bpm = 120
    if bpms:
        stable = bpms[len(bpms)//4:]
        bpm = round(sorted(stable)[len(stable)//2])
    print(f"  BPM: {bpm}")
    
    # Step 5: Save files
    os.makedirs(song_dir, exist_ok=True)
    
    # meta.json
    meta = {
        "title": ug["title"], "artist": ug["artist"], "key": ug["key"],
        "bpm": bpm, "bpm_source": "aubio",
        "ug_tab_id": ug["tab_id"],
        "tuning": ug.get("tuning", ""),
        "capo": str(ug.get("capo", "")),
        "difficulty": ug.get("difficulty", ""),
        "duration_bars": 128,
        "time_sig": [4, 4],
        "notes": f"Imported via import-songs.py",
        "lyrics": [],
        "cue_events": [{"bar": 1, "type": "program_change", "channel": 1, "value": 0}],
    }
    with open(os.path.join(song_dir, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    
    # song.chopro
    with open(os.path.join(song_dir, "song.chopro"), "w") as f:
        f.write(chopro)
    
    size = os.path.getsize(full_path)
    print(f"  ✓ Imported ({size//1024}KB audio)")
    return True

def main():
    songs = []
    
    if FILE_INPUT:
        with open(FILE_INPUT) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"): continue
                if " — " in line:
                    artist, title = line.split(" — ", 1)
                elif " - " in line:
                    artist, title = line.split(" - ", 1)
                else:
                    continue
                songs.append((artist.strip(), title.strip()))
    
    if ARTIST and TOP:
        # Auto-generate top hits list (hardcoded for now)
        top_hits = {
            "Eagles": [
                ("Eagles", "Hotel California"),
                ("Eagles", "Take It Easy"),
                ("Eagles", "Desperado"),
                ("Eagles", "Life in the Fast Lane"),
                ("Eagles", "Take It to the Limit"),
                ("Eagles", "One of These Nights"),
                ("Eagles", "Lyin' Eyes"),
                ("Eagles", "Peaceful Easy Feeling"),
                ("Eagles", "Witchy Woman"),
                ("Eagles", "Heartache Tonight"),
                ("Eagles", "The Long Run"),
                ("Eagles", "New Kid in Town"),
                ("Eagles", "Tequila Sunrise"),
                ("Eagles", "Already Gone"),
                ("Eagles", "Best of My Love"),
            ]
        }
        songs = top_hits.get(ARTIST, [])
        print(f"Top {len(songs)} hits for {ARTIST}:")
        for a, t in songs:
            print(f"  {a} — {t}")
    
    # Read from stdin if no songs specified
    if not songs and sys.stdin.isatty() == False:
        for line in sys.stdin:
            line = line.strip()
            if not line: continue
            if " — " in line:
                artist, title = line.split(" — ", 1)
            elif " - " in line:
                artist, title = line.split(" - ", 1)
            else:
                continue
            songs.append((artist.strip(), title.strip()))
    
    if not songs:
        print("No songs specified. Use --artist <name> --top N, --file, or pipe input.")
        print("Example: echo 'Eagles — Hotel California' | python3 tools/import-songs.py")
        return
    
    print(f"\nImporting {len(songs)} songs...")
    print(f"Mode: {'DRY RUN' if DRY_RUN else 'LIVE'}\n")
    
    ok = 0
    for i, (artist, title) in enumerate(songs, 1):
        print(f"[{i}/{len(songs)}] {artist} — {title}")
        if import_song(artist, title):
            ok += 1
        print()
    
    print(f"Done: {ok}/{len(songs)} imported")

if __name__ == "__main__":
    main()
