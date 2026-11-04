/**
 * Разговор в песочнице идёт задачей ядра (этап 10, зона F6) — настоящая дорога: одноразовая
 * панель + своё ядро (`startStand({ core })`), вопрос через `POST /api/sandbox/run`, ядро поднимает
 * НАСТОЯЩИЙ `claude`, а тот ходит в заглушку `packages/stub-model`. Адрес заглушки и подставной ключ
 * лежат ТОЛЬКО в settings.json песочницы: в каталоге конфигурации стенда (слое «человека») адреса
 * нет — сеанс, ушедший со слоем человека, до заглушки не дойдёт. Подменена только модель.
 *
 * Что видно:
 *   - ответ модели приходит потоком SSE `/api/sandbox/run`, поток кончается сам;
 *   - в запросе к модели метка из CLAUDE.md песочницы есть, а меток из CLAUDE.md человека
 *     (каталог конфигурации стенда) и из CLAUDE.md рабочей папки (слой проекта) — нет:
 *     песочница видит свои правила, не чужие;
 *   - бриф ядра в запрос не примешан (сессия `brief: 'none'`);
 *   - задача ядра несёт имя `CLAUDE_CONFIG_DIR` в `session.env`, значения в журнале нет;
 *   - «Стоп» (`POST /api/sandbox/:id/stop`) посреди удержанного ответа модели снимает задачу:
 *     в журнале переход в `cancelled`, поток SSE закрыт.
 *
 * Запуск: `node tools/qa/check-sandbox-core.mjs` (стенд свой, `pnpm dev` не нужен; нужен `claude` в
 * PATH — нет его, «не проверено», код 2). Код выхода: 0 — сходится, 1 — провал.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';
import { NotChecked, runOnStand, wait } from './throwaway-stand.mjs';

const ANSWER = 'SANDBOX-CORE-STUB-ANSWER';
const SANDBOX_MARK = 'SANDBOX-RULE-MARK-7d1';
const HUMAN_MARK = 'HUMAN-RULE-MARK-4b2';
const PROJECT_MARK = 'PROJECT-RULE-MARK-9c3';
const HOLD_PROMPT = 'HOLD-THIS-ANSWER';
/** Строки брифа ядра (`chatBrief` в session-start.ts) — при `brief: 'none'` их в запросе нет. */
const BRIEF_STEP = 'agentdeck-step:';
const BRIEF_CHAT = 'You are in an AgentDeck chat with the human.';

function claudeDir() {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf8',
    });
    const first = out.split(/\r?\n/).find(Boolean);
    return first ? dirname(first) : '';
  } catch {
    return '';
  }
}

const cliDir = claudeDir();
if (!cliDir) {
  console.log('Не проверено: claude нет в PATH');
  process.exit(2);
}

/** Вопрос с меткой удержания держит ответ до «Стоп»; остальное — короткий ответ. */
const stub = await startStubModel({
  script: (ctx) => {
    const asked = ctx.info.userTexts.join('\n');
    if (asked.includes(HOLD_PROMPT)) return { text: ANSWER, holdMs: Infinity };
    return ANSWER;
  },
});

await runOnStand(
  {
    label: 'sandbox-core',
    web: false,
    extraPath: [cliDir],
    core: true,
    async seed({ cfg }) {
      // Слой человека: правило с меткой, ключ, но НЕ адрес модели.
      writeFileSync(join(cfg, 'CLAUDE.md'), `# human\nAlways mention ${HUMAN_MARK}.\n`);
      writeFileSync(
        join(cfg, 'settings.json'),
        `${JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-stand-stub' } }, null, 2)}\n`,
      );
    },
  },
  async (stand, check) => {
    try {
      await scenario(stand, check);
    } finally {
      await stub.close();
    }
  },
);

