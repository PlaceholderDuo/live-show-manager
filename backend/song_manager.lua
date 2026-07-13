------------------------------------------------------------
-- Live Show Manager
-- backend/song_manager.lua
--
-- Song CRUD: add, remove, search, duplicate detection.
------------------------------------------------------------

local SongManager = {}

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



------------------------------------------------------------
-- Search
------------------------------------------------------------

function SongManager.search(songs, query)

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



function SongManager.findExact(songs, title)

    local q = string.lower(
        Util.trim(title)
    )

    for _, song in ipairs(songs) do

        if string.lower(
            song.title or ""
        ) == q then

            return song

        end

    end

    return nil

end



------------------------------------------------------------
-- Add
------------------------------------------------------------

function SongManager.buildMeta(song)

    local meta = {}

    if song.title
    and song.title ~= "" then
        meta.title = song.title
    end

    if song.artist
    and song.artist ~= "" then
        meta.artist = song.artist
    end

    if song.bpm and song.bpm > 0 then
        meta.bpm = song.bpm
    end

    if song.key and song.key ~= "" then
        meta.key = song.key
    end

    if song.snapshot_id
    and song.snapshot_id > 0 then
        meta.snapshot_id =
            song.snapshot_id
    end

    if song.duration_bars
    and song.duration_bars > 0 then
        meta.duration_bars =
            song.duration_bars
    end

    if song.notes
    and song.notes ~= "" then
        meta.notes = song.notes
    end

    return meta

end



function SongManager.add(data)

    local id = Util.slug(data.title)
    local folder = data.title

    local folderPath =
        FS.join(
            SONG_LIBRARY_PATH,
            folder
        )

    if FS.exists(folderPath) then
        return nil,
            "Folder already exists: "
            .. folder
    end

    local ok = os.execute(
        'mkdir -p "'
        .. folderPath
        .. '"'
    )

    if not ok then
        return nil,
            "Failed to create folder"
    end

    local meta =
        SongManager.buildMeta(data)

    local json =
        JSON.encode(meta)

    FS.write(
        FS.join(
            folderPath,
            "meta.json"
        ),
        json
    )

    local song = Song.new()
    song.id = id
    song.folder = folder
    song.path = folderPath
    song.title = data.title

    if data.artist then
        song.artist = data.artist
    end

    if data.bpm then
        song.bpm = data.bpm
    end

    if data.key then
        song.key = data.key
    end

    if data.notes then
        song.notes = data.notes
    end

    return song, nil

end



------------------------------------------------------------
-- Remove
------------------------------------------------------------

function SongManager.remove(song)

    if not song or not song.path then
        return false,
            "No song path"
    end

    if not FS.exists(song.path) then
        return false,
            "Folder does not exist"
    end

    local ok = os.execute(
        'rm -rf "'
        .. song.path
        .. '"'
    )

    if not ok then
        return false,
            "Failed to remove folder"
    end

    return true, nil

end



------------------------------------------------------------
-- Audio file
------------------------------------------------------------

function SongManager.pickAudioFile()

    local title = "Select audio file"
    local extensions =
        "Audio files:*.mp3;*.wav;*.ogg;*.flac;*.m4a"

    local file = reaper.GetUserFileNameForRead(
        "",
        title,
        extensions
    )

    if file and file ~= "" then
        return file
    end

    return nil

end



------------------------------------------------------------

return SongManager
