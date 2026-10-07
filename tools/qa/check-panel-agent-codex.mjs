// Агент панели на Codex — живьём: одноразовая панель, НАСТОЯЩИЙ `codex`
// (из `STEER_CLI_DIR` или PATH) и заглушка модели OpenAI responses.
//
// Почему не `config.toml` с провайдером-заглушкой, как у check-codex-kit: панель
// запускает агента с `--ignore-user-config`, и Codex не читает ни провайдера из
// своего дома, ни проектный `.codex/config.toml` (он не доверен — доверие живёт в
// том же отключённом конфиге; проверено). Поэтому граница подменена там, где
// она и есть, — в сети: Codex идёт к `api.openai.com` своим обычным путём, через
// прокси из `HTTPS_PROXY` с одноразовым центром в `SSL_CERT_FILE` (обе
// переменные панель передаёт CLI по своему списку), а `tls-intercept.mjs`
// завершает TLS и отдаёт запрос заглушке (`stub-codex-agent-model.mjs`). Запуск
// панели — ровно тот, что получит человек, включая модель Codex по умолчанию.
//
// Доказательство — тела запросов на заглушке и ответы API панели, не код:
//   0. без CLI — 409 `cli_not_found` с именем Codex (свой стенд без codex);
//   1. ход дошёл до Codex: ключ из `CODEX_API_KEY`, в инструкциях — дописка агента
//      со страницей человека; `where_am_i` прошёл через настоящий переходник, итог
//      вернулся модели, ответ — в ленте окна и в файле разговора; ни одного
//      инструмента сверх переходника вне известного набора «без рук»;
//   2. второй ход несёт итог действия первого (память разговора);
//   3–4. карточка (настройка панели): одобрено — настройка изменилась; отклонено —
//      нет, модель получила отказ человека;
//   5–6. неверный ввод действия — лента помечает ошибку, модель видит причину, и
//      следующий ход помнит действие С ПРИЧИНОЙ;
//   7. `apply_patch`, который Codex даёт модели сам, не пишет файл (песочница);
//   8. картинка доехала до модели (`-i` → `input_image`);
//   9. отказ модели (401) — кадр ошибки, а не пустой «готово»;
//   10. закрытое окно снимает Codex: его соединение с моделью рвётся;
//   11. 12 ходов разом — каждый видит действия переходника (`required=true`);
//   и Codex не записал сессий (`--ephemeral`).
// Дом Codex — временный `CODEX_HOME`; настоящие `~/.codex` и `~/.agents` не пишутся.
// Нет `codex` — «не проверено» (код 2), а не провал.
//
// Запуск: STEER_CLI_DIR=<каталог с codex> node tools/qa/check-panel-agent-codex.mjs
//         [--server-dir <копия apps/server>] — прогон над копией сервера (мутанты).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createCodexAgentModel, isBridgeTool, offeredNames } from './stub-codex-agent-model.mjs';
import { NotChecked, reporter, startStand, wait } from './throwaway-stand.mjs';
import { makeTestCa, startInterceptProxy } from './tls-intercept.mjs';

const IS_WIN = process.platform === 'win32';
/** Параллельных ходов в сценарии 11: на 12 гонка старта переходника воспроизводилась. */
const CROWD = 12;
const MODEL_HOST = 'api.openai.com';
const tag = Math.random().toString(36).slice(2, 8);
const marks = {
  route: `/route-mark-${tag}`,
  patchFile: `agent-wrote-${tag}.txt`,
};
/** Собран из кусков: в репозитории не должно лежать присваивание, похожее на ключ. */
const API_KEY = ['codex', 'stub', tag].join('-');
// 1×1 PNG: панель сверяет сигнатуру файла с заявленным типом.
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Что Codex 0.160 даёт модели сверх переходника при флагах панели и чем это не
 * руки (снято вживую на модели по умолчанию): обвязка режима кода (`exec` без
 * Node, файлов и сети; `wait`), чтение ресурсов MCP (настроен один переходник),
 * часы, `apply_patch` (песочница read-only отказывает — сценарий 7), вопросы
 * человеку (в `exec` некому ответить) и совместная работа агентов того же
 * процесса с теми же флагами. Новый инструмент новой версии сюда не попадёт сам —
 * проверка покраснеет и заставит решить, руки это или нет.
 */
