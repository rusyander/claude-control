import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Общее у двух проходов секретного свипа (`panel-agent-005`): хранилища с
 * канарейками, строки действий (`ROWS`), засев временного дома и поиск утечки.
 * `secret-sweep.integration.test.ts` доводит изменения до карточки и отклоняет,
 * `secret-sweep-approve.integration.test.ts` одобряет и смотрит на результат
 * исполнения (ревью U0, M4, 28.09.2026). НОВОЕ ДЕЙСТВИЕ — строка в `ROWS` здесь.
 */

/** Запрос человека (Origin окна); ответ ≥ 400 — исключение. */
export type Human = (options: InjectOptions) => Promise<LightMyRequestResponse>;

// ---- canaries: one per store, so a red names the store ----

/**
 * «Простая» метка: строчные буквы и цифры, короче 24 символов — детектор по
 * форме её не узнаёт, спасти её может только знание о хранилище (имя поля,
 * секретность записи, то, что значение вообще не отдаётся).
 */
export function plain(tag: string): string {
  const letters = 'ghjkmnpqrstvwxyz';
  const body = [...randomBytes(12)].map((byte) => letters[byte % letters.length]).join('');
  return `swp${tag}${body}${10 + (randomBytes(1)[0]! % 89)}`;
}

/** Ключ, вставленный в свободный текст: узнать его можно только по форме. */
export function opaque(tag: string): string {
  const body = randomBytes(18)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '');
  return `Swp${tag}${body}7Q3x9K`;
}

export const STORES = {
  settingsEnv: plain('se'),
  settingsLocalEnv: plain('sl'),
  secretsEnv: plain('sv'),
  mcpEnv: plain('me'),
  mcpArgs: plain('ma'),
  mcpHeader: plain('mh'),
  mcpUrl: plain('mu'),
  projectMcpEnv: plain('pe'),
  projectMcpHeader: plain('ph'),
  projectSettingsEnv: plain('ps'),
  projectDotenv: plain('pd'),
  hookCommand: plain('hc'),
  permissionRule: plain('pr'),
  scriptBody: plain('sb'),
  groupEnv: plain('ge'),
  contourKey: plain('ck'),
  endpointToken: plain('et'),
  atlassianToken: plain('ia'),
  confluenceToken: plain('ic'),
  forgeToken: plain('if'),
  telegramToken: plain('it'),
  tmsToken: plain('im'),
  ciToken: plain('ii'),
  webhookToken: plain('iw'),
  testEnvSecret: plain('ts'),
  remoteApiToken: plain('ra'),
  cliOauthToken: plain('co'),
  panelApiKey: plain('pk'),
  backupPassphrase: plain('bp'),
  runnerScript: plain('rn'),
  chatPastedKey: opaque('Ch'),
  ruleBodyKey: opaque('Ru'),
} as const;

export type Store = keyof typeof STORES;

export const CONTOUR = 'sweep-contour';
export const ENDPOINT = 'sweep-endpoint';
export const MCP_STDIO = 'sweep-stdio';
export const MCP_HTTP = 'sweep-http';
export const PROJECT_MCP = 'sweep-proj-mcp';
export const CHAT = '5e3c0a52-7d1b-4c1e-9f0a-1b2c3d4e5f60';
export const ORIGIN = 'http://localhost:8888';

// ---- the table: every panel action, what it is called with, what it must reach ----

export interface Seeded {
  home: string;
  project: string;
  group: string;
  rule: string;
  hook: string;
  skill: string;
  script: string;
  permission: string;
}

/** `done`/`failed` — исход исполнения (чтение); `card` — карточка показана и отклонена. */
export type Reach = 'done' | 'card' | 'failed';
export type Input = Record<string, unknown> | ((seeded: Seeded) => Record<string, unknown>);
export type Call = readonly [Reach, Input?];
export type Row = readonly Call[] | { skip: string };

export const p =
  (extra: Record<string, unknown> = {}) =>
  (s: Seeded) => ({
    projectPath: s.project,
    ...extra,
  });
export const proj =
  (extra: Record<string, unknown> = {}) =>
  (s: Seeded) => ({
    project: s.project,
    ...extra,
  });
export const bilingual = (text: string) => ({ ru: text, en: text });

