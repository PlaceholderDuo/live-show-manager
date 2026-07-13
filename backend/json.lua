------------------------------------------------------------
-- Live Show Manager
-- backend/json.lua
--
-- Lightweight JSON encoder/decoder
------------------------------------------------------------

local JSON = {}

------------------------------------------------------------
-- Decode
------------------------------------------------------------

function JSON.decode(str)

    local pos = 1


    local function skipWhitespace()

        while true do

            local c =
                str:sub(pos,pos)

            if c == " "
            or c == "\n"
            or c == "\r"
            or c == "\t" then

                pos = pos + 1

            else

                break

            end

        end

    end



    local function parseString()

        pos = pos + 1

        local result = ""


        while pos <= #str do

            local c =
                str:sub(pos,pos)


            if c == '"' then

                pos = pos + 1
                return result

            end


            result =
                result .. c


            pos =
                pos + 1

        end


        return nil

    end



    local parseValue



    local function parseObject()

        local object = {}

        pos = pos + 1


        skipWhitespace()


        while str:sub(pos,pos) ~= "}" do


            local key =
                parseString()


            skipWhitespace()


            pos = pos + 1


            local value =
                parseValue()


            object[key] =
                value


            skipWhitespace()


            if str:sub(pos,pos) == "," then

                pos = pos + 1

            end


            skipWhitespace()

        end


        pos = pos + 1


        return object

    end



    local function parseArray()

        local array = {}

        pos = pos + 1


        skipWhitespace()


        while str:sub(pos,pos) ~= "]" do


            table.insert(
                array,
                parseValue()
            )


            skipWhitespace()


            if str:sub(pos,pos) == "," then

                pos = pos + 1

            end


            skipWhitespace()

        end


        pos = pos + 1


        return array

    end



    local function parseNumber()

        local start =
            pos


        while str:sub(pos,pos)
            :match("[%d%.%-+eE]") do

            pos = pos + 1

        end


        return tonumber(
            str:sub(
                start,
                pos - 1
            )
        )

    end



    function parseValue()

        skipWhitespace()


        local c =
            str:sub(pos,pos)



        if c == '"' then

            return parseString()


        elseif c == "{" then

            return parseObject()


        elseif c == "[" then

            return parseArray()


        elseif c:match("[%d%-]") then

            return parseNumber()


        elseif str:sub(pos,pos+3) == "true" then

            pos = pos + 4
            return true


        elseif str:sub(pos,pos+4) == "false" then

            pos = pos + 5
            return false


        elseif str:sub(pos,pos+3) == "null" then

            pos = pos + 4
            return nil

        end


        return nil

    end


    return parseValue()

end



------------------------------------------------------------
-- Encode
------------------------------------------------------------

local function escapeString(str)

    str =
        str:gsub(
            "\\",
            "\\\\"
        )


    str =
        str:gsub(
            '"',
            '\\"'
        )


    return '"' .. str .. '"'

end



local function encodeValue(value)


    if type(value) == "nil" then

        return "null"


    elseif type(value) == "boolean" then

        return tostring(value)


    elseif type(value) == "number" then

        return tostring(value)


    elseif type(value) == "string" then

        return escapeString(value)


    elseif type(value) == "table" then


        local isArray = true

        local count = 0


        for k,v in pairs(value) do

            count = count + 1

            if type(k) ~= "number" then
                isArray = false
            end

        end



        local result = {}


        if isArray then


            for i = 1,count do

                table.insert(
                    result,
                    encodeValue(
                        value[i]
                    )
                )

            end


            return "[" ..
                table.concat(
                    result,
                    ","
                )
                ..
                "]"


        else


            for k,v in pairs(value) do

                table.insert(
                    result,
                    escapeString(k)
                    ..
                    ":"
                    ..
                    encodeValue(v)
                )

            end


            return "{" ..
                table.concat(
                    result,
                    ","
                )
                ..
                "}"

        end

    end


    return "null"

end



function JSON.encode(tbl)

    return encodeValue(tbl)

end



------------------------------------------------------------

return JSON
