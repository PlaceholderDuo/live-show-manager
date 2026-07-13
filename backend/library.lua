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
