------------------------------------------------------------
-- Live Show Manager
-- gui/remove_song_dialog.lua
--
-- Remove-song dialog with search and confirmation.
------------------------------------------------------------

local RemoveSongDialog = {}



function RemoveSongDialog.render(
    ctx,
    library,
    state
)

    local submitted = false
    local cancelled = false


    if not state.open then
        return submitted, cancelled
    end


    reaper.ImGui_OpenPopup(
        ctx,
        "Remove Song"
    )


    local popupOpen = true
    local visible, popupOpen =
        reaper.ImGui_BeginPopupModal(
            ctx,
            "Remove Song",
            popupOpen,
            reaper.ImGui_WindowFlags_AlwaysAutoResize()
        )


    if not visible then
        return submitted, cancelled
    end


    reaper.ImGui_Text(
        ctx,
        "Search for a song to remove:"
    )


    local ret, newSearch =
        reaper.ImGui_InputText(
            ctx,
            "##remove_search",
            state.searchText
        )

    if ret then
        state.searchText = newSearch
        state.selectedSong = nil
    end


    local SongManager =
        App.require(
            "backend.song_manager"
        )

    local results =
        SongManager.search(
            library,
            state.searchText
        )


    if reaper.ImGui_BeginChild(
        ctx,
        "remove_results",
        0,
        math.min(
            #results * 24 + 8,
            200
        )
    ) then

        for _, song in
            ipairs(results) do

            local label =
                song.title

            if song.artist
            and song.artist ~= "" then
                label = label
                    .. " - "
                    .. song.artist
            end

            local isSelected =
                state.selectedSong
                and state.selectedSong.id
                    == song.id

            if reaper.ImGui_Selectable(
                ctx,
                label
                    .. "##rem"
                    .. song.id,
                isSelected
            ) then

                state.selectedSong =
                    song

            end

        end

        reaper.ImGui_EndChild(ctx)

    end


    reaper.ImGui_Separator(ctx)


    if state.selectedSong then

        reaper.ImGui_Text(
            ctx,
            "Remove: "
            .. state.selectedSong.title
        )

        if reaper.ImGui_Button(
            ctx,
            "Delete Song"
        ) then

            submitted = true

        end

    end


    reaper.ImGui_SameLine(ctx)


    if reaper.ImGui_Button(
        ctx,
        "Cancel"
    ) then

        cancelled = true

    end


    reaper.ImGui_EndPopup(ctx)


    return submitted, cancelled

end



------------------------------------------------------------

return RemoveSongDialog
