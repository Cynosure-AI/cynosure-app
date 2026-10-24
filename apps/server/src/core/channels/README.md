# Project command suggestions

All platforms use the current unarchived projects from `project-store.ts`. Selected
projects resolve by ID, including after a rename or reorder. A removed or archived
selection asks the user to refresh. Existing text commands still accept a name,
partial name, number, or `off`/`none`; no argument still lists projects.

- **Discord:** `/project` is upserted as a global application command on startup
  and command refresh, preserving other application commands. Its optional
  `project` argument uses native autocomplete (up to 25 matching names per request).
  The existing allowed-user list protects both suggestions and execution.
  The bot installation must include the `applications.commands` OAuth scope;
  reinstall with that scope if the command is missing. Global command updates may
  take time to appear. Existing `!project` and text `/project` continue working.
- **Telegram:** the existing startup/refresh `setMyCommands` menu includes
  `/project`. Sending it now also opens an inline keyboard with 20 choices per
  page. Pages fetch the current list; buttons select by ID. Telegram does not
  autocomplete free-text arguments. Buttons only work in the allowed user's
  private chat.
- **Slack:** sending `/project` opens an ephemeral message with a searchable
  external select. Opening or typing in the select requests current matching
  projects (up to 100). Existing `!project` also offers the select in its reply
  thread. Project selection changes the active conversation's project for the
  whole Slack channel, as existing text commands do. Slack does not autocomplete
  arguments in the message composer.

## Slack app setup

The existing bot/app tokens and Socket Mode connection handle slash commands,
options requests, and selections. Listeners register on every channel startup.
The bot token cannot publish slash-command definitions; configure `/project`
once in the Slack app's **Slash Commands** settings, or merge this into its app
manifest (preserving existing settings):

```yaml
features:
  slash_commands:
    - command: /project
      description: Show or switch the project this chat works in
      usage_hint: "[project name, number, or off]"
      should_escape: false
oauth_config:
  scopes:
    bot:
      - commands
settings:
  socket_mode_enabled: true
  interactivity:
    is_enabled: true
```

Keep existing bot scopes, including `chat:write`, and the app token's
`connections:write` scope. Reinstall the Slack app if adding the `commands` scope.
Socket Mode delivers interactivity and options payloads without a public Request
URL or Options Load URL. `!project` remains available without provisioning the
slash command; its select still needs interactivity enabled.

Project changes require no command re-registration: autocomplete and picker
options are loaded on demand rather than stored in command definitions.

References: [Discord application commands](https://docs.discord.com/developers/docs/interactions/slash-commands),
[Telegram Bot API](https://core.telegram.org/bots/api#inlinekeyboardmarkup),
[Slack select menus](https://docs.slack.dev/reference/block-kit/block-elements/select-menu-element/),
[Slack app manifests](https://docs.slack.dev/reference/app-manifest/).