export const ROWS: Readonly<Record<string, Row>> = {
  // actions-app / local
  where_am_i: [['done']],
  list_sections: [['done']],
  open_page: [['done', { route: '/' }]],
  // actions-projects
  list_projects: [['done']],
  create_project: [['card', (s) => ({ path: join(s.home, 'fresh-project') })]],
  list_chats: [['done']],
  list_chat_projects: [['done']],
  list_active_runs: [['done']],
  start_chat: [['card', (s) => ({ project: s.project, prompt: 'hello' })]],
  delete_project: [['card', proj()]],
  // actions-tests
  list_test_groups: [['done', p()]],
  list_cases: [['done', p()]],
  coverage: [['done', p()]],
  last_run: [['done', p()]],
  draft_cases: [['failed', p({ runId: 'run-1' })]],
  run_tests: [
    ['card', p()],
    ['card', p({ environmentId: 'sweep-stand' })],
  ],
  save_test_case: [['card', p({ groupId: 'sweep', title: 'Case' })]],
  save_test_group: [['card', p({ id: 'sweep', title: 'Sweep 2' })]],
  delete_test_group: [['card', p({ id: 'sweep' })]],
  reject_draft: [['failed', p({ runId: 'run-1' })]],
  list_test_runs: [['done', p()]],
  read_test_run: [['failed', p({ runId: 'run-1' })]],
  lint_tests: [['done', p()]],
  stop_tests: [['failed', p()]],
  delete_test_case: [['card', p({ groupId: 'sweep', caseId: 'case-1' })]],
  read_tests_report: [
    ['done', p({ kind: 'report' })],
    ['done', p({ kind: 'library-setup' })],
  ],
  save_test_plan: [['card', p({ title: 'Plan' })]],
  build_test_plan: [['card', p({ recipe: 'smoke' })]],
  delete_test_plan: [['failed', p({ planId: 'plan-1' })]],
  start_manual_run: [['card', p()]],
  record_manual_result: [['failed', p({ caseId: 'case-1', status: 'passed' })]],
  finish_manual_run: [['failed', p()]],
  cancel_manual_run: [['failed', p()]],
  attach_test_note: [['card', p({ caseId: 'case-1', name: 'note.txt', text: 'x' })]],
  accept_baseline: [['failed', p({ caseId: 'case-1', pointId: 'point-1' })]],
  sync_e2e_tests: [['card', p()]],
  run_e2e_tests: [['card', p()]],
  stop_e2e_tests: [['failed', p()]],
  save_shared_step: [['card', p({ title: 'Step', steps: [{ action: 'open the page' }] })]],
  delete_shared_step: [['failed', p({ stepId: 'step-1' })]],
  save_test_environment: [
    ['card', p({ title: 'Stand' })],
    ['card', p({ environmentId: 'sweep-stand', title: 'Sweep stand 2' })],
  ],
  delete_test_environment: [['card', p({ environmentId: 'sweep-stand' })]],
  save_test_schema: [['failed', p({ attributes: [], statuses: [] })]],
  save_test_view: [['card', p({ title: 'View', filter: { query: 'login' } })]],
  delete_test_view: [['failed', p({ viewId: 'view-1' })]],
  install_test_convention: [['card', p()]],
  bulk_edit_cases: [
    ['card', p({ groupId: 'sweep', caseIds: ['case-1'], action: 'tag', value: 'x' })],
  ],
  bulk_delete_cases: [['card', p({ groupId: 'sweep', caseIds: ['case-1'] })]],
  set_draft_auto_accept: [['card', p({ enabled: true })]],
  rollback_draft: [['failed', p({ runId: 'run-1' })]],
  // actions-contour
  list_contours: [['done']],
  contour_status: [['done', { id: CONTOUR }]],
  probe_contour_url: [['done', { id: CONTOUR }]],
  save_contour_draft: [['card', { baseUrl: 'http://127.0.0.1:1' }]],
  enable_contour: [['card', { id: CONTOUR }]],
  disable_contour: [['failed', { id: CONTOUR }]],
  deactivate_contour: [['failed', { id: CONTOUR }]],
  delete_contour: [['card', { id: CONTOUR }]],
  gateway_status: [['done']],
  start_gateway: [['card']],
  restart_gateway: [['card']],
  contour_spend: [['done', { id: CONTOUR }]],
  clear_contour_exhausted: [['failed', { id: CONTOUR }]],
  contour_mcp_connect: [['card', { connect: true }]],
  ask_contour_agent: [['failed', { contour: CONTOUR, agent: 'helper', message: 'hi' }]],
  read_contour_agent_session: [['failed', { contour: CONTOUR, session: 'session-1' }]],
  reset_contour_agent_session: [['failed', { contour: CONTOUR, session: 'session-1' }]],
  contour_embeddings: [['failed', { contour: CONTOUR, model: 'embed', texts: ['t'] }]],
  // actions-config
  list_rules: [['done'], ['done', (s) => ({ id: s.rule })]],
  list_skills: [['done']],
  list_hooks: [['done']],
  list_mcp: [['done']],
  list_permissions: [['done']],
  save_rule: [['card', (s) => ({ id: s.rule, title: 'Sweep rule', body: 'short' })]],
  toggle_rule: [['card', (s) => ({ id: s.rule, isEnabled: false })]],
  delete_rule: [['card', (s) => ({ id: s.rule })]],
  save_skill: [['card', (s) => ({ id: s.skill, name: s.skill, description: 'd', body: 'b' })]],
  delete_skill: [['card', (s) => ({ id: s.skill })]],
  add_permission_rule: [['card', { decision: 'allow', pattern: 'Bash(pwd)' }]],
  remove_permission_rule: [['card', (s) => ({ id: s.permission })]],
  save_mcp_server: [
    // Сервер с сохранёнными секретами агент не перенаправляет: отказ до карточки.
    ['failed', { id: MCP_STDIO, name: MCP_STDIO, transport: 'stdio', command: 'node', args: [] }],
    ['failed', { id: MCP_HTTP, name: MCP_HTTP, transport: 'http', url: 'https://mcp.example.com' }],
  ],
  delete_mcp_server: [
    ['card', { id: MCP_STDIO }],
    ['card', { id: MCP_HTTP }],
  ],
  save_hook: [
    ['card', (s) => ({ id: s.hook, event: 'PreToolUse', matchers: ['Bash'], command: 'true' })],
  ],
  toggle_hook: [['card', (s) => ({ id: s.hook, isEnabled: false })]],
  delete_hook: [['card', (s) => ({ id: s.hook })]],
  move_hook: [['failed', (s) => ({ id: s.hook, direction: 'down' })]],
  list_env: [['done']],
  set_env: [
    // Секрет меняет только человек: ни значение от агента, ни правка сохранённого.
    ['failed', { key: 'SWEEP_API_TOKEN', value: 'new', source: 'settings' }],
    ['failed', { key: 'SWEEP_API_TOKEN', source: 'settings' }],
    ['failed', { key: 'SWEEP_LOCAL_SECRET', source: 'settings-local' }],
    ['failed', { key: 'SWEEP_VAULT_PASSWORD', source: 'secrets' }],
    ['card', { key: 'SWEEP_REGION', value: 'us-east', source: 'settings' }],
  ],
  delete_env: [
    ['card', { key: 'SWEEP_API_TOKEN', source: 'settings' }],
    ['card', { key: 'SWEEP_LOCAL_SECRET', source: 'settings-local' }],
    ['card', { key: 'SWEEP_VAULT_PASSWORD', source: 'secrets' }],
  ],
  move_env: [['card', { key: 'SWEEP_API_TOKEN', source: 'settings' }]],
  read_claude_md: [['done']],
  save_claude_md: [['card', { content: 'x' }]],
  list_scripts: [['done']],
  read_script: [['done', (s) => ({ id: s.script })]],
  save_script: [['card', (s) => ({ id: s.script, content: 'echo ok' })]],
  delete_script: [['card', (s) => ({ id: s.script })]],
  list_commands: [['done']],
  toggle_skill: [['card', (s) => ({ id: s.skill, isEnabled: false })]],
  toggle_mcp_server: [['card', { id: MCP_STDIO, isEnabled: false }]],
  toggle_permission_rule: [['card', (s) => ({ id: s.permission, isEnabled: false })]],
  move_permission: [['card', (s) => ({ id: s.permission })]],
  edit_permission_rule: [
    ['card', (s) => ({ id: s.permission, decision: 'deny', pattern: 'Bash(pwd)' })],
  ],
  check_mcp_health: [['card', { id: MCP_HTTP }]],
  list_mcp_tools: [['card', { id: MCP_HTTP }]],
  rename_skill: [['card', (s) => ({ id: s.skill, newId: `${s.skill}-2` })]],
  list_skill_templates: [['done']],
  apply_skill_template: [['failed', (s) => ({ skill: s.skill, templateId: 'none' })]],
  list_skill_files: [['done', (s) => ({ skill: s.skill })]],
  read_skill_file: [['done', (s) => ({ skill: s.skill, file: 'SKILL.md' })]],
  save_skill_file: [['card', (s) => ({ skill: s.skill, file: 'notes.md', content: 'x' })]],
  delete_skill_file: [['failed', (s) => ({ skill: s.skill, file: 'notes.md' })]],
  move_skill_file: [['failed', (s) => ({ skill: s.skill, from: 'notes.md', to: 'n.md' })]],
  // actions-groups
  list_groups: [['done']],
  read_group: [['done', (s) => ({ id: s.group })]],
  save_group: [
    ['failed', (s) => ({ id: s.group, name: 'sweep', env: { SWEEP_GROUP_TOKEN: 'new' } })],
    ['card', (s) => ({ id: s.group, name: 'sweep 2' })],
  ],
  toggle_group: [['card', (s) => ({ id: s.group, isEnabled: false })]],
  delete_group: [['card', (s) => ({ id: s.group })]],
  draft_group: [['card', { name: 'fresh group' }]],
  copy_group: [['card', (s) => ({ id: s.group })]],
  draft_scenario: [
    ['card', { name: 'scenario', steps: [{ title: bilingual('a'), prompt: bilingual('b') }] }],
  ],
  add_group_step: [
    [
      'card',
      (s) => ({
        id: s.group,
        step: { anchor: 'work', title: bilingual('a'), prompt: bilingual('b') },
      }),
    ],
  ],
  move_group_step: [['failed', (s) => ({ id: s.group, stepId: 'step-1', position: 0 })]],
  set_group_knobs: [['failed', (s) => ({ id: s.group, values: {} })]],
  list_discovered_groups: [['done']],
  run_group_discovery: [['card']],
  import_discovered_group: [['failed', { key: 'none' }]],
  copy_group_to_global: [['failed', (s) => ({ id: s.group })]],
  apply_group_advice: [['card', (s) => ({ id: s.group, items: [{ kind: 'skill', id: 'x' }] })]],
  merge_group_origin: [['failed', (s) => ({ id: s.group })]],
  read_group_override: [['done', (s) => ({ id: s.group, path: s.project })]],
  set_group_override: [['card', (s) => ({ id: s.group, path: s.project, enabled: true })]],
  activate_groups_for_path: [['failed', (s) => ({ path: s.project })]],
  list_resource_catalog: [['done']],
  draft_group_step: [['card', (s) => ({ id: s.group, text: 'step', anchor: 'work' })]],
  promote_group_step: [
    ['failed', (s) => ({ id: s.group, stepId: 'step-1', type: 'rule', draft: 'x' })],
  ],
  // actions-app: settings, endpoints, dlp, integrations
  get_settings: [['done']],
  update_settings: [['card', { theme: 'dark' }]],
  switch_provider: [['card', { provider: 'codex' }]],
  list_endpoints: [['done']],
  save_endpoint: [
    [
      'card',
      { id: ENDPOINT, name: 'Sweep 2', baseUrl: 'http://127.0.0.1:1', apiKind: 'anthropic' },
    ],
  ],
  probe_endpoint: [['done', { id: ENDPOINT }]],
  apply_endpoint: [['card', { id: ENDPOINT, provider: 'claude' }]],
  delete_endpoint: [['card', { id: ENDPOINT }]],
  get_dlp: [['done']],
  save_dlp_rules: [
    ['card', { rules: [{ id: 'terms', name: 'Clients', kind: 'terms', terms: ['Acme'] }] }],
  ],
  toggle_dlp_proxy: [['failed', { running: true }]],
  dlp_preview: [['done', { text: 'plain text' }]],
  dlp_journal: [['done']],
  clear_dlp_journal: [['failed']],
  list_integrations: [['done']],
  save_integration: [['card', { id: 'atlassian', settings: { email: 'other@example.com' } }]],
  check_integration: [['card', { id: 'atlassian' }]],
  forget_integration: [['card', { id: 'telegram' }]],
  jira_projects: [['failed']],
  jira_search: [['failed', { q: 'bug' }]],
  jira_issue: [['failed', { key: 'PRJ-1' }]],
  confluence_spaces: [['failed']],
  confluence_search: [['failed', { q: 'page' }]],
  confluence_page: [['failed', { id: '1' }]],
  list_integration_links: [['done', (s) => ({ path: s.project })]],
  save_integration_link: [['card', (s) => ({ path: s.project, note: 'note' })]],
  remove_integration_link: [['failed', (s) => ({ path: s.project })]],
  atlassian_mcp_disconnect: [['failed']],
  // help, overview, search, analytics, providers
  search_help: [['done', { query: 'token' }]],
  read_help_topic: [['done', { id: 'env' }]],
  list_help_topics: [['done']],
  overview: [['done']],
  search_panel: [
    ['done', { query: 'sweep' }],
    ['done', { query: 'token' }],
  ],
  analytics_summary: [['done']],
  analytics_live: [['done']],
  compare_providers: [['done', { left: 'claude', right: 'codex' }]],
  local_models_status: [['done']],
  kit_status: [['done']],
  read_env_passport: [['done']],
  read_split_defaults: [['done']],
  save_split_defaults: [['card', { parallelLight: 2 }]],
  // Сита: секрет в тексте выученного сита проверяет actions-sieves.integration.test.ts.
  read_sieves: [['done']],
  delete_learned_sieve: [['failed', { id: 'no-such-sieve' }]],
  watcher_status: [['done']],
  set_watcher: [['card', { enabled: true }]],
  list_models: [['done']],
  format_check: [['done']],
  read_account: [['done']],
  cli_version: [['done']],
  // CLI в PATH нет (граница подменена) — обновлять нечего.
  update_cli: [['failed']],
  // plugins, history, backups
  list_plugins: [['done']],
  list_available_plugins: [['done']],
  install_plugin: [['card', { id: 'sweep@market' }]],
  uninstall_plugin: [['failed', { id: 'sweep@market' }]],
  toggle_plugin: [['failed', { id: 'sweep@market', isEnabled: false }]],
  update_plugin: [['failed', { id: 'sweep@market' }]],
  add_plugin_marketplace: [['card', { source: 'owner/repo' }]],
  remove_plugin_marketplace: [['failed', { name: 'market' }]],
  scaffold_plugin: [['card', (s) => ({ dir: join(s.home, 'plugin'), name: 'plugin' })]],
  list_history: [['done']],
  history_diff: [['failed', { name: 'none' }]],
  revert_history_hunk: [['failed', { name: 'none', hunk: 0 }]],
  list_backups: [['done']],
  restore_backup: [['failed', { name: 'none' }]],
  delete_backup: [['failed', { name: 'none' }]],
  // portability, environment transfer, sessions
  portability_plan: [['done', { target: 'codex' }]],
  apply_portability: [
    ['card', { target: 'codex' }],
    ['card', { target: 'goose' }],
  ],
  revert_portability: [['failed', { target: 'codex' }]],
  portability_transfer: [['done', { target: 'codex' }]],
  list_portability_subscriptions: [['done']],
  env_transfer_preview: [['done']],
  env_transfer_export: [['card', (s) => ({ targetDir: join(s.home, 'transfer') })]],
  session_where: [['done', { sessionId: CHAT }]],
  stop_session: [['failed', { sessionId: CHAT }]],
  // chat
  read_chat: [['done', { chat: CHAT }]],
  search_chats: [['done', { query: 'key' }]],
  list_waiting: [['done']],
  list_chat_artifacts: [['done', { chat: CHAT }]],
  read_chat_artifact: [['failed', { chat: CHAT, name: 'none.md' }]],
  delete_chat_artifact: [['failed', { chat: CHAT, name: 'none.md' }]],
  send_chat_message: [['card', { chat: CHAT, message: 'hello' }]],
  continue_chat_handoff: [['failed', { chat: CHAT }]],
  restart_chat_session: [['card', { chat: CHAT }]],
  request_split: [['card', { chat: CHAT }]],
  split_decline: [['card', { chat: CHAT }]],
  set_chat_group: [['card', (s) => ({ chat: CHAT, group: s.group })]],
  stop_chat_run: [['failed', { chat: CHAT }]],
  split_control: [['failed', { chat: CHAT, mode: 'pause_group' }]],
  // sandbox
  list_sandbox_fixtures: [['done']],
  sandbox_probe_hook: [['card', (s) => ({ hook: s.hook })]],
  sandbox_ask: [['card', { question: 'what is set?' }]],
  // project config, git, copies, runner, files
  read_project_claude_md: [['done', proj()]],
  list_project_mcp: [['done', proj()]],
  list_project_permissions: [['done', proj()]],
  read_project_group_choice: [['done', proj()]],
  read_project_copy_settings: [['done', proj()]],
  save_project_claude_md: [['card', proj({ content: 'x' })]],
  save_project_mcp_server: [
    ['failed', proj({ id: PROJECT_MCP, name: PROJECT_MCP, transport: 'stdio', command: 'node' })],
    ['card', proj({ name: 'sweep-new', transport: 'stdio', command: 'node' })],
  ],
  delete_project_mcp_server: [['card', proj({ id: PROJECT_MCP })]],
  toggle_project_mcp_server: [['card', proj({ id: PROJECT_MCP, enabled: false })]],
  add_project_permission: [['card', proj({ decision: 'allow', pattern: 'Bash(ls)' })]],
  edit_project_permission: [
    ['failed', proj({ id: 'none', decision: 'deny', pattern: 'Bash(ls)' })],
  ],
  remove_project_permission: [['failed', proj({ id: 'none' })]],
  set_project_group_choice: [['failed', proj({ groupKey: null })]],
  save_project_mirror_settings: [['card', proj({ include: ['.env'] })]],
  save_project_split_settings: [['card', proj({ deliver: false })]],
  project_git_status: [['done', p()]],
  list_worktrees: [['done', p()]],
  git_checkout: [['failed', proj({ branch: 'main' })]],
  git_create_branch: [['card', proj({ name: 'sweep-branch' })]],
  git_commit: [['card', proj({ message: 'sweep' })]],
  git_pull: [['failed', proj()]],
  add_worktree: [['card', proj({ branch: 'sweep-copy' })]],
  remove_worktree: [['failed', proj({ copy: 'none' })]],
  bootstrap_worktree: [['failed', proj({ copy: 'none' })]],
  mirror_worktree: [['failed', proj({ copy: 'none' })]],
  describe_project_runner: [['done', proj()]],
  list_project_files: [['done', proj()]],
  read_project_file: [
    ['done', proj({ file: '.env' })],
    ['done', proj({ file: '.mcp.json' })],
    ['done', proj({ file: '.claude/settings.json' })],
    ['done', proj({ file: 'package.json' })],
  ],
  save_project_runner_settings: [['card', proj({ command: 'npm start' })]],
  set_project_runner_autostart: [['card', proj({ enabled: true })]],
  start_project_runner: [['card', proj()]],
  stop_project_runner: [['failed', proj()]],
  open_project_in_editor: [['card', proj()]],
  free_port: [['failed', { port: 65001 }]],
  // lane A gaps (28.09): chat, settings, project, tests
  read_chat_modes: [['done', { chat: CHAT }]],
  read_chat_spend: [['done']],
  request_chat_handoff: [['card', { chat: CHAT }]],
  read_model_cascade: [['done', proj()]],
  set_model_cascade: [['card', proj({ enabled: false })]],
  list_lowered_runs: [['done']],
  read_split_overlap: [['failed', { chat: CHAT }]],
  split_accept_group: [['failed', { chat: CHAT, group: 0 }]],
  split_resume_interrupted: [['failed', { chat: CHAT }]],
  read_model_pricing: [['done']],
  list_editors: [['done']],
  read_claude_access: [['done']],
  browse_folders: [['done'], ['done', (s) => ({ path: s.project })]],
  list_providers: [['done']],
  read_provider_checks: [['done']],
  run_provider_check: [['card']],
  jira_transitions: [['failed', { key: 'PRJ-1' }]],
  portability_fidelity: [['done', { target: 'codex' }]],
  summarize_resource: [['card', (s) => ({ type: 'skill', id: s.skill })]],
  read_project_changes: [['done', { chat: CHAT }]],
  read_worktree_bootstrap_log: [['failed', proj({ copy: 'none' })]],
  read_project_local_config: [['done', proj()]],
  draft_defect: [['failed', p({ groupId: 'none', caseId: 'none' })]],
  refresh_defect_states: [['failed', p()]],
  list_test_drafts: [['done', p()]],
  // the sweep project already has the panel's e2e scaffold: create has nothing to do
  create_e2e_folder: [['failed', p()]],
  remove_e2e_folder: [['card', p()]],
  list_default_test_groups: [['done']],
};

