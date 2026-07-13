------------------------------------------------------------
-- Live Show Manager
-- builders/region_builder.lua
--
-- Calculates REAPER region positions from song data
-- and generates RPP MARKER lines.
------------------------------------------------------------

local RegionBuilder = {}



function RegionBuilder.calculate(songs)

    local regions = {}
    local cursor = 0

    for _, song in ipairs(songs) do

        local bpm = (song.bpm and song.bpm > 0)
            and song.bpm
            or 120

        local bars = (song.duration_bars
            and song.duration_bars > 0)
            and song.duration_bars
            or 32

        local duration =
            (bars * 4 * 60) / bpm

        table.insert(
            regions,
            {
                song = song,
                startTime = cursor,
                duration = duration
            }
        )

        cursor = cursor + duration

    end

    return regions

end



function RegionBuilder.toRPP(regions, startIndex)

    local lines = {}
    local idx = startIndex or 0

    for _, r in ipairs(regions) do

        local label =
            r.song.title
            or r.song.id
            or "Song"

        local posStr = string.format(
            "%.6f",
            r.startTime
        )

        local lenStr = string.format(
            "%.6f",
            r.duration
        )

        table.insert(
            lines,
            '  MARKER '
            .. idx .. ' '
            .. posStr .. ' '
            .. lenStr .. ' "'
            .. label .. '" 0'
        )

        idx = idx + 1

    end

    return table.concat(lines, "\n")

end



------------------------------------------------------------

return RegionBuilder
