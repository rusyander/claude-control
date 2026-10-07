/**
 * Фальшивый `claude` для хода агента по разделу тестов через окно
 * (`check-agent-tests-case-walk.mjs`, Ф22: panel-agent-002 и -004).
 *
 * Разговор с панелью — тот же, что у `fake-cli-panel-agent.mjs` (настоящий
 * переходник `tools/mcp/panel.mjs` из `--mcp-config` панели); подменён только
 * выбор хода по ТЕКУЩЕЙ просьбе:
 * - «открой тестирование проекта «P»» → `list_projects`, `open_page` с
 *   `projectPath` этого проекта;
 * - «добавь в группу «G» проекта «P» кейс «T»» → `list_projects`,
 *   `save_test_case` (шаги и оракул — как написал бы агент); ответ называет кейс
 *   или отказ.
 */
import { FAKE_PANEL_AGENT_CLI_SOURCE } from './fake-cli-panel-agent.mjs';

const SCENARIO = String.raw`const current = (/Human \(current request\): ([\s\S]*)$/.exec(prompt)?.[1] ?? prompt).trim();
  const projectName = (/проект[а-я]*\s+«([^»]+)»/i.exec(current)?.[1] ?? '').trim();
  const json = (text) => {
    const at = text.search(/[[{]/);
    try { return at < 0 ? undefined : JSON.parse(text.slice(at)); } catch { return undefined; }
  };
  const projects = json((await tool('list_projects', {})).text);
  const list = Array.isArray(projects) ? projects : (projects?.projects ?? []);
  const project = list.find((item) => item.name === projectName);
  let reply;
  if (!project) {
    reply = 'Проекта «' + projectName + '» нет в панели.';
  } else if (/открой/i.test(current)) {
    const opened = await tool('open_page', { route: '/tests', projectPath: project.path });
    reply = opened.isError || !opened.text.startsWith('Done.')
      ? 'Не открыл: ' + opened.text.split('\n')[0]
      : 'Открыл тестирование проекта «' + projectName + '».';
  } else {
    const groupId = (/в группу\s+«([^»]+)»/i.exec(current)?.[1] ?? '').trim();
    const title = (/кейс\s+«([^»]+)»/i.exec(current)?.[1] ?? '').trim();
    const saved = await tool('save_test_case', {
      projectPath: project.path,
      groupId,
      title,
      steps: [
        { action: 'Оставить поле сообщения пустым и нажать Enter', expected: 'Сообщение не уходит, лента не меняется' },
      ],
      oracle: 'Лента чата и запросы /api/chat — нового хода нет',
    });
    const body = json(saved.text);
    reply = saved.isError || !saved.text.startsWith('Done.')
      ? 'Кейс «' + title + '» не заведён: ' + saved.text.split('\n')[0]
      : 'Завёл кейс «' + title + '» (' + (body?.caseId ?? '?') + ') в группе ' + groupId + '.';
  }
`;

const REPLY_LINE =
  "  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });";
const start = FAKE_PANEL_AGENT_CLI_SOURCE.indexOf('const current =');
const end = FAKE_PANEL_AGENT_CLI_SOURCE.indexOf(REPLY_LINE);
if (start < 0 || end < start) {
  throw new Error('fake-cli-panel-agent.mjs changed shape: scenario anchors not found');
}

export const FAKE_PANEL_AGENT_TESTS_CASE_CLI_SOURCE =
  FAKE_PANEL_AGENT_CLI_SOURCE.slice(0, start) + SCENARIO + FAKE_PANEL_AGENT_CLI_SOURCE.slice(end);
