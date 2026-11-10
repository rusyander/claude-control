/**
 * Модель сквозного обхода волны 3 этапа 12 (`check-core-w3-cross-zone-live.mjs`) — сценарий
 * `packages/stub-model`. Один и тот же модуль грузят маршрут-заглушка ядра стенда (`routes.stub`,
 * свой процесс) и заглушка входа CLI в процессе проверки: решение — только по телу запроса, без
 * общего состояния, поэтому оба маршрута ведут сессию одинаково, какой бы из них ни выбрал суд.
 *
 * Что делает модель:
 *   - шаг прохода (`(walk, step `): план ходов по метке в цели человека — `W3-LOGIN` (вход с
 *     доступом стенда по имени), `W3-AWAY` (переходы за пределы стендов, панель, доступ в числовое
 *     поле), `W3-SUB` (проект в подкаталоге репозитория: свой доступ и чужой); без метки —
 *     проход на расхождении: открыть стенд и сдать шаг;
 *   - чат человека: короткий ответ (на «ход-pick» — «выбор принят»);
 *   - прочие шаги ведущего (разведка, разбор, план, работа, ревью, второе ревью): один `step_done`
 *     (разведке — карта и класс M); диалект любой — история вызовов читается у anthropic-messages,
 *     openai-responses и openai-chat.
 * Инструменты ядра у CLI отложены — сначала `ToolSearch select:` всех нужных разом.
 */

const STEP = /agentdeck-step: ?([0-9a-f-]{36})/;
const PREFIX = 'mcp__agentdeck__';
const BROWSE = [
  'browse_open',
  'browse_click',
  'browse_fill',
  'browse_expect',
  'browse_snapshot',
  'step_done',
];

/** Карта разведки и класс: приём ведущего доходит до плана (как check-core-timeline). */
const RESEARCH = {
  map: {
    lines: ['README.md — единственный файл репозитория стенда'],
    files: [{ path: 'README.md', why: 'stand file' }],
    tests: [],
    owners: [],
  },
  classProposal: 'M',
};

/** Вызовы инструментов, уже сделанные моделью в этой сессии, — по диалекту тела запроса. */
export function callsOf(body) {
  const out = [];
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (m?.role !== 'assistant') continue;
    if (Array.isArray(m.content))
      for (const c of m.content)
        if (c?.type === 'tool_use') out.push({ name: String(c.name), input: c.input ?? {} });
    for (const t of Array.isArray(m.tool_calls) ? m.tool_calls : [])
      out.push({ name: String(t?.function?.name ?? ''), input: safeJson(t?.function?.arguments) });
  }
  for (const item of Array.isArray(body?.input) ? body.input : [])
    if (item?.type === 'function_call')
      out.push({ name: String(item.name ?? ''), input: safeJson(item.arguments) });
  return out;
}

function safeJson(text) {
  try {
    return typeof text === 'string' ? JSON.parse(text) : (text ?? {});
  } catch {
    return {};
  }
}

/** Тексты человека в запросе (строка или текстовые блоки), без результатов инструментов. */
export function userWords(body) {
  const flat = (content) => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((b) => b?.type !== 'tool_result' && b?.type !== 'function_call_output')
      .map((b) => (typeof b === 'string' ? b : (b?.text ?? flat(b?.content))))
      .filter(Boolean)
      .join('\n');
  };
  const out = [];
  for (const m of Array.isArray(body?.messages) ? body.messages : [])
    if (m?.role === 'user') out.push(flat(m.content));
  for (const item of Array.isArray(body?.input) ? body.input : [])
    if (item?.role === 'user') out.push(flat(item.content));
  return out.filter(Boolean);
}

