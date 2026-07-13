------------------------------------------------------------
-- Live Show Manager
-- builders/show_builder.lua
--
-- Orchestrator: reads MasterRig.rpp template, calls
-- region_builder and cue_builder, assembles the RPP
-- project file, and writes it to ~/ReaperShows/.
------------------------------------------------------------

local ShowBuilder = {}

local FS =
    App.require("backend.filesystem")

local Util =
    App.require("backend.util")

local RegionBuilder =
    App.require("builders.region_builder")

local CueBuilder =
    App.require("builders.cue_builder")



local HOME =
    os.getenv("HOME")

local TEMPLATE_PATH =
    Util.joinPath(
        HOME,
        "ReaperTemplates",
        "MasterRig.rpp"
    )

local SHOWS_PATH =
    Util.joinPath(
        HOME,
        "ReaperShows"
    )



function ShowBuilder.build(
    setlistSongs,
    setName,
    library
)

    if not setlistSongs
    or #setlistSongs == 0
    then
        return false,
            "Setlist is empty"
    end

    if not setName
    or setName == ""
    then
        return false,
            "Setlist has no name"
    end

    local songs =
        ShowBuilder.resolveSongs(
            setlistSongs,
            library
        )

    if #songs == 0 then
        return false,
            "No songs could be resolved"
    end

    local showDir =
        Util.joinPath(
            SHOWS_PATH,
            setName
        )

    os.execute(
        'mkdir -p "' .. showDir .. '"'
    )

    local showPath =
        Util.joinPath(
            showDir,
            setName .. ".rpp"
        )

    if not FS.exists(TEMPLATE_PATH)
    then
        return false,
            "Template not found:\n"
            .. TEMPLATE_PATH
    end

    local templateContent =
        FS.read(TEMPLATE_PATH)

    if not templateContent then
        return false,
            "Failed to read template"
    end

    local regions =
        RegionBuilder.calculate(songs)

    local regionRPP =
        RegionBuilder.toRPP(
            regions,
            0
        )

    local cues =
        CueBuilder.copyCues(
            songs,
            showDir
        )

    local cueRPP =
        CueBuilder.toRPP(
            cues,
            regions
        )

    local showRPP =
        ShowBuilder.insertIntoRPP(
            templateContent,
            regionRPP,
            cueRPP
        )

    local ok =
        FS.write(
            showPath,
            showRPP
        )

    if not ok then
        return false,
            "Failed to write show project"
    end

    return true, showPath

end



function ShowBuilder.resolveSongs(
    songIds,
    library
)

    local lookup = {}

    for _, s in ipairs(library) do
        lookup[s.id] = s
    end

    local resolved = {}

    for _, id in ipairs(songIds) do

        if lookup[id] then
            table.insert(
                resolved,
                lookup[id]
            )
        end

    end

    return resolved

end



function ShowBuilder.insertIntoRPP(
    templateContent,
    regionRPP,
    cueRPP
)

    local lines = {}

    for line in
        templateContent:gmatch(
            "([^\n]*)\n?"
        )
    do
        table.insert(lines, line)
    end

    local depth = 0
    local projectEndLine = nil

    for i, line in ipairs(lines) do

        for j = 1, #line do

            local c = line:sub(j, j)

            if c == "<" then
                depth = depth + 1
            elseif c == ">" then
                depth = depth - 1

                if depth == 0 then
                    projectEndLine = i
                end

            end

        end

    end

    if not projectEndLine then
        return templateContent
    end

    local toInsert = {}

    if regionRPP and regionRPP ~= ""
    then
        table.insert(
            toInsert,
            regionRPP
        )
    end

    if cueRPP and cueRPP ~= "" then
        table.insert(toInsert, cueRPP)
    end

    if #toInsert == 0 then
        return templateContent
    end

    local result = {}

    for i = 1, projectEndLine - 1 do
        table.insert(result, lines[i])
    end

    for _, block in ipairs(toInsert) do
        table.insert(result, block)
    end

    for i = projectEndLine, #lines do
        table.insert(result, lines[i])
    end

    return table.concat(result, "\n")

end



------------------------------------------------------------

return ShowBuilder
