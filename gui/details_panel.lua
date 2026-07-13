------------------------------------------------------------
-- Live Show Manager
-- gui/details_panel.lua
--
-- Shows details for a selected song.
------------------------------------------------------------

local DetailsPanel = {}



function DetailsPanel.render(ctx, song)

    if not song then
        return
    end

    reaper.ImGui_Separator(ctx)
    reaper.ImGui_Text(ctx, "SONG DETAILS")
    reaper.ImGui_Separator(ctx)

    reaper.ImGui_Text(
        ctx,
        "Title: " ..
        (song.title or "")
    )

    reaper.ImGui_Text(
        ctx,
        "Artist: " ..
        (song.artist or "")
    )

    reaper.ImGui_Text(
        ctx,
        "BPM: " ..
        tostring(song.bpm or 0)
    )

    reaper.ImGui_Text(
        ctx,
        "Key: " ..
        (song.key or "")
    )

    reaper.ImGui_Text(
        ctx,
        "Duration: " ..
        tostring(song.duration_bars or 0)
        .. " bars"
    )

    if song.notes and song.notes ~= "" then

        reaper.ImGui_Text(ctx, "Notes:")

        reaper.ImGui_TextWrapped(
            ctx,
            song.notes
        )

    end

end



------------------------------------------------------------

return DetailsPanel