/** Ходы прохода по метке цели: `{ tool, args }` по порядку, затем `step_done`. */
export function walkPlan(text, opts = {}) {
  const base = /Walk the stand (https?:\/\/[^\s"\\)]+)/.exec(text)?.[1] ?? '';
  const away = opts.awayUrl ?? 'http://192.0.2.1:9';
  const done = (summary) => ({
    tool: 'step_done',
    args: { outcome: 'done', requirements: [], summary },
  });
  if (text.includes('W3-LOGIN')) {
    return [
      { tool: 'browse_open', args: { url: `${base}/login` } },
      { tool: 'browse_fill', args: { target: { label: 'User' }, value: 'demo' } },
      {
        tool: 'browse_fill',
        args: { target: { label: 'Password' }, secret: { name: 'STAND_PASSWORD' } },
      },
      { tool: 'browse_click', args: { target: { role: 'button', name: 'Sign in' } } },
      { tool: 'browse_expect', args: { expect: 'visible', target: { testId: 'hash' } } },
      done('logged in, the welcome page shows the hash'),
    ];
  }
  if (text.includes('W3-AWAY')) {
    return [
      {
        tool: 'browse_open',
        args: { url: `${base}/away?to=${encodeURIComponent(`${away}/redirect`)}` },
      },
      {
        tool: 'browse_open',
        args: { url: `${base}/link?to=${encodeURIComponent(`${away}/link`)}` },
      },
      { tool: 'browse_click', args: { target: { role: 'link', name: 'Go' } } },
      { tool: 'browse_open', args: { url: 'http://127.0.0.1:8888/' } },
      { tool: 'browse_open', args: { url: 'http://127.0.0.1:5178/api/location' } },
      { tool: 'browse_open', args: { url: `${base}/amount` } },
      {
        tool: 'browse_fill',
        args: { target: { label: 'Amount' }, secret: { name: 'STAND_PASSWORD' } },
      },
      done('off-stand pages were refused; the number field refused the secret'),
    ];
  }
  if (text.includes('W3-SUB')) {
    return [
      { tool: 'browse_open', args: { url: `${base}/login` } },
      {
        tool: 'browse_fill',
        args: { target: { label: 'Password' }, secret: { name: 'STAND_PASSWORD' } },
      },
      {
        tool: 'browse_fill',
        args: { target: { label: 'Password' }, secret: { name: 'SUB_TOKEN' } },
      },
      { tool: 'browse_click', args: { target: { role: 'button', name: 'Sign in' } } },
      { tool: 'browse_expect', args: { expect: 'visible', target: { testId: 'hash' } } },
      done('the subfolder project logged in with its own secret'),
    ];
  }
  return [
    ...(base ? [{ tool: 'browse_open', args: { url: `${base}/login` } }] : []),
    done('mismatch walk: the stand opens'),
  ];
}

/** Следующий вызов по плану; инструмент не объявлен — сначала загрузка через ToolSearch. */
function nextCall(ctx, plan, stepId, names) {
  const used = callsOf(ctx.request.body).filter((c) => c.name !== 'ToolSearch');
  const move = plan[used.length];
  if (!move) return { text: 'Walked.' };
  const full = PREFIX + move.tool;
  const tools = ctx.info.tools.map((t) => t.name);
  const args = move.tool === 'step_done' ? { stepId, ...move.args } : move.args;
  if (tools.includes(full)) return { tool: { name: full, args } };
  const searched = callsOf(ctx.request.body).some(
    (c) => c.name === 'ToolSearch' && String(c.input?.query ?? '').includes(full),
  );
  if (tools.includes('ToolSearch') && !searched) {
    const query = `select:${names.map((n) => PREFIX + n).join(',')}`;
    return { tool: { name: 'ToolSearch', args: { query, max_results: names.length } } };
  }
  return { text: `no ${move.tool} tool here` };
}

/** Сценарий для `startStubModel({ script })` и `routes.stub[].script` ядра. */
export function w3WalkScript(opts = {}) {
  return (ctx) => {
    const body = ctx.request.body ?? {};
    const text = JSON.stringify(body);
    const stepId = STEP.exec(text)?.[1];
    if (!stepId) return { text: 'stub side reply' };
    if (text.includes('You are in an AgentDeck chat')) {
      const words = userWords(body).join('\n');
      return { text: words.includes('ход-pick') ? 'выбор принят' : 'W3 ответ чата' };
    }
    if (text.includes('(walk, step ')) return nextCall(ctx, walkPlan(text, opts), stepId, BROWSE);
    // Шаги ведущего: один step_done; разведке — карта и класс.
    const extra = text.includes('(research, step ') ? RESEARCH : {};
    const plan = [
      {
        tool: 'step_done',
        args: { outcome: 'done', requirements: [], summary: 'stub step done', ...extra },
      },
    ];
    return nextCall(ctx, plan, stepId, ['step_done']);
  };
}
