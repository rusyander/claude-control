/**
 * Фальшивый `claude` для хода агента по действиям, закрывшим пробелы реестра
 * возможностей (`check-agent-gaps-walk.mjs`, дорожка A 28.09).
 *
 * Разговор с панелью — тот же, что у `fake-cli-panel-agent.mjs` (настоящий
 * переходник `tools/mcp/panel.mjs` из `--mcp-config` панели, MCP по stdio,
 * `stream-json` на выход); подменён только выбор хода по ТЕКУЩЕЙ просьбе:
 * - «что поменял агент в чате «ID»» → `read_project_changes`; ответ перечисляет файлы;
 * - «что в .claude папки «P»» → `read_project_local_config`; ответ называет скиллы,
 *   правила и команды хуков так, как их вернула панель (ключ модели не виден);
 * - «выключи/включи подбор модели в проекте «P»» → `set_model_cascade`.
 */
import { FAKE_PANEL_AGENT_CLI_SOURCE } from './fake-cli-panel-agent.mjs';

const SCENARIO = String.raw`const current = (/Human \(current request\): ([\s\S]*)$/.exec(prompt)?.[1] ?? prompt).trim();
  const quoted = (/«([^»]+)»/.exec(current)?.[1] ?? '').trim();
  const first = (text) => text.split('\n')[0];
  // Имя проекта — в id через list_projects (как делает модель); путь уходит как есть.
  const projectRef = async () => {
    if (/^[A-Za-z]:[\\/]|^\//.test(quoted)) return quoted;
    const listed = (await tool('list_projects', {})).text;
    let projects;
    try {
      projects = JSON.parse(listed.slice(listed.search(/[[{]/)));
    } catch {
      projects = undefined;
    }
    const list = Array.isArray(projects) ? projects : (projects?.projects ?? []);
    return list.find((item) => item.name === quoted)?.id ?? quoted;
  };
  let reply;
  if (/поменял/i.test(current)) {
    const read = await tool('read_project_changes', { chat: quoted });
    const body = parse(read.text);
    reply = read.isError || !body
      ? 'Правки не прочитаны: ' + first(read.text)
      : 'Файлы: ' + body.files.map((file) => file.path + ' +' + file.added + '/-' + file.removed).join(', ');
  } else if (/\.claude/i.test(current)) {
    const read = await tool('read_project_local_config', { project: await projectRef() });
    const body = parse(read.text);
    reply = read.isError || !body
      ? 'Папка не прочитана: ' + first(read.text)
      : 'Скиллы: ' + body.skills.map((skill) => skill.name).join(', ') +
        '; правила: ' + body.rules.map((rule) => rule.path).join(', ') +
        '; хуки: ' + body.hooks.map((hook) => hook.event + ' ' + hook.command).join(' | ');
  } else {
    const enabled = !/выключи/i.test(current);
    const made = await tool('set_model_cascade', { project: await projectRef(), enabled });
    reply = made.isError || !made.text.startsWith('Done.')
      ? 'Подбор модели не изменён: ' + first(made.text)
      : 'Подбор модели ' + (enabled ? 'включён' : 'выключен') + '.';
  }
`;

const REPLY_LINE =
  "  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });";
const start = FAKE_PANEL_AGENT_CLI_SOURCE.indexOf('const current =');
const end = FAKE_PANEL_AGENT_CLI_SOURCE.indexOf(REPLY_LINE);
if (start < 0 || end < start) {
  throw new Error('fake-cli-panel-agent.mjs changed shape: scenario anchors not found');
}

export const FAKE_PANEL_AGENT_GAPS_CLI_SOURCE =
  FAKE_PANEL_AGENT_CLI_SOURCE.slice(0, start) + SCENARIO + FAKE_PANEL_AGENT_CLI_SOURCE.slice(end);
