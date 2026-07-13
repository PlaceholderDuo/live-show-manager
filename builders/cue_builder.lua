------------------------------------------------------------
-- Live Show Manager
-- builders/cue_builder.lua
--
-- Handles MIDI cue file operations and generates
-- RPP track blocks for cue items.
------------------------------------------------------------

local CueBuilder = {}

local FS =
    App.require("backend.filesystem")

local Util =
    App.require("backend.util")



function CueBuilder.copyCues(songs, showDir)

    local cueDir =
        Util.joinPath(showDir, "cues")

    os.execute(
        'mkdir -p "' .. cueDir .. '"'
    )

    local copied = {}

    for _, song in ipairs(songs) do

        if song.cue
        and song.cue ~= ""
        and FS.exists(song.cue)
        then

            local name =
                Util.slug(
                    song.title or song.id
                )
                .. ".mid"

            local dest =
                Util.joinPath(
                    cueDir,
                    name
                )

            os.execute(
                string.format(
                    'cp "%s" "%s"',
                    song.cue,
                    dest
                )
            )

            table.insert(
                copied,
                {
                    song = song,
                    destPath = dest,
                    fileName = name
                }
            )

        end

    end

    return copied

end



function CueBuilder.toRPP(cues, regions)

    if #cues == 0 then
        return ""
    end

    local items = {}

    for _, cue in ipairs(cues) do

        local name =
            cue.song.title or cue.song.id
            or "cue"

        local relative =
            "cues/" .. cue.fileName

        local startTime = 0
        local duration = 8

        for _, r in ipairs(regions) do

            if r.song.id == cue.song.id
            then

                startTime = r.startTime
                duration = r.duration
                break

            end

        end

        local item = string.format(
            [=[
    <ITEM
      POSITION %.6f 0 0 0
      LENGTH %.6f 0 0 0
      LOOP 1
      SOURCE MIDI
        HASDATA 0
        FILE "%s"
      >
]=],
            startTime,
            duration,
            relative
        )

        table.insert(items, item)

    end

    local trackItems =
        table.concat(items, "")

    local track = string.format(
        [=[
  <TRACK
    NAME "Cues"
    PEAKCOL 16576
    BEAT -1
    VOLPAN 0 1 -1 -1 1
    MUTESOLO 0 0 0
%s  >
]=],
        trackItems
    )

    return track

end



------------------------------------------------------------

return CueBuilder
