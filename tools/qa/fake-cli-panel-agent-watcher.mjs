/**
 * Фальшивый `claude` для хода агента над наблюдателем (`check-agent-watcher-walk.mjs`).
 *
 * Разговор с панелью — тот же, что у `fake-cli-panel-agent.mjs` (настоящий
 * переходник `tools/mcp/panel.mjs` из `--mcp-config` панели, MCP по stdio,
 * `stream-json` на выход); подменён только выбор хода по ТЕКУЩЕЙ просьбе:
 * - «включи наблюдатель» → `set_watcher {enabled:true}`;
 * - «выключи наблюдатель» → `set_watcher {enabled:false}`.
 */
import { FAKE_PANEL_AGENT_CLI_SOURCE } from './fake-cli-panel-agent.mjs';

const SCENARIO = String.raw`const current = (/Human \(current request\): ([\s\S]*)$/.exec(prompt)?.[1] ?? prompt).trim();
  const enabled = !/выключи/i.test(current);
  const done = await tool('set_watcher', { enabled });
  let reply = done.isError || !done.text.startsWith('Done.')
    ? 'Наблюдатель не переключён: ' + done.text.split('\n')[0]
    : enabled ? 'Наблюдатель включён.' : 'Наблюдатель выключен.';
`;

const REPLY_LINE =
  "  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });";
const start = FAKE_PANEL_AGENT_CLI_SOURCE.indexOf('const current =');
const end = FAKE_PANEL_AGENT_CLI_SOURCE.indexOf(REPLY_LINE);
if (start < 0 || end < start) {
  throw new Error('fake-cli-panel-agent.mjs changed shape: scenario anchors not found');
}

export const FAKE_PANEL_AGENT_WATCHER_CLI_SOURCE =
  FAKE_PANEL_AGENT_CLI_SOURCE.slice(0, start) + SCENARIO + FAKE_PANEL_AGENT_CLI_SOURCE.slice(end);
