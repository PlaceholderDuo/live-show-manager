------------------------------------------------------------
-- Live Show Manager
-- gui/setlist_panel.lua
--
-- Renders the setlist and action buttons.
------------------------------------------------------------

local SetlistPanel = {}



function SetlistPanel.render(
    ctx,
    library,
    setlist,
    selectedIdx,
    setName
)

    reaper.ImGui_Separator(ctx)
    reaper.ImGui_Text(ctx, "TONIGHT'S SETLIST")
    reaper.ImGui_Separator(ctx)

    local result = selectedIdx
    local add = false
    local remove = false
    local up = false
    local down = false
    local save = false
    local load = false
    local build = false

    if setName and setName ~= "" then
        reaper.ImGui_Text(ctx, setName)
    end

    if #setlist == 0 then

        reaper.ImGui_Text(ctx, "(empty)")

    else

        if reaper.ImGui_BeginChild(
            ctx,
            "setlist_list",
            0,
            0
        ) then

            for i, songId in ipairs(setlist) do

                local title = songId

                for _, s in ipairs(library) do
                    if s.id == songId then
                        title = s.title
                        break
                    end
                end

                if reaper.ImGui_Selectable(
                    ctx,
                    i .. ". " ..
                    title ..
                    "##set" .. i,
                    result == i
                ) then
                    result = i
                end

            end

            reaper.ImGui_EndChild(ctx)

        end

    end

    reaper.ImGui_Separator(ctx)

    add = reaper.ImGui_Button(
        ctx,
        "Add to Setlist"
    )

    reaper.ImGui_SameLine(ctx)

    remove = reaper.ImGui_Button(
        ctx,
        "Remove"
    )

    reaper.ImGui_SameLine(ctx)

    up = reaper.ImGui_Button(
        ctx,
        "Up"
    )

    reaper.ImGui_SameLine(ctx)

    down = reaper.ImGui_Button(
        ctx,
        "Down"
    )


    reaper.ImGui_Separator(ctx)

    save = reaper.ImGui_Button(
        ctx,
        "Save Setlist"
    )

    reaper.ImGui_SameLine(ctx)

    load = reaper.ImGui_Button(
        ctx,
        "Load Setlist"
    )

    reaper.ImGui_Separator(ctx)

    reaper.ImGui_PushStyleColor(
        ctx,
        reaper.ImGui_Col_Button(),
        {
            0.2,
            0.2,
            0.2,
            1.0
        }
    )

    reaper.ImGui_PushStyleColor(
        ctx,
        reaper.ImGui_Col_ButtonHovered(),
        {
            0.3,
            0.3,
            0.3,
            1.0
        }
    )

    reaper.ImGui_PushStyleColor(
        ctx,
        reaper.ImGui_Col_ButtonActive(),
        {
            0.25,
            0.25,
            0.25,
            1.0
        }
    )

    build = reaper.ImGui_Button(
        ctx,
        "BUILD SHOW"
    )

    reaper.ImGui_PopStyleColor(ctx, 3)

    if reaper.ImGui_IsItemHovered(ctx) then

        reaper.ImGui_BeginTooltip(ctx)

        reaper.ImGui_Text(
            ctx,
            "Generate REAPER show project"
            .. " from current setlist"
        )

        reaper.ImGui_EndTooltip(ctx)

    end

    return result,
        add,
        remove,
        up,
        down,
        save,
        load,
        build

end



------------------------------------------------------------

return SetlistPanel
