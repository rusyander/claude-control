import type { ChatMessageCode } from '@agentdeck/contracts/server-messages';

export const chatEn: Record<ChatMessageCode, string> = {
  'run-busy':
    'The previous answer in this conversation is still being generated. Wait for it to finish or press “Stop” — the message was not sent.',
  'run-steer-ended':
    'The turn has already ended — the mid-turn message was not sent; the panel will send it the usual way.',
  'run-group-paused':
    'The group is paused — the queued message was not sent so as not to wake it. It stays in the queue.',
  'run-empty-prompt': 'The message is empty — nothing to send.',
  'run-unsupported-upload':
    'Unsupported attachments: {{names}}. The message was not sent. Allowed extensions: {{supported}}.',
  'run-workspace-missing':
    'This chat’s working folder was not found: {{cwd}}. The conversation started there and can only continue from there.',
  'run-session-unknown':
    'Conversation {{sessionId}} was not found: there is no transcript with this sessionId. The message was not sent — a new conversation without a sessionId starts separately.',
  'permission-expired':
    'This permission request has expired: the agent stopped waiting for an answer, so the decision would not run anything. If it asks again, answer the new request.',
  'core-permit-browser-only':
    'A permission question of a core task is answered with the card’s button in the chat window: the answer goes to the core as a browser command, and this route does not pass it to the core.',
  'decision-human-only':
    'Decision rejected: it came from a process of a panel agent. Only a human answers permission requests and queued items.',
  'decision-peer-unknown':
    'Decision not taken: the panel could not check who sent it. Try again in a few seconds.',
  'decision-device-unverified':
    'Decision not taken: the panel did not recognise the window it came from. Open the panel in a browser on this computer and answer there.',
  'decision-remote-unverified':
    'Decision not taken: a remote answer is accepted only through this machine’s Tailscale Serve with the access token.',
  'decision-signature-required':
    'Decision not taken: “decisions only with the phone’s signature” is on and the request carries no signature. Answer from the phone the key is bound to (Settings → Decision signing) — it signs the decision itself. Denying works from anywhere.',
  'decision-signature-lever':
    'Change not applied: “decisions only with the phone’s signature” is on, and this change loosens the rights of every future decision. Switch signing off on the phone (Settings → Decision signing), make the change, then switch it back on.',
  'decision-signature-invalid':
    'Decision not taken: the phone’s signature does not match — the key is not bound to this panel or the request was altered on the way.',
  'decision-signature-revoked':
    'Decision not taken: this phone’s key was revoked in the panel. Bind the phone again while signing is off.',
  'decision-signature-stale':
    'Decision not taken: the phone’s and the computer’s clocks differ by more than 5 minutes. Check the time on both and answer again.',
  'decision-signature-replayed':
    'Decision not taken: this signature was already used. The same request is not accepted twice — answer again.',
  'decision-signature-no-device':
    'Decision not taken: signing is on but no bound phone is left. To switch it off without a phone, delete the file {{path}} on this computer.',
  'phone-signing-body-invalid': 'The signing mode request is malformed.',
  'phone-signing-enabled':
    'New key not bound: signing is on. Switch it off on a phone that is already bound, bind the new one, then switch it back on.',
  'phone-signing-device-not-found': 'There is no such key among the bound ones.',
  'phone-signing-devices-changed':
    'Signing not switched on: the list of bound phones changed. Refresh the screen and compare the fingerprints again.',
  'phone-signing-key-revoked':
    'Key not bound: it was revoked in the panel. The phone will create a new key — bind that one.',
  'deferred-not-found': 'There is no queued item {{id}}: it was removed or the number is wrong.',
  'editor-not-found': 'Code editor not found. Set it in the settings or install code/cursor.',
  'handoff-proposal-invalid':
    'The proposal could not be parsed: “what is done” and “how to continue” are required',
  'restart-run-in-progress':
    'The run is still going: wait for the turn to end or stop it, then restart',
  'cli-not-found': 'Claude CLI was not found on PATH',
  'cli-outdated':
    'The panel runs Claude Code {{current}}, but the model needs version {{required}} or newer. Update the CLI.',
  'cli-provider-not-found': '{{provider}} CLI was not found on PATH',
  'cli-update-unsupported': 'Updating the {{provider}} CLI from the panel is not supported',
  'prompt-too-long':
    'The conversation context is full: it will not accept another message. Compact the context or continue in a new session.',
  'chat-process-lost':
    'The chat process was lost: it was ended outside the panel. The conversation is saved — send a message and it continues where it stopped.',
  'core-chat-contour-down':
    'The turn was not sent: the required contour {{contour}} is unavailable — its gateway has no route or key. The turn never goes to the vendor cloud instead. Check the contour in «Contours».',
  'core-chat-model-needed':
    'The turn was not sent: route {{route}} needs a concrete model. Pick a chat model or set the contour default model.',
  'core-chat-contour-model':
    'The turn was not sent: model {{model}} is not available in contour {{contour}} — the contour key does not allow it. The turn never goes to the vendor cloud instead. Pick a chat model the contour opens to its key (listed in «Contours»), or ask the platform administrator to allow this model for the key.',
  'core-chat-estimate-refused':
    'The turn was not sent: the task core did not accept it (code {{code}}). Core reason: {{reason}}',
  'core-chat-refused':
    'The task core refused the chat turn (code {{code}}). The reason is in the core task journal.',
  'core-chat-kit-hooks':
    'The turn did not start: this step runs your layer’s hooks as «{{mode}}» (narrowed by the scenario or a contour rule), and the panel kit adds its hooks only while they are on. Remove the hook narrowing from the contour rule, or switch the kit for this CLI to «Yours only» and turn its guards off on the «Panel kit» page.',
  'core-chat-kit-mcp':
    'The turn did not start: the kit folder {{path}} declares MCP servers (.mcp.json or mcpServers in plugin.json) — they would bypass the core session’s MCP list. Remove them from your kit files on the «Panel kit» page; MCP servers are connected in the «MCP servers» section.',
  'core-chat-kit-missing':
    'The turn did not start: the core could not find or read the kit folder {{path}}. The panel rebuilds the kit on every turn — send the message again; if it repeats, check that the folder is readable.',
  'core-chat-layer-untrusted':
    'The turn did not start: the project local layer is on in this folder, and Claude Code does not trust the folder. The layer is built from repository files, and the core does not run it without trust. Trust the folder: open claude in it in a terminal and answer «yes» to the trust question, then send the message again. Or turn the layer off: «Projects» → the project → «From the project» → «Local layer» → mode «Off»; the chat then runs without the repository files until the folder is trusted.',
  'core-chat-layer-mode':
    'The turn did not start: this step runs your configuration layer as «{{mode}}» (narrowed by the scenario or a contour rule), and the project local layer rides only with the full one. Remove the narrowing from the contour rule, or turn the local layer off: «Projects» → the project → «From the project» → «Local layer» → mode «Off».',
  'core-chat-layer-sources':
    'The turn did not start: the panel assembled the session with the project team files beside the local layer — the layer would duplicate them. This is a panel fault, not your setting: send the message again; if it repeats, turn the local layer off («Projects» → the project → «From the project» → «Local layer» → «Off») and report the fault.',
  'core-chat-layer-build':
    'The turn did not start: the core could not use the local layer build {{path}} — the folder is missing, unreadable or declares MCP servers. The panel rebuilds the layer on every turn — send the message again; if it repeats, open the «Local layer» card («Projects» → the project → «From the project»): the build error is shown there — or turn the layer off.',
  'core-chat-layer-fit':
    'The turn did not start: the project local layer does not fit the core session (part «{{field}}»: instructions over 200,000 characters or a hook of a foreign shape). Compress the layer instructions or turn the layer off: «Projects» → the project → «From the project» → «Local layer» → mode «Off».',
  'core-chat-carry-unsupported':
    'The turn did not start: the {{adapter}} CLI cannot take part of the panel layer into the core session ({{fields}}: the kit, the local layer or a settings narrowing). Start the chat in Claude Code, or turn that part off for this CLI.',
  'conversation-unspecified': 'No conversation specified',
  'conversation-not-found': 'Conversation not found',
  'panel-help-query-empty': 'Empty help query.',
  'panel-card-click-only': 'A card decision is made only by a click in the panel window.',
  'panel-card-truncated':
    'The card does not show everything that will be executed — it cannot be approved. Reject it and ask the agent to split the action into parts.',
  'panel-card-not-found': 'There is no such card — it may already have been withdrawn.',
  'panel-card-decided': 'A decision on this card has already been made.',
  'panel-conversation-not-found': 'There is no such conversation.',
  'panel-conversation-running':
    'A turn is running in this conversation — delete it after the agent answers.',
  'foreign-chat-not-for-claude': 'Claude has its own chat — these routes are not for it.',
  'conversation-create-failed': 'Could not create the conversation',
  'panel-help-topic-missing': 'There is no help topic “{{id}}”. Available: {{known}}.',
  'panel-agent-busy':
    'The agent is still answering in this conversation — wait for the turn to end.',
  'panel-agent-not-running': 'No turn is running in this conversation.',
  'panel-agent-bad-from-seq': 'The frame number (fromSeq) must be a number.',
  'panel-agent-turn-gone': 'The start of the turn is no longer kept — open the conversation again.',
  'panel-agent-provider-unsupported':
    'The panel agent does not work with {{provider}}: this CLI has no run in which the agent acts through the panel tools alone. The agent works with Claude Code, Qwen Code, Codex, Gemini CLI, OpenCode, Goose and Kimi Code — switch the active CLI in «Providers».',
  'panel-agent-stopped': 'The turn was stopped.',
  'panel-agent-extra-tool':
    'The CLI gave the agent a tool beyond the panel bridge ({{tool}}) — the turn was stopped so that the agent has no extra hands.',
  'panel-agent-timeout': 'The agent did not finish the turn in the allotted time.',
  'panel-agent-no-reply': 'The agent did not answer.',
  'panel-agent-cli-exit': 'The CLI exited with code {{code}} without an answer.',
  'panel-agent-model-error': 'The model turn ended with an error and the CLI gave no words for it.',
  'tests-agent-provider-unsupported':
    'The Tests block agent runs as a core task and works with Claude Code, Qwen Code and Codex, and the active CLI is {{provider}}: the core has no adapter for it. The run was not started — switch the CLI in «Providers» or mark the cases by hand.',
  'tests-agent-core-refused': 'The core did not start the run on {{provider}}: {{reason}}',
  'panel-agent-last-not-user': 'the last message must be from the human',
  'split-group-no-slot': 'All slots are taken: {{running}} of {{limit}} running',
  'split-group-no-slot-paused':
    'All slots are taken: {{running}} running, {{paused}} paused, of {{limit}} — Resume or Remove on a paused group frees a slot',
  'split-limit-active': 'The subscription limit is exhausted until {{until}}',
  'chat-group-pair-inactive-side':
    'Group “{{group}}” is the inactive side of its pair in this project: the other side is in effect. Pick that one, or switch the pair side on the Groups page.',
  'chat-stop-unconfirmed':
    "The agent process was not stopped: the panel could not verify that the number is still the agent's, so it left it alone. The run goes on — try Stop again.",
  'chat-keep-session-gone':
    'The new conversation is no longer running — there is no turn to move back to the old one.',
  'chat-pin-invalid': 'The pinned field must be true or false',
  'chat-pin-child': 'A group chat is pinned together with its parent',
};
