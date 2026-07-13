---------------------------------------
-- Setlist Builder GUI
-- Version 0.2
--
-- Features:
--   Song Library
--   Search
--   Setlist Editing
--   Reordering
--
-- Requires:
--   ReaImGui
---------------------------------------


---------------------------------------
-- ReaImGui Check
---------------------------------------

if not reaper.ImGui_CreateContext then

    reaper.ShowMessageBox(
        "ReaImGui is not installed.\n\nInstall it through ReaPack.",
        "Setlist Builder",
        0
    )

    return

end



---------------------------------------
-- Load Backend
---------------------------------------

local function GetScriptPath()

    local source =
        debug.getinfo(
            1,
            "S"
        ).source

    return source:match(
        "@(.*)"
    )

end



local function LoadBackend()

    local path =
        GetScriptPath()


    local backend =
        path:gsub(
            "setlist_builder_gui.lua",
            "setlist_builder.lua"
        )


    local file =
        io.open(
            backend,
            "r"
        )


    if not file then

        reaper.ShowMessageBox(
            "Backend not found:\n\n"
            .. backend,
            "Setlist Builder",
            0
        )

        return false

    end


    file:close()


    dofile(
        backend
    )


    return true

end



if not LoadBackend() then
    return
end



---------------------------------------
-- Data
---------------------------------------

local songs =
    ScanSongLibrary()



local currentSetlist =
    {}


local selectedLibrarySong =
    nil


local selectedSetlistIndex =
    nil


local search =
    ""



---------------------------------------
-- Helpers
---------------------------------------

local function FindSongByID(id)

    for _,song in ipairs(songs) do

        if song.id == id then
            return song
        end

    end


    return nil

end



local function MatchesSearch(song)

    if search == "" then
        return true
    end


    local text =
        string.lower(
            song.title
            ..
            " "
            ..
            song.artist
        )


    return string.find(
        text,
        string.lower(search),
        1,
        true
    ) ~= nil

end



local function AlreadyInSetlist(id)

    for _,songID in ipairs(currentSetlist) do

        if songID == id then
            return true
        end

    end


    return false

end



---------------------------------------
-- Draw Library
---------------------------------------

local function DrawLibrary()

    reaper.ImGui_Text(
        ctx,
        "SONG LIBRARY"
    )


    local changed

    changed,
    search =
        reaper.ImGui_InputText(
            ctx,
            "Search",
            search
        )


    reaper.ImGui_Separator(
        ctx
    )


reaper.ImGui_BeginChild(
    ctx,
    "Library",
    300,
    400,
    true,
    0
)


    for i,song in ipairs(songs) do


        if MatchesSearch(song) then


            local prefix =
                song.valid
                and "✓ "
                or "⚠ "



            local selected =
                selectedLibrarySong == song



            if reaper.ImGui_Selectable(
                ctx,
                prefix
                ..
                song.title
                ..
                "##lib"
                ..
                i,
                selected
            ) then

                selectedLibrarySong =
                    song

            end



            if selectedLibrarySong == song then


                reaper.ImGui_Text(
                    ctx,
                    "   "
                    ..
                    song.artist
                )


                reaper.ImGui_Text(
                    ctx,
                    string.format(
                        "   %s | %s BPM",
                        song.key,
                        song.bpm
                    )
                )


                if not song.valid then

                    reaper.ImGui_Text(
                        ctx,
                        "   "
                        ..
                        table.concat(
                            song.warnings,
                            ", "
                        )
                    )

                end

            end


        end

    end


    reaper.ImGui_EndChild(
        ctx
    )

end



---------------------------------------
-- Draw Setlist
---------------------------------------

local function DrawSetlist()


    reaper.ImGui_Text(
        ctx,
        "TONIGHT'S SETLIST"
    )


    reaper.ImGui_Separator(
        ctx
    )


reaper.ImGui_BeginChild(
    ctx,
    "Setlist",
    300,
    400,
    true,
    0
)



    for i,id in ipairs(currentSetlist) do


        local song =
            FindSongByID(id)


        local name =
            song
            and song.title
            or id



        if reaper.ImGui_Selectable(
            ctx,
            i
            ..
            ". "
            ..
            name
            ..
            "##set"
            ..
            i,
            selectedSetlistIndex == i
        ) then

            selectedSetlistIndex =
                i

        end


    end



    reaper.ImGui_EndChild(
        ctx
    )

end



---------------------------------------
-- Main Window
---------------------------------------

ctx =
    reaper.ImGui_CreateContext(
        "Setlist Builder"
    )



local function Main()


    local visible,open =
        reaper.ImGui_Begin(
            ctx,
            "Setlist Builder",
            true
        )



    if visible then


        reaper.ImGui_BeginGroup(
            ctx
        )


        DrawLibrary()


        reaper.ImGui_EndGroup(
            ctx
        )


        reaper.ImGui_SameLine(
            ctx
        )


        reaper.ImGui_BeginGroup(
            ctx
        )


        DrawSetlist()


        reaper.ImGui_EndGroup(
            ctx
        )



        reaper.ImGui_Separator(
            ctx
        )



        if reaper.ImGui_Button(
            ctx,
            "Add"
        ) then


            if selectedLibrarySong
            and not AlreadyInSetlist(
                selectedLibrarySong.id
            ) then


                table.insert(
                    currentSetlist,
                    selectedLibrarySong.id
                )

            end

        end



        reaper.ImGui_SameLine(
            ctx
        )


        if reaper.ImGui_Button(
            ctx,
            "Remove"
        ) then


            if selectedSetlistIndex then


                table.remove(
                    currentSetlist,
                    selectedSetlistIndex
                )


                selectedSetlistIndex=nil

            end


        end



        reaper.ImGui_SameLine(
            ctx
        )


        if reaper.ImGui_Button(
            ctx,
            "Up"
        ) then


            local i =
                selectedSetlistIndex


            if i and i > 1 then

                currentSetlist[i],
                currentSetlist[i-1]
                =
                currentSetlist[i-1],
                currentSetlist[i]


                selectedSetlistIndex =
                    i-1

            end

        end



        reaper.ImGui_SameLine(
            ctx
        )


        if reaper.ImGui_Button(
            ctx,
            "Down"
        ) then


            local i =
                selectedSetlistIndex


            if i and i < #currentSetlist then


                currentSetlist[i],
                currentSetlist[i+1]
                =
                currentSetlist[i+1],
                currentSetlist[i]


                selectedSetlistIndex =
                    i+1

            end

        end



        reaper.ImGui_End(
            ctx
        )


    end



    if open then

        reaper.defer(
            Main
        )

    end


end



Main()
