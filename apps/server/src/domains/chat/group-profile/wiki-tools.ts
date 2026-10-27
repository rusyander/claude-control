/**
 * Имена инструментов вики трекера — для CLI, чей выключатель снимает инструменты
 * только поимённо (Codex: `mcp_servers.<сервер>.disabled_tools`, точное имя, шаблон
 * `confluence_*` он не понимает — проверено codex 0.155.1 телом запроса). У Claude
 * хватает шаблона в `deny`, список не нужен.
 *
 * Набор — объединение: сервер трекера с вики (35 имён `confluence_*`, сняты с
 * переписки группы 25.10) и мост трекера панели (`tools/mcp/atlassian.mjs`,
 * сверяется тестом). Лишнее имя безвредно (снимать нечего), новое имя новой версии
 * сервера останется у группы — дороже на одно описание, но не поломка.
 */
export const WIKI_TOOL_NAMES: readonly string[] = [
  'confluence_add_comment',
  'confluence_add_inline_comment',
  'confluence_add_label',
  'confluence_check_content_permissions',
  'confluence_copy_page',
  'confluence_create_page',
  'confluence_create_page_from_template',
  'confluence_delete_attachment',
  'confluence_delete_page',
  'confluence_download_attachment',
  'confluence_download_content_attachments',
  'confluence_get_attachments',
  'confluence_get_comments',
  'confluence_get_inline_comments',
  'confluence_get_labels',
  'confluence_get_page',
  'confluence_get_page_children',
  'confluence_get_page_diff',
  'confluence_get_page_history',
  'confluence_get_page_images',
  'confluence_get_page_restrictions',
  'confluence_get_page_template',
  'confluence_get_page_views',
  'confluence_get_space_page_tree',
  'confluence_get_space_permissions',
  'confluence_list_page_templates',
  'confluence_move_page',
  'confluence_page',
  'confluence_reply_to_comment',
  'confluence_search',
  'confluence_search_user',
  'confluence_set_page_restrictions',
  'confluence_spaces',
  'confluence_update_page',
  'confluence_update_page_section',
  'confluence_upload_attachment',
  'confluence_upload_attachments',
];
