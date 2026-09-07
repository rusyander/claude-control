/**
 * Ключи кэша внешних интеграций.
 *
 * Список коннекторов адресуется одним ключом: их всегда пять, и сервер отдаёт
 * их вместе. Привязки — ПУТЁМ проекта, как и всё в тестах: один и тот же проект
 * открывают из чата, из реестра и с телефона, и путь — единственное, что
 * делает эти входы одним кэшем.
 *
 * Поиск по Jira и Confluence кэшируется по запросу: человек листает результаты
 * туда-обратно, и повторять чужой сетевой вызов на каждый рендер незачем.
 */
const ROOT = 'integrations';

export const integrationKeys = {
  root: [ROOT],
  list: [ROOT, 'list'],
  links: (path: string | undefined) => [ROOT, 'links', path ?? ''],
  jiraProjects: [ROOT, 'jira', 'projects'],
  jiraSearch: (query: string) => [ROOT, 'jira', 'search', query],
  confluenceSearch: (query: string) => [ROOT, 'confluence', 'search', query],
};