// ---- seeding the throwaway home ----

export const write = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

/** Каталоги PATH без CLI агентов: ни одно действие не дотянется до настоящего `claude`. */
export function pathWithoutAgentClis(): string {
  const raw = process.env.PATH ?? process.env.Path ?? '';
  const names = ['claude', 'codex', 'gemini', 'qwen', 'cn', 'goose', 'kimi', 'cursor-agent'];
  const exts = ['', '.cmd', '.exe', '.ps1', '.bat'];
  return raw
    .split(delimiter)
    .filter((dir) => {
      try {
        const listed = new Set(
          (
            execFileSync(
              process.execPath,
              ['-e', 'console.log(require("fs").readdirSync(process.argv[1]).join("\\n"))', dir],
              {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
              },
            ) as string
          )
            .split('\n')
            .map((name) => name.trim().toLowerCase()),
        );
        return !names.some((name) => exts.some((ext) => listed.has(`${name}${ext}`)));
      } catch {
        return true;
      }
    })
    .join(delimiter);
}

/** `git: false` — повторный засев поверх (проход одобрения): репозиторий уже есть. */
export function seedFiles(config: string, project: string, { git: withGit = true } = {}): void {
  write(
    join(config, 'settings.json'),
    JSON.stringify(
      {
        env: { SWEEP_API_TOKEN: STORES.settingsEnv, SWEEP_REGION: 'eu-west' },
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: `node notify.js --token ${STORES.hookCommand}` }],
            },
          ],
        },
        // «Всегда разрешить» пишет команду буквально — с ключом внутри (ревью сит,
        // 28.09: id разрешения в `portability_fidelity` уносил его модели slug-ом).
        permissions: {
          allow: [
            'Bash(ls)',
            `Bash(curl -H "Authorization: Bearer ${STORES.permissionRule}" https://api.example.com)`,
          ],
        },
      },
      null,
      2,
    ),
  );
  write(
    join(config, 'settings.local.json'),
    JSON.stringify({ env: { SWEEP_LOCAL_SECRET: STORES.settingsLocalEnv } }, null, 2),
  );
  write(join(config, '.mcp-secrets.env'), `SWEEP_VAULT_PASSWORD=${STORES.secretsEnv}\n`);
  write(
    join(config, '.claude.json'),
    JSON.stringify(
      {
        mcpServers: {
          [MCP_STDIO]: {
            type: 'stdio',
            command: 'node',
            args: ['server.js', '--api-key', STORES.mcpArgs],
            env: { SWEEP_MCP_API_KEY: STORES.mcpEnv },
          },
          [MCP_HTTP]: {
            type: 'http',
            url: `https://mcp.example.com/mcp?apiKey=${STORES.mcpUrl}`,
            headers: { Authorization: `Bearer ${STORES.mcpHeader}` },
          },
        },
      },
      null,
      2,
    ),
  );
  write(
    join(config, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: STORES.cliOauthToken,
        refreshToken: STORES.cliOauthToken,
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      },
    }),
  );
  write(
    join(config, 'CLAUDE.md'),
    `# Instructions\n\n## ПРАВИЛО: Sweep rule\n\nDeploy with the key ${STORES.ruleBodyKey} when asked.\n`,
  );
  write(
    join(config, 'skills', 'sweep-skill', 'SKILL.md'),
    '---\nname: sweep-skill\ndescription: Sweep skill\n---\n\nDo the sweep.\n',
  );
  write(
    join(config, 'hooks', 'sweep-notify.sh'),
    `#!/bin/sh\nexport NOTIFY_API_TOKEN=${STORES.scriptBody}\ncurl -s https://notify.example.com\n`,
  );
  const transcripts = join(config, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'));
  write(
    join(transcripts, `${CHAT}.jsonl`),
    [
      {
        type: 'user',
        uuid: 'u1',
        sessionId: CHAT,
        timestamp: '2026-09-28T10:00:00.000Z',
        cwd: project,
        message: { role: 'user', content: `deploy with ${STORES.chatPastedKey} please` },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: CHAT,
        timestamp: '2026-09-28T10:00:05.000Z',
        cwd: project,
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: `Deploying with ${STORES.chatPastedKey}.` }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );

  write(join(project, '.env'), `DB_PASSWORD=${STORES.projectDotenv}\nDB_HOST=localhost\n`);
  write(
    join(project, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          [PROJECT_MCP]: {
            type: 'http',
            url: 'https://tools.example.com/mcp',
            headers: { 'X-Api-Key': STORES.projectMcpHeader },
          },
          'sweep-proj-stdio': {
            command: 'node',
            args: ['tool.js'],
            env: { SWEEP_PROJECT_MCP_KEY: STORES.projectMcpEnv },
          },
        },
      },
      null,
      2,
    ),
  );
  write(
    join(project, '.claude', 'settings.json'),
    JSON.stringify({ env: { SWEEP_PROJECT_SECRET: STORES.projectSettingsEnv } }, null, 2),
  );
  write(join(project, 'README.md'), '# sweep\n');
  write(
    join(project, 'package.json'),
    JSON.stringify(
      {
        name: 'sweep-project',
        private: true,
        scripts: { dev: `node server.js --port 5999 --api-key ${STORES.runnerScript}` },
      },
      null,
      2,
    ),
  );
  // Группа кейсов с важностью и длительностью: без них «дым» пуст и карточки нет.
  write(
    join(project, '.agent', 'tests', 'sweep.tests.json'),
    JSON.stringify({
      version: 1,
      title: 'Sweep',
      cases: [
        {
          id: 'case-1',
          type: 'case',
          title: 'Login',
          steps: [{ action: 'Open', expected: 'Opened' }],
          status: 'unknown',
          source: 'human',
          priority: 'high',
          duration: 3,
        },
      ],
    }),
  );
  if (!withGit) return;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: project, stdio: 'ignore', windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=s@example.com', '-c', 'user.name=s', 'add', 'README.md');
  git('-c', 'user.email=s@example.com', '-c', 'user.name=s', 'commit', '-q', '-m', 'init');
}

