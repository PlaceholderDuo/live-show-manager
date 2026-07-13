------------------------------------------------------------
-- Live Show Manager
-- gui/library_panel.lua
--
-- Renders the song library list with status icons.
------------------------------------------------------------

local LibraryPanel = {}



function LibraryPanel.render(ctx, songs, selectedIdx)

    reaper.ImGui_Separator(ctx)
    reaper.ImGui_Text(ctx, "SONG LIBRARY")
    reaper.ImGui_Separator(ctx)

    if #songs == 0 then
        reaper.ImGui_Text(ctx, "No songs found.")
        return nil
    end

    local result = selectedIdx

    if reaper.ImGui_BeginChild(ctx, "library_list", 0, 0) then

        for i, song in ipairs(songs) do

            local icon = song.valid and "✓ " or "⚠ "
            local label = icon .. song.title

            if reaper.ImGui_Selectable(
                ctx,
                label .. "##lib" .. i,
                result == i
            ) then
                result = i
            end

            if not song.valid
            and reaper.ImGui_IsItemHovered(ctx) then

                reaper.ImGui_BeginTooltip(ctx)

                for _, w in ipairs(song.warnings) do
                    reaper.ImGui_Text(ctx, "⚠ " .. w)
                end

                reaper.ImGui_EndTooltip(ctx)

            end

        end

        reaper.ImGui_EndChild(ctx)

    end

    return result

end



------------------------------------------------------------

return LibraryPanel
