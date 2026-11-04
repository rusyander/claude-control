/**
 * Агент панели у чужого CLI — живьём через ядро (этап 10). Кейс panel-agent-foreign-001.
 *
 * Активный CLI — Qwen Code: ход агента уходит вопросом ядра «ask», ядро запускает НАСТОЯЩИЙ
 * `qwen` сессией с одним мостом `panel-bridge` (`tools/mcp/panel.mjs`), модель — заглушка
 * OpenAI chat по программе (`panel-agent-core-stand.mjs`, профиль «Ассистент панели» — свой
 * адрес, вид API `openai-compat`). Доказательство — не текст ответа, а то, что прошло по проводу:
 *   - кадр start назвал qwen (ход не ушёл молча в Claude и не получил отказ);
 *   - модели предложены ТОЛЬКО инструменты моста панели (ни оболочки, ни файлов);
 *   - в запросе модели — наставление агента панели;
 *   - вызов `where_am_i` прошёл через настоящий мост в одноразовую панель, и его результат
 *     (страница из запроса) вернулся модели; ответ это называет;
 *   - отрицательный шаг: модель зовёт встроенный `enter_worktree` Qwen Code → ход оборван кодом
 *     «лишний инструмент» с этим именем, ответа нет.
 *
 * Нет `qwen` в PATH — «не проверено» (код 2), а не провал.
 * Запуск: `node tools/qa/check-panel-agent-foreign.mjs`
 */
import { runPanelAgentOnCore } from './panel-agent-core-stand.mjs';

const ROUTE_MARK = `/route-mark-${Math.random().toString(36).slice(2, 8)}`;
const BRIEF = 'You are the agent of the AgentDeck panel';
/** Встроенный инструмент Qwen Code с побочным действием (git worktree), которого агенту не положено. */
const EXTRA_TOOL = 'enter_worktree';

/** Модель: `where_am_i`, затем ответ — дошла ли до неё страница из запроса. */
async function program({ current, tool }) {
  // Встроенный инструмент Qwen Code сверх моста: ход обязан оборваться, а не исполнить его.
  if (/extra/i.test(current)) return { tool: { name: EXTRA_TOOL, args: { name: 'qa-extra' } } };
  const result = await tool('where_am_i', {});
  if (result.isError) return `AGENT_FAILED ${result.text.slice(0, 200)}`;
  return `AGENT_OK ${result.text.includes(ROUTE_MARK) ? 'ROUTE_SEEN' : 'ROUTE_MISSING'}`;
}

/** Сырые запросы к модели: брифинг ищется во всём теле (системная реплика у CLI своя). */
const raw = [];

await runPanelAgentOnCore(
  {
    label: 'agent-qwen',
    program,
    cli: 'qwen',
    apiKind: 'openai-compat',
    modelOptions: {
      route: ({ method, body }) => {
        if (method === 'POST' && body) raw.push(JSON.stringify(body));
        return undefined;
      },
    },
  },
  async (stand, check, model) => {
    const response = await fetch(`${stand.apiUrl}/api/agent/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: stand.webUrl },
      body: JSON.stringify({
        conversationId: 'live-qwen-1',
        messages: [{ role: 'user', content: 'Где я сейчас?' }],
        context: { route: ROUTE_MARK, title: 'Проверка' },
      }),
    });
    const text = await response.text();
    check(
      'ход принят (200, поток)',
      response.status === 200,
      `${response.status} ${text.slice(0, 400)}`,
    );
    const frames = text
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice(6)));
    console.log('  кадры:', JSON.stringify(frames).slice(0, 1500));
    const start = frames.find((frame) => frame.kind === 'start');
    check('start: провайдер qwen', start?.providerId === 'qwen', JSON.stringify(start));
    check(
      'кадра ошибки нет',
      !frames.some((frame) => frame.kind === 'error'),
      JSON.stringify(frames.filter((frame) => frame.kind === 'error')),
    );
    const calls = model.turns.at(-1)?.calls ?? [];
    check(
      'where_am_i выполнен настоящим мостом без ошибки, страница из запроса вернулась модели',
      calls.length === 1 &&
        calls[0].name === 'where_am_i' &&
        !calls[0].isError &&
        calls[0].text.includes(ROUTE_MARK),
      JSON.stringify(calls).slice(0, 600),
    );
    const done = frames.findLast((frame) => frame.kind === 'done');
    check(
      'ответ агента: результат действия дошёл до модели',
      done?.reply === 'AGENT_OK ROUTE_SEEN',
      JSON.stringify(done),
    );
    const offered = [...new Set(model.turns.flatMap((turn) => turn.offered))];
    console.log('  предложено модели:', JSON.stringify(offered));
    check(
      'модели предложены ТОЛЬКО инструменты моста панели',
      offered.length > 0 && offered.every((name) => name.includes('panel-bridge')),
      JSON.stringify(offered),
    );
    check(
      'в запросе модели — наставление агента панели',
      raw.some((body) => body.includes(BRIEF)),
      `${raw.length} запросов`,
    );

    // ── Отрицательный шаг: модель зовёт встроенный инструмент CLI сверх моста ──
    const extra = await fetch(`${stand.apiUrl}/api/agent/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: stand.webUrl },
      body: JSON.stringify({
        conversationId: 'live-qwen-2',
        messages: [{ role: 'user', content: 'extra' }],
        context: { route: ROUTE_MARK, title: 'Проверка' },
      }),
    });
    const extraFrames = (await extra.text())
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice(6)));
    const stopped = extraFrames.find((frame) => frame.kind === 'error');
    check(
      `${EXTRA_TOOL}: ход оборван кодом «лишний инструмент» с именем из CLI`,
      stopped?.messageCode === 'panel-agent-extra-tool' &&
        String(stopped.message).includes(EXTRA_TOOL),
      JSON.stringify(extraFrames).slice(0, 800),
    );
    check(
      `${EXTRA_TOOL}: ответа агента нет`,
      !extraFrames.some((frame) => frame.kind === 'done' && frame.reply),
      JSON.stringify(extraFrames.at(-1)),
    );
  },
);
