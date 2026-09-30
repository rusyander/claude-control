import type { RouteLedger } from './capability-ledger.types.ts';

/**
 * Реестр возможностей агента панели (G4): КАЖДЫЙ маршрут сервера — метод и шаблон
 * адреса ровно как в Fastify — и что агенту с ним можно. Ключи сверяет с живой
 * сборкой приложения `capability-ledger.test.ts` в обе стороны: новый маршрут без
 * строки и строка без маршрута — красное. Исполнитель (`panel-agent-routes.ts`)
 * отказывает всему, чего здесь нет.
 *
 * - `action:a,b` — исполняют эти действия (и только они); строка без имени
 *   действия в `PANEL_ACTIONS` — красное.
 * - `human:<reason>` — агенту закрыт на любом шаге (D2). Переклассифицировать —
 *   только решением владельца: список закреплён в тесте.
 * - `internal:<kind>` — служебный (поток, обратный вызов, предпросмотр карточки,
 *   состояние окна); `internal:preview` можно звать и не-GET при сборке карточки.
 * - `foreign-cli` — настройки чужих CLI, отложено (D6).
 * - `gap:<lane>` — возможность интерфейса, которой у агента ещё нет.
 *
 * Дорожка, добавляя действие, меняет `gap:<lane>` (или дописывает имя в `action:`)
 * у КАЖДОГО маршрута, который действие исполняет или пишет после исполнения.
 * Чтения (GET) в карточке, подготовке и после исполнения строки не требуют,
 * если маршрут не `human:`.
 */
