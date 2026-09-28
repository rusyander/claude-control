/**
 * Фальшивый `claude` для хода агента над настройками панели (`check-agent-manage-walk.mjs`).
 *
 * Разговор с панелью — тот же, что у `fake-cli-panel-agent.mjs` (настоящий
 * переходник `tools/mcp/panel.mjs` из `--mcp-config` панели, MCP по stdio,
 * `stream-json` на выход); подменён только выбор хода по ТЕКУЩЕЙ просьбе:
 * - «удали копию «N»» → `delete_backup`; ответ называет сделанное или отказ;
 * - «создай плагин P в папке «D»» → `scaffold_plugin` с командами;
 * - «сколько записей в журнале защиты данных» → `dlp_journal` (чтение, без карточки).
 */
import { FAKE_PANEL_AGENT_CLI_SOURCE } from './fake-cli-panel-agent.mjs';

const SCENARIO = String.raw`const current = (/Human \(current request\): ([\s\S]*)$/.exec(prompt)?.[1] ?? prompt).trim();
  const quoted = (/«([^»]+)»/.exec(current)?.[1] ?? '').trim();
  let reply;
  if (/копи/i.test(current)) {
    const done = await tool('delete_backup', { name: quoted });
    reply = done.isError || !done.text.startsWith('Done.')
      ? 'Копия ' + quoted + ' не удалена: ' + done.text.split('\n')[0]
      : 'Удалил копию ' + quoted + '.';
  } else if (/плагин/i.test(current)) {
    const name = (/плагин\s+(\S+)/i.exec(current)?.[1] ?? 'kit').trim();
    const made = await tool('scaffold_plugin', { dir: quoted, name, commands: true });
    reply = made.isError || !made.text.startsWith('Done.')
      ? 'Плагин ' + name + ' не создан: ' + made.text.split('\n')[0]
      : 'Создал каркас плагина ' + name + '.';
  } else {
    const read = await tool('dlp_journal', {});
    const body = parse(read.text);
    reply = read.isError
      ? 'Журнал не прочитан: ' + read.text.split('\n')[0]
      : 'В журнале защиты данных записей: ' + (body?.count ?? '?') + '.';
  }
`;

const REPLY_LINE =
  "  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });";
const start = FAKE_PANEL_AGENT_CLI_SOURCE.indexOf('const current =');
const end = FAKE_PANEL_AGENT_CLI_SOURCE.indexOf(REPLY_LINE);
if (start < 0 || end < start) {
  throw new Error('fake-cli-panel-agent.mjs changed shape: scenario anchors not found');
}

export const FAKE_PANEL_AGENT_MANAGE_CLI_SOURCE =
  FAKE_PANEL_AGENT_CLI_SOURCE.slice(0, start) + SCENARIO + FAKE_PANEL_AGENT_CLI_SOURCE.slice(end);