const KNOWN_NO_HANDS = new Set([
  'exec',
  'wait',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'clock__curr_time',
  'apply_patch',
  'request_user_input',
  'request_user_input_async',
  'collaboration__followup_task',
  'collaboration__interrupt_agent',
  'collaboration__list_agents',
  'collaboration__send_message',
  'collaboration__spawn_agent',
  'collaboration__wait_agent',
]);

const serverAt = process.argv.indexOf('--server-dir');
const SERVER_DIR = serverAt > 0 ? process.argv[serverAt + 1] : undefined;

function findCli(name) {
  const names = IS_WIN ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

const framesOf = (text) =>
  text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)));

/**
 * Один ход через API панели. `decide` — решение по каждой карточке этого хода
 * (кликом окна: Origin окна одноразовой панели); `abortWhen` — закрыть окно,
 * когда условие выполнится.
 */
async function turn(stand, { conversationId, messages, images, decide, abortWhen, quiet }) {
  const origin = `http://127.0.0.1:${Number(new URL(stand.apiUrl).port) + 1}`;
  const controller = new AbortController();
  let settled = false;
  const cards = [];
  const running = fetch(`${stand.apiUrl}/api/agent/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({
      conversationId,
      messages,
      ...(images ? { images } : {}),
      context: { route: marks.route, title: 'Проверка' },
    }),
    signal: controller.signal,
  })
    .then(async (res) => ({ status: res.status, text: await res.text() }))
    .catch((error) => ({ status: 0, text: String(error) }))
    .finally(() => (settled = true));
  const seen = new Set();
  for (let t = 0; t < 120_000 && !settled; t += 200) {
    if (abortWhen?.()) {
      controller.abort();
      break;
    }
    if (decide) {
      for (const card of (await stand.api('/agent/pending')).body ?? []) {
        if (seen.has(card.id) || card.conversationId !== conversationId) continue;
        seen.add(card.id);
        const answer = await stand.api(`/agent/pending/${card.id}`, {
          method: 'POST',
          headers: { origin },
          body: { decision: decide(card) },
        });
        cards.push({ name: card.name, answer: answer.status });
      }
    }
    await wait(200);
  }
  const response = await running;
  const frames = response.status === 200 ? framesOf(response.text) : [];
  if (!quiet) console.log(`  кадры ${conversationId}: ${JSON.stringify(frames).slice(0, 600)}`);
  return { ...response, frames, cards, done: frames.at(-1) };
}

const toolResult = (run, name) =>
  run.frames.find((f) => f.kind === 'tool-result' && f.name === name);
const user = (content) => ({ role: 'user', content });

const { check, finish } = reporter();
const dir = findCli('codex');
if (!dir) {
  console.log('Не проверено: codex нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}
console.log(`codex: ${dir}${SERVER_DIR ? `\nсервер: ${SERVER_DIR}` : ''}`);

const root = mkdtempSync(join(tmpdir(), 'cc-agent-codex-'));
const codexHome = join(root, 'codex-home');
mkdirSync(codexHome, { recursive: true });
const tls = makeTestCa([MODEL_HOST]);
writeFileSync(join(root, 'ca.pem'), tls.caPem);
const model = createCodexAgentModel(marks);
const proxy = await startInterceptProxy({ hosts: [MODEL_HOST], tls, handler: model.handler });
const serverDir = SERVER_DIR ? { serverDir: SERVER_DIR } : {};

let bare;
let stand;
try {
  console.log('\n0. Codex не найден — честный отказ');
  {
    const saved = process.env.PATH;
    // На PATH человека codex может лежать — у этого стенда его нет.
    process.env.PATH = (saved ?? '')
      .split(delimiter)
      .filter(
        (entry) =>
          entry && entry !== dir && !existsSync(join(entry, IS_WIN ? 'codex.cmd' : 'codex')),
      )
      .join(delimiter);
    try {
      bare = await startStand({
        web: false,
        label: 'agent-codex-bare',
        settings: { provider: 'codex' },
        ...serverDir,
      });
    } finally {
      process.env.PATH = saved;
    }
    const refused = await bare.api('/agent/run', {
      method: 'POST',
      body: {
        conversationId: `bare-${tag}`,
        messages: [user('WHERE')],
        context: { route: marks.route },
      },
    });
    check(
      '409 cli_not_found с кодом текста и именем Codex',
      refused.status === 409 &&
        refused.body?.error === 'cli_not_found' &&
        refused.body?.messageCode === 'panel-agent-cli-not-found' &&
        /codex/i.test(refused.body?.params?.provider ?? ''),
      `${refused.status} ${refused.text.slice(0, 300)}`,
    );
    await bare.stop();
    bare = undefined;
  }

  // Codex уводится на заглушку только переменными, которые панель и так передаёт
  // CLI по своему списку; заданы явно — значения из оболочки человека не в счёт.
  stand = await startStand({
    web: false,
    label: 'agent-codex',
    settings: { provider: 'codex' },
    extraPath: [dir],
    env: {
      CODEX_HOME: codexHome,
      CODEX_API_KEY: API_KEY,
      HTTPS_PROXY: proxy.url,
      https_proxy: proxy.url,
      HTTP_PROXY: proxy.url,
      http_proxy: proxy.url,
      SSL_CERT_FILE: join(root, 'ca.pem'),
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    ...serverDir,
  });

  console.log('\n1. «Где я?» — where_am_i через настоящий переходник');
  const whereId = `codex-where-${tag}`;
  const where = await turn(stand, {
    conversationId: whereId,
    messages: [user('WHERE: где я сейчас?')],
  });
  check(
    'ход принят (200, поток)',
    where.status === 200,
    `${where.status} ${where.text.slice(0, 400)}`,
  );
  check(
    'start: провайдер codex',
    where.frames[0]?.kind === 'start' && where.frames[0]?.providerId === 'codex',
    JSON.stringify(where.frames[0]),
  );
  check(
    'кадр действия where_am_i',
    where.frames.some((f) => f.kind === 'tool' && f.name === 'where_am_i'),
  );
  check(
    'действие выполнено панелью без ошибки',
    toolResult(where, 'where_am_i')?.isError === false,
  );
  check(
    'ответ агента: итог действия дошёл до модели и до ленты',
    where.done?.kind === 'done' && where.done.reply === 'AGENT_OK ROUTE_SEEN',
    JSON.stringify(where.done),
  );
  const whereFile = (await stand.api(`/agent/conversations/${whereId}`)).body;
  check(
    'ответ записан в разговор панели',
    whereFile?.messages?.at(-1)?.content === 'AGENT_OK ROUTE_SEEN',
    JSON.stringify(whereFile?.messages?.at(-1)),
  );
  const first = model.requests[0];
  check('модель получила запрос', Boolean(first));
  check(
    'в инструкциях модели — дописка агента панели со страницей человека',
    Boolean(
      first?.instructions.includes('You are the agent of the AgentDeck panel') &&
      first.instructions.includes(`route ${marks.route}`),
    ),
    first?.instructions.slice(0, 300),
  );
  check(
    'к модели — ключ из CODEX_API_KEY',
    model.requests.every((r) => r.auth === `Bearer ${API_KEY}`),
    JSON.stringify([...new Set(model.requests.map((r) => r.auth.slice(0, 30)))]),
  );
  const seenNames = [
    ...new Set(model.requests.flatMap((r) => [...offeredNames(r), ...r.allTools])),
  ];
  const bridgeNames = seenNames.filter(isBridgeTool);
  const extra = seenNames.filter((name) => !isBridgeTool(name));
  const directBridge = model.requests.some((r) =>
    [...r.direct, ...r.additional].some(isBridgeTool),
  );
  console.log(
    `  инструменты переходника: ${bridgeNames.length} (${directBridge ? 'предложены прямо' : 'отложены, видны только в ALL_TOOLS режима кода'})`,
  );
  console.log(`  сверх переходника: ${extra.join(', ') || '—'}`);
  check(
    'инструменты переходника видны модели',
    bridgeNames.some((n) => n.endsWith('where_am_i')),
    seenNames.join(', '),
  );
  check(
    'сверх переходника — ничего вне известного набора «без рук»',
    extra.every((name) => KNOWN_NO_HANDS.has(name)),
    extra.filter((name) => !KNOWN_NO_HANDS.has(name)).join(', '),
  );

  console.log('\n2. Второй ход несёт итог действия первого');
  const memory = await turn(stand, {
    conversationId: whereId,
    messages: [
      user('WHERE: где я сейчас?'),
      { role: 'assistant', content: 'AGENT_OK ROUTE_SEEN' },
      user('MEMORY: что ты уже сделал?'),
    ],
  });
  check(
    'модель видит прошлое действие where_am_i',
    memory.done?.reply === 'MEMORY_SEEN',
    JSON.stringify(memory.done),
  );

  // Карточки — на настройках самой панели: действия раздела «Конфигурация» при
  // активном Codex честно отказывают (они правят файлы Claude Code).
  const accent = async () => (await stand.api('/settings')).body?.accent;
  console.log('\n3. Действие с карточкой — одобрено');
  const okRun = await turn(stand, {
    conversationId: `codex-set-ok-${tag}`,
    messages: [user('SET_OK: включи фиолетовый акцент')],
    decide: () => 'approve',
  });
  check(
    'карточка update_settings открылась и принята кликом окна',
    okRun.cards.length === 1 &&
      okRun.cards[0].name === 'update_settings' &&
      okRun.cards[0].answer === 200,
    JSON.stringify(okRun.cards),
  );
  check(
    'лента: update_settings выполнено без ошибки',
    toolResult(okRun, 'update_settings')?.isError === false,
  );
  check('модель получила «Done.»', okRun.done?.reply === 'SET_DONE', JSON.stringify(okRun.done));
  const accentAfterOk = await accent();
  check('настройка изменилась: акцент purple', accentAfterOk === 'purple', String(accentAfterOk));

  console.log('\n4. Действие с карточкой — отклонено');
  const noRun = await turn(stand, {
    conversationId: `codex-set-no-${tag}`,
    messages: [user('SET_NO: включи янтарный акцент')],
    decide: () => 'reject',
  });
  check(
    'карточка отклонена кликом окна',
    noRun.cards.length === 1 && noRun.cards[0].answer === 200,
    JSON.stringify(noRun.cards),
  );
  check('лента: действие update_settings завершено', Boolean(toolResult(noRun, 'update_settings')));
  check(
    'модель получила отказ человека',
    noRun.done?.reply === 'SET_REJECT_SEEN',
    JSON.stringify(noRun.done),
  );
  const accentAfterNo = await accent();
  check(
    'отклонённое не выполнено: акцент остался purple',
    accentAfterNo === 'purple',
    String(accentAfterNo),
  );

  console.log('\n5. Неверный ввод действия — честная ошибка');
  const invalidId = `codex-invalid-${tag}`;
  const invalid = await turn(stand, {
    conversationId: invalidId,
    messages: [user('INVALID: включи неоновую тему')],
  });
  check(
    'лента: update_settings помечено ошибкой',
    toolResult(invalid, 'update_settings')?.isError === true,
    JSON.stringify(invalid.frames.filter((f) => f.kind === 'tool-result')),
  );
  check(
    'модель видит причину отказа схемы',
    invalid.done?.reply === 'INVALID_SEEN',
    JSON.stringify(invalid.done),
  );

  console.log('\n6. Следующий ход помнит неудачное действие с причиной');
  const memoryFail = await turn(stand, {
    conversationId: invalidId,
    messages: [
      user('INVALID: включи неоновую тему'),
      { role: 'assistant', content: 'INVALID_SEEN' },
      user('MEMORY_FAIL: почему не вышло?'),
    ],
  });
  check(
    'итог прошлого хода: «update_settings (failed): Input rejected…»',
    memoryFail.done?.reply === 'MEMORY_FAIL_SEEN',
    JSON.stringify(memoryFail.done),
  );

  console.log('\n7. apply_patch, который Codex даёт сам, не пишет файл');
  const patch = await turn(stand, {
    conversationId: `codex-patch-${tag}`,
    messages: [user('PATCH: запиши файл')],
  });
  check(
    'песочница отказала, файла нет',
    patch.done?.reply === 'PATCH_BLOCKED',
    JSON.stringify(patch.done),
  );

  console.log('\n8. Картинка доезжает до модели');
  const image = await turn(stand, {
    conversationId: `codex-image-${tag}`,
    messages: [user('IMAGE: что на картинке?')],
    images: [{ name: 'dot.png', mediaType: 'image/png', base64: PNG_1PX }],
  });
  check(
    'модель получила input_image',
    image.done?.reply === 'IMAGE_SEEN',
    JSON.stringify(image.done),
  );

  console.log('\n9. Модель отказала (401) — кадр ошибки, а не «готово»');
  const fail = await turn(stand, {
    conversationId: `codex-fail-${tag}`,
    messages: [user('FAIL401: ответь')],
  });
  check(
    'последний кадр — error с причиной модели',
    fail.done?.kind === 'error' && /401|unauthor|api key/i.test(fail.done.message ?? ''),
    JSON.stringify(fail.done),
  );
  check('кадра done нет', !fail.frames.some((f) => f.kind === 'done'));

  console.log('\n10. Окно закрыто посреди хода — Codex снят');
  const hangsBefore = model.hanging.length;
  await turn(stand, {
    conversationId: `codex-hang-${tag}`,
    messages: [user('HANG: думай долго')],
    abortWhen: () => model.hanging.length > hangsBefore,
  });
  const hold = model.hanging[hangsBefore];
  const abortedAt = Date.now();
  for (let i = 0; i < 60 && hold && !hold.closedAt; i += 1) await wait(250);
  check(
    'соединение Codex с моделью закрыто после закрытия окна',
    Boolean(hold?.closedAt),
    hold ? `открыто ${Date.now() - abortedAt} мс` : 'заглушка не получила запрос',
  );

  console.log(`\n11. ${CROWD} ходов разом — каждый видит переходник`);
  // Без `required=true` Codex под нагрузкой начинал ход раньше, чем переходник отдал
  // список действий, — модель оставалась без инструментов панели. По одному ходу
  // гонка почти не видна; толпа из параллельных ходов воспроизводила её на 13–20 из 48.
  const crowd = await Promise.all(
    Array.from({ length: CROWD }, (_, i) =>
      turn(stand, {
        conversationId: `codex-crowd-${tag}-${i}`,
        messages: [user('WHERE: где я?')],
        quiet: true,
      }),
    ),
  );
  const crowdMissed = crowd.filter((run) => run.done?.reply !== 'AGENT_OK ROUTE_SEEN');
  check(
    `все ${CROWD} ходов получили действие панели и его итог`,
    crowdMissed.length === 0,
    `без переходника: ${crowdMissed.length}; ${JSON.stringify(crowdMissed[0]?.done ?? null).slice(0, 300)}`,
  );

  check('сессии не записаны (CODEX_HOME/sessions нет)', !existsSync(join(codexHome, 'sessions')));
  console.log(
    `  запросов к модели: ${model.requests.length}; CONNECT к модели: ${proxy.connects.length}; отклонено прокси: ${JSON.stringify([...new Set(proxy.refused)])}`,
  );
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`Не проверено: ${error.message}`);
    process.exitCode = 2;
  } else {
    check('сценарий дошёл до конца', false, error?.stack ?? String(error));
  }
} finally {
  await bare?.stop();
  await stand?.stop();
  await proxy.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (process.exitCode === 2) process.exit(2);
finish();
