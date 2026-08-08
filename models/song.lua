------------------------------------------------------------
-- Live Show Manager
-- models/song.lua
------------------------------------------------------------

local Song = {}



function Song.new(overrides)

    local song = {
        id = "",
        title = "",
        artist = "",
        bpm = 0,
        bpm_verified = false,
        time_sig = { 4, 4 },
        key = "",
        snapshot_id = 0,
        duration_bars = 0,
        notes = "",
        cue = "",
        valid = true,
        warnings = {}
    }

    if overrides then
        for k, v in pairs(overrides) do
            song[k] = v
        end
    end

    return song

end



function Song.fromMeta(id, folder, meta)

    local song = Song.new()

    song.id = id
    song.folder = folder

    if meta.title then
        song.title = meta.title
    end

    if meta.artist then
        song.artist = meta.artist
    end

    if meta.bpm then
        song.bpm = meta.bpm
    end

    -- bpm_verified: true only when the tempo has a trusted source (LRCLIB-derived,
    -- gpif, or human tap-verified). The runner refuses to push an unverified BPM
    -- into REAPER's tempo (avoids stretching tempo-synced audio + wrong click).
    if meta.bpm_verified ~= nil then
        song.bpm_verified = meta.bpm_verified == true
    end

    if meta.time_sig then
        song.time_sig = meta.time_sig
    end

    if meta.key then
        song.key = meta.key
    end

    if meta.snapshot_id then
        song.snapshot_id = meta.snapshot_id
    end

    if meta.duration_bars then
        song.duration_bars = meta.duration_bars
    end

    if meta.notes then
        song.notes = meta.notes
    end

    return song

end



function Song.validate(song)

    local warnings = {}

    if not song.title or song.title == "" then
        table.insert(warnings, "Missing title")
    end

    if not song.artist or song.artist == "" then
        table.insert(warnings, "Missing artist")
    end

    if song.bpm == 0 then
        table.insert(warnings, "Missing BPM")
    end

    song.warnings = warnings
    song.valid = #warnings == 0

    return song.valid, warnings

end



function Song.isValid(song)

    return song.valid ~= false
        and #(song.warnings or {}) == 0

end



------------------------------------------------------------

return Song