/**
 * Засев через API панели, как это сделал бы человек. `contour` — поля контура поверх
 * выключенного по умолчанию (проход одобрения включает его на стаб-платформе).
 */
export async function seedThroughPanel(
  human: Human,
  project: string,
  contour: Record<string, unknown> = {},
): Promise<string> {
  await human({ method: 'POST', url: '/api/projects', payload: { path: project, name: 'sweep' } });
  const { defaultOurRules, defaultPlatformRules } = await import('@agentdeck/contracts/platform');
  const { defaultPlatformTransport } = await import('@agentdeck/contracts/platform-transport');
  await human({
    method: 'PUT',
    url: `/api/platforms/${CONTOUR}`,
    payload: {
      token: STORES.contourKey,
      settings: {
        id: CONTOUR,
        title: 'Sweep contour',
        driver: 'enterprise-platform',
        baseUrl: 'http://127.0.0.1:1',
        enabled: false,
        mode: 'required',
        budgetUsd: 100,
        capabilities: [],
        targets: ['assistant'],
        projectPaths: [],
        consumers: [],
        agents: [],
        budgetSince: '',
        toolShim: true,
        contourPrompt: true,
        defaultModel: '',
        consumerModels: {},
        modelMap: {},
        rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
        caCertPath: '',
        transport: defaultPlatformTransport(),
        ...contour,
      },
    },
  });
  await human({
    method: 'PATCH',
    url: '/api/settings',
    payload: {
      endpointProfiles: [
        {
          id: ENDPOINT,
          name: 'Sweep',
          baseUrl: 'http://127.0.0.1:1',
          apiKind: 'anthropic',
          model: '',
          writeToken: false,
          imagesUrl: '',
          ownerPlatformId: '',
        },
      ],
    },
  });
  await human({
    method: 'PUT',
    url: `/api/endpoints/${ENDPOINT}/token`,
    payload: { token: STORES.endpointToken },
  });
  const integrations: Record<string, [Store, Record<string, unknown>]> = {
    atlassian: [
      'atlassianToken',
      {
        enabled: true,
        baseUrl: 'http://127.0.0.1:1',
        email: 'qa@example.com',
        deployment: 'cloud',
        confluenceUrl: '',
      },
    ],
    forge: ['forgeToken', { enabled: false, kind: '', baseUrl: '', repo: '' }],
    telegram: ['telegramToken', { enabled: false, chatId: '', events: [] }],
    tms: ['tmsToken', { enabled: false, kind: '', baseUrl: '', projectKey: '', groupId: '' }],
    ci: ['ciToken', { enabled: false, kind: '', repo: '', workflow: '', artifact: '' }],
    webhook: ['webhookToken', { enabled: false, url: '', events: [] }],
  };
  for (const [id, [store, settings]] of Object.entries(integrations)) {
    await human({
      method: 'PUT',
      url: `/api/integrations/${id}`,
      payload: {
        settings,
        token: STORES[store],
        ...(id === 'atlassian' ? { confluenceToken: STORES.confluenceToken } : {}),
      },
    });
  }
  await human({
    method: 'POST',
    url: '/api/project-tests/environment',
    payload: { path: project, environment: { id: 'sweep-stand', title: 'Sweep stand' } },
  });
  await human({
    method: 'POST',
    url: '/api/project-tests/env-secret',
    payload: {
      path: project,
      environmentId: 'sweep-stand',
      name: 'STAND_PASSWORD',
      value: STORES.testEnvSecret,
    },
  });
  await human({
    method: 'POST',
    url: '/api/backups/secret-passphrase',
    payload: { passphrase: STORES.backupPassphrase, enable: true },
  });
  await human({
    method: 'POST',
    url: '/api/credentials',
    payload: { value: JSON.stringify({ apiKey: STORES.panelApiKey }) },
  });
  const created = await human({
    method: 'POST',
    url: '/api/groups',
    payload: { name: 'sweep', members: [] },
  });
  const group = (created.json() as { id: string }).id;
  await human({
    method: 'PUT',
    url: `/api/groups/${group}`,
    payload: {
      name: 'sweep',
      members: [],
      env: { SWEEP_GROUP_TOKEN: STORES.groupEnv },
      isEnabled: true,
    },
  });
  return group;
}

