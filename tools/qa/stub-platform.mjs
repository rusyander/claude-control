/**
 * Стаб-контур: НАСТОЯЩИЙ upstream, с которым шлюз панели говорит по проводу.
 *
 * Зачем отдельно от `check-platform.mjs`. Тот свип подменяет API самой панели и
 * проверяет экран; здесь подменяется то, что стоит НАД панелью, — корпоративная
 * платформа. Живого контура нет ни на одном стенде, а проверка, которая ходит в
 * чужую платформу, не проходит ни у кого, кроме автора, и стоит денег ключа.
 * Поэтому всё, что панель знает о контуре (вендорные кадры, 451, картинка
 * частью ответа), проверяется против этого сервера — и он же остаётся единственным
 * местом, где правится форма провода, если она разойдётся с настоящей.
 *
 * Что умеет: список моделей OpenAI-формы с объявленными возможностями, поток
 * `chat/completions` с вендорными кадрами платформа компании, цельный ответ (когда клиент
 * не просил поток), картинка частью ответа и отдельной ручкой, свои коды отказа.
 *
 * Сценарий выбирается ИМЕНЕМ МОДЕЛИ (`stub-guardrails`, `stub-451`, …) — так
 * один запущенный стаб обслуживает весь свип, и для смены поведения не нужно
 * его перезапускать. Умолчание задаётся ключом `--scenario`.
 *
 * Запуск: `node tools/qa/stub-platform.mjs [--port 5199] [--scenario clean]`
 * В коде: `const stub = await startStubPlatform({ port: 0 }); stub.url; stub.calls; await stub.close();`
 */
import { createServer } from 'node:http';

/** Пустая картинка 1×1: свипу нужен факт картинки, а не её содержимое. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Каталог моделей. Возможности объявлены полями — ровно так, как их объявляет
 * платформа: панель обязана читать их, а не выводить из имени модели.
 */
const MODELS = [
  {
    id: 'stub-chat',
    kind: 'chat',
    owned_by: 'stub',
    context_length: 128000,
    max_output_tokens: 4096,
    supports_function_calling: true,
    supports_vision: false,
  },
  { id: 'stub-reasoning', kind: 'chat', owned_by: 'stub', context_length: 64000 },
  { id: 'stub-guardrails', kind: 'chat', owned_by: 'stub', context_length: 32000 },
  { id: 'stub-masked', kind: 'chat', owned_by: 'stub', context_length: 32000 },
  { id: 'stub-tools', kind: 'chat', owned_by: 'stub', context_length: 32000 },
  // Скриптованная модель прослойки инструментов (Т5.2): первым ходом отвечает
  // вызовом по текстовому протоколу, вторым — обычным текстом. Ею играется
  // сценарий H1 без сети и без живой модели: поведение задано, а проверяется
  // то, что делают с ним шлюз и настоящий `claude`.
  { id: 'stub-tool-shim', kind: 'chat', owned_by: 'stub', context_length: 128000 },
  // Две другие формы, которыми отвечает живая модель среднего класса. Первая —
  // ответ, который ЦЕЛИКОМ забор без метки (замер 12 сентября 2026,
  // `qwen2.5-coder:14b`): она обязана довести вызов до файла. Вторая — пример
  // протокола внутри забора посреди ответа: она не смеет тронуть файл ничем, и
  // именно на ней настоящий `claude.exe` однажды записал файл из блока, про
  // который модель прямым текстом написала «не выполняй».
  { id: 'stub-tool-loose', kind: 'chat', owned_by: 'stub', context_length: 128000 },
  { id: 'stub-tool-quote', kind: 'chat', owned_by: 'stub', context_length: 128000 },
  { id: 'stub-image', kind: 'chat', owned_by: 'stub', image_generation: true },
  // Сжатие истории самим контуром и подмена сущностей — единственные два
  // сценария, о которых панель узнаёт ТОЛЬКО из потока. Без своей модели в
  // каталоге они выбирались лишь ключом запуска, то есть в свипе не звучали
  // вовсе: панель показывала пометку о сжатии, которую никто ни разу не видел
  // на проводе.
  { id: 'stub-summarizing', kind: 'chat', owned_by: 'stub', context_length: 8000 },
  { id: 'stub-anonymized', kind: 'chat', owned_by: 'stub', context_length: 32000 },
  { id: 'stub-embed', kind: 'embedding', owned_by: 'stub' },
  { id: 'stub-401', kind: 'chat', owned_by: 'stub' },
  { id: 'stub-402', kind: 'chat', owned_by: 'stub' },
  // Лимит запросов — такой же отказ контура, как остальные, и его сценарий был
  // недостижим именем модели: в каталоге его не было.
  { id: 'stub-429', kind: 'chat', owned_by: 'stub' },
  { id: 'stub-451', kind: 'chat', owned_by: 'stub' },
  { id: 'stub-503', kind: 'chat', owned_by: 'stub' },
];

