/** Имя инструмента MCP: `mcp__<сервер>__<инструмент>`, у вызова с файлом — и путь после пробела. */
const MCP_TOOL = /^mcp__(.+?)__(\S+)/;

/**
 * Список «разрешено автоматически» одной строкой (живой прогон 20.10, карточка
 * 28): `mcp__tracker__jira_assign_issue` шесть раз подряд занимал
 * пол-карточки. Одинаковые отметки сводятся в «имя ×N», вызовы MCP — под меткой
 * своего сервера («tracker: jira_assign_issue ×6, jira_transition_issue
 * ×7»), у вызова MCP с файлом в счёт идёт имя инструмента — файлы разные, а
 * читать нужно, ЧТО прошло без человека. Порядок — по первому появлению.
 */
export function autoNoticeList(summaries: readonly string[]): string {
  // Строка — отметка или сервер MCP со счётом его инструментов; Map держит порядок появления.
  const rows = new Map<string, { server?: string; counts: Map<string, number> }>();
  for (const summary of summaries) {
    const mcp = MCP_TOOL.exec(summary);
    const server = mcp?.[1];
    const key = server === undefined ? `=${summary}` : `mcp:${server}`;
    const row = rows.get(key) ?? { ...(server === undefined ? {} : { server }), counts: new Map() };
    const label = mcp?.[2] ?? summary;
    row.counts.set(label, (row.counts.get(label) ?? 0) + 1);
    rows.set(key, row);
  }

  return [...rows.values()]
    .map(({ server, counts }) => {
      const list = [...counts]
        .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
        .join(', ');
      return server === undefined ? list : `${server}: ${list}`;
    })
    .join('; ');
}
