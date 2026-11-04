import type { LocalMessageCode } from '@agentdeck/contracts/server-messages';

export const localEn: Record<LocalMessageCode, string> = {
  'local-timeout': 'the model server did not answer within {{seconds}} s — log: {{log}}',
  'local-stop-failed': 'the server on port {{port}} did not stop',
  'local-hold-refused': 'the core refused to hold the model ({{code}}): {{reason}}',
  'local-core-unreachable': 'the core is not answering — local models run through it: {{reason}}',
  'local-download-http': 'download failed: HTTP {{status}}',
  'local-download-cut': 'download was cut: {{done}} of {{size}} bytes — press again, it resumes',
  'local-download-cancelled': 'download cancelled',
  'local-checksum-mismatch': 'checksum of {{name}} did not match — file removed, press again',
  'local-runtime-missing': 'the model server is not installed — press «Install» first',
  'local-server-down': 'the model server is not running',
  'local-model-unknown': 'model {{tag}} is not in the panel catalog',
  'local-toggle-no-model':
    'no model is chosen for agents — turn one on in the «Agents» tab of «Local models»',
  'local-model-missing': 'model {{tag}} is not downloaded',
  'local-model-loaded':
    'quantization {{quant}} of {{tag}} is loaded in the model server — stop the server first ("Stop and free memory" on the "Hardware & server" tab), then delete',
  'local-model-run-active':
    'a local run is in progress and afterwards the server switches to quantization {{quant}} of {{tag}} — delete once the run ends',
  'local-model-downloading':
    'model {{tag}} is downloading — wait for it to finish or cancel the download, then delete',
  'local-model-path':
    'the file of model {{tag}} lies outside the panel models folder — the panel deletes only its own files, deletion refused',
  'local-contour-save': 'saving the contour: {{reason}}',
  'local-contour-activate': 'activating the contour: {{reason}}',
  'local-contour-deactivate': 'deactivating the contour: {{reason}}',
  'local-npm-failed': 'Qwen Code install failed: {{reason}}',
  'local-release-http': 'GitHub answered {{status}} to the llama.cpp release request',
  'local-asset-missing': '{{version}} has no file {{name}}',
  'local-sums-missing': '{{version}}: the file has no checksum in the release',
  'local-checksum-missing': 'there is no checksum for {{name}}',
  'local-binary-missing': 'the unpacked archive has no llama-server executable',
  'local-quant-unknown': 'model {{tag}} has no quantization {{quant}}',
  'local-context-range': 'context window must be between {{min}} and {{max}} tokens',
  'local-choice-no-fit':
    '{{tag}}: this combination does not fit — needs {{need}} GB, {{available}} GB available',
  'local-custom-input': 'give the repository as «owner/repo» or a Hugging Face link',
  'local-custom-no-gguf': 'repository {{repo}} has no GGUF files with a ready quantization',
  'local-custom-no-arch':
    'could not read the model layout from {{repo}}: without layers and attention heads the window memory cannot be computed',
  'local-job-unknown': 'no such download',
  'local-mcp-project': 'an absolute path to the project folder is required',
  'local-claude-settings-broken': 'Claude settings.json is not valid JSON — fix the file: {{path}}',
  'kit-item-unknown': 'The panel kit has no such item',
  'kit-mode-unsupported': 'This CLI does not support that kit mode',
  'kit-global-missing': 'The global layer has no such item',
  'kit-global-unsupported': 'Only skills, commands and subagents move to and from the global layer',
  'kit-hooks-invalid': 'hooks.json not saved: it is not JSON of the form {"hooks": {…}}',
  'kit-compose-failed':
    'Run not started: the panel kit failed to build. Switch the kit mode to «Yours only» or retry',
  'kit-codex-too-large':
    'Run not started: the panel kit rules and skills for Codex take {{size}} characters, and the Codex session instructions field holds no more than {{limit}}. Nothing was trimmed: switch some kit items off or switch the kit mode to «Yours only»',
};
