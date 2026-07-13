------------------------------------------------------------
-- Live Show Manager
-- models/setlist.lua
--
-- Setlist model with file persistence.
------------------------------------------------------------

local Setlist = {}

local FS =
    App.require("backend.filesystem")

local JSON =
    App.require("backend.json")

local Util =
    App.require("backend.util")



local SETLISTS_DIR =
    Util.joinPath(
        App.root,
        "data",
        "setlists"
    )



------------------------------------------------------------
-- Constructor
------------------------------------------------------------

function Setlist.new(name, songs)

    return {
        name = name
            or "Untitled Setlist",
        songs = songs or {}
    }

end



------------------------------------------------------------
-- Persistence
------------------------------------------------------------

function Setlist.filePath(name)

    return Util.joinPath(
        SETLISTS_DIR,
        Util.slug(name) .. ".json"
    )

end



function Setlist.save(setlist)

    if not setlist or not setlist.name
    then
        return false, "No setlist name"
    end

    local data = {
        name = setlist.name,
        songs = setlist.songs or {}
    }

    local json = JSON.encode(data)
    local path =
        Setlist.filePath(setlist.name)

    local ok = FS.write(path, json)

    if not ok then
        return false,
            "Failed to write file"
    end

    return true, path

end



function Setlist.load(name)

    local path =
        Setlist.filePath(name)

    if not FS.exists(path) then
        return nil,
            "Setlist not found: "
            .. name
    end

    local raw = FS.read(path)
    local ok, data =
        pcall(JSON.decode, raw)

    if not ok or not data then
        return nil,
            "Invalid setlist file"
    end

    return Setlist.new(
        data.name,
        data.songs or {}
    ), nil

end



------------------------------------------------------------
-- List / Delete
------------------------------------------------------------

function Setlist.list()

    local files =
        FS.listFiles(
            SETLISTS_DIR,
            ".json"
        )

    local names = {}

    for _, file in ipairs(files) do

        local name =
            file:match(
                "^(.*)%.json$"
            )

        if name then
            table.insert(
                names,
                name
            )
        end

    end

    table.sort(names)

    return names

end



function Setlist.delete(name)

    local path =
        Setlist.filePath(name)

    if not FS.exists(path) then
        return false,
            "Setlist not found"
    end

    os.remove(path)

    return true, nil

end



------------------------------------------------------------

return Setlist
