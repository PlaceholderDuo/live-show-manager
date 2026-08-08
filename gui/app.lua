------------------------------------------------------------
-- Live Show Manager
-- gui/app.lua
--
-- Launch/status console. The TUI (singer server) is now the
-- playlist manager: build/load/edit your set there and it is
-- pushed automatically to this bridge. This window only:
--   1. Launches the performance Runner (which hot-follows
--      data/setlists/_last_session.json from the web server)
--   2. Shows live follow / transport status
--   3. Network + troubleshooting info for the phones
------------------------------------------------------------

local AppGUI = {}

function AppGUI.run()

    local ctx =
        reaper.ImGui_CreateContext(
            "Live Show Manager"
        )

    local Util =
        App.require("backend.util")

    local Runner =
        App.require("runner.runner")

    local FS =
        App.require("backend.filesystem")

    local JSON =
        App.require("backend.json")

    local FOLLOW_SESSION_PATH =
        Util.joinPath(
            App.root,
            "data",
            "setlists",
            "_last_session.json"
        )

    local runner = nil

    local followName = ""
    local followCount = 0
    local followPreview = ""

    local statusMessage = nil
    local statusTimer = 0

    local showNetworkInfo = false
    local netInfo = {
        ip = "?",
        bonjour = "?",
        serverUp = false,
        fetched = false,
        showTroubleshoot = false
    }

    local refreshTimer = 0

    ------------------------------------------------------------
    -- Helpers
    ------------------------------------------------------------

    local function setStatus(msg)
        statusMessage = msg
        statusTimer = 300
    end

    local function refreshNetInfo()

        local ok1, out1 =
            reaper.ExecProcess(
                "ifconfig en0 2>/dev/null | grep 'inet ' | awk '{print $2}'",
                0
            )

        if ok1 == 0 and out1 and out1 ~= "" then
            netInfo.ip = out1:match("%d+%.%d+%.%d+%.%d+") or "?"
        end

        local ok2, out2 =
            reaper.ExecProcess(
                "pgrep -f 'node.*server.js' > /dev/null 2>&1 && echo YES || echo NO",
                0
            )

        netInfo.serverUp = out2 and out2:match("YES") and true or false
        netInfo.fetched = true
    end

    -- Preview the currently-pushed set (without launching) so the window
    -- shows what LAUNCH will follow. Runs every ~2s.
    local function refreshFollowPreview()
        local ok, raw =
            pcall(FS.read, FOLLOW_SESSION_PATH)

        if not ok or not raw or raw == "" then
            followPreview = "No live set pushed yet"
            return
        end

        local okd, data =
            pcall(JSON.decode, raw)

        if not okd or not data or not data.songs then
            followPreview = "Live set: unreadable"
            return
        end

        followName = data.name or "Live set"
        followCount = #data.songs
        local title = data.songs[1] and data.songs[1].title or ""
        followPreview = "(" .. followCount .. " songs)"
            .. (title ~= "" and (" — starts with \"" .. title .. "\"") or "")
    end

    -- Pull the CURRENT TUI band set into the live session so the runner
    -- reflects the TUI's queue even if a push hasn't happened yet. Short
    -- curl timeout keeps this from blocking REAPER on a slow/missing server.
    local function pullTuiSet()
        reaper.ExecProcess(
            "curl -s -m 3 -X POST http://localhost:3000/api/local/setlist/pull-tui "
            .. "-H 'Content-Type: application/json' -d '{}' > /dev/null 2>&1",
            4000
        )
    end

    local function launch()

        -- Always reflect the CURRENT TUI band set before going live.
        pullTuiSet()

        -- Idempotent: launchd keeps the web server up anyway.
        local controlPath =
            App.root .. "/web/control.sh"

        local ret, output =
            reaper.ExecProcess(
                "bash '" .. controlPath .. "' start",
                0
            )

        if ret ~= 0 then
            setStatus("Server start: " .. tostring(output or ""))
        end

        local r = Runner.new()
        local ok, err = r:loadFollowShow()

        if ok then
            runner = r
            r:start()
            followName = r.show and r.show.name or "Live set"
            followCount = r.totalSongs
            setStatus(
                "FOLLOWING TUI set: "
                .. followName
                .. " ("
                .. r.totalSongs
                .. " songs)"
            )
        else
            setStatus(err or "No live set yet")
        end
    end

    ------------------------------------------------------------
    -- GUI loop
    ------------------------------------------------------------

    local function loop()

        reaper.ImGui_SetNextWindowSize(
            ctx,
            460,
            350,
            reaper.ImGui_Cond_FirstUseEver()
        )

        local visible, open =
            reaper.ImGui_Begin(
                ctx,
                "Live Show Manager",
                true
            )

        if visible then

            refreshTimer = refreshTimer + 1
            if refreshTimer >= 120 then
                refreshTimer = 0
                refreshFollowPreview()
            end

            ----------------------------------------------------
            -- Launch / follow status
            ----------------------------------------------------

            reaper.ImGui_Text(
                ctx,
                "Playlist manager: the TUI (singer server). This window launches the REAPER runner."
            )

            reaper.ImGui_Separator(ctx)

            reaper.ImGui_PushStyleColor(
                ctx,
                reaper.ImGui_Col_Button(),
                Util.rgba(0.15, 0.6, 0.3, 1.0)
            )
            reaper.ImGui_PushStyleColor(
                ctx,
                reaper.ImGui_Col_ButtonHovered(),
                Util.rgba(0.2, 0.7, 0.4, 1.0)
            )

            if reaper.ImGui_Button(
                ctx,
                "▶ LAUNCH PERFORMANCE"
            ) then
                launch()
            end

            reaper.ImGui_PopStyleColor(ctx, 2)

            if runner then
                reaper.ImGui_Text(
                    ctx,
                    "● FOLLOWING: "
                    .. followName
                    .. " ("
                    .. followCount
                    .. " songs)"
                )
                local now = runner.currentSong
                    and runner.currentSong.title
                    or (runner.playing and "playing..." or "standby")
                reaper.ImGui_Text(ctx, "Current: " .. now)
            else
                reaper.ImGui_Text(
                    ctx,
                    "○ Standby — tap LAUNCH to follow the TUI live set"
                )
                reaper.ImGui_Text(
                    ctx,
                    "Set ready: " .. followPreview
                )
            end

            if runner then
                reaper.ImGui_SameLine(ctx)
                if reaper.ImGui_Button(ctx, "Restart") then
                    Runner.stop(runner)
                    launch()
                end
            end

            reaper.ImGui_Separator(ctx)

            ----------------------------------------------------
            -- Network info + troubleshooting
            ----------------------------------------------------

            if reaper.ImGui_Button(
                ctx,
                showNetworkInfo and "▾ Network Info" or "▸ Network Info"
            ) then
                showNetworkInfo = not showNetworkInfo
                if showNetworkInfo and not netInfo.fetched then
                    refreshNetInfo()
                end
            end

            if showNetworkInfo then

                reaper.ImGui_Indent(ctx)
                reaper.ImGui_Text(ctx, "Refresh interval: on open only (click to re-refresh)")

                if reaper.ImGui_Button(ctx, "⟳ Refresh") then
                    refreshNetInfo()
                end

                reaper.ImGui_SameLine(ctx)
                if reaper.ImGui_Button(ctx, "Open iPhone URL") then
                    reaper.ExecProcess(
                        "open http://" .. netInfo.ip .. ":3000/",
                        0
                    )
                end

                reaper.ImGui_Separator(ctx)

                reaper.ImGui_Text(ctx, "Server")
                reaper.ImGui_SameLine(ctx)
                if netInfo.serverUp then
                    reaper.ImGui_Text(ctx, "● RUNNING  (port 3000)")
                else
                    reaper.ImGui_Text(ctx, "○ STOPPED")
                end

                reaper.ImGui_Text(ctx, "Mac IP")
                reaper.ImGui_SameLine(ctx)
                reaper.ImGui_Text(ctx, netInfo.ip .. ":3000")

                reaper.ImGui_Text(ctx, "iPhone URL")
                reaper.ImGui_SameLine(ctx)
                reaper.ImGui_Text(ctx, "http://" .. netInfo.ip .. ":3000/")

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

                    reaper.ImGui_BulletText(ctx, "No song data on the controller?")
                    reaper.ImGui_Indent(ctx)
                    reaper.ImGui_Text(ctx, "1. TUI: import your playlist (band set)")
                    reaper.ImGui_Text(ctx, "2. Click LAUNCH PERFORMANCE here")
                    reaper.ImGui_Unindent(ctx)

                    reaper.ImGui_BulletText(ctx, "Transport buttons don't work?")
                    reaper.ImGui_Indent(ctx)
                    reaper.ImGui_Text(ctx, "REAPER > Preferences > Control Surfaces")
                    reaper.ImGui_Text(ctx, "Add OSC: Local port 8000, Dest 127.0.0.1:9000")
                    reaper.ImGui_Unindent(ctx)

                end

                reaper.ImGui_Unindent(ctx)

            end

            reaper.ImGui_Separator(ctx)

            ----------------------------------------------------
            -- Status bar
            ----------------------------------------------------

            if statusMessage then

                reaper.ImGui_Separator(ctx)

                reaper.ImGui_Text(ctx, statusMessage)

                statusTimer = statusTimer - 1

                if statusTimer <= 0 then
                    statusMessage = nil
                end

            end

            reaper.ImGui_End(ctx)

        end

        if open then
            reaper.defer(loop)
        end

    end

    refreshFollowPreview()
    refreshNetInfo()

    -- Pull from the TUI right when the script opens, then preview it.
    pullTuiSet()
    refreshFollowPreview()

    reaper.defer(loop)

end

------------------------------------------------------------

return AppGUI