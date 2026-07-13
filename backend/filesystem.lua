------------------------------------------------------------
-- Live Show Manager
-- backend/filesystem.lua
------------------------------------------------------------

local FS = {}

local Util =
    App.require("backend.util")


------------------------------------------------------------
-- File Checks
------------------------------------------------------------

function FS.exists(path)

    local file =
        io.open(path, "r")

    if file then
        file:close()
        return true
    end

    return false

end


function FS.directoryExists(path)

    local info =
        reaper.EnumerateSubdirectories(
            path,
            0
        )

    return info ~= nil

end


------------------------------------------------------------
-- Reading / Writing
------------------------------------------------------------

function FS.read(path)

    local file =
        io.open(
            path,
            "r"
        )


    if not file then
        return nil
    end


    local content =
        file:read("*all")


    file:close()


    return content

end



function FS.write(path, content)

    local file =
        io.open(
            path,
            "w"
        )


    if not file then

        return false

    end


    file:write(
        content
    )


    file:close()


    return true

end


------------------------------------------------------------
-- Directory Listing
------------------------------------------------------------

function FS.listFolders(path)

    local folders = {}

    local index = 0


    while true do

        local folder =
            reaper.EnumerateSubdirectories(
                path,
                index
            )


        if not folder then
            break
        end


        table.insert(
            folders,
            folder
        )


        index = index + 1

    end


    return folders

end



function FS.listFiles(path, extension)

    local files = {}

    local index = 0


    while true do

        local file =
            reaper.EnumerateFiles(
                path,
                index
            )


        if not file then
            break
        end


        if not extension
        or file:sub(-#extension) == extension then

            table.insert(
                files,
                file
            )

        end


        index = index + 1

    end


    return files

end


------------------------------------------------------------
-- Path Helpers
------------------------------------------------------------

function FS.join(...)

    local parts =
        {...}


    local path =
        table.concat(
            parts,
            "/"
        )


    return path:gsub("//","/")

end


------------------------------------------------------------

return FS
