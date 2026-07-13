-- Live Show Manager — tools/launch_performance.lua
-- =========================================
-- Standalone script to launch the performance runner from a REAPER toolbar
-- button, key command, or action list.
--
-- HOW TO USE:
--   1. In REAPER: Actions > Show action list > New action > Load ReaScript
--   2. Select this file → give it a name like "Launch Performance"
--   3. Bind to a toolbar button or key (e.g., F8)
--   4. When clicked: shows a dialog listing saved setlists, asks which to load
--   5. Loads the setlist, starts the runner, shows confirmation
--   6. Open http://<mac-ip>:3000 on iPhone → controls are live
--
-- REQUIREMENTS:
--   - main.lua must have been run at least once this session (to load App global)
--   - At least one saved setlist in data/setlists/
--   - ~/ReaperSongs/ must have the songs referenced by the setlist
--
-- TROUBLESHOOTING:
--   - "No saved setlists" → save one from the editor first
--   - Blank dialog → main.lua hasn't been loaded yet (run it first this session)
--   - Song shows as "No Show Loaded" on iPhone → setlist not found or library empty

-- Determine the script root directory
local root = debug.getinfo(1, "S").source:match("@(.*)/")

-- Bootstrap: if App hasn't been loaded yet, load main.lua to set up
-- the module loader and all dependencies.
if not App then
  dofile(root .. "/main.lua")
  return  -- main.lua will launch the GUI, runner is ready behind it
end

-- Load required modules
local SetlistModel = App.require("models.setlist")
local Library = App.require("backend.library")
local Runner = App.require("runner.runner")

-- Get list of saved setlists
local names = SetlistModel.list()

if #names == 0 then
  -- No saved setlists — tell the user to save one from the editor first
  reaper.MB(
    "No saved setlists found.\n\n" ..
    "Save a setlist in the editor first:\n" ..
    "  1. Run main.lua\n" ..
    "  2. Build a setlist from your library\n" ..
    "  3. Click 'Save Setlist'\n" ..
    "  4. Run this script again",
    "Performance",
    0
  )
  return
end

-- Show a dialog asking which setlist to load
-- The dialog shows all available setlist names as reference
local listStr = table.concat(names, "\n")
local ret, chosen = reaper.GetUserInputs(
  "Launch Performance",
  1,
  "Available setlists:\n" .. listStr .. "\n\nEnter name to load:",
  ""
)

if ret and chosen and chosen ~= "" then
  -- Load the chosen setlist
  local loaded, err = SetlistModel.load(chosen)
  if not loaded then
    reaper.MB("Failed to load setlist: " .. (err or "?"), "Error", 0)
    return
  end

  -- Scan the song library (reads ~/ReaperSongs/)
  local library = Library.scan()

  -- Start the Node.js bridge server (launchd auto-restarts on crash)
  local projectRoot = root:gsub("/tools/?$", "")
  reaper.ExecProcess("bash '" .. projectRoot .. "/web/control.sh' start", 0)

  -- Create and start the runner
  local runner = Runner.new()
  runner:loadShow(loaded.songs, library, loaded.name)
  runner:start()

  -- Confirm to user
  reaper.MB(
    "Performance mode active!\n\n" ..
    "Show: " .. loaded.name .. "\n" ..
    "Songs: " .. #loaded.songs .. "\n\n" ..
    "Controls ready on iPhone at:\n" ..
    "http://RDFX1-macbook-pro.local:3000\n\n" ..
    "Close this message and start playing.",
    "Live Show Manager",
    0
  )
end
