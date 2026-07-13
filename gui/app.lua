------------------------------------------------------------
-- Live Show Manager
-- gui/app.lua
--
-- Main application window and GUI loop.
-- Coordinates all panels, dialogs, and actions.
------------------------------------------------------------

local AppGUI = {}



function AppGUI.run()

    local ctx =
        reaper.ImGui_CreateContext(
            "Live Show Manager"
        )

    local Library =
        App.require("backend.library")

    local Util =
        App.require("backend.util")

    local LibraryPanel =
        App.require("gui.library_panel")

    local SetlistPanel =
        App.require("gui.setlist_panel")

    local DetailsPanel =
        App.require("gui.details_panel")

    local AddSongDialog =
        App.require("gui.add_song_dialog")

    local RemoveSongDialog =
        App.require("gui.remove_song_dialog")

    local SetlistModel =
        App.require("models.setlist")


    local library = Library.scan()
    local setlist = {}
    local setlistName = nil
    local selectedLibraryIdx = nil
    local selectedSetlistIdx = nil

    local addSongState = {
        open = false,
        searchText = "",
        title = "",
        artist = "",
        bpmStr = "",
        key = "",
        notes = "",
        audioPath = nil
    }

    local removeSongState = {
        open = false,
        searchText = "",
        selectedSong = nil
    }

    local loadSetlistState = {
        open = false,
        savedNames = {},
        selectedIdx = nil
    }

    local statusMessage = nil
    local statusTimer = 0
    local showNetworkInfo = false
    local netInfo = { ip = "?", bonjour = "?", serverUp = false, fetched = false, showTroubleshoot = false }


    local function refreshNetInfo()
        local ret1, out1 = reaper.ExecProcess("ifconfig en0 2>/dev/null | grep 'inet ' | awk '{print $2}'", 0)
        if ret1 == 0 and out1 and out1 ~= "" then
            netInfo.ip = out1:match("%d+%.%d+%.%d+%.%d+") or "?"
        end
        netInfo.bonjour = "RDFX1-macbook-pro.local"
        local ret2, out2 = reaper.ExecProcess("pgrep -f 'node.*server.js' > /dev/null 2>&1 && echo 'YES' || echo 'NO'", 0)
        netInfo.serverUp = out2 and out2:match("YES") and true or false
        netInfo.fetched = true
    end


    local function setStatus(msg)
        statusMessage = msg
        statusTimer = 300
    end


    local function rescanLibrary()
        library = Library.scan()
        selectedLibraryIdx = nil
    end


    local function closeDialogs()
        addSongState.open = false
        removeSongState.open = false
        loadSetlistState.open = false
    end


    local function resetAddSongState()
        addSongState.searchText = ""
        addSongState.title = ""
        addSongState.artist = ""
        addSongState.bpmStr = ""
        addSongState.key = ""
        addSongState.notes = ""
        addSongState.audioPath = nil
    end



    local function loop()

        reaper.ImGui_SetNextWindowSize(
            ctx,
            480,
            520,
            reaper.ImGui_Cond_FirstUseEver()
        )

        local visible, open =
            reaper.ImGui_Begin(
                ctx,
                "Live Show Manager",
                true
            )

        if visible then


            ----------------------------------------------------
            -- Toolbar
            ----------------------------------------------------

            if reaper.ImGui_Button(
                ctx,
                "Add Song"
            ) then

                resetAddSongState()

                addSongState.open = true
                removeSongState.open = false
                loadSetlistState.open = false

            end

            reaper.ImGui_SameLine(ctx)

            if reaper.ImGui_Button(
                ctx,
                "Remove Song"
            ) then

                removeSongState.open = true
                addSongState.open = false
                loadSetlistState.open = false

            end

    reaper.ImGui_SameLine(ctx)

    if reaper.ImGui_Button(
        ctx,
        "Refresh Library"
    ) then

        rescanLibrary()
        setStatus(
            "Library refreshed"
        )

    end

    reaper.ImGui_SameLine(ctx)

    reaper.ImGui_PushStyleColor(
        ctx,
        reaper.ImGui_Col_Button(),
        { 0.15, 0.6, 0.3, 1.0 }
    )
    reaper.ImGui_PushStyleColor(
        ctx,
        reaper.ImGui_Col_ButtonHovered(),
        { 0.2, 0.7, 0.4, 1.0 }
    )

    if reaper.ImGui_Button(
        ctx,
        "▶ LAUNCH PERFORMANCE"
    ) then

        if not setlistName or setlistName == "" then
            setStatus("Save setlist first")
        elseif #setlist == 0 then
            setStatus("Setlist is empty")
        else
            -- Start the Node.js bridge server (launchd auto-restarts on crash)
            local controlPath = App.root .. "/web/control.sh"
            local ret, output = reaper.ExecProcess("bash '" .. controlPath .. "' start", 0)
            if ret ~= 0 then
                setStatus("Server start: " .. output)
            end

            local Runner = App.require("runner.runner")
            local r = Runner.new()
            r:loadShow(setlist, library, setlistName)
            r:start()
            setStatus("Runner started for: " .. setlistName)
        end

    end

    reaper.ImGui_PopStyleColor(ctx, 2)

    ----------------------------------------------------
    -- Network Info + Troubleshooting
    ----------------------------------------------------
    if reaper.ImGui_Button(ctx, showNetworkInfo and "▾ Network Info" or "▸ Network Info") then
        showNetworkInfo = not showNetworkInfo
        if showNetworkInfo and not netInfo.fetched then refreshNetInfo() end
    end

    if showNetworkInfo then
        reaper.ImGui_Indent(ctx)
        reaper.ImGui_Text(ctx, "Refresh interval: on open only (click to re-refresh)")

        if reaper.ImGui_Button(ctx, "⟳ Refresh") then
            refreshNetInfo()
        end

        reaper.ImGui_SameLine(ctx)
        if reaper.ImGui_Button(ctx, "Open iPhone URL") then
            reaper.ExecProcess("open http://" .. netInfo.ip .. ":3000/", 0)
        end

        reaper.ImGui_Separator(ctx)
        reaper.ImGui_Text(ctx, "Server")
        reaper.ImGui_SameLine(ctx)
        if netInfo.serverUp then
            reaper.ImGui_Text(ctx, "● RUNNING  (port 3000)")
        else
            reaper.ImGui_Text(ctx, "○ STOPPED  (tap LAUNCH PERFORMANCE above)")
        end

        reaper.ImGui_Text(ctx, "Mac IP")
        reaper.ImGui_SameLine(ctx)
        reaper.ImGui_Text(ctx, netInfo.ip .. ":3000")

        reaper.ImGui_Text(ctx, "Bonjour")
        reaper.ImGui_SameLine(ctx)
        reaper.ImGui_Text(ctx, netInfo.bonjour .. ":3000")

        reaper.ImGui_Text(ctx, "iPhone URL")
        reaper.ImGui_SameLine(ctx)
        reaper.ImGui_Text(ctx, "http://" .. netInfo.ip .. ":3000/")

        reaper.ImGui_Text(ctx, "Legacy URL")
        reaper.ImGui_SameLine(ctx)
        reaper.ImGui_Text(ctx, "http://" .. netInfo.ip .. ":3000/index.legacy.html")

        reaper.ImGui_Separator(ctx)

        if reaper.ImGui_Button(ctx, "▸ Troubleshooting") then
            netInfo.showTroubleshoot = not netInfo.showTroubleshoot
        end
        if netInfo.showTroubleshoot then
            reaper.ImGui_BulletText(ctx, "iPhone can't connect?")
            reaper.ImGui_Indent(ctx)
            reaper.ImGui_Text(ctx, "1. Both devices on same WiFi network")
            reaper.ImGui_Text(ctx, "2. Firewall is OFF (Preferences > Security)")
            reaper.ImGui_Text(ctx, "3. Open Safari, type: http://" .. netInfo.ip .. ":3000/")
            reaper.ImGui_Text(ctx, "4. Tap 'Add to Home Screen' for fullscreen")
            reaper.ImGui_Unindent(ctx)

            reaper.ImGui_BulletText(ctx, "Server won't start?")
            reaper.ImGui_Indent(ctx)
            reaper.ImGui_Text(ctx, "cd ~/Library/Application\\ Support/REAPER/")
            reaper.ImGui_Text(ctx, "  Scripts/Live\\ Show\\ Manager/web")
            reaper.ImGui_Text(ctx, "./control.sh start")
            reaper.ImGui_Unindent(ctx)

            reaper.ImGui_BulletText(ctx, "No BPM/song data on controller?")
            reaper.ImGui_Indent(ctx)
            reaper.ImGui_Text(ctx, "Click LAUNCH PERFORMANCE above")
            reaper.ImGui_Text(ctx, "This starts the Lua runner + server")
            reaper.ImGui_Unindent(ctx)

            reaper.ImGui_BulletText(ctx, "Transport buttons don't work?")
            reaper.ImGui_Indent(ctx)
            reaper.ImGui_Text(ctx, "REAPER > Preferences > Control Surfaces")
            reaper.ImGui_Text(ctx, "Add OSC: Local port 8000, Dest 127.0.0.1:9000")
            reaper.ImGui_Unindent(ctx)

            reaper.ImGui_BulletText(ctx, "Need to restart server?")
            reaper.ImGui_Indent(ctx)
            reaper.ImGui_Text(ctx, "cd ~/Library/Application\\ Support/REAPER/")
            reaper.ImGui_Text(ctx, "  Scripts/Live\\ Show\\ Manager/web")
            reaper.ImGui_Text(ctx, "./control.sh restart")
            reaper.ImGui_Unindent(ctx)
        end

        reaper.ImGui_Unindent(ctx)
    end

    reaper.ImGui_Separator(ctx)


            ----------------------------------------------------
            -- Library Panel
            ----------------------------------------------------

            local newLib =
                LibraryPanel.render(
                    ctx,
                    library,
                    selectedLibraryIdx
                )

            if newLib ~= nil then
                selectedLibraryIdx = newLib
            end


            ----------------------------------------------------
            -- Setlist Panel
            ----------------------------------------------------

            local newSet,
                add,
                remove,
                up,
                down,
                save,
                load,
                build =
                SetlistPanel.render(
                    ctx,
                    library,
                    setlist,
                    selectedSetlistIdx,
                    setlistName
                )

            if newSet ~= nil then
                selectedSetlistIdx = newSet
            end


            ----------------------------------------------------
            -- Setlist: Add song from library
            ----------------------------------------------------

            if add and selectedLibraryIdx then

                local songId =
                    library[
                        selectedLibraryIdx
                    ].id

                if not Util.contains(
                    setlist,
                    songId
                ) then

                    table.insert(
                        setlist,
                        songId
                    )

                    setStatus(
                        "Added to setlist"
                    )

                end

            end


            ----------------------------------------------------
            -- Setlist: Remove song
            ----------------------------------------------------

            if remove
            and selectedSetlistIdx then

                table.remove(
                    setlist,
                    selectedSetlistIdx
                )

                selectedSetlistIdx = nil
                setStatus("Removed from setlist")

            end


            ----------------------------------------------------
            -- Setlist: Move up
            ----------------------------------------------------

            if up
            and selectedSetlistIdx
            and selectedSetlistIdx > 1 then

                local idx =
                    selectedSetlistIdx

                setlist[idx],
                setlist[idx - 1] =
                    setlist[idx - 1],
                    setlist[idx]

                selectedSetlistIdx =
                    idx - 1

            end


            ----------------------------------------------------
            -- Setlist: Move down
            ----------------------------------------------------

            if down
            and selectedSetlistIdx
            and selectedSetlistIdx
                < #setlist then

                local idx =
                    selectedSetlistIdx

                setlist[idx],
                setlist[idx + 1] =
                    setlist[idx + 1],
                    setlist[idx]

                selectedSetlistIdx =
                    idx + 1

            end


            ----------------------------------------------------
            -- Setlist: Save
            ----------------------------------------------------

            if save then

                local ret, name =
                    reaper.GetUserInputs(
                        "Save Setlist",
                        1,
                        "Setlist name:",
                        setlistName or ""
                    )

                if ret then

                    local s =
                        SetlistModel.new(
                            name,
                            setlist
                        )

                    local ok, err =
                        SetlistModel.save(s)

                    if ok then

                        setlistName = name
                        setStatus(
                            "Saved: " .. name
                        )

                    else

                        setStatus(
                            "Save failed: "
                            .. (err or "?")
                        )

                    end

                end

            end


            ----------------------------------------------------
            -- Setlist: Load
            ----------------------------------------------------

            if load then

                loadSetlistState.savedNames =
                    SetlistModel.list()

                loadSetlistState.selectedIdx =
                    nil

                loadSetlistState.open = true

            end


            ----------------------------------------------------
            -- Setlist: Build Show
            ----------------------------------------------------

            if build then

                if not setlistName
                or setlistName == ""
                then

                    setStatus(
                        "Save setlist first"
                    )

                elseif #setlist == 0 then

                    setStatus(
                        "Setlist is empty"
                    )

                else

                    local ShowBuilder =
                        App.require(
                            "builders.show_builder"
                        )

                    local ok, result =
                        ShowBuilder.build(
                            setlist,
                            setlistName,
                            library
                        )

                    if ok then

                        setStatus(
                            "Show built: "
                            .. result
                        )

                        local ret =
                            reaper.MB(
                                "Show project created.\n"
                                .. "Open in REAPER?",
                                "Build Complete",
                                4
                            )

                        if ret == 6 then

                            reaper.OpenProject(
                                result
                            )

                        end

                    else

                        setStatus(
                            "Build failed: "
                            .. (result or "?")
                        )

                    end

                end

            end


            ----------------------------------------------------
            -- Load Setlist Dialog
            ----------------------------------------------------

            if loadSetlistState.open then

                reaper.ImGui_OpenPopup(
                    ctx,
                    "Load Setlist"
                )

                local loadOpen = true
                local loadVis, loadOpen =
                    reaper.ImGui_BeginPopupModal(
                        ctx,
                        "Load Setlist",
                        loadOpen,
                        reaper.ImGui_WindowFlags_AlwaysAutoResize()
                    )

                if loadVis then

                    local names =
                        loadSetlistState.savedNames

                    if #names == 0 then

                        reaper.ImGui_Text(
                            ctx,
                            "No saved setlists."
                        )

                    else

                        for i, name in
                            ipairs(names) do

                            local isSel =
                                loadSetlistState.selectedIdx
                                == i

                            if reaper.ImGui_Selectable(
                                ctx,
                                name
                                    .. "##loadset"
                                    .. i,
                                isSel
                            ) then
                                loadSetlistState.selectedIdx
                                    = i
                            end

                        end

                    end

                    reaper.ImGui_Separator(ctx)

                    if loadSetlistState.selectedIdx
                    then

                        if reaper.ImGui_Button(
                            ctx,
                            "Load"
                        ) then

                            local name =
                                names[
                                    loadSetlistState.selectedIdx
                                ]

                            local loaded, err =
                                SetlistModel.load(
                                    name
                                )

                            if loaded then

                                setlist =
                                    loaded.songs
                                setlistName =
                                    loaded.name
                                selectedSetlistIdx =
                                    nil

                                setStatus(
                                    "Loaded: "
                                    .. name
                                )

                            else

                                setStatus(
                                    "Load failed: "
                                    .. (err or "?")
                                )

                            end

                            loadSetlistState.open
                                = false
                            reaper.ImGui_CloseCurrentPopup(
                                ctx
                            )

                        end

                        reaper.ImGui_SameLine(ctx)

                    end

                    if reaper.ImGui_Button(
                        ctx,
                        "Cancel"
                    ) then
                        loadSetlistState.open
                            = false
                        reaper.ImGui_CloseCurrentPopup(
                            ctx
                        )
                    end

                    reaper.ImGui_EndPopup(ctx)

                end

            end


            ----------------------------------------------------
            -- Details Panel (for selected setlist song)
            ----------------------------------------------------

            if selectedSetlistIdx then

                local songId =
                    setlist[
                        selectedSetlistIdx
                    ]

                for _, s in ipairs(library) do

                    if s.id == songId then
                        DetailsPanel.render(
                            ctx,
                            s
                        )
                        break
                    end

                end

            end


            ----------------------------------------------------
            -- Status bar
            ----------------------------------------------------

            if statusMessage then

                reaper.ImGui_Separator(ctx)

                reaper.ImGui_Text(
                    ctx,
                    statusMessage
                )

                statusTimer =
                    statusTimer - 1

                if statusTimer <= 0 then
                    statusMessage = nil
                end

            end


            ----------------------------------------------------
            -- Add Song Dialog
            ----------------------------------------------------

            local addChanged,
                addSubmitted,
                addCancelled =
                AddSongDialog.render(
                    ctx,
                    library,
                    addSongState
                )

            if addSubmitted then

                local SongManager =
                    App.require(
                        "backend.song_manager"
                    )

                local bpm = tonumber(
                    addSongState.bpmStr
                ) or 0

                local data = {
                    title = addSongState.title,
                    artist = addSongState.artist,
                    bpm = bpm,
                    key = addSongState.key,
                    notes = addSongState.notes
                }

                if not data.title
                or data.title == "" then

                    setStatus(
                        "Title is required"
                    )

                else

                    local song, err =
                        SongManager.add(data)

                    if song then

                        if addSongState.audioPath
                        then

                            local AudioImport =
                                App.require(
                                    "backend.audio_import"
                                )

                            AudioImport.import(
                                addSongState.audioPath,
                                song.path
                            )

                        end

                        rescanLibrary()
                        setStatus(
                            "Added: "
                            .. data.title
                        )

                    else

                        setStatus(
                            "Error: "
                            .. (err or "?")
                        )

                    end

                end

                addSongState.open = false
                reaper.ImGui_CloseCurrentPopup(
                    ctx
                )

            end

            if addCancelled then
                addSongState.open = false
                reaper.ImGui_CloseCurrentPopup(
                    ctx
                )
            end


            ----------------------------------------------------
            -- Remove Song Dialog
            ----------------------------------------------------

            local remSubmitted,
                remCancelled =
                RemoveSongDialog.render(
                    ctx,
                    library,
                    removeSongState
                )

            if remSubmitted
            and removeSongState.selectedSong
            then

                local SongManager =
                    App.require(
                        "backend.song_manager"
                    )

                local song =
                    removeSongState.selectedSong

                local ok, err =
                    SongManager.remove(song)

                if ok then

                    local id = song.id

                    for i = #setlist, 1, -1 do
                        if setlist[i] == id then
                            table.remove(
                                setlist,
                                i
                            )
                        end
                    end

                    rescanLibrary()
                    setStatus(
                        "Removed: "
                        .. song.title
                    )

                else

                    setStatus(
                        "Error: "
                        .. (err or "?")
                    )

                end

                removeSongState.open = false
                reaper.ImGui_CloseCurrentPopup(ctx)

            end

            if remCancelled then
                removeSongState.open = false
                reaper.ImGui_CloseCurrentPopup(ctx)
            end


            reaper.ImGui_End(ctx)

        end

        if open then
            reaper.defer(loop)
        end

    end



    reaper.defer(loop)

end



------------------------------------------------------------

return AppGUI