/** POST /api/sandbox/run и чтение SSE до конца потока; кадры `data:` — события. */
async function ask(stand, id, prompt, { onEvent } = {}) {
  const res = await fetch(`${stand.apiUrl}/api/sandbox/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, prompt }),
  });
  const events = [];
  if (!res.ok || !res.body) return { status: res.status, events, text: await res.text() };
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n');
      if (!data) continue;
      const event = JSON.parse(data);
      events.push(event);
      onEvent?.(event);
    }
  }
  return { status: res.status, events, text: '' };
}

function journals(coreHome) {
  const dir = join(coreHome, 'tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((id) => {
    const file = readdirSync(join(dir, id)).find((name) => name.endsWith('.jsonl'));
    const text = file ? readFileSync(join(dir, id, file), 'utf8') : '';
    const lines = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { id, text, lines };
  });
}

async function scenario(stand, check) {
  const id = 'core-check';
  const created = await stand.api('/sandbox/create', { method: 'POST', body: { id } });
  check('песочница собрана — 200', created.status === 200, `${created.status} ${created.text}`);
  const configDir = created.body?.configDir;
  if (!configDir || !existsSync(configDir)) throw new NotChecked('каталог песочницы не собран');

  // Свой слой песочницы: правило с меткой и адрес модели — только здесь.
  writeFileSync(join(configDir, 'CLAUDE.md'), `# sandbox\nAlways mention ${SANDBOX_MARK}.\n`);
  const settingsPath = join(configDir, 'settings.json');
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  settings.env = {
    ...(settings.env ?? {}),
    ANTHROPIC_BASE_URL: stub.baseUrl,
    // Доступ песочницы в жизни — копия .credentials.json человека; у стенда её нет, ключ из
    // settings.json человека панель не переносит (она берёт только переменную окружения).
    ANTHROPIC_API_KEY: 'sk-ant-stand-stub',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  // Слой проекта в рабочей папке (её создаёт сборка песочницы): CLI с источником `project`
  // прочёл бы его, песочница с источником только человека — нет.
  const workDir = created.body?.workDir;
  if (!workDir || !existsSync(workDir)) throw new NotChecked('рабочая папка песочницы не собрана');
  writeFileSync(join(workDir, 'CLAUDE.md'), `# project\nAlways mention ${PROJECT_MARK}.\n`);

  // 1. Обычный вопрос: ответ потоком, правила песочницы видны, чужие — нет.
  const first = await ask(stand, id, 'Say hello');
  const text = first.events
    .filter((event) => event.kind === 'text' || event.kind === 'delta' || event.text)
    .map((event) => event.text ?? event.delta ?? '')
    .join('');
  const errors = first.events.filter((event) => event.kind === 'error');
  check('поток ответа — 200', first.status === 200, `${first.status} ${first.text}`);
  check(
    'ответ модели пришёл потоком песочницы',
    text.includes(ANSWER) || JSON.stringify(first.events).includes(ANSWER),
    JSON.stringify(first.events).slice(0, 1500),
  );
  check('ошибок в потоке нет', errors.length === 0, JSON.stringify(errors).slice(0, 1500));
  const bodies = stub.bodies.join('\n');
  check(
    'модель вызвана через ядро (настоящий claude на заглушке)',
    stub.requests.length > 0,
    stand.coreLog().slice(-1500),
  );
  check(
    'в запросе — правило песочницы',
    bodies.includes(SANDBOX_MARK),
    `запросов: ${stub.requests.length}`,
  );
  check('правила человека в запросе нет', !bodies.includes(HUMAN_MARK));
  check('слоя проекта рабочей папки в запросе нет', !bodies.includes(PROJECT_MARK));
  check(
    'бриф ядра в запрос не примешан',
    !bodies.includes(BRIEF_STEP) && !bodies.includes(BRIEF_CHAT),
  );

  const afterFirst = journals(stand.coreHome);
  check('задача ядра одна', afterFirst.length === 1, afterFirst.map((j) => j.id).join(','));
  const createdLine = afterFirst[0]?.lines.find((line) => line.kind === 'task.created');
  const session = createdLine?.data?.session ?? {};
  check(
    'задача несёт имя CLAUDE_CONFIG_DIR, бриф выключен, источник — только человек',
    JSON.stringify(session.env ?? []).includes('CLAUDE_CONFIG_DIR') &&
      session.brief === 'none' &&
      session.sources === 'user',
    JSON.stringify(session),
  );
  check(
    'значения каталога песочницы и ключа в журнале нет',
    !afterFirst[0]?.text.includes('sk-ant-stand-stub') &&
      !afterFirst[0]?.text.includes(configDir.replace(/\\/g, '\\\\')),
  );

  // 2. «Стоп» посреди удержанного ответа: задача ядра снята, поток закрыт.
  const before = stub.requests.length;
  const pending = ask(stand, id, HOLD_PROMPT);
  for (let i = 0; i < 240 && !(stub.holding() && stub.requests.length > before); i += 1) {
    await wait(500);
  }
  check('ответ модели удержан', stub.holding());
  const stopped = await stand.api(`/sandbox/${id}/stop`, { method: 'POST' });
  check('«Стоп» — ok', stopped.status === 200 && stopped.body?.ok === true, stopped.text);
  const closed = await Promise.race([pending.then(() => true), wait(60_000).then(() => false)]);
  check('поток песочницы закрыт после «Стоп»', closed);

  let cancelled = false;
  let held;
  for (let i = 0; i < 120 && !cancelled; i += 1) {
    held = journals(stand.coreHome).find((j) => j.id !== afterFirst[0]?.id);
    cancelled = Boolean(
      held?.lines.some(
        (line) =>
          (line.kind === 'task.transition' && line.data?.to === 'cancelled') ||
          (line.kind === 'task.ended' && line.data?.outcome === 'cancelled'),
      ),
    );
    if (!cancelled) await wait(500);
  }
  check(
    'задача ядра второго вопроса снята (cancelled)',
    cancelled,
    (held?.text ?? 'задачи нет').slice(-1500),
  );
}