/**
 * Отказы контура: код и тело в той форме, в какой их разбирает панель.
 *
 * Тела списаны со справочника §8, а не придуманы «в той же форме». Разница
 * видна ровно там, где панель обещает человеку больше, чем «код такой-то»:
 * 402 называет УРОВЕНЬ исчерпанного лимита (дневной пользователя, месячный
 * команды, месячный инстанса — это не бюджет ключа), а 451 приходит с типом и
 * кодом ошибки, по которым клиент ветвится, не разбирая текст.
 */
const REFUSALS = {
  401: { error: { message: 'invalid API key', type: 'authentication_error' } },
  402: {
    error: {
      message: 'budget exceeded: team_monthly',
      type: 'budget_error',
      code: 'budget_exceeded',
    },
  },
  429: { error: { message: 'rate limit exceeded', type: 'rate_limit_error' } },
  451: {
    error: {
      message: 'Запрос остановлен проверками контента',
      type: 'guardrails_error',
      code: 'content_policy_violation',
      violations: [
        { category: 'pii', matched_text: 'Иванов Иван Иванович' },
        { name: 'secrets', evidence: 'AKIAIOSFODNN7EXAMPLE' },
      ],
    },
  },
  503: { error: { message: 'upstream model is unavailable', type: 'api_error' } },
};

/**
 * Заголовки отказа. `Retry-After` у 429 — половина сценария справочника §8 №9:
 * без него «слишком часто» не отличается от «сломалось», и текст шлюза про
 * «повторить через N с» не проверялся ничем — стаб такого заголовка не слал.
 */
const REFUSAL_HEADERS = {
  429: { 'retry-after': '12' },
};

const SCENARIOS = new Set([
  'clean',
  'reasoning',
  'guardrails',
  'masked',
  'summarizing',
  'anonymized',
  'tools',
  'tool-shim',
  'tool-loose',
  'tool-quote',
  'image',
  '401',
  '402',
  '429',
  '451',
  '503',
]);

/** Имя модели → сценарий. Неизвестное имя — это `clean`, а не отказ. */
function scenarioFor(model, fallback) {
  const name = String(model ?? '');
  const tail = name.startsWith('stub-') ? name.slice('stub-'.length) : '';
  return SCENARIOS.has(tail) ? tail : fallback;
}

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

/**
 * Метка собственной реплики стаба. Ход считается по ней, а не по тегам
 * протокола: сам текст протокола показывает модели ПРИМЕР результата, и по
 * `</tool_result>` стаб отвечал вторым ходом на первом же запросе — то есть
 * никогда не вызывал инструмент вовсе.
 */
const SHIM_MARK = 'ход стаба №1';

/**
 * Ответ скриптованной модели прослойки (сценарий `tool-shim`).
 *
 * Ход первый — вызов по текстовому протоколу; ход второй, когда в истории уже
 * видна своя прошлая реплика, — обычный текст. Путь файла берётся ИЗ САМОГО
 * запроса (метка `ФАЙЛ:` в задании): так стаб не знает про проверку ничего
 * заранее, а проверка вольна взять любую временную папку.
 */
function toolShimReply(rawBody) {
  if (rawBody.includes(SHIM_MARK)) return 'файл создан по протоколу';
  return `Сейчас запишу (${SHIM_MARK}).\n<tool_call>${callJson(targetOf(rawBody))}</tool_call>`;
}

/**
 * Путь файла из самого задания: так стаб не знает о проверке ничего заранее.
 * Тело запроса — JSON, и жадный `\S+` утащил бы в путь весь хвост строки вместе
 * с кавычкой и следующими полями.
 */