/** Идентификатор записи, в JSON которой есть `marker`, — как его видит список панели. */
export async function idOf(human: Human, url: string, marker: string): Promise<string> {
  const body = (await human({ method: 'GET', url })).json() as unknown;
  const items = Array.isArray(body)
    ? body
    : (Object.values(body as Record<string, unknown>).find(Array.isArray) ?? []);
  const found = (items as { id?: unknown }[]).find(
    (item) => typeof item.id === 'string' && JSON.stringify(item).includes(marker),
  );
  if (!found)
    throw new Error(`no item with ${marker} in ${url}: ${JSON.stringify(body).slice(0, 400)}`);
  return found.id as string;
}

/**
 * Формы утечки одной канарейки (ревью U0, M4): значение без последних четырёх
 * символов (маска вправе показать хвост «••••ab12»), его первые 12 символов,
 * base64 и base64url при любом выравнивании (значение внутри чужого блока) и
 * разрезанное пополам (обе половины в одном тексте — модель склеит).
 */
export function needles(value: string): { kind: string; needle: string | [string, string] }[] {
  const out: { kind: string; needle: string | [string, string] }[] = [
    { kind: 'value', needle: value.slice(0, -4) },
    { kind: 'prefix-12', needle: value.slice(0, 12) },
  ];
  for (const [kind, encoding] of [
    ['base64', 'base64'],
    ['base64url', 'base64url'],
  ] as const) {
    for (let pad = 0; pad < 3; pad += 1) {
      const encoded = Buffer.from(`${'\u0000'.repeat(pad)}${value}`).toString(encoding);
      // Первые знаки несут байты выравнивания, последние — хвост без полной тройки.
      const skip = pad === 0 ? 0 : 4;
      out.push({ kind: `${kind}+${pad}`, needle: encoded.replace(/=+$/, '').slice(skip, -4) });
    }
  }
  const half = Math.floor(value.length / 2);
  out.push({ kind: 'split', needle: [value.slice(0, half), value.slice(half)] });
  return out;
}

/** Хранилище, форма, место и полсотни символов перед меткой — красное называет, где искать. */
export function leaks(
  texts: readonly { where: string; text: string }[],
  stores: Readonly<Record<string, string>> = STORES,
): string[] {
  return texts.flatMap(({ where, text }) =>
    Object.entries(stores).flatMap(([store, value]) =>
      needles(value).flatMap(({ kind, needle }) => {
        const first = typeof needle === 'string' ? needle : needle[0];
        const at = text.indexOf(first);
        if (at < 0) return [];
        if (typeof needle !== 'string' && !text.includes(needle[1])) return [];
        return [`${store} (${kind}) → ${where}: …${text.slice(Math.max(0, at - 50), at)}`];
      }),
    ),
  );
}
