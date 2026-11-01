/**
 * Ответы `chat/completions` стаб-контура: кадры потока (данными — пишет их сервер пакета,
 * `frame()`) и цельное тело. Вендорные кадры (`platform_*`) идут в том порядке, в каком их
 * шлёт контур: стадии до ответа, расход и итог после, `[DONE]` последним.
 */
import { PNG_1X1, REWRITTEN_FINAL, deckText, ruleViolation } from './catalog.mjs';
import { SHIM_REPLIES, nativeToolTurn, tailShimReply } from './shim.mjs';

const at = (data) => ({ data });
const DONE = Object.freeze({ data: '[DONE]' });

/**
 * Кадр расхода в форме контура: `usage` рядом с НЕпустым `choices` (кадр litellm как есть).
 * Пустой `choices`, как у OpenAI, стаб не шлёт: на нём разбор зеленел, а живой контур писал ноль.
 */
function usageChunk(head) {
  return {
    ...head,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
    usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
  };
}

/** Кадры нативного хода: вендорных кадров у совместимого шлюза нет вовсе. */
function nativeToolFrames(model, rawBody) {
  const head = { id: 'stub-native', model, object: 'chat.completion.chunk' };
  const turn = nativeToolTurn(rawBody);
  const out = [];
  if (turn.text) {
    out.push(at({ ...head, choices: [{ index: 0, delta: { content: turn.text } }] }));
    out.push(at({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  } else {
    // Аргументы — двумя кусками, как их отдаёт живой шлюз: склейку по `index` проверяет прогон.
    const cut = Math.floor(turn.call.arguments.length / 2);
    const piece = (extra, args) => ({
      ...head,
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...extra, function: args }] } }],
    });
    out.push(
      at(
        piece(
          { id: turn.call.id, type: 'function' },
          { name: turn.call.name, arguments: turn.call.arguments.slice(0, cut) },
        ),
      ),
    );
    out.push(at(piece({}, { arguments: turn.call.arguments.slice(cut) })));
    out.push(at({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
  }
  out.push(at(usageChunk(head)));
  out.push(DONE);
  return out;
}

/** Кадры, которые идут ПОСЛЕ текста: вердикты, причина остановки, расход, итог, `[DONE]`. */
function tailFrames(scenario, head, out) {
  if (scenario === 'tools') out.push(at({ platform_tools_unavailable: true }));
  if (scenario === 'masked') {
    out.push(
      at({ platform_sanitized: { violations: [ruleViolation('Телефоны', 'ANONYMIZE', '')] } }),
    );
  }
  if (scenario === 'anonymized') {
    // Словарь замен и пары возвращённого — СПИСКОМ `{placeholder, value}`, как платформа.
    // Наружу не уходит ни то ни другое: в словаре лежат сами исходные данные.
    out.push(
      at({
        platform_anonymization_mapping: {
          '[PERSON_1]': 'Иванов Иван Иванович',
          '[ORG_1]': 'ООО «Ромашка»',
        },
      }),
    );
    out.push(
      at({
        platform_deanonymized_entities: [
          { placeholder: '[PERSON_1]', value: 'Иванов Иван Иванович' },
          { placeholder: '[ORG_1]', value: 'ООО «Ромашка»' },
        ],
      }),
    );
  }
  if (scenario === 'guardrails') {
    out.push(
      at({
        platform_guardrails: {
          stream_interrupted: true,
          violations: [ruleViolation('Токсичность', 'TOXICITY', 'то, на чём сработали')],
        },
      }),
    );
    // Оборванный поток не получает ни причины остановки, ни `[DONE]`: так это выглядит у
    // контура, и панель обязана отличать это от нормального конца.
    return out;
  }
  out.push(at({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  // Картинку частью ответа платформа отдаёт дорогой Responses API — кадра расхода там нет (MD-09).
  if (scenario !== 'image') out.push(at(usageChunk(head)));
  // Итоговый текст — после расхода и перед `[DONE]`: такой порядок у платформы.
  if (scenario === 'rewritten') out.push(at({ platform_deanonymized: REWRITTEN_FINAL }));
  out.push(DONE);
  return out;
}

/** Кадры одного ответа в порядке, в котором их шлёт контур. */
export function streamFrames(scenario, model, rawBody = '', png = PNG_1X1) {
  if (scenario === 'tool-native') return nativeToolFrames(model, rawBody);
  const head = { id: 'stub-1', model, object: 'chat.completion.chunk' };
  const delta = (content) => ({ ...head, choices: [{ index: 0, delta: { content } }] });
  const out = [];
  // Стадии платформы идут ПЕРЕД ответом: по ним панель показывает, что контур делал с запросом.
  out.push(at({ platform_status: 'guardrails_input' }));
  // Сжатие истории — единственный след того, что модель видела не весь диалог (справочник §5.1).
  if (scenario === 'summarizing') out.push(at({ platform_status: 'summarizing' }));
  if (scenario === 'reasoning') out.push(at({ platform_reasoning: 'сначала посчитаю' }));
  out.push(at({ platform_status: 'inference' }));

  if (scenario === 'image') {
    out.push(
      at({
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
    // Колода ДВУМЯ кусками: блок, разрезанный на границе чанка, разбор обязан собрать целиком.
    const text = deckText();
    const cut = Math.floor(text.length / 2);
    out.push(at(delta(text.slice(0, cut))), at(delta(text.slice(cut))));
  } else if (scenario === 'tool-tail') {
    const text = tailShimReply(rawBody);
    const cut = text.length - '"}}</tool_call>'.length;
    out.push(at(delta(text.slice(0, cut))));
    out.push(at({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    out.push(at(delta(text.slice(cut))), at(usageChunk(head)), DONE);
    return out;
  } else if (scenario === 'rewritten') {
    out.push(at(delta('Пишите на [EMAIL_1]')));
  } else if (scenario === 'stream-error') {
    out.push(at(delta('гот')));
    out.push(
      at({
        error: {
          message: 'Лимит запросов модели исчерпан',
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
        },
      }),
    );
    return out;
  } else if (SHIM_REPLIES[scenario]) {
    // Текст вызова режется пополам, как с настоящей модели: ограждение потокового разбора на
    // границе чанка проверяется прогоном, а не только модульным тестом.
    const text = SHIM_REPLIES[scenario](rawBody);
    const cut = Math.floor(text.length / 2);
    out.push(at(delta(text.slice(0, cut))), at(delta(text.slice(cut))));
  } else {
    out.push(at(delta('готов')));
  }
  return tailFrames(scenario, head, out);
}

function wholeChoice(id, model, message, finish, usage) {
  return {
    id,
    model,
    object: 'chat.completion',
    choices: [{ index: 0, finish_reason: finish, message }],
    ...(usage ? { usage } : {}),
  };
}

/** Цельное тело: вендорные вердикты живут в нём рядом с ответом (справочник §7). */
export function wholeBody(scenario, model, rawBody = '', png = PNG_1X1) {
  if (scenario === 'deck') {
    return wholeChoice('stub-deck-1', model, { role: 'assistant', content: deckText() }, 'stop', {
      prompt_tokens: 21,
      completion_tokens: 30,
      total_tokens: 51,
    });
  }
  if (scenario === 'tool-native') {
    const turn = nativeToolTurn(rawBody);
    const calls = turn.call
      ? {
          tool_calls: [
            {
              id: turn.call.id,
              type: 'function',
              function: { name: turn.call.name, arguments: turn.call.arguments },
            },
          ],
        }
      : {};
    return wholeChoice(
      'stub-native',
      model,
      { role: 'assistant', content: turn.text ?? null, ...calls },
      turn.call ? 'tool_calls' : 'stop',
      { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
    );
  }
  const content =
    scenario === 'image'
      ? [
          { type: 'text', text: 'вот картинка' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
        ]
      : (SHIM_REPLIES[scenario]?.(rawBody) ?? 'готов');
  return {
    ...wholeChoice(
      'stub-1',
      model,
      { role: 'assistant', content },
      'stop',
      scenario === 'image'
        ? undefined
        : { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
    ),
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
export function singleTurnBody(model, tools) {
  const name = Array.isArray(tools) && typeof tools[0] === 'string' ? tools[0] : 'web_search';
  return wholeChoice(
    'stub-single-turn',
    model,
    {
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
    'tool_calls',
    { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
  );
}
