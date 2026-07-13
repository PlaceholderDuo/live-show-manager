------------------------------------------------------------
-- Live Show Manager
-- gui/add_song_dialog.lua
--
-- Add-song dialog with real-time search and duplicate
-- detection.
------------------------------------------------------------

local AddSongDialog = {}

local Util =
    App.require("backend.util")



function AddSongDialog.render(
    ctx,
    library,
    state
)

    local changed = false
    local submitted = false
    local cancelled = false


    if not state.open then
        return changed,
            submitted,
            cancelled
    end


    reaper.ImGui_OpenPopup(
        ctx,
        "Add Song"
    )


    local popupOpen = true
    local visible, popupOpen =
        reaper.ImGui_BeginPopupModal(
            ctx,
            "Add Song",
            popupOpen,
            reaper.ImGui_WindowFlags_AlwaysAutoResize()
        )


    if not visible then
        return changed,
            submitted,
            cancelled
    end


    reaper.ImGui_Text(
        ctx,
        "Search existing songs:"
    )


    local ret, newSearch =
        reaper.ImGui_InputText(
            ctx,
            "##add_search",
            state.searchText
        )


    if ret then
        state.searchText = newSearch
        changed = true
    end


    local query =
        Util.trim(state.searchText)

    local matches = {}

    if query ~= "" then

        for _, song in
            ipairs(library) do

            local title =
                string.lower(
                    song.title or ""
                )

            local artist =
                string.lower(
                    song.artist or ""
                )

            local q =
                string.lower(query)

            if title:find(q, 1, true)
            or artist:find(q, 1, true)
            then

                table.insert(
                    matches,
                    song
                )

            end

        end

    end


    if #matches > 0 then

        local exact = false

        for _, s in ipairs(matches) do

            if string.lower(
                s.title or ""
            ) == string.lower(
                query
            ) then
                exact = true
            end

        end


        if exact then

            reaper.ImGui_PushStyleColor(
                ctx,
                reaper.ImGui_Col_Text(),
                1.0, 0.3, 0.3, 1.0
            )

            reaper.ImGui_Text(
                ctx,
                "⚠ Song already exists!"
            )

            reaper.ImGui_PopStyleColor(ctx)

        else

            reaper.ImGui_Text(
                ctx,
                "Matching songs:"
            )

        end


        if reaper.ImGui_BeginChild(
            ctx,
            "add_search_results",
            0,
            math.min(
                #matches * 22,
                120
            )
        ) then

            for _, s in ipairs(matches) do

                local artist = s.artist
                    and s.artist ~= ""
                    and " — " .. s.artist
                    or ""

                reaper.ImGui_Text(
                    ctx,
                    s.title .. artist
                )

            end

            reaper.ImGui_EndChild(ctx)

        end


        reaper.ImGui_Separator(ctx)

    end


    reaper.ImGui_Text(ctx, "New Song Details")

    local ret2, newTitle =
        reaper.ImGui_InputText(
            ctx,
            "Title",
            state.title
        )

    if ret2 then
        state.title = newTitle
    end


    local ret3, newArtist =
        reaper.ImGui_InputText(
            ctx,
            "Artist",
            state.artist
        )

    if ret3 then
        state.artist = newArtist
    end


    local ret4, newBpmStr =
        reaper.ImGui_InputText(
            ctx,
            "BPM",
            state.bpmStr
        )

    if ret4 then
        state.bpmStr = newBpmStr
    end


    local ret5, newKey =
        reaper.ImGui_InputText(
            ctx,
            "Key",
            state.key
        )

    if ret5 then
        state.key = newKey
    end


    local ret6, newNotes =
        reaper.ImGui_InputText(
            ctx,
            "Notes",
            state.notes,
            320
        )

    if ret6 then
        state.notes = newNotes
    end


    reaper.ImGui_Separator(ctx)


    if reaper.ImGui_Button(
        ctx,
        "Browse Audio..."
    ) then

        local SongManager =
            App.require(
                "backend.song_manager"
            )

        local file =
            SongManager.pickAudioFile()

        if file then
            state.audioPath = file
        end

    end


    reaper.ImGui_SameLine(ctx)


    if state.audioPath then

        local name =
            state.audioPath:match(
                "([^/]+)$"
            )

        reaper.ImGui_Text(
            ctx,
            name or state.audioPath
        )

    else

        reaper.ImGui_Text(
            ctx,
            "No audio selected"
        )

    end


    reaper.ImGui_Separator(ctx)


    if reaper.ImGui_Button(
        ctx,
        "Add Song"
    ) then

        submitted = true

    end


    reaper.ImGui_SameLine(ctx)


    if reaper.ImGui_Button(
        ctx,
        "Cancel"
    ) then

        cancelled = true

    end


    reaper.ImGui_EndPopup(ctx)


    return changed, submitted, cancelled

end



------------------------------------------------------------

return AddSongDialog
