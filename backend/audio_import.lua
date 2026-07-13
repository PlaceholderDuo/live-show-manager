------------------------------------------------------------
-- Live Show Manager
-- backend/audio_import.lua
--
-- Audio import and optional downsampling via ffmpeg.
------------------------------------------------------------

local AudioImport = {}

local FS =
    App.require("backend.filesystem")



function AudioImport.hasFFmpeg()

    local handle =
        io.popen(
            "which ffmpeg 2>/dev/null"
        )

    local result =
        handle:read("*a")

    handle:close()

    return result ~= nil
        and result ~= ""

end



function AudioImport.import(sourcePath, destFolder)

    if not FS.exists(sourcePath) then
        return nil,
            "Source file not found"
    end

    if not FS.exists(destFolder) then

        local ok =
            os.execute(
                'mkdir -p "'
                .. destFolder
                .. '"'
            )

        if not ok then
            return nil,
                "Failed to create folder"
        end

    end

    local filename =
        sourcePath:match(
            "([^/]+)$"
        )

    local destPath =
        FS.join(
            destFolder,
            filename
        )

    if AudioImport.hasFFmpeg() then

        local cmd = string.format(
            'ffmpeg -y -i "%s"'
            .. ' -ac 1 -ar 22050 -b:a 48k'
            .. ' "%s" 2>/dev/null',
            sourcePath,
            destPath
        )

        local ok =
            os.execute(cmd)

        if not ok then

            return nil,
                "Downsample failed"

        end

    else

        local ok =
            os.execute(
                string.format(
                    'cp "%s" "%s"',
                    sourcePath,
                    destPath
                )
            )

        if not ok then
            return nil,
                "Copy failed"
        end

    end

    return destPath, nil

end



------------------------------------------------------------

return AudioImport
