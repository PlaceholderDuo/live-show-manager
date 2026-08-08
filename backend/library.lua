------------------------------------------------------------
-- Live Show Manager
-- backend/library.lua
--
-- Scans ~/ReaperSongs/ for song folders.
------------------------------------------------------------

local Library = {}

local Song =
    App.require("models.song")

local FS =
    App.require("backend.filesystem")

local JSON =
    App.require("backend.json")

local Util =
    App.require("backend.util")



local SONG_LIBRARY_PATH =
    Util.joinPath(
        os.getenv("HOME"),
        "ReaperSongs"
    )



function Library.scan()

    local songs = {}
    local folders =
        FS.listFolders(
            SONG_LIBRARY_PATH
        )

    for _, folder in ipairs(folders) do

        local song =
            Library.scanFolder(folder)

        table.insert(
            songs,
            song
        )

    end


    table.sort(
        songs,
        function(a, b)
            return a.title < b.title
        end
    )


    return songs

end



function Library.scanFolder(folder)

    local folderPath =
        FS.join(
            SONG_LIBRARY_PATH,
            folder
        )

    local id =
        Util.slug(folder)

    local song =
        Song.new()

    song.id = id
    song.folder = folder
    song.path = folderPath

    local warnings = {}

    local metaPath =
        FS.join(
            folderPath,
            "meta.json"
        )

    local cuePath =
        FS.join(
            folderPath,
            "cue.mid"
        )

    if not FS.exists(metaPath) then

        table.insert(
            warnings,
            "Missing meta.json"
        )

        song.title = folder

    else

        local raw =
            FS.read(metaPath)

        local ok, meta =
            pcall(
                JSON.decode,
                raw
            )

        if not ok or not meta then

            table.insert(
                warnings,
                "Invalid meta.json"
            )

            song.title = folder

        else

            if not meta.title
            or meta.title == "" then

                table.insert(
                    warnings,
                    "Missing title"
                )

                song.title = folder

            else

                song.title =
                    meta.title

            end

            if meta.artist then
                song.artist = meta.artist
            end

            if meta.bpm then
                song.bpm = meta.bpm
            end

            if meta.bpm_verified ~= nil then
                song.bpm_verified = (meta.bpm_verified == true)
            end

            if meta.time_sig then
                song.time_sig = meta.time_sig
            end

            if meta.key then
                song.key = meta.key
            end

            if meta.snapshot_id then
                song.snapshot_id =
                    meta.snapshot_id
            end

            if meta.duration_bars then
                song.duration_bars =
                    meta.duration_bars
            end

            -- Song length for the REAPER region. Authoritative source, in order:
            --   1. meta.lrc_duration_sec  (real track length from LRCLIB)
            --   2. last CLEAN chopro @time + outro  (outlier-rejected like timing.js)
            --   3. meta.duration_bars  (fallback)
            -- This makes new songs correct automatically — the region always
            -- matches the real recording, never a corrupt bar-derived value.
            local durSec = nil
            if meta.lrc_duration_sec and meta.lrc_duration_sec > 0 then
                durSec = meta.lrc_duration_sec
            else
                local choproPath =
                    FS.join(
                        folderPath,
                        "song.chopro"
                    )
                if FS.exists(choproPath) then
                    local chRaw = FS.read(choproPath) or ""
                    local times = {}
                    for line in (chRaw .. "\n"):gmatch("(.-)\n") do
                        local t = line:match("@time%s*=%s*([%d.]+)")
                        if t then
                            local tn = tonumber(t)
                            if tn and tn > 0 then table.insert(times, tn) end
                        end
                    end
                    if #times >= 4 then
                        table.sort(times)
                        local med = times[math.floor(#times / 2) + 1]
                        local maxKeep = math.max(600, med * 3)
                        local lastClean = 0
                        for _, tn in ipairs(times) do
                            if tn <= maxKeep and tn > lastClean then lastClean = tn end
                        end
                        if lastClean > 0 then
                            durSec = math.min(600, lastClean + 12)
                        end
                    end
                end
            end
            if durSec and durSec > 0 then
                local bpm = song.bpm or meta.bpm or 120
                if bpm and bpm > 0 then
                    song.duration_bars = math.max(1, math.floor(durSec * bpm / 240))
                end
            end

            if meta.notes then
                song.notes = meta.notes
            end

        end

    end

    if not FS.exists(cuePath) then

        table.insert(
            warnings,
            "Missing cue.mid"
        )

    else

        song.cue = cuePath

    end

    song.warnings = warnings
    song.valid = #warnings == 0

    return song

end





function Library.search(songs, query)

    if not query or query == "" then
        return songs
    end

    local q = string.lower(query)
    local results = {}

    for _, song in ipairs(songs) do

        local title =
            string.lower(
                song.title or ""
            )

        local artist =
            string.lower(
                song.artist or ""
            )

        if title:find(q, 1, true)
        or artist:find(q, 1, true) then

            table.insert(
                results,
                song
            )

        end

    end

    return results

end



------------------------------------------------------------

return Library
