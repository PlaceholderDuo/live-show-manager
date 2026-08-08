# BPM Validation Pipeline (Pass / Go-Deeper)

Status: **PLANNED** (not yet built)
Owner: Live Show Manager

## Problem

The lyric-timing pipeline imported LRCLIB synced lyrics → `@bar=N` → `@time=N`,
converting through `meta.bpm`. `meta.bpm` comes from aubio (255 songs) or gpif
(24 songs) and is wrong ~1/3 of the time, which **stretches** otherwise-correct
LRCLIB timestamps. Outlier rejection fixed 280/290 songs, but BPM accuracy
still matters for two independent needs:

1. **The click** — must be at the real tempo (show-critical).
2. **Region lengths** in REAPER — must match the real song.

LRCLIB's lyric `@time` seconds are ground truth and should stay **decoupled
from BPM** (already done in `web/public/timing.js`). What we need is a trusted
BPM value.

## Signal sources

| Source | What it gives | Reliability | Availability |
|--------|---------------|-------------|--------------|
| LRCLIB `duration` | real track length (sec) | High | Returned by API; NOT currently stored in meta.json |
| `meta.bpm` (aubio) | auto-detected tempo | ~2/3 reliable | 255 songs |
| `meta.bpm` (gpif) | tempo from GuitarPro | High | 24 songs |
| chopro `@bar` count | bar span | Medium (some inflated) | 290 songs |
| Local audio `*_ref.mp3` | actual recording | N/A | 1 song today |

## Design

### Track 1 — Lyric timing (DONE, decoupled)
`timing.js` trusts `@time` (LRCLIB seconds), outlier-rejects corrupt values,
caps implausible times. Independent of BPM. Do not regress this.

### Track 2 — BPM validation

**Capture the anchor (cheap):**
- `lrc-to-bars.js` stores LRCLIB `duration` → `meta.json["lrc_duration_sec"]`
  on next import (re-fetch or new songs).
- Implied BPM = `maxBar × 240 / lrc_duration_sec`.

**PASS rule (cheap, offline):**
- If `meta.bpm_source === "gpif"` → trust (proven reliable).
- Else if `lrc_duration_sec` exists AND `|meta.bpm − impliedBpm| / impliedBpm ≤ 0.08`
  → aubio confirmed → trust `meta.bpm`.
- Else → **go deeper**.

**GO-DEEPER rule (audio, when available):**
- For songs with local audio (`<song>/*_ref.mp3` or `*_ref.m4a/wav`):
  1. Extract BPM from a **long sample** (~60–120s) with a **secondary estimator**
     (e.g. aubio `tempo` CLI on a longer window, or librosa `beat.beat_track`).
  2. Cross-check the secondary result against `meta.bpm` AND the LRCLIB-implied
     BPM. Accept only a majority/agreement value.
  3. If confirmed → write `meta.json["bpm"]` (corrected) + `bpm_source="verified"`.
- Songs with no audio and no confirmation → keep `meta.bpm` but mark
  `bpm_verified: false` so the click/region layer can flag them.

**Consumers:**
- Runner `_setSongBpm` (click) + region builder use `meta.bpm` when verified,
  else fall back (current behavior) + a sync-health "BPM unverified" warning.
- `timing.js` continues using `@time` directly regardless.

## Rollout

1. **Cheap now**: capture `lrc_duration_sec` on re-fetch; add the implied-BPM
   comparison; flag unverified BPMs in sync-health. No audio needed. Covers the
   click correctness for the majority.
2. **Audio deep**: add a BPM-extraction tool (`web/tools/verify-bpm.js`) that
   runs the secondary estimator on `<song>/*_ref.*` for songs the cheap check
   fails. Runs per-song; needs the audio files to exist.
3. **Metadata**: extend meta.json with `lrc_duration_sec`, `bpm_source`,
   `bpm_confidence`, `bpm_verified`.

## Open questions

- Where do audio files live / naming convention beyond `Beds Are Burning`?
  (`<song>/<Title>_ref.mp3` + stems seen once.)
- Secondary estimator choice (aubio CLI vs librosa) — librosa is pip-only and
  heavy; aubio CLI is already used. Confirm acceptable.
- How to auto-fetch LRCLIB duration for existing 289 songs (one re-fetch pass,
  like `re-sync-timing.js`).
