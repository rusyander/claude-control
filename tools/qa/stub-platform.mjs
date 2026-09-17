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
 * `chat/completions` с вендорными кадрами платформы компании, цельный ответ (когда клиент
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
  // Модель, которая надиктовывает колоду блоком (Т10): дорога контура у
  // презентаций — это обычный чат, и панель разбирает ответ тем же кодом, каким
  // читает блок из ответа агента.
  { id: 'stub-deck', kind: 'chat', owned_by: 'stub', context_length: 32000 },
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
  // Модель совместимого шлюза с разборщиком вызовов (vLLM `--tool-call-parser`):
  // вызов приходит ПОЛЕМ `tool_calls`, а не текстом. Играет аудит DRV-01 — руки
  // агента у платформы, принимающей `tools` полем.
  { id: 'stub-tool-native', kind: 'chat', owned_by: 'stub', context_length: 128000 },
  { id: 'stub-image', kind: 'chat', owned_by: 'stub', image_generation: true },
  // Сжатие истории самим контуром и подмена сущностей — единственные два
  // сценария, о которых панель узнаёт ТОЛЬКО из потока. Без своей модели в
  // каталоге они выбирались лишь ключом запуска, то есть в свипе не звучали
  // вовсе: панель показывала пометку о сжатии, которую никто ни разу не видел
  // на проводе.
  { id: 'stub-summarizing', kind: 'chat', owned_by: 'stub', context_length: 8000 },
  { id: 'stub-anonymized', kind: 'chat', owned_by: 'stub', context_length: 32000 },
  // Итоговый текст контура разошёлся с отданным потоком (`platform_deanonymized`).
  { id: 'stub-rewritten', kind: 'chat', owned_by: 'stub', context_length: 32000 },
  // Отказ поставщика объектом `error` ПОСЛЕ заголовков 200 — так делает litellm.
  { id: 'stub-stream-error', kind: 'chat', owned_by: 'stub', context_length: 32000 },
  // Хвост вызова прослойки приходит ПОСЛЕ причины остановки (придержанный хвост).
  { id: 'stub-tool-tail', kind: 'chat', owned_by: 'stub', context_length: 32000 },
  { id: 'stub-embed', kind: 'embedding', owned_by: 'stub' },
  { id: 'stub-401', kind: 'chat', owned_by: 'stub' },
  { id: 'stub-402', kind: 'chat', owned_by: 'stub' },
  // Лимит запросов — такой же отказ контура, как остальные, и его сценарий был
  // недостижим именем модели: в каталоге его не было.
  { id: 'stub-429', kind: 'chat', owned_by: 'stub' },
  { id: 'stub-451', kind: 'chat', owned_by: 'stub' },
  { id: 'stub-503', kind: 'chat', owned_by: 'stub' },
];

/** Нарушение в форме `RuleViolation` (`mod-guardrailsbox/.../models.py:226`). */
function ruleViolation(ruleName, ruleType, message) {
  return {
    rule_id: `r-${ruleType.toLowerCase()}`,
    rule_name: ruleName,
    rule_type: ruleType,
    action: 'BLOCK',
    mode: 'ENFORCE',
    scope: 'GLOBAL',
    scanner_name: ruleType,
    score: 1,
    message,
    details: {},
  };
}

/**
 * Отказы контура: код и тело в той форме, в какой их разбирает панель.
 *
 * Тела списаны со справочника §8, а не придуманы «в той же форме». Разница
 * видна ровно там, где панель обещает человеку больше, чем «код такой-то»:
 * 402 на `/v1` называет бюджет КЛЮЧА, а 451 приходит с перечнем сработавших
 * правил рядом с `error`.
 */
