import type { coreChatRu } from './ru.ts';

/** English texts of the core's launch refusal line in the `/chat` feed (stage 11, W3-17a); typed against the Russian module. */
export const coreChatEn: typeof coreChatRu = {
  launchRefused: {
    no_core_hook:
      'This CLI does not run through the core: it has no core hook — neither a pre-tool check nor deny rules — so the core cannot judge its actions ({{code}}).',
    adapter_not_built:
      'The core adapter for this CLI is not ready yet — chat through the core does not run for it ({{code}}).',
    other: 'The core refused to launch the CLI: {{code}} {{setting}}',
    kitHooks:
      'The chat did not start: this step runs your layer’s hooks as «{{mode}}» (narrowed by the scenario or a contour rule), and the panel kit adds its hooks only while they are on. Remove the hook narrowing from the contour rule, or switch the kit for this CLI to «Yours only» and turn its guards off on the «Panel kit» page.',
    kitMcp:
      'The chat did not start: the kit folder {{path}} declares MCP servers (.mcp.json or mcpServers in plugin.json) — they would bypass the core session’s MCP list. Remove them from your kit files on the «Panel kit» page; MCP servers are connected in the «MCP servers» section.',
    kitMissing:
      'The chat did not start: the core could not find or read the kit folder {{path}}. The panel rebuilds the kit on every start — start the chat again; if it repeats, check that the folder is readable.',
    layerUntrusted:
      'The chat did not start: the project local layer is on in this folder, and Claude Code does not trust the folder. The layer is built from repository files, and the core does not run it without trust. Trust the folder: open claude in it in a terminal and answer «yes» to the trust question, then start the chat again. Or turn the layer off: «Projects» → the project → «From the project» → «Local layer» → mode «Off»; the chat then runs without the repository files until the folder is trusted.',
    layerMode:
      'The chat did not start: this step runs your configuration layer as «{{mode}}» (narrowed by the scenario or a contour rule), and the project local layer rides only with the full one. Remove the narrowing from the contour rule, or turn the local layer off: «Projects» → the project → «From the project» → «Local layer» → mode «Off».',
    layerSources:
      'The chat did not start: the panel assembled the session with the project team files beside the local layer — the layer would duplicate them. This is a panel fault, not your setting: start the chat again; if it repeats, turn the local layer off («Projects» → the project → «From the project» → «Local layer» → «Off») and report the fault.',
    layerBuild:
      'The chat did not start: the core could not use the local layer build {{path}} — the folder is missing, unreadable or declares MCP servers. The panel rebuilds the layer on every start — start the chat again; if it repeats, open the «Local layer» card («Projects» → the project → «From the project»): the build error is shown there — or turn the layer off.',
    layerFit:
      'The chat did not start: the project local layer does not fit the core session (part «{{field}}»: instructions over 200,000 characters or a hook of a foreign shape). Compress the layer instructions or turn the layer off: «Projects» → the project → «From the project» → «Local layer» → mode «Off».',
    carryUnsupported:
      'The chat did not start: the {{adapter}} CLI cannot take part of the panel layer into the core session ({{fields}}: the kit, the local layer or a settings narrowing). Start the chat in Claude Code, or turn that part off for this CLI.',
  },
};
