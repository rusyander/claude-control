/**
 * Фальшивый `claude` для хода агента над проектом (`check-agent-projects-walk.mjs`).
 *
 * Разговор с панелью — тот же, что у `fake-cli-panel-agent.mjs` (настоящий
 * переходник `tools/mcp/panel.mjs` из `--mcp-config` панели, MCP по stdio,
 * `stream-json` на выход); подменён только выбор хода по ТЕКУЩЕЙ просьбе:
 * - «создай ветку B в проекте P и закоммить» → `list_projects`, `git_create_branch`,
 *   `git_commit`; ответ называет сделанное или отказ;
 * - «покажи файл F проекта P» → `read_project_file`; ответ пересказывает текст,
 *   каким его вернула панель (секреты модели не видны — значит, и в ответе их нет);
 * - «отправь проект P на сервер» → `git_push`: такого действия у агента нет.
 */
import { FAKE_PANEL_AGENT_CLI_SOURCE } from './fake-cli-panel-agent.mjs';

const SCENARIO = String.raw`const current = (/Human \(current request\): ([\s\S]*)$/.exec(prompt)?.[1] ?? prompt).trim();
  const projectName = (/проект[а-я]*\s+«([^»]+)»/i.exec(current)?.[1] ?? '').trim();
  // Список приходит массивом: разбор с первой скобки любого вида.
  const listed = (await tool('list_projects', {})).text;
  let projects;
  try {
    projects = JSON.parse(listed.slice(listed.search(/[[{]/)));
  } catch {
    projects = undefined;
  }
  const list = Array.isArray(projects) ? projects : (projects?.projects ?? []);
  const project = list.find((item) => item.name === projectName);
  let reply;
  if (!project) {
    reply = 'Проекта «' + projectName + '» нет в панели.';
  } else if (/ветк/i.test(current)) {
    const branch = (/ветку\s+(\S+)/i.exec(current)?.[1] ?? 'feature/x').trim();
    const made = await tool('git_create_branch', { project: project.id, name: branch });
    if (made.isError || !made.text.startsWith('Done.')) {
      reply = 'Ветка ' + branch + ' не создана: ' + made.text.split('\n')[0];
    } else {
      const commit = await tool('git_commit', { project: project.id, message: 'walk: ' + branch });
      reply = commit.isError || !commit.text.startsWith('Done.')
        ? 'Ветка ' + branch + ' создана, коммит не сделан: ' + commit.text.split('\n')[0]
        : 'Создал ветку ' + branch + ' и закоммитил правки.';
    }
  } else if (/файл/i.test(current)) {
    const file = (/файл\s+(\S+)/i.exec(current)?.[1] ?? '').trim();
    const read = await tool('read_project_file', { project: project.id, file });
    const body = parse(read.text);
    reply = read.isError ? 'Файл не прочитан: ' + read.text : 'Файл ' + file + ':\n' + (body?.text ?? read.text);
  } else {
    const push = await tool('git_push', { project: project.id });
    reply = push.isError ? 'Отправить не могу: ' + push.text.split('\n')[0] : 'Отправил.';
  }
`;

const REPLY_LINE =
  "  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });";
const start = FAKE_PANEL_AGENT_CLI_SOURCE.indexOf('const current =');
const end = FAKE_PANEL_AGENT_CLI_SOURCE.indexOf(REPLY_LINE);
if (start < 0 || end < start) {
  throw new Error('fake-cli-panel-agent.mjs changed shape: scenario anchors not found');
}

export const FAKE_PANEL_AGENT_PROJECTS_CLI_SOURCE =
  FAKE_PANEL_AGENT_CLI_SOURCE.slice(0, start) + SCENARIO + FAKE_PANEL_AGENT_CLI_SOURCE.slice(end);
