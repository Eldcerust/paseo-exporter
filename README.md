# Paseo exporter

Export a session as formatted Markdown or structured JSON using a composer **Export** button, `/export`, or the Command Center. Archive using your saved defaults, then import the saved file back into a new context-loaded Paseo chat from **Archived chats** in the main sidebar, without requiring the original chat record.

## Use

1. Open a session and click **Export** above its composer.
2. Choose **Markdown** or **JSON**.
3. Select **Host exports folder**, **Session folder**, **Custom host folder**, or **Clipboard**.
4. Choose whether to include reasoning, tool calls/results, and timestamps.
5. Click **Save .md / .json** or **Copy export**. Choose **Full panel** for a formatted preview.

The bubble uses compact format and destination buttons, with one description for the selected location. Paseo owns its scrolling; there is no nested scroll view. Session updates preserve the Export button and open controls.

The Command Center action **Export conversation as Markdown or JSON** and `/export` open the same controls in a larger session panel. The current Paseo plugin API does not expose the session tab’s right-click menu or custom keyboard shortcuts. Use Cmd+K / Ctrl+K to reach the command.

Host exports go to `~/Paseo Exports`. Session exports go to `<session working directory>/Paseo Exports`. Custom folders accept absolute paths or `~/...`. Folders are created as needed, and files use a sanitized title, agent ID, timestamp, and random suffix. Existing files are never overwritten. Files are created with mode `0600`; newly created folders use `0700`, subject to platform filesystem support. Remote host destinations refer to the remote machine. Clipboard exports refer to the device running the app.

## Screenshots

Export controls beside the session composer:

![Export composer popover](docs/images/export-popover.png)

Full export panel with workspace defaults:

![Export panel and saved defaults](docs/images/export-panel.png)

## Archive and restore

1. Set your format, folder, and content options in **Export → Defaults**, using **Save for workspace** or **Save for host**. Workspace defaults take precedence.
2. Open the existing **Export** popup or panel and choose **Archive** next to the Save button. There is no separate Archive composer pill or Pill hub tool. `/archive` and **Save export and archive conversation** in the Command Center also open Export.
3. Review the inline confirmation and choose **Save export and archive**. This uses saved defaults, not unsaved changes in the export form. Wait for the current turn to finish or stop it first. The chat and its own workspace leave the sidebar together, so it no longer shows under its project (for example Random).
4. Open **Archived chats** in the main sidebar list, alongside History, Search, and Schedules. **Saved export files** is the default view. Select your Markdown or JSON export, review its preview and provider/model, choose an existing working directory, then select **Restore from file**. The Command Center action **Open archived chats** opens the same page.

Archive saves the same Markdown or JSON file as Export before calling Paseo's native soft archive. A failed export leaves the chat active. Clipboard defaults are not accepted for Archive: save a folder destination first. If saving succeeds but native archive fails, the error includes the saved file path and the file is retained. Concurrent archive/restore requests for the same chat through this plugin are rejected until the first completes.

