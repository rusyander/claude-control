/**
 * Фальшивый `claude` для хода агента по блоку «Тестирование»
 * (`check-agent-tests-block-walk.mjs`).
 *
 * Разговор с панелью — тот же, что у `fake-cli-panel-agent.mjs` (настоящий
 * переходник `tools/mcp/panel.mjs` из `--mcp-config` панели, MCP по stdio,
 * `stream-json` на выход); подменён только выбор хода по ТЕКУЩЕЙ просьбе:
 * - «заведи тест-план «T» из кейсов A, B в проекте «P»» → `list_projects`,
 *   `save_test_plan`; ответ называет план или отказ;
 * - «какие тест-планы в проекте «P»» → `read_tests_report` kind=plans; ответ
 *   перечисляет планы так, как их вернула панель.
 */
import { FAKE_PANEL_AGENT_CLI_SOURCE } from './fake-cli-panel-agent.mjs';

const SCENARIO = String.raw`const current = (/Human \(current request\): ([\s\S]*)$/.exec(prompt)?.[1] ?? prompt).trim();
  const projectName = (/проект[а-я]*\s+«([^»]+)»/i.exec(current)?.[1] ?? '').trim();
  // Ответ панели — строка «Done.» и JSON; список проектов — массив, а не объект.
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
  } else if (/заведи/i.test(current)) {
    const title = (/тест-план\s+«([^»]+)»/i.exec(current)?.[1] ?? 'План').trim();
    const caseIds = ((/из кейсов\s+([^\s].*?)\s+в проекте/i.exec(current)?.[1]) ?? '')
      .split(/[,\s]+/).filter(Boolean);
    const saved = await tool('save_test_plan', { projectPath: project.path, title, caseIds });
    const body = json(saved.text);
    reply = saved.isError || !saved.text.startsWith('Done.')
      ? 'План «' + title + '» не заведён: ' + saved.text.split('\n')[0]
      : 'Завёл тест-план «' + title + '» (' + (body?.planId ?? '?') + ') из ' + caseIds.length + ' кейсов.';
  } else {
    const read = await tool('read_tests_report', { projectPath: project.path, kind: 'plans' });
    const body = json(read.text);
    const plans = body?.plans ?? [];
    reply = read.isError
      ? 'Отчёт не прочитан: ' + read.text.split('\n')[0]
      : plans.length === 0
        ? 'Тест-планов нет.'
        : 'Тест-планы: ' + plans.map((plan) => '«' + plan.title + '» — ' + (plan.caseIds ?? []).join(', ')).join('; ');
  }
`;

const REPLY_LINE =
  "  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });";
const start = FAKE_PANEL_AGENT_CLI_SOURCE.indexOf('const current =');
const end = FAKE_PANEL_AGENT_CLI_SOURCE.indexOf(REPLY_LINE);
if (start < 0 || end < start) {
  throw new Error('fake-cli-panel-agent.mjs changed shape: scenario anchors not found');
}

export const FAKE_PANEL_AGENT_TESTS_BLOCK_CLI_SOURCE =
  FAKE_PANEL_AGENT_CLI_SOURCE.slice(0, start) + SCENARIO + FAKE_PANEL_AGENT_CLI_SOURCE.slice(end);