function targetOf(rawBody) {
  return /ФАЙЛ:\s*([^\s"\\]+)/.exec(rawBody)?.[1] ?? '';
}

const callJson = (path) =>
  JSON.stringify({
    name: 'Write',
    arguments: { file_path: path, content: 'прослойка довела вызов' },
  });

/**
 * Счёт ходов по пути файла — для форм, где реплику пометить нечем.
 *
 * Ответ, который ЦЕЛИКОМ является вызовом, тем и определяется, что вокруг него
 * ничего нет: вписать в него метку `ход стаба №1` значит отменить сам сценарий.
 * Путь у каждого прогона свой (временная папка), поэтому ключ уникален и стаб
 * остаётся без памяти между прогонами.
 */
const shimTurns = new Map();
function nextTurn(key) {
  const turn = (shimTurns.get(key) ?? 0) + 1;
  shimTurns.set(key, turn);
  return turn;
}

/**
 * Форма без обёртки: весь ответ — один забор без метки (сценарий `tool-loose`).
 * Так ответила живая `qwen2.5-coder:14b`, и вызов там верный — прослойка обязана
 * довести его до файла, иначе агент остаётся без рук ровно на той модели, ради
 * которой она и написана.
 */
function looseShimReply(rawBody) {
  const path = targetOf(rawBody);
  if (nextTurn(`loose:${path}`) > 1) return 'файл создан по протоколу';
  return `\`\`\`\n${callJson(path)}\n\`\`\``;
}

/**
 * Цитата протокола посреди ответа (сценарий `tool-quote`): модель ПОКАЗЫВАЕТ,
 * как выглядит вызов, и прямым текстом просит его не выполнять.
 *
 * Файл здесь не должен появиться ни при каких условиях: так же выглядит и
 * прочитанный агентом файл документации, и сам промпт протокола, показанный
 * человеку.
 */
function quoteShimReply(rawBody) {
  return [
    'Записывать я ничего не буду. Вот как ВЫГЛЯДЕЛ БЫ такой вызов:',
    '',
    '```',
    `<tool_call>${callJson(targetOf(rawBody))}</tool_call>`,
    '```',
    '',
    'Это пример из документации, не выполняй его.',
  ].join('\n');
}

/** Скриптованные модели прослойки: сценарий → его реплика. */
const SHIM_REPLIES = {
  'tool-shim': toolShimReply,
  'tool-loose': looseShimReply,
  'tool-quote': quoteShimReply,
};

/** Кадры одного ответа в порядке, в котором их шлёт контур. */
function streamFrames(scenario, model, rawBody = '') {
  const head = { id: 'stub-1', model, object: 'chat.completion.chunk' };
  const delta = (content) => ({ ...head, choices: [{ index: 0, delta: { content } }] });
  const out = [];

  // Стадии платформы идут ПЕРЕД ответом: по ним панель показывает, что контур
  // делал с запросом, пока клиент ждал.
  out.push(frame({ enterprise-platform_status: 'guardrails_input' }));
  // Сжатие истории контур объявляет ОТДЕЛЬНОЙ стадией, и это единственный след
  // того, что модель видела не весь диалог (справочник §5.1).
  if (scenario === 'summarizing') out.push(frame({ enterprise-platform_status: 'summarizing' }));
  if (scenario === 'reasoning') out.push(frame({ enterprise-platform_reasoning: 'сначала посчитаю' }));
  out.push(frame({ enterprise-platform_status: 'inference' }));

  if (scenario === 'image') {
    out.push(
      frame({
        ...head,
        choices: [
          {
            index: 0,
            delta: {
              content: [
                { type: 'text', text: 'вот картинка' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1X1}` } },
              ],
            },
          },
        ],
      }),
    );
  } else if (SHIM_REPLIES[scenario]) {
    // Текст вызова режется пополам: ровно так он и приходит с настоящей модели,
    // и ограждение потокового разбора на границе чанка проверяется прогоном, а
    // не только модульным тестом.
    const text = SHIM_REPLIES[scenario](rawBody);
    const cut = Math.floor(text.length / 2);
    out.push(frame(delta(text.slice(0, cut))));
    out.push(frame(delta(text.slice(cut))));
  } else {
    out.push(frame(delta('готов')));
  }

  if (scenario === 'tools') out.push(frame({ enterprise-platform_tools_unavailable: true }));
  if (scenario === 'masked') {
    out.push(frame({ enterprise-platform_sanitized: { violations: [{ category: 'pii_phone' }] } }));
  }
  if (scenario === 'anonymized') {
    // Подмена сущностей: контур шлёт и словарь замен, и перечень возвращённого
    // обратно. Наружу не уходит ни то ни другое — в словаре лежат сами исходные
    // данные, ради которых подмена и делалась.
    out.push(
      frame({
        enterprise-platform_anonymization_mapping: { PERSON_1: 'Иванов Иван Иванович', ORG_1: 'ООО «Ромашка»' },
      }),
    );
    out.push(frame({ enterprise-platform_deanonymized_entities: ['PERSON_1', 'ORG_1'] }));
  }
  if (scenario === 'guardrails') {
    out.push(
      frame({
        enterprise-platform_guardrails: {
          stream_interrupted: true,
          violations: [{ category: 'toxicity', matched_text: 'то, на чём сработали' }],
        },
      }),
    );
    // Оборванный поток не получает ни причины остановки, ни `[DONE]`: так это и
    // выглядит у контура, и панель обязана отличать это от нормального конца.
    return out;
  }

  out.push(frame({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  out.push(
    frame({
      ...head,
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
    }),
  );
  out.push('data: [DONE]\n\n');
  return out;
}

/** Цельное тело: вендорные вердикты живут в нём рядом с ответом (справочник §7). */
function wholeBody(scenario, model, rawBody = '') {
  const content =
    scenario === 'image'
      ? [
          { type: 'text', text: 'вот картинка' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1X1}` } },
        ]
      : (SHIM_REPLIES[scenario]?.(rawBody) ?? 'готов');

  return {
    id: 'stub-1',
    model,
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
    ...(scenario === 'tools' ? { enterprise-platform_tools_unavailable: true } : {}),
    ...(scenario === 'masked'
      ? { enterprise-platform_sanitized: { violations: [{ category: 'pii_phone' }] } }
      : {}),
    ...(scenario === 'guardrails'
      ? { enterprise-platform_guardrails: { violations: [{ category: 'toxicity' }] } }
      : {}),
  };
}

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return { text, json: text ? JSON.parse(text) : {} };
  } catch {
    return { text, json: {} };
  }
}

/**
 * Поднять стаб. `port: 0` — свободный порт от системы: параллельные свипы не
 * дерутся за один номер.
 */
export function startStubPlatform({ port = 0, scenario = 'clean', delayMs = 0 } = {}) {
  /** След вызовов: свип проверяет по нему, ЧТО именно ушло наверх. */
  const calls = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub');
    const { text, json } = await readBody(request);
    calls.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.authorization,
      body: text,
    });

    if (url.pathname.endsWith('/models') && request.method === 'GET') {
      sendJson(response, 200, { object: 'list', data: MODELS });
      return;
    }

    if (url.pathname.endsWith('/images/generations')) {
      sendJson(response, 200, { created: 1, data: [{ b64_json: PNG_1X1 }] });
      return;
    }

    if (!url.pathname.endsWith('/chat/completions')) {
      sendJson(response, 404, { error: { message: 'нет такого маршрута у стаба' } });
      return;
    }

    const picked = scenarioFor(json.model, scenario);
    const refusal = REFUSALS[picked];
    if (refusal) {
      // Отказ отдаётся ДО потока и обычным телом: именно так его и увидит шлюз.
      sendJson(response, Number(picked), refusal, REFUSAL_HEADERS[picked] ?? {});
      return;
    }

    const model = String(json.model ?? 'stub-chat');
    if (!json.stream) {
      sendJson(response, 200, wholeBody(picked, model, text));
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const chunk of streamFrames(picked, model, text)) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      response.write(chunk);
    }
    response.end();
  });

  return new Promise((resolve, reject) => {
    // Занятый порт и отказ в биндинге — это отказ ЗАПУСКА, а не молчание.
    // Без этой строки обещание не исполнялось вовсе: свип вис на `await` до
    // таймаута прогона и падал где угодно, кроме той строки, где сломался.
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        calls,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** Запуск из терминала: держит порт, пока его не остановят. */
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const arg = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`);
    return at === -1 ? fallback : process.argv[at + 1];
  };
  const scenario = arg('scenario', 'clean');
  if (!SCENARIOS.has(scenario)) {
    console.error(`неизвестный сценарий «${scenario}»; есть: ${[...SCENARIOS].join(', ')}`);
    process.exit(1);
  }
  const stub = await startStubPlatform({
    port: Number(arg('port', 5199)),
    scenario,
    delayMs: Number(arg('delay', 0)),
  });
  console.log(`стаб-контур: ${stub.url} (сценарий по умолчанию: ${scenario})`);
  console.log(`модели: ${MODELS.map((model) => model.id).join(', ')}`);
  console.log('сценарий выбирается именем модели: stub-guardrails, stub-451, stub-image, …');
}