**Archive closes the whole session.** Paseo gives every chat its own workspace row in the sidebar, and archiving only the chat leaves that row behind. After the chat is archived, the plugin also archives the chat's own workspace, which closes that workspace's terminals. It does this only when it is safe: the workspace is kept, and the toast and receipt say why, when another chat is still active in it (Paseo's workspace archive would archive that chat too), when it is a Git worktree or any kind other than a plain folder (Paseo deletes the worktree folder when it archives one), or when it is already archived. If the workspace archive itself fails after the chat is archived, the error says so and includes the saved file path; archive that workspace from the sidebar. A plain folder is never deleted.

The file list scans `~/Paseo Exports`, your current custom default folders, and paths remembered when this version exports or archives. Catalog receipts live under `~/Paseo Exports/.archive-catalog/<host namespace>` and contain file paths, not copies of the conversation. This preserves discovery when defaults change or the plugin reloads. Use **Scan folder** for older session-folder exports or another folder, or enter an absolute file path and choose **Inspect file**. Paths refer to the selected daemon host. Only regular Markdown/JSON exports in this exporter's format are accepted; unrelated files and unreadable or oversized exports produce warnings. Source files are never changed or deleted by importing.

**Restore from file is a context import.** It reads the file itself and creates a new agent using the SDK with the complete saved text embedded in its persisted additional system context. It does not look up the original agent, so the original Paseo record and provider session can be gone. The new chat is titled `Restored: <title>` and opens when navigation is available. No initial prompt is submitted and archived commands are not replayed. Send your next message to continue with the saved conversation as reference. A plugin timeline receipt identifies the source; that display-only receipt can disappear on daemon restart, while the saved agent configuration retains the imported context.

Paseo's provider-import endpoint accepts an existing native provider-session ID, not arbitrary transcript messages. The public plugin SDK does not expose reconstruction of native user/assistant history from Markdown/JSON. Context import is therefore the supported fallback: it does not recreate old message bubbles, native tool state, binary attachments, or the original provider session identity. Imports over **1 MiB** are rejected before chat creation, never silently truncated. The selected provider's context and launch limits also apply. Choose a currently available provider/model and an existing working directory, especially if the original worktree was removed. Conversation content is supplied to that provider when the restored chat is used.

**Paseo native archives** is a separate, secondary view for unhiding existing sessions with **Unarchive** or **Unarchive and open**. That operation still requires the original record and provider persistence. It is not the file-import path. **Paseo's built-in Archive action does not automatically create an export**; use Archive inside Export for export-before-archive.

Paseo can also archive managed child agents when archiving a parent. Their separate histories are not included in the parent's export, and restoring the parent does not automatically restore its children. Worktree deletion is never performed by the plugin's archive action. **Restoring a chat natively does not restore its archived workspace**: the plugin SDK can archive a workspace but has no call to bring one back, and unarchiving a chat only restores the chat. A chat inside an archived workspace has no sidebar row, so the native Unarchive screen says so; Paseo offers a Restore action for the workspace when you open the chat from History or with **Unarchive and open**. **Restore from file** is unaffected because it creates a new chat.

## Saved defaults

Open **Export**, select your format, destination, and content options, then expand **Defaults**:

- **Save for workspace** remembers those settings for every session in the current workspace.
- **Save for host** sets the fallback for workspaces on the connected host.
- **Use host defaults** removes the current workspace override.

Saved values apply when you reopen Export. Changing controls for one export does not change defaults unless you explicitly save them. Workspace overrides take precedence over host defaults. Tool calls remain selectable even when excluded by default.

Preferences are stored through Paseo’s host-side plugin settings, shared by clients connected to that host, and survive plugin reloads, updates, and daemon restarts. Removing the plugin deletes its settings. Personal paths and choices are not stored in this repository. Custom folders are created only when you save an export.

## Install locally

Requires Paseo **0.15.3 or a compatible later release**, including the app that renders client contributions. Enable plugins in Paseo settings, then:

```sh
paseo plugin install git:Eldcerust/paseo-exporter
```

Paseo compiles the TypeScript sources and supplies runtime libraries. There is no runtime dependency installation or build command.

## Export contents

Markdown preserves message Markdown and includes session metadata, numbered user/assistant messages, reasoning, tool details and errors, task checkboxes, notices, compaction markers, and plugin rows. Reasoning and tool details use standard Markdown inside HTML `details` blocks, supported by GitHub and many Markdown viewers. Viewers without HTML disclosure support may display these differently.

JSON has `schemaVersion: 1`, `exportedAt`, `options`, `session`, and `entries`. Each entry contains the original structured timeline item, provider, sequence ranges, collapse metadata, and optional timestamp. It supports downstream processing and context import through Archived chats. Session metadata includes provider, model, and reasoning effort at export time. Effective/runtime values take precedence over configuration; configured provider, model, and effort are preserved separately. Unreported effort is `null` in JSON and “Not reported” in Markdown. These settings are exported even when reasoning text is excluded. Historical model/effort changes are not exposed per message by Paseo. Only relevant metadata is exported, rather than the full agent configuration.

The exporter walks all available history pages backwards from the initial newest boundary and restores chronological order. It requests Paseo’s projected history to avoid repeated streaming deltas and tool lifecycle updates. Cursor failures, history replacement, and reported gaps fail the export instead of silently saving a partial file.

A snapshot can include an active/unfinished turn. Exports cannot recover material removed by provider retention or compaction. Attachments are represented only as exposed by Paseo’s timeline; binary files are not embedded or copied. Child-agent histories remain separate sessions. Message timestamps are the timeline timestamps supplied by Paseo; they are not reconstructed.

The plugin makes no direct external network requests. Preview, inspection, and clipboard content travels over the existing Paseo connection. Context import places conversation content into the selected provider's agent configuration, so using that chat can send it to the provider. Saved files can include sensitive conversation and tool output, including secrets that were already in the session.

## Development

```sh
npm ci
npm run check
paseo plugin reload paseo-exporter-fork
paseo plugin logs paseo-exporter-fork
npm pack --dry-run --ignore-scripts
```

Source layout:

- `index.client.tsx`: composer button, command, slash command, and panel registration.
- `client/export-panel.tsx`: shared popover/panel controls, themed preview, and inline archive confirmation.
- `client/archive-screen.tsx`: main sidebar entry, file-first source selector, and separate native-unarchive view.
- `client/archive-files-screen.tsx`: file discovery, inspection, preview, and context-import controls.
- `client/archive-import-receipt.tsx`: receipt shown in a newly imported context chat.
- `index.server.ts`: RPC registration.
- `server/history.ts`: complete history pagination and consistency checks.
- `server/markdown.ts`: Markdown formatting and filename generation.
- `server/export.ts`: JSON formatting, destination selection, and exclusive file writes.
- `server/archive.ts`: native archive discovery, per-agent operation locks, export-before-archive, archiving the chat's own workspace when nothing else lives in it, and original-session restore.
- `server/archive-files.ts`: bounded file reads, format validation, durable host-scoped path catalog, and file-to-context import.
- `shared/export.ts`: validated RPC contracts.
- `shared/archive.ts`: validated archive/list/restore contracts.
- `shared/archive-files.ts`: file metadata, inspection/import contracts, and receipt schema.
- `tests/export.test.ts`: pagination, format, filtering, error, destination, and save tests.
- `tests/archive.test.ts`: archive ordering, saved defaults, workspace archive and keep rules, failure handling, concurrency, directory pagination, and restore tests.
- `tests/archive-files.test.ts`: independent file restoration, catalog persistence, invalid inputs, concurrency, and source-file preservation.
- `tests/export-ui.test.ts`: single-tool registration, inline archive placement in both popup hosts, confirmation, and error-state tests.

GitHub Actions runs typechecking, all tests, and a package contents check on every push and pull request, using Node.js 22 and 24. The workflow can also be started manually.

The public GitHub repository is the distribution source. The package is marked `private` to prevent accidental npm publication; this does not affect Git installation in Paseo. `OVERVIEW.md` is included for the plugin listing.