export const ROUTE_LEDGER: RouteLedger = {
  // analytics-routes.ts
  'GET /api/analytics': 'action:analytics_summary',
  'GET /api/analytics/live': 'action:analytics_live',
  'GET /api/analytics/pricing': 'action:read_model_pricing',
  // analytics-session-routes.ts
  'GET /api/analytics/sessions/:sessionId/where': 'action:session_where',
  'POST /api/analytics/sessions/:sessionId/stop': 'action:stop_session',
  // assistant-routes.ts
  'POST /api/assist': 'internal:assistant',
  'POST /api/assistant/run': 'internal:assistant',
  // backup-routes.ts
  'DELETE /api/backups/:name': 'action:delete_backup',
  'GET /api/backups': 'action:list_backups',
  'GET /api/backups/:name/preview': 'internal:preview',
  'POST /api/backups/:name/restore': 'action:restore_backup',
  'POST /api/backups/secret-passphrase': 'human:secret',
  // chat/artifact-routes.ts
  'DELETE /api/chat/:chatId/artifact': 'action:delete_chat_artifact',
  'GET /api/chat/:chatId/artifact': 'action:read_chat_artifact',
  'GET /api/chat/:chatId/artifacts': 'action:list_chat_artifacts',
  // chat/browse-routes.ts
  'GET /api/editors': 'action:list_editors',
  'GET /api/fs/list': 'action:browse_folders',
  'GET /api/fs/roots': 'action:browse_folders',
  'POST /api/projects/open-in-editor': 'action:open_project_in_editor',
  // chat/cascade-routes.ts
  'GET /api/chat/cascade': 'action:read_model_cascade',
  'GET /api/chat/lowered-runs': 'action:list_lowered_runs',
  'PUT /api/chat/cascade': 'action:set_model_cascade',
  // chat/cli-routes.ts
  'GET /api/chat/cli': 'action:cli_version',
  'POST /api/chat/cli/update': 'action:update_cli',
  // chat/group-settings-routes.ts
  'GET /api/chat/:chatId/group-settings': 'action:set_chat_group',
  'GET /api/chat/escalations': 'action:list_waiting',
  'POST /api/chat/:chatId/escalations/read': 'internal:ui-state',
  'PUT /api/chat/:chatId/group-settings': 'action:set_chat_group',
  // chat/handoff-routes.ts
  'GET /api/chat/handoff/request': 'action:request_chat_handoff',
  'GET /api/chat/handoff/state': 'action:read_chat_modes',
  'POST /api/chat/:id/restart': 'action:restart_chat_session',
  'POST /api/chat/handoff': 'action:continue_chat_handoff',
  'POST /api/chat/handoff/auto': 'action:restart_chat_session',
  // chat/inbox-routes.ts
  'GET /api/chat/inbox': 'action:list_waiting',
  // chat/run-routes.ts
  'GET /api/chat/:chatId/auto-mode': 'action:read_chat_modes',
  'GET /api/chat/:chatId/stream': 'internal:stream',
  'GET /api/chat/active': 'action:list_active_runs',
  'GET /api/chat/spend': 'action:read_chat_spend',
  'POST /api/chat/:chatId/auto-approve': 'human:rights',
  'POST /api/chat/:chatId/branch-decision': 'human:rights',
  'POST /api/chat/:chatId/permission-decision': 'human:rights',
  'POST /api/chat/:chatId/stop': 'action:stop_chat_run',
  'POST /api/chat/permission-request': 'internal:callback',
  'POST /api/chat/send':
    'action:start_chat,send_chat_message,request_split,restart_chat_session,request_chat_handoff',
  // chat/split-control-routes.ts
  'POST /api/chat/split/:parent/accept': 'action:split_accept_group',
  'POST /api/chat/split/:parent/auto-notices/dismiss': 'internal:ui-state',
  'POST /api/chat/split/:parent/cancel': 'human:split-apply',
  'POST /api/chat/split/:parent/pause': 'action:split_control',
  'POST /api/chat/split/:parent/resume-paused': 'action:split_control',
  'POST /api/chat/split/:parent/start-now': 'human:split-apply',
  'POST /api/chat/split/:parent/restart-group': 'human:split-apply',
  'POST /api/chat/split/:parent/drop-group': 'human:split-apply',
  // chat/split-routes.ts
  'GET /api/chat/split/:parent/overlap': 'action:read_split_overlap',
  'GET /api/chat/split/request': 'action:request_split',
  'POST /api/chat/split': 'human:split-apply',
  'POST /api/chat/split/:parent/cleanup': 'human:split-apply',
  'POST /api/chat/split/:parent/hold': 'action:split_control',
  'POST /api/chat/split/:parent/relaunch': 'human:split-apply',
  'POST /api/chat/split/:parent/release': 'action:split_control',
  'POST /api/chat/split/:parent/resume': 'action:split_resume_interrupted',
  'POST /api/chat/split/:parent/review-decision': 'human:outward',
  'POST /api/chat/split/:parent/review-push': 'human:outward',
  'POST /api/chat/split/:parent/review-retry': 'human:outward',
  'POST /api/chat/split/:parent/tickets/file': 'human:outward',
  'POST /api/chat/split/decline': 'action:split_decline',
  // chat/transcript-routes.ts
  // Выгрузка разговора файлом — кнопка человека «Экспортировать» (D2, U5c).
  'GET /api/chat/:chatId/export': 'human:download',
  'GET /api/chat/:chatId/progress': 'action:read_chat',
  'GET /api/chat/search': 'action:search_chats',
  'GET /api/chats': 'action:list_chats',
  'GET /api/chats/:chatId/messages': 'action:read_chat',
  'GET /api/chats/:chatId/version': 'internal:ui-state',
  'GET /api/chats/projects': 'action:list_chat_projects',
  // chat/tree-routes.ts
  'GET /api/chat/:id/tree': 'action:read_chat,split_control',
  'GET /api/chat/awaiting': 'action:list_waiting',
  'POST /api/chat/:id/tree/pause': 'action:split_control',
  'POST /api/chat/:id/tree/resume': 'action:split_control',
  // compromise-routes.ts
  'GET /api/compromises': 'human:prompts',
  // config-preview-routes.ts
  'POST /api/config-preview': 'internal:preview',
  // config-routes.ts
  'DELETE /api/credentials': 'human:secret',
  'GET /api/account': 'action:read_account',
  'GET /api/credentials': 'action:read_claude_access',
  'GET /api/location': 'action:read_account',
  'GET /api/overview': 'action:overview',
  'GET /api/providers': 'action:list_providers',
  'GET /api/providers/detect': 'foreign-cli',
  'GET /api/settings': 'action:get_settings',
  'GET /api/settings/export': 'human:download',
  'GET /api/system': 'action:read_account',
  'PATCH /api/settings': 'action:update_settings,switch_provider,save_endpoint,delete_endpoint',
  'POST /api/credentials': 'human:secret',
  'POST /api/location': 'human:location',
  'POST /api/settings/import': 'human:settings-import',
  // dlp-routes.ts
  'DELETE /api/dlp/journal': 'action:clear_dlp_journal',
  'GET /api/dlp': 'action:get_dlp',
  'GET /api/dlp/journal': 'action:dlp_journal',
  'POST /api/dlp/preview': 'action:dlp_preview',
  'POST /api/dlp/start': 'action:toggle_dlp_proxy',
  'POST /api/dlp/stop': 'action:toggle_dlp_proxy',
  'PUT /api/dlp/rules': 'action:save_dlp_rules',
  // endpoint-routes.ts
  'DELETE /api/endpoints/:id/token': 'human:secret',
  'GET /api/endpoints': 'action:list_endpoints',
  'POST /api/endpoints/:id/apply': 'action:apply_endpoint',
  'POST /api/endpoints/:id/probe': 'action:probe_endpoint',
  'PUT /api/endpoints/:id/token': 'human:secret',
  // entity/env-routes.ts
  'DELETE /api/env': 'action:delete_env',
  'GET /api/env': 'action:list_env',
  'GET /api/env/reveal': 'human:secret',
  'POST /api/env': 'action:set_env',
  'POST /api/env/:key/move': 'action:move_env',
  // entity/hook-routes.ts
  'DELETE /api/hooks/:id': 'action:delete_hook',
  'GET /api/hooks': 'action:list_hooks',
  'POST /api/hooks': 'action:save_hook',
  'POST /api/hooks/:id/move': 'action:move_hook',
  'PUT /api/hooks/:id': 'action:save_hook',
  // entity/mcp-routes.ts
  'DELETE /api/mcp/:id': 'action:delete_mcp_server',
  'DELETE /api/mcp/:id/oauth': 'human:consent',
  'GET /api/mcp': 'action:list_mcp',
  'GET /api/mcp/oauth/callback': 'internal:callback',
  'POST /api/mcp': 'action:save_mcp_server',
  'POST /api/mcp/:id/health': 'action:check_mcp_health',
  'POST /api/mcp/:id/oauth/start': 'human:consent',
  'POST /api/mcp/:id/tools': 'action:list_mcp_tools',
  'PUT /api/mcp/:id': 'action:save_mcp_server',
  // entity/permission-routes.ts
  'DELETE /api/permissions/:id': 'action:remove_permission_rule',
  'GET /api/permissions': 'action:list_permissions',
  'POST /api/permissions': 'action:add_permission_rule',
  'POST /api/permissions/:id/move': 'action:move_permission',
  'PUT /api/permissions/:id': 'action:edit_permission_rule',
  // entity/rule-routes.ts
  'DELETE /api/rules/:id': 'action:delete_rule',
  'GET /api/claude-md': 'action:read_claude_md',
  'GET /api/rules': 'action:list_rules',
  'POST /api/rules': 'action:save_rule',
  'PUT /api/claude-md': 'action:save_claude_md',
  'PUT /api/rules/:id': 'action:save_rule',
  // entity/skill-routes.ts
  'DELETE /api/skills/:id': 'action:delete_skill',
  'GET /api/commands': 'action:list_commands',
  'GET /api/skills': 'action:list_skills',
  'POST /api/skills': 'action:save_skill',
  'POST /api/skills/:id/rename': 'action:rename_skill',
  'PUT /api/skills/:id': 'action:save_skill',
  // entity/toggle-routes.ts
  'POST /api/entities/:kind/:id/enabled':
    'action:toggle_rule,toggle_hook,toggle_skill,toggle_mcp_server,toggle_permission_rule',
  // env-transfer-routes.ts
  'GET /api/env-transfer/preview': 'action:env_transfer_preview',
  'POST /api/env-transfer/export': 'action:env_transfer_export',
  'POST /api/env-transfer/import/apply': 'human:upload',
  'POST /api/env-transfer/import/plan': 'human:upload',
  // events-routes.ts
  'GET /api/events': 'internal:stream',
  // format-check-routes.ts
  'GET /api/format-check': 'action:format_check',
  'POST /api/format-check/refresh': 'action:format_check',
  // group-duplicate-routes.ts
  'POST /api/groups/:id/duplicate': 'action:copy_group',
  // group-knobs-routes.ts
  'GET /api/groups/:id/knobs': 'action:read_group',
  'PUT /api/groups/:id/knobs': 'action:set_group_knobs,draft_group',
  // group-path-routes.ts
  'GET /api/groups/:id/members': 'action:read_group',
  'GET /api/groups/:id/path': 'action:read_group',
  'GET /api/groups/resource-catalog': 'action:list_resource_catalog',
  'GET /api/resources/summary': 'action:summarize_resource',
  'POST /api/groups/:id/path/draft': 'action:draft_group_step',
  'POST /api/groups/:id/path/promote': 'action:promote_group_step',
  'PUT /api/groups/:id/path/steps':
    'action:add_group_step,move_group_step,draft_group,draft_scenario',
  // group-routes.ts
  'DELETE /api/groups/:id': 'action:delete_group',
  'GET /api/groups': 'action:list_groups',
  'GET /api/groups/:id/delete-effect': 'internal:preview',
  'POST /api/groups': 'action:save_group,draft_group,draft_scenario',
  'POST /api/groups/:id/enabled': 'action:toggle_group',
  'POST /api/groups/activate': 'action:activate_groups_for_path',
  'PUT /api/groups/:id': 'action:save_group',
  // group-sources-routes.ts
  'GET /api/groups/:id/override': 'action:read_group_override',
  'GET /api/groups/discovery': 'action:list_discovered_groups',
  'GET /api/projects/group-choice': 'action:read_project_group_choice',
  'POST /api/groups/:id/advice/apply': 'action:apply_group_advice',
  'POST /api/groups/:id/copy-to-global': 'action:copy_group_to_global',
  'POST /api/groups/:id/merge-origin': 'action:merge_group_origin',
  'POST /api/groups/discovery/:key/import': 'action:import_discovered_group',
  'POST /api/groups/discovery/run': 'action:run_group_discovery',
  'PUT /api/groups/:id/override': 'action:set_group_override',
  'PUT /api/projects/group-choice': 'action:set_project_group_choice',
  // history-routes.ts
  'GET /api/history': 'action:list_history',
  'GET /api/history/diff': 'action:history_diff',
  'POST /api/history/revert-hunk': 'action:revert_history_hunk',
  // integrations/confluence-routes.ts
  'GET /api/integrations/confluence/page/:id': 'action:confluence_page',
  'GET /api/integrations/confluence/search': 'action:confluence_search',
  'GET /api/integrations/confluence/spaces': 'action:confluence_spaces',
  'POST /api/integrations/confluence/page': 'human:outward',
  'PUT /api/integrations/confluence/page/:id': 'human:outward',
  // integrations/connector-routes.ts
  'DELETE /api/integrations/:id': 'action:forget_integration',
  'GET /api/integrations': 'action:list_integrations',
  'POST /api/integrations/:id/check': 'action:check_integration',
  'PUT /api/integrations/:id': 'action:save_integration',
  // integrations/exchange-routes.ts
  'POST /api/integrations/ci/import': 'human:upload',
  'POST /api/integrations/telegram/test': 'human:outward',
  'POST /api/integrations/tms/pull': 'human:outward',
  'POST /api/integrations/tms/push': 'human:outward',
  'POST /api/integrations/webhook/test': 'human:outward',
  // integrations/jira-routes.ts
  'GET /api/integrations/jira/issue/:key': 'action:jira_issue',
  'GET /api/integrations/jira/issue/:key/transitions': 'action:jira_transitions',
  'GET /api/integrations/jira/projects': 'action:jira_projects',
  'GET /api/integrations/jira/search': 'action:jira_search',
  'POST /api/integrations/jira/issue': 'human:outward',
  'POST /api/integrations/jira/issue/:key/comment': 'human:outward',
  'POST /api/integrations/jira/issue/:key/transition': 'human:outward',
  // integrations/link-routes.ts
  'DELETE /api/integrations/links': 'action:remove_integration_link',
  'GET /api/integrations/links': 'action:list_integration_links',
  'PUT /api/integrations/links': 'action:save_integration_link',
  // integrations/mcp-routes.ts
  'DELETE /api/integrations/mcp/connect': 'action:atlassian_mcp_disconnect',
  'GET /api/integrations/mcp/connect': 'internal:preview',
  // Подключённый MCP Atlassian пишет наружу без карточки — только согласие человека (28.09).
  'POST /api/integrations/mcp/connect': 'human:consent',
  // media-routes.ts
  'GET /api/media/decks/:id/:format': 'internal:media',
  'GET /api/media/decks/plan': 'internal:media',
  'GET /api/media/images/:id': 'internal:media',
  'GET /api/media/images/plan': 'internal:media',
  'POST /api/media/agent-files': 'internal:callback',
  'POST /api/media/decks': 'human:paid',
  'POST /api/media/decks/block': 'internal:callback',
  'POST /api/media/images': 'human:paid',
  'POST /api/media/images/block': 'internal:callback',
  'POST /api/media/prompt': 'internal:preview',
  // model-routes.ts
  'GET /api/models': 'action:list_models',
  // panel-agent
  'DELETE /api/agent/conversations/:id': 'internal:agent',
  'GET /api/agent/actions': 'internal:agent',
  'GET /api/agent/conversations': 'internal:agent',
  'GET /api/agent/conversations/:id': 'internal:agent',
  'GET /api/agent/help/search': 'action:search_help',
  'GET /api/agent/help/topic': 'action:read_help_topic',
  'GET /api/agent/help/topics': 'action:list_help_topics',
  'GET /api/agent/journal': 'internal:agent',
  'GET /api/agent/pending': 'internal:agent',
  'GET /api/agent/run/:id/stream': 'internal:agent',
  'POST /api/agent/actions/:name': 'internal:agent',
  'POST /api/agent/pending/:id': 'internal:agent',
  'POST /api/agent/run': 'internal:agent',
  'POST /api/agent/run/:id/stop': 'internal:agent',
  // platform-routes.ts
  'DELETE /api/platforms/:id': 'action:delete_contour',
  'DELETE /api/platforms/:id/agents/sessions/:sessionId': 'action:reset_contour_agent_session',
  'DELETE /api/platforms/:id/spend/exhausted': 'action:clear_contour_exhausted',
  'DELETE /api/platforms/activation-notice': 'internal:ui-state',
  'DELETE /api/platforms/mcp/connect': 'action:contour_mcp_connect',
  'GET /api/platform-run-plan/:consumer': 'internal:preview',
  'GET /api/platforms': 'action:list_contours,contour_status',
  'GET /api/platforms/:id/agents/sessions/:sessionId': 'action:read_contour_agent_session',
  'GET /api/platforms/:id/apply': 'internal:preview',
  'GET /api/platforms/:id/spend': 'action:contour_spend',
  'GET /api/platforms/gateway': 'action:gateway_status',
  'GET /api/platforms/mcp/connect': 'internal:preview',
  'POST /api/platforms/:id/activate': 'action:enable_contour',
  'POST /api/platforms/:id/agents/ask': 'action:ask_contour_agent',
  'POST /api/platforms/:id/apply': 'action:enable_contour,save_contour_draft',
  'POST /api/platforms/:id/check': 'action:probe_contour_url',
  'POST /api/platforms/:id/deactivate': 'action:deactivate_contour',
  'POST /api/platforms/:id/disable': 'action:disable_contour',
  'POST /api/platforms/:id/embeddings': 'action:contour_embeddings',
  'POST /api/platforms/gateway/restart': 'action:restart_gateway',
  'POST /api/platforms/gateway/start': 'action:start_gateway',
  'POST /api/platforms/mcp/connect': 'action:contour_mcp_connect',
  'PUT /api/platforms/:id': 'action:save_contour_draft,enable_contour',
  'PUT /api/platforms/:id/token': 'human:secret',
  // plugin-routes.ts
  'DELETE /api/plugins/marketplaces/:name': 'action:remove_plugin_marketplace',
  'GET /api/plugins': 'action:list_plugins',
  'GET /api/plugins/available': 'action:list_available_plugins',
  'POST /api/plugins/:id/enabled': 'action:toggle_plugin',
  'POST /api/plugins/:id/uninstall': 'action:uninstall_plugin',
  'POST /api/plugins/:id/update': 'action:update_plugin',
  'POST /api/plugins/install': 'action:install_plugin',
  'POST /api/plugins/marketplaces': 'action:add_plugin_marketplace',
  'POST /api/plugins/scaffold': 'action:scaffold_plugin',
  // portability-carry-routes.ts
  'GET /api/portability/carry': 'foreign-cli',
  'POST /api/portability/carry/apply': 'foreign-cli',
  // portability-routes.ts
  'DELETE /api/portability/subscription': 'foreign-cli',
  'GET /api/portability/fidelity': 'action:portability_fidelity',
  'GET /api/portability/passport': 'action:read_env_passport',
  'GET /api/portability/subscriptions': 'action:list_portability_subscriptions',
  'GET /api/portability/transfer': 'action:portability_plan,portability_transfer',
  'POST /api/portability/apply': 'action:apply_portability',
  'POST /api/portability/plan': 'internal:preview',
  'POST /api/portability/probe': 'foreign-cli',
  'POST /api/portability/revert': 'action:revert_portability',
  'POST /api/portability/subscription/apply': 'foreign-cli',
  'POST /api/portability/subscription/drift/apply': 'foreign-cli',
  'POST /api/portability/subscription/drift/plan': 'foreign-cli',
  'POST /api/portability/subscription/plan': 'foreign-cli',
  'PUT /api/portability/subscription': 'foreign-cli',
  // project-files-routes.ts
  'DELETE /api/project-files/view': 'internal:ui-state',
  'GET /api/project-files/changes': 'action:read_project_changes',
  'GET /api/project-files/content': 'action:read_project_file',
  'GET /api/project-files/layout': 'internal:ui-state',
  'GET /api/project-files/raw': 'internal:media',
  'GET /api/project-files/tree': 'action:list_project_files',
  'GET /api/project-files/view': 'internal:ui-state',
  'PUT /api/project-files/content': 'human:code-write',
  'PUT /api/project-files/layout': 'internal:ui-state',
  'PUT /api/project-files/view': 'internal:ui-state',
  // project-git-routes.ts
  'GET /api/project-git': 'action:project_git_status',
  'GET /api/project-git/mirror-settings': 'action:read_project_copy_settings',
  'GET /api/project-git/split-settings': 'internal:preview',
  'GET /api/project-git/worktrees': 'action:list_worktrees',
  'GET /api/project-git/worktrees/bootstrap-log': 'action:read_worktree_bootstrap_log',
  'POST /api/project-git/branch': 'action:git_create_branch',
  'POST /api/project-git/checkout': 'action:git_checkout',
  'POST /api/project-git/commit': 'action:git_commit',
  'POST /api/project-git/pull': 'action:git_pull',
  'POST /api/project-git/push': 'human:outward',
  'POST /api/project-git/worktrees/add': 'action:add_worktree',
  'POST /api/project-git/worktrees/bootstrap': 'action:bootstrap_worktree',
  'POST /api/project-git/worktrees/mirror': 'action:mirror_worktree',
  'POST /api/project-git/worktrees/remove': 'action:remove_worktree',
  'PUT /api/project-git/mirror-settings': 'action:save_project_mirror_settings',
  'PUT /api/project-git/split-settings': 'action:save_project_split_settings',
  // project-local-routes.ts
  'GET /api/projects/:id/local': 'action:read_project_local_config',
  'GET /api/projects/local': 'action:read_project_local_config',
  // project-routes.ts
  'DELETE /api/projects/:id': 'action:delete_project',
  'DELETE /api/projects/:id/mcp/:serverId': 'action:delete_project_mcp_server',
  'DELETE /api/projects/:id/permissions/:permId': 'action:remove_project_permission',
  'GET /api/projects': 'action:list_projects',
  'GET /api/projects/:id/mcp': 'action:list_project_mcp',
  'GET /api/projects/:id/permissions': 'action:list_project_permissions',
  'GET /api/projects/:id/rules': 'action:read_project_claude_md',
  'POST /api/projects': 'action:create_project',
  'POST /api/projects/:id/mcp': 'action:save_project_mcp_server',
  'POST /api/projects/:id/mcp/:serverId/enabled': 'action:toggle_project_mcp_server',
  'POST /api/projects/:id/permissions': 'action:add_project_permission',
  'PUT /api/projects/:id/mcp/:serverId': 'action:save_project_mcp_server',
  'PUT /api/projects/:id/permissions/:permId': 'action:edit_project_permission',
  'PUT /api/projects/:id/rules': 'action:save_project_claude_md',
  // project-runner-routes.ts
  'GET /api/project-runner': 'internal:preview',
  'GET /api/project-runner/describe': 'action:describe_project_runner',
  'GET /api/project-runner/port': 'internal:preview',
  'POST /api/project-runner/autostart': 'action:set_project_runner_autostart',
  'POST /api/project-runner/autostart/clear': 'internal:ui-state',
  'POST /api/project-runner/free-port': 'action:free_port',
  'POST /api/project-runner/settings': 'action:save_project_runner_settings',
  'POST /api/project-runner/start': 'action:start_project_runner',
  'POST /api/project-runner/stop': 'action:stop_project_runner',
  // project-tests/case-history-routes.ts
  'GET /api/project-tests/case-history': 'action:read_tests_report',
  'GET /api/project-tests/flaky': 'action:read_tests_report',
  // project-tests/coverage-routes.ts
  'POST /api/project-tests/coverage': 'action:coverage',
  'POST /api/project-tests/defects/refresh': 'action:refresh_defect_states',
  // project-tests/defect-routes.ts
  'POST /api/project-tests/defect': 'action:draft_defect',
  'POST /api/project-tests/defect/create': 'human:outward',
  // project-tests/draft-routes.ts
  'GET /api/project-tests/drafts': 'action:list_test_drafts',
  'POST /api/project-tests/draft/apply': 'action:draft_cases',
  'POST /api/project-tests/draft/auto': 'action:set_draft_auto_accept',
  'POST /api/project-tests/draft/from-chat': 'gap:P3',
  'POST /api/project-tests/draft/reject': 'action:reject_draft',
  'POST /api/project-tests/draft/rollback': 'action:rollback_draft',
  // project-tests/e2e-routes.ts
  'DELETE /api/project-tests/e2e': 'action:remove_e2e_folder',
  'GET /api/project-tests/e2e': 'action:read_tests_report',
  'GET /api/project-tests/pyramid': 'action:read_tests_report',
  'POST /api/project-tests/e2e': 'action:create_e2e_folder',
  'POST /api/project-tests/e2e/run': 'action:run_e2e_tests',
  'POST /api/project-tests/e2e/run/stop': 'action:stop_e2e_tests',
  'POST /api/project-tests/e2e/sync': 'action:sync_e2e_tests',
  // project-tests/health-routes.ts
  'GET /api/project-tests/lint': 'action:lint_tests',
  'GET /api/project-tests/quarantine': 'action:read_tests_report',
  'GET /api/project-tests/risk': 'action:read_tests_report',
  'GET /api/project-tests/taxonomy': 'action:read_tests_report',
  // project-tests/import-routes.ts
  'GET /api/project-tests/export': 'human:download',
  'GET /api/project-tests/run/export': 'human:download',
  'POST /api/project-tests/import/cases': 'human:upload',
  'POST /api/project-tests/import/results': 'human:upload',
  // project-tests/library-routes.ts
  'DELETE /api/project-tests/case': 'action:delete_test_case',
  'DELETE /api/project-tests/environment': 'action:delete_test_environment',
  'DELETE /api/project-tests/group': 'action:delete_test_group',
  'DELETE /api/project-tests/shared-step': 'action:delete_shared_step',
  'DELETE /api/project-tests/view': 'action:delete_test_view',
  'GET /api/project-tests': 'action:list_test_groups,list_cases,last_run,read_tests_report',
  'GET /api/project-tests/defaults': 'action:list_default_test_groups',
  'POST /api/project-tests/bulk': 'action:bulk_edit_cases,bulk_delete_cases',
  'POST /api/project-tests/case': 'action:save_test_case',
  'POST /api/project-tests/convention': 'action:install_test_convention',
  'POST /api/project-tests/environment': 'action:save_test_environment',
  'POST /api/project-tests/group': 'action:save_test_group',
  'POST /api/project-tests/group/update': 'action:save_test_group',
  'POST /api/project-tests/schema': 'action:save_test_schema',
  'POST /api/project-tests/shared-step': 'action:save_shared_step',
  'POST /api/project-tests/view': 'action:save_test_view',
  // project-tests/manual-routes.ts
  'GET /api/project-tests/baselines': 'action:read_tests_report',
  'GET /api/project-tests/manual': 'action:read_tests_report',
  'POST /api/project-tests/attachment': 'action:attach_test_note',
  'POST /api/project-tests/baseline': 'human:upload',
  'POST /api/project-tests/baseline/accept': 'action:accept_baseline',
  'POST /api/project-tests/manual/cancel': 'action:cancel_manual_run',
  'POST /api/project-tests/manual/finish': 'action:finish_manual_run',
  'POST /api/project-tests/manual/result': 'action:record_manual_result',
  'POST /api/project-tests/manual/start': 'action:start_manual_run',
  // project-tests/plan-routes.ts
  'DELETE /api/project-tests/plan': 'action:delete_test_plan',
  'GET /api/project-tests/plan/points': 'action:read_tests_report',
  'GET /api/project-tests/plan/preview': 'internal:preview',
  'GET /api/project-tests/plans': 'action:read_tests_report',
  'POST /api/project-tests/plan': 'action:save_test_plan',
  'POST /api/project-tests/plan/build': 'action:build_test_plan',
  // project-tests/publish-routes.ts
  'POST /api/project-tests/run/publish': 'human:outward',
  // project-tests/release-routes.ts
  'GET /api/project-tests/release': 'action:read_tests_report',
  'GET /api/project-tests/release/export': 'human:download',
  'GET /api/project-tests/release/pdf': 'human:download',
  // project-tests/run-routes.ts
  'GET /api/project-tests/history': 'action:read_tests_report',
  'GET /api/project-tests/impact': 'action:read_tests_report',
  'GET /api/project-tests/report': 'action:read_tests_report',
  'GET /api/project-tests/run': 'action:read_test_run',
  'GET /api/project-tests/run/diff': 'action:read_tests_report',
  'GET /api/project-tests/run/pdf': 'human:download',
  'GET /api/project-tests/runs': 'action:last_run,list_test_runs',
  'POST /api/project-tests/run': 'action:run_tests',
  'POST /api/project-tests/stop': 'action:stop_tests',
  // project-tests/secret-routes.ts
  'DELETE /api/project-tests/env-secret': 'human:secret',
  'GET /api/project-tests/env-secrets': 'human:secret',
  'POST /api/project-tests/env-secret': 'human:secret',
  // prompt-gate-routes.ts
  'GET /api/prompt-gate': 'human:prompt-gate',
  'PUT /api/prompt-gate': 'human:prompt-gate',
  // prompt-routes.ts
  'DELETE /api/prompts/:id': 'human:prompts',
  'GET /api/prompts': 'human:prompts',
  'GET /api/prompts/:id': 'human:prompts',
  'PUT /api/prompts/:id': 'human:prompts',
  // provider-chat-routes.ts
  'DELETE /api/provider-chat/chats/:id': 'foreign-cli',
  'GET /api/provider-chat/chats': 'foreign-cli',
  'GET /api/provider-chat/chats/:id': 'foreign-cli',
  'GET /api/provider-chat/chats/:id/status': 'foreign-cli',
  'GET /api/provider-chat/chats/:id/stream': 'foreign-cli',
  'PATCH /api/provider-chat/chats/:id': 'foreign-cli',
  'POST /api/provider-chat/chats': 'foreign-cli',
  'POST /api/provider-chat/chats/:id/restart': 'foreign-cli',
  'POST /api/provider-chat/chats/:id/send': 'foreign-cli',
  'POST /api/provider-chat/chats/:id/stop': 'foreign-cli',
  // provider-check-routes.ts
  'GET /api/providers/checks': 'action:read_provider_checks',
  'POST /api/providers/:id/check': 'action:run_provider_check',
  // provider-compare-routes.ts
  'GET /api/provider-compare': 'action:compare_providers',
  'POST /api/provider-migrate': 'foreign-cli',
  // provider-env-routes.ts
  'GET /api/provider-env': 'foreign-cli',
  'PUT /api/provider-env': 'foreign-cli',
  // provider-hooks-routes.ts
  'GET /api/provider-hooks': 'foreign-cli',
  'PUT /api/provider-hooks': 'foreign-cli',
  // provider-instructions-routes.ts
  'GET /api/provider-instructions': 'foreign-cli',
  'GET /api/provider-instructions/file': 'foreign-cli',
  'PUT /api/provider-instructions': 'foreign-cli',
  'PUT /api/provider-instructions/file': 'foreign-cli',
  // provider-keys-routes.ts
  'DELETE /api/provider-keys/:id': 'foreign-cli',
  'GET /api/provider-keys': 'foreign-cli',
  'GET /api/provider-runner': 'foreign-cli',
  'PUT /api/provider-keys/:id': 'foreign-cli',
  // provider-mcp-routes.ts
  'DELETE /api/provider-mcp/:id': 'foreign-cli',
  'GET /api/provider-mcp': 'foreign-cli',
  'POST /api/provider-mcp': 'foreign-cli',
  'PUT /api/provider-mcp/:id': 'foreign-cli',
  // provider-permissions-routes.ts
  'GET /api/provider-permissions': 'foreign-cli',
  'PUT /api/provider-permissions': 'foreign-cli',
  // provider-plugins-routes.ts
  'DELETE /api/provider-plugins/file': 'foreign-cli',
  'GET /api/provider-plugins': 'foreign-cli',
  'GET /api/provider-plugins/file': 'foreign-cli',
  'PUT /api/provider-plugins/file': 'foreign-cli',
  'PUT /api/provider-plugins/packages': 'foreign-cli',
  // provider-preview-routes.ts
  'POST /api/provider-preview': 'foreign-cli',
  // provider-project/env-routes.ts
  'GET /api/projects/:id/provider/env': 'foreign-cli',
  'PUT /api/projects/:id/provider/env': 'foreign-cli',
  // provider-project/hooks-routes.ts
  'GET /api/projects/:id/provider/hooks': 'foreign-cli',
  'PUT /api/projects/:id/provider/hooks': 'foreign-cli',
  // provider-project/info-routes.ts
  'GET /api/projects/:id/provider': 'foreign-cli',
  // provider-project/instructions-routes.ts
  'GET /api/projects/:id/provider/instructions': 'foreign-cli',
  'GET /api/projects/:id/provider/instructions-list': 'foreign-cli',
  'GET /api/projects/:id/provider/instructions-list/file': 'foreign-cli',
  'PUT /api/projects/:id/provider/instructions': 'foreign-cli',
  'PUT /api/projects/:id/provider/instructions-list': 'foreign-cli',
  'PUT /api/projects/:id/provider/instructions-list/file': 'foreign-cli',
  // provider-project/mcp-routes.ts
  'DELETE /api/projects/:id/provider/mcp/:serverId': 'foreign-cli',
  'GET /api/projects/:id/provider/mcp': 'foreign-cli',
  'POST /api/projects/:id/provider/mcp': 'foreign-cli',
  'PUT /api/projects/:id/provider/mcp/:serverId': 'foreign-cli',
  // provider-project/permissions-routes.ts
  'GET /api/projects/:id/provider/permissions': 'foreign-cli',
  'PUT /api/projects/:id/provider/permissions': 'foreign-cli',
  // provider-project/plugins-routes.ts
  'DELETE /api/projects/:id/provider/plugins/file': 'foreign-cli',
  'GET /api/projects/:id/provider/plugins': 'foreign-cli',
  'GET /api/projects/:id/provider/plugins/file': 'foreign-cli',
  'PUT /api/projects/:id/provider/plugins/file': 'foreign-cli',
  'PUT /api/projects/:id/provider/plugins/packages': 'foreign-cli',
  // provider-project/rules-routes.ts
  'DELETE /api/projects/:id/provider/rules/rule': 'foreign-cli',
  'GET /api/projects/:id/provider/rules': 'foreign-cli',
  'GET /api/projects/:id/provider/rules/rule': 'foreign-cli',
  'PUT /api/projects/:id/provider/rules/rule': 'foreign-cli',
  // provider-project/skills-routes.ts
  'DELETE /api/projects/:id/provider/skills/skill': 'foreign-cli',
  'GET /api/projects/:id/provider/skills': 'foreign-cli',
  'GET /api/projects/:id/provider/skills/skill': 'foreign-cli',
  'PUT /api/projects/:id/provider/skills/skill': 'foreign-cli',
  // provider-rules-routes.ts
  'DELETE /api/provider-rules/rule': 'foreign-cli',
  'GET /api/provider-rules': 'foreign-cli',
  'GET /api/provider-rules/rule': 'foreign-cli',
  'PUT /api/provider-rules/rule': 'foreign-cli',
  // provider-skills-routes.ts
  'DELETE /api/provider-skills/skill': 'foreign-cli',
  'GET /api/provider-skills': 'foreign-cli',
  'GET /api/provider-skills/skill': 'foreign-cli',
  'PUT /api/provider-skills/skill': 'foreign-cli',
  // remote-routes.ts
  'DELETE /api/remote/devices': 'human:remote',
  'GET /api/remote': 'human:remote',
  'PATCH /api/remote': 'human:remote',
  'POST /api/remote/devices': 'human:remote',
  'POST /api/remote/test': 'human:remote',
  'POST /api/remote/token': 'human:remote',
  // resource-routes.ts
  'DELETE /api/resources/:kind/:id/file': 'action:delete_skill_file',
  'GET /api/resources/:kind/:id/file': 'action:read_skill_file',
  'GET /api/resources/:kind/:id/files': 'action:list_skill_files',
  'GET /api/resources/:kind/templates': 'action:list_skill_templates',
  'POST /api/resources/:kind/:id/apply-template': 'action:apply_skill_template',
  'POST /api/resources/:kind/:id/assist': 'internal:assistant',
  'POST /api/resources/:kind/:id/move': 'action:move_skill_file',
  'PUT /api/resources/:kind/:id/file': 'action:save_skill_file',
  // sandbox-routes.ts
  'DELETE /api/sandbox/:id': 'action:sandbox_probe_hook,sandbox_ask',
  'GET /api/sandbox/:id/files': 'action:sandbox_ask',
  'GET /api/sandbox/fixtures': 'action:list_sandbox_fixtures',
  'POST /api/sandbox/:id/stop': 'action:sandbox_ask',
  'POST /api/sandbox/create': 'action:sandbox_probe_hook,sandbox_ask',
  // Вызов инструмента MCP из песочницы может писать наружу — человеку (D2, U5c).
  'POST /api/sandbox/mcp-call': 'human:outward',
  // Список инструментов для той же формы вызова — половина человеческого пути
  // выше. Агенту список инструментов даёт `list_mcp_tools` (`POST /api/mcp/:id/tools`).
  'POST /api/sandbox/mcp-tools': 'human:outward',
  'POST /api/sandbox/probe-hook': 'action:sandbox_probe_hook',
  'POST /api/sandbox/run': 'action:sandbox_ask',
  // script-routes.ts
  'DELETE /api/scripts/*': 'action:delete_script',
  'GET /api/scripts': 'action:list_scripts',
  'GET /api/scripts/*': 'action:read_script',
  'POST /api/scripts': 'action:save_script',
  'PUT /api/scripts/*': 'action:save_script',
  // search-routes.ts
  'GET /api/search': 'action:search_panel',
  // split-defaults-routes.ts
  'GET /api/split-defaults': 'action:read_split_defaults',
  'PUT /api/split-defaults': 'action:save_split_defaults',
  // sieve-routes.ts
  'GET /api/sieves': 'action:read_sieves',
  'DELETE /api/sieves/learned/:id': 'action:delete_learned_sieve',
  'POST /api/sieves/learned/:id/accept': 'human:prompts',
  // dev-restart-routes.ts
  'GET /api/dev-restart': 'internal:ui-state',
  'POST /api/dev-restart': 'human:dev-restart',
  // watcher-routes.ts
  'GET /api/watcher': 'action:watcher_status',
  'POST /api/watcher': 'action:set_watcher',
  'POST /api/watcher/events': 'internal:ui-state',
};
