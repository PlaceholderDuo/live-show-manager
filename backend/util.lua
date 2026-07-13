------------------------------------------------------------
-- Live Show Manager
-- backend/util.lua
------------------------------------------------------------

local Util = {}

------------------------------------------------------------
-- Logging
------------------------------------------------------------

function Util.log(message)
    reaper.ShowConsoleMsg(tostring(message) .. "\n")
end

function Util.clearConsole()
    reaper.ClearConsole()
end

------------------------------------------------------------
-- Strings
------------------------------------------------------------

function Util.trim(str)
    return (str:gsub("^%s*(.-)%s*$", "%1"))
end

function Util.slug(str)

    str = string.lower(str)

    str = str:gsub("[^%w%s]", "")

    str = str:gsub("%s+", "_")

    return str

end

function Util.startsWith(str, start)
    return str:sub(1, #start) == start
end

function Util.endsWith(str, ending)

    return ending == ""
        or str:sub(-#ending) == ending

end

------------------------------------------------------------
-- Tables
------------------------------------------------------------

function Util.contains(tbl, value)

    for _, v in ipairs(tbl) do
        if v == value then
            return true
        end
    end

    return false

end

function Util.indexOf(tbl, value)

    for i, v in ipairs(tbl) do
        if v == value then
            return i
        end
    end

    return nil

end

function Util.shallowCopy(tbl)

    local copy = {}

    for k, v in pairs(tbl) do
        copy[k] = v
    end

    return copy

end

function Util.deepCopy(orig)

    if type(orig) ~= "table" then
        return orig
    end

    local copy = {}

    for k, v in pairs(orig) do
        copy[k] = Util.deepCopy(v)
    end

    return copy

end

------------------------------------------------------------
-- Paths
------------------------------------------------------------

function Util.scriptDirectory()

    local source =
        debug.getinfo(2, "S").source

    local path =
        source:match("@(.*/)")

    return path

end

function Util.joinPath(...)

    local parts = {...}

    return table.concat(parts, "/")
        :gsub("//", "/")

end

------------------------------------------------------------
-- Pretty Print
------------------------------------------------------------

function Util.dump(tbl, indent)

    indent = indent or 0

    if type(tbl) ~= "table" then
        Util.log(tbl)
        return
    end

    for k, v in pairs(tbl) do

        local prefix =
            string.rep(" ", indent)

        if type(v) == "table" then

            Util.log(prefix .. tostring(k) .. ":")

            Util.dump(v, indent + 4)

        else

            Util.log(
                prefix ..
                tostring(k) ..
                " = " ..
                tostring(v)
            )

        end

    end

end

------------------------------------------------------------

return Util
