# AI assistants

Stratum can let an AI assistant work in your workspace, such as Claude
Desktop or any other app that supports the
[Model Context Protocol](https://modelcontextprotocol.io) (MCP). You can ask
for something like "smooth the torque in SN-24001, find the runs where speed is
above 900 rpm and give me the average torque in each". The assistant then does
it with the same steps you would use. Its work appears in History like your
own, and Undo (Ctrl+Z) reverses it.

## What an assistant can do

- See your recordings, History, signals, values, segments and batches, with
  the names Stratum shows.
- Read exact samples and statistics, and measure between two times.
- Derive signals, calculate values, find segments, Compare & align, and run
  saved workflows on recordings. It can preview these first without saving.
- Edit, rename and delete steps, set checks, and use Undo and Redo.
- Import recordings and workflow files, export CSV files and save or open
  workspace backups, using the full file paths you give it. It never
  overwrites a file unless asked to.
- Look at plots of signals, and select a step or output in the Stratum window
  to show you what it means.

An assistant cannot change Stratum's settings or reach anything outside your
workspace and the files you point it to.

## Your data

Stratum itself still sends nothing anywhere. When you allow an assistant,
everything its tools read, such as names, values, samples and plot images,
goes to that assistant and its AI service. That is how it can answer you.
Allow assistants only for workspaces you are comfortable sharing that way,
and turn access off when you are done.

Access is off until you turn it on. While it is on, Stratum opens a private
channel on this computer that needs a secret key kept in your Stratum
profile, so only programs running under your account on this computer can
use it. Turning access off closes the channel at once.

## Set up Claude Desktop

1. In Stratum, open **Workspace** (the folder button at the top right) and,
   under **AI assistants**, choose **Allow AI assistants**.
2. Choose **Copy configuration**.
3. In Claude Desktop, open **Settings → Developer → Edit Config**. This opens
   `claude_desktop_config.json`. Paste the copied entry. If the file already
   has an `"mcpServers"` section, add only the `"stratum"` part to it.
4. Restart Claude Desktop. Stratum's tools appear in its tools menu.

Other MCP apps use the same command, arguments and environment variable as
the copied entry. The entry stays valid when Stratum updates.

If Stratum is closed when the assistant needs it, it starts. While an
assistant works, the status bar shows "AI assistant is working…", and each
change it makes is announced at the bottom of the window.

## Turn it off

Open **Workspace → AI assistants** and choose **Turn off**. Connected
assistants are cut off at once, and their requests are refused until you
allow access again. The entry in the assistant's configuration can stay. It
does nothing while access is off.

## Tips

- Name the recording or signal you mean. The assistant can search for steps
  and outputs as Ctrl+K does.
- Ask it to preview first ("show me the segments it would find").
- Everything it creates is ordinary: open Details, use New version… or
  delete it as you would your own steps.