const REFUSALS = {
  401: { error: { message: 'invalid API key', type: 'authentication_error' } },
  // `inst-api/internal/api/handler_public_api.go:340` дословно.
  402: {
    error: {
      message: 'budget exceeded for this API key',
      type: 'billing_error',
      code: 'budget_exceeded',
    },
  },
  429: { error: { message: 'rate limit exceeded', type: 'rate_limit_error' } },
  // Форма `mod-llmbox/.../guardrails/helpers.py:35-43`: перечень рядом с `error`,
  // элементы — `RuleViolation` (models.py:226). Найденное лежит в `message`
  // сканера — панель его не читает никогда.
  451: {
    error: {
      message: 'Запрос остановлен проверками контента',
      type: 'guardrail_violation',
      code: 'content_policy_violation',
    },
    violations: [
      ruleViolation('Персональные данные', 'ANONYMIZE', 'найдено: Иванов Иван Иванович'),
      ruleViolation(null, 'SECRETS', 'ключ AKIAIOSFODNN7EXAMPLE'),
    ],
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
  'tool-tail',
  'tool-native',
  'rewritten',
  'stream-error',
  'image',
  'deck',
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

/**
 * Вызов, чей хвост контур отдаёт ПОСЛЕ кадра с причиной остановки (сценарий
 * `tool-tail`). Контур с проверками вывода придерживает конец ответа и
 * досылает его после `finish_reason` (router.py:988–996): прослойка, закрывавшая
 * разбор на причине остановки, теряла вызов целиком.
 */
function tailShimReply(rawBody) {
  return `<tool_call>${callJson(targetOf(rawBody) || 'tail.txt')}</tool_call>`;
}

/** Скриптованные модели прослойки: сценарий → его реплика. */
const SHIM_REPLIES = {
  'tool-shim': toolShimReply,
  'tool-loose': looseShimReply,
  'tool-quote': quoteShimReply,
  'tool-tail': tailShimReply,
};

/**
 * Ход модели с НАТИВНЫМИ вызовами (сценарий `tool-native`): первым ходом — вызов
 * `Write` полем `tool_calls`, вторым, когда в истории уже стоит роль `tool`, —
 * текст. Ход считается по роли `tool` в теле: её там нет, пока мост выбрасывает
 * результаты, и тогда стаб честно зовёт инструмент снова, а не притворяется.
 */
function nativeToolTurn(rawBody) {
  if (rawBody.includes('"role":"tool"')) return { text: 'файл создан полем' };
  // Модель зовёт только объявленное: без `Write` в поле `tools` вызывать нечего.
  // Иначе прогон создавал файл и там, где мост инструменты выбросил, — проверка
  // «файл на диске» зеленела на сломанном мосте.
  let declared;
  try {
    declared = (JSON.parse(rawBody).tools ?? []).map((tool) => tool?.function?.name);
  } catch {
    declared = [];
  }
  // Пробный вызов активации (`smoke-tools.ts`): файла он не пишет, и зелёная
  // строка «модель вызывает инструменты полем» снимается на настоящей пробе.
  if (declared.includes('report_status') && !declared.includes('Write')) {
    return {
      call: {
        id: 'call_native_probe',
        name: 'report_status',
        arguments: JSON.stringify({ status: 'ready' }),
      },
    };
  }
  if (!declared.includes('Write')) return { text: 'инструментов мне не объявили' };
  return {
    call: {
      id: 'call_native_1',
      name: 'Write',
      arguments: JSON.stringify({ file_path: targetOf(rawBody), content: 'руки полем' }),
    },
  };
}

/** Кадры нативного хода: вендорных кадров у совместимого шлюза нет вовсе. */
function nativeToolFrames(model, rawBody) {
  const head = { id: 'stub-native', model, object: 'chat.completion.chunk' };
  const turn = nativeToolTurn(rawBody);
  const out = [];
  if (turn.text) {
    out.push(frame({ ...head, choices: [{ index: 0, delta: { content: turn.text } }] }));
    out.push(frame({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  } else {
    // Аргументы — двумя кусками, как их и отдаёт живой шлюз: склейку по `index`
    // проверяет прогон, а не только модульный тест.
    const cut = Math.floor(turn.call.arguments.length / 2);
    const piece = (extra, args) => ({
      ...head,
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...extra, function: args }] } }],
    });
    out.push(
      frame(
        piece(
          { id: turn.call.id, type: 'function' },
          { name: turn.call.name, arguments: turn.call.arguments.slice(0, cut) },
        ),
      ),
    );
    out.push(frame(piece({}, { arguments: turn.call.arguments.slice(cut) })));
    out.push(frame({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
  }
  out.push(frame(usageChunk(head)));
  out.push('data: [DONE]\n\n');
  return out;
}

/** Итоговый текст сценария `rewritten`: с восстановленным значением вместо метки. */
export const REWRITTEN_FINAL = 'Пишите на ivan@example.ru';

/** Кадры одного ответа в порядке, в котором их шлёт контур. */
function streamFrames(scenario, model, rawBody = '', png = PNG_1X1) {
  if (scenario === 'tool-native') return nativeToolFrames(model, rawBody);
  const head = { id: 'stub-1', model, object: 'chat.completion.chunk' };
  const delta = (content) => ({ ...head, choices: [{ index: 0, delta: { content } }] });
  const out = [];

  // Стадии платформы идут ПЕРЕД ответом: по ним панель показывает, что контур
  // делал с запросом, пока клиент ждал.
  out.push(frame({ platform_status: 'guardrails_input' }));
  // Сжатие истории контур объявляет ОТДЕЛЬНОЙ стадией, и это единственный след
  // того, что модель видела не весь диалог (справочник §5.1).
  if (scenario === 'summarizing') out.push(frame({ platform_status: 'summarizing' }));
  if (scenario === 'reasoning') out.push(frame({ platform_reasoning: 'сначала посчитаю' }));
  out.push(frame({ platform_status: 'inference' }));

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
                { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
              ],
            },
          },
        ],
      }),
    );
  } else if (scenario === 'deck') {
    // Колода приходит ДВУМЯ кусками: блок, разрезанный на границе чанка, — это
    // ровно то, что отдаёт живая модель, и разбор обязан собрать его целиком.
    const text = deckText();
    const cut = Math.floor(text.length / 2);
    out.push(frame(delta(text.slice(0, cut))));
    out.push(frame(delta(text.slice(cut))));
  } else if (scenario === 'tool-tail') {
    const text = tailShimReply(rawBody);
    const cut = text.length - '"}}</tool_call>'.length;
    out.push(frame(delta(text.slice(0, cut))));
    out.push(frame({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    out.push(frame(delta(text.slice(cut))));
    out.push(frame(usageChunk(head)));
    out.push('data: [DONE]\n\n');
    return out;
  } else if (scenario === 'rewritten') {
    out.push(frame(delta('Пишите на [EMAIL_1]')));
  } else if (scenario === 'stream-error') {
    out.push(frame(delta('гот')));
    out.push(
      frame({
        error: {
          message: 'Лимит запросов модели исчерпан',
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
        },
      }),
    );
    return out;
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

  if (scenario === 'tools') out.push(frame({ platform_tools_unavailable: true }));
  if (scenario === 'masked') {
    out.push(
      frame({ platform_sanitized: { violations: [ruleViolation('Телефоны', 'ANONYMIZE', '')] } }),
    );
  }
  if (scenario === 'anonymized') {
    // Подмена сущностей: контур шлёт и словарь замен, и пары возвращённого
    // обратно — СПИСКОМ `{placeholder, value}`, как router.py:1094–1108. Наружу
    // не уходит ни то ни другое — в словаре лежат сами исходные данные, ради
    // которых подмена и делалась.
    out.push(
      frame({
        platform_anonymization_mapping: {
          '[PERSON_1]': 'Иванов Иван Иванович',
          '[ORG_1]': 'ООО «Ромашка»',
        },
      }),
    );
    out.push(
      frame({
        platform_deanonymized_entities: [
          { placeholder: '[PERSON_1]', value: 'Иванов Иван Иванович' },
          { placeholder: '[ORG_1]', value: 'ООО «Ромашка»' },
        ],
      }),
    );
  }
  if (scenario === 'guardrails') {
    out.push(
      frame({
        platform_guardrails: {
          stream_interrupted: true,
          violations: [ruleViolation('Токсичность', 'TOXICITY', 'то, на чём сработали')],
        },
      }),
    );
    // Оборванный поток не получает ни причины остановки, ни `[DONE]`: так это и
    // выглядит у контура, и панель обязана отличать это от нормального конца.
    return out;
  }

  out.push(frame({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  // Картинку частью ответа платформа компании отдаёт дорогой Responses API, и кадра расхода
  // там нет вовсе (`responses_api.py stream_responses_api`, аудит MD-09).
  if (scenario !== 'image') out.push(frame(usageChunk(head)));
  // Итоговый текст шлётся после расхода и перед `[DONE]` (router.py:1086–1088).
  if (scenario === 'rewritten') out.push(frame({ platform_deanonymized: REWRITTEN_FINAL }));
  out.push('data: [DONE]\n\n');
  return out;
}

/**
 * Кадр расхода в форме контура: `usage` рядом с НЕпустым `choices` — контур
 * отдаёт кадр litellm как есть (router.py:898–912). Пустой `choices`, как у
 * OpenAI, стаб не шлёт: на нём разбор зеленел, а живой контур записывал ноль.
 */
function usageChunk(head) {
  return {
    ...head,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
    usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
  };
}

/** Цельное тело: вендорные вердикты живут в нём рядом с ответом (справочник §7). */
/**
 * Колода, которую «надиктовала» модель контура. Завёрнута в блок нарочно: ровно
 * так отвечает живая модель, и панель обязана снять один слой ограды сама.
 */
export const DECK_JSON = {
  title: 'Отчёт о работе панели',
  subtitle: 'проверка на проводе',
  slides: [
    { title: 'Что сделано', bullets: ['режимы', 'колода'], notes: 'заметка докладчику' },
    { title: 'Что дальше', bullets: ['ревью'], notes: '' },
  ],
};

/** Текст ответа с колодой: блок как есть, вместе с оградой. */
function deckText() {
  return ['```agentdeck:deck', JSON.stringify(DECK_JSON), '```'].join('\n');
}

function deckBody(model) {
  const content = deckText();
  return {
    id: 'stub-deck-1',
    model,
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 21, completion_tokens: 30, total_tokens: 51 },
  };
}

function wholeBody(scenario, model, rawBody = '', png = PNG_1X1) {
  if (scenario === 'deck') return deckBody(model);
  if (scenario === 'tool-native') {
    const turn = nativeToolTurn(rawBody);
    return {
      id: 'stub-native',
      model,
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: turn.call ? 'tool_calls' : 'stop',
          message: {
            role: 'assistant',
            content: turn.text ?? null,
            ...(turn.call
              ? {
                  tool_calls: [
                    {
                      id: turn.call.id,
                      type: 'function',
                      function: { name: turn.call.name, arguments: turn.call.arguments },
                    },
                  ],
                }
              : {}),
          },
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
    };
  }
  const content =
    scenario === 'image'
      ? [
          { type: 'text', text: 'вот картинка' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
        ]
      : (SHIM_REPLIES[scenario]?.(rawBody) ?? 'готов');

  return {
    id: 'stub-1',
    model,
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...(scenario === 'image'
      ? {}
      : { usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } }),
    ...(scenario === 'tools' ? { platform_tools_unavailable: true } : {}),
    ...(scenario === 'masked'
      ? { platform_sanitized: { violations: [ruleViolation('Телефоны', 'ANONYMIZE', '')] } }
      : {}),
    ...(scenario === 'guardrails'
      ? { platform_guardrails: { violations: [ruleViolation('Токсичность', 'TOXICITY', '')] } }
      : {}),
  };
}

/** Ответ `single_turn`: контур не исполняет вызов, а отдаёт его клиенту целиком. */
function singleTurnBody(model, tools) {
  const name = Array.isArray(tools) && typeof tools[0] === 'string' ? tools[0] : 'web_search';
  return {
    id: 'stub-single-turn',
    model,
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'сейчас поищу',
          tool_calls: [
            {
              id: 'call_stub_1',
              type: 'function',
              function: { name, arguments: '{"query":"погода"}' },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
  };
}

/**
 * Модель в форме каталога OpenRouter. Цена есть только у `stub-chat`, и она
 * круглая — доллар за токен, — чтобы деньги ответа сверялись без округлений;
 * у остальных `"-1"`, «неизвестно», как у маршрутизаторов OpenRouter.
 */
function openRouterModel({ id, context_length }) {
  return {
    id,
    name: id,
    context_length,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    supported_parameters: ['tools', 'max_tokens'],
    top_provider: { context_length, max_completion_tokens: 2048 },
    pricing:
      id === 'stub-chat' ? { prompt: '1', completion: '1' } : { prompt: '-1', completion: '-1' },
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

const NATIVE_TEXT = 'ответ родной ручки';

/** Ответ Anthropic-вида: цельным сообщением или потоком событий. */
function anthropicMessage(response, json) {
  const model = String(json.model ?? 'stub-chat');
  const usage = { input_tokens: 11, output_tokens: 5 };
  const message = {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: NATIVE_TEXT }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage,
  };
  if (json.stream !== true) {
    sendJson(response, 200, message);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = [
    ['message_start', { type: 'message_start', message: { ...message, content: [] } }],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: NATIVE_TEXT } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  for (const [event, data] of events) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  response.end();
}

/**
 * Поднять стаб. `port: 0` — свободный порт от системы: параллельные свипы не
 * дерутся за один номер. `png` — base64 картинки, которую «рисует» контур:
 * свипу хватает точки 1×1, кадру справки нужна видимая картинка. `vendorPrefix` —
 * слово вендорных полей (`<префикс>_status`): у настоящей установки платформы
 * оно своё, и проверка переезда говорит со стабом прежним словом.
 */
export function startStubPlatform({
  port = 0,
  scenario = 'clean',
  delayMs = 0,
  png = PNG_1X1,
  vendorPrefix = 'platform',
} = {}) {
  const vendor = (text) =>
    vendorPrefix === 'platform' ? text : text.replaceAll('"platform_', `"${vendorPrefix}_`);
  const field = (name) => `${vendorPrefix}_${name}`;
  /** След вызовов: свип проверяет по нему, ЧТО именно ушло наверх. */
  const calls = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub');
    const { text, json } = await readBody(request);
    calls.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      authorization: request.headers.authorization,
      // Транспорт контура (DRV-04/05): свой заголовок ключа и лишний заголовок.
      apiKey: request.headers['api-key'],
      anthropicVersion: request.headers['anthropic-version'],
      tenant: request.headers['x-tenant'],
      body: text,
    });

    if (url.pathname.endsWith('/models') && request.method === 'GET') {
      // Каталоги чужой формы (DRV-06) под своим префиксом пути: Together отдаёт
      // голый массив, OpenRouter — списки возможностей и цены строками за токен.
      if (url.pathname.startsWith('/together/')) {
        sendJson(
          response,
          200,
          MODELS.map(({ id, context_length }) => ({ id, type: 'chat', context_length })),
        );
        return;
      }
      if (url.pathname.startsWith('/openrouter/')) {
        sendJson(response, 200, { data: MODELS.map(openRouterModel) });
        return;
      }
      sendJson(response, 200, { object: 'list', data: MODELS });
      return;
    }

    if (url.pathname.endsWith('/images/generations')) {
      // Отказ ручки картинок выбирается СЛОВОМ В ПРОМПТЕ (`stub-451 …`): модель у
      // неё одна, рисующая, и сценарий по имени модели здесь не выбрать.
      const refusedWith = /\bstub-(\d{3})\b/.exec(String(json.prompt ?? ''))?.[1];
      if (refusedWith && REFUSALS[refusedWith]) {
        sendJson(
          response,
          Number(refusedWith),
          REFUSALS[refusedWith],
          REFUSAL_HEADERS[refusedWith] ?? {},
        );
        return;
      }
      sendJson(response, 200, { created: 1, data: [{ b64_json: png }] });
      return;
    }

    // Родная ручка Anthropic (vLLM, LiteLLM, Ollama, OpenRouter — DRV-03): эхо
    // текстом, чтобы свип видел, что ответ пришёл отсюда, а не с моста.
    if (url.pathname.endsWith('/messages') && request.method === 'POST') {
      anthropicMessage(response, json);
      return;
    }

    if (!url.pathname.endsWith('/chat/completions')) {
      sendJson(response, 404, { error: { message: 'нет такого маршрута у стаба' } });
      return;
    }

    // `mod-llmbox/.../chat/router.py:237-243` дословно: `single_turn` с потоком —
    // 400 FastAPI, без потока — цельное тело, вызов в `message.tool_calls`.
    if (json[field('tool_mode')] === 'single_turn') {
      if (json.stream === true) {
        sendJson(response, 400, {
          detail: `${field('tool_mode')}=single_turn is not supported with stream=true`,
        });
        return;
      }
      sendJson(
        response,
        200,
        singleTurnBody(String(json.model ?? 'stub-chat'), json[field('tools')]),
      );
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
      sendJson(
        response,
        200,
        JSON.parse(vendor(JSON.stringify(wholeBody(picked, model, text, png)))),
      );
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const chunk of streamFrames(picked, model, text, png)) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      response.write(vendor(chunk));
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
