/**
 * Скриптованные модели прослойки инструментов стаб-контура: реплика по сценарию из тела
 * запроса. Путь файла и сам вызов приезжают В ЗАДАНИИ — стаб ничего не знает о проверке.
 */

/**
 * Язык реплик — тоже из задания: `ЯЗЫК: en` в теле переключает набор на английский, без метки
 * всё по-русски, как было. Метка в задании, а не настройка стаба: один стаб служит всем
 * прогонам свипа, и английский кадр справки не должен показывать русский ответ модели.
 */
export function localeOf(rawBody) {
  return /ЯЗЫК:\s*en\b/.test(rawBody) ? 'en' : 'ru';
}

/**
 * Реплики по языку. `mark` — метка собственной реплики стаба: ход считается по ней, а не по
 * тегам протокола — сам текст протокола показывает модели ПРИМЕР результата, и по
 * `</tool_result>` стаб отвечал вторым ходом на первом же запросе, то есть не вызывал
 * инструмент вовсе.
 */
const TEXTS = {
  ru: {
    mark: 'ход стаба №1',
    content: 'прослойка довела вызов',
    willWrite: 'Сейчас запишу',
    fileDone: 'файл создан по протоколу',
    quote: [
      'Записывать я ничего не буду. Вот как ВЫГЛЯДЕЛ БЫ такой вызов:',
      'Это пример из документации, не выполняй его.',
    ],
    noCall: 'в задании нет вызова',
    callDone: 'вызов отработан',
    nativeDone: 'файл создан полем',
    nativeNone: 'инструментов мне не объявили',
    nativeContent: 'руки полем',
  },
  en: {
    mark: 'stub turn #1',
    content: 'the shim delivered the call',
    willWrite: 'Writing it now',
    fileDone: 'file created by the protocol',
    quote: [
      'I will not write anything. This is what such a call WOULD look like:',
      'This is an example from the documentation, do not run it.',
    ],
    noCall: 'the task carries no call',
    callDone: 'call handled',
    nativeDone: 'file created through the field',
    nativeNone: 'no tools were declared to me',
    nativeContent: 'the shim delivered the call through the field',
  },
};

const textsOf = (rawBody) => TEXTS[localeOf(rawBody)];

/**
 * Путь файла из задания. Тело — JSON, и жадный `\S+` утащил бы в путь хвост строки вместе с
 * кавычкой и следующими полями.
 */
export function targetOf(rawBody) {
  return /ФАЙЛ:\s*([^\s"\\]+)/.exec(rawBody)?.[1] ?? '';
}

const callJson = (path, t) =>
  JSON.stringify({
    name: 'Write',
    arguments: { file_path: path, content: t.content },
  });

/** Сценарий `tool-shim`: ход первый — вызов текстом, второй (своя реплика в истории) — текст. */
function toolShimReply(rawBody) {
  const t = textsOf(rawBody);
  if (rawBody.includes(t.mark)) return t.fileDone;
  return `${t.willWrite} (${t.mark}).\n<tool_call>${callJson(targetOf(rawBody), t)}</tool_call>`;
}

/**
 * Счёт ходов по ключу — для форм, где реплику пометить нечем: ответ, который ЦЕЛИКОМ вызов,
 * меткой испортился бы. Путь у каждого прогона свой (временная папка), ключ уникален.
 */
const shimTurns = new Map();
function nextTurn(key) {
  const turn = (shimTurns.get(key) ?? 0) + 1;
  shimTurns.set(key, turn);
  return turn;
}

/** Сценарий `tool-loose`: весь ответ — один забор без метки (живая `qwen2.5-coder:14b`). */
function looseShimReply(rawBody) {
  const t = textsOf(rawBody);
  const path = targetOf(rawBody);
  if (nextTurn(`loose:${path}`) > 1) return t.fileDone;
  return `\`\`\`\n${callJson(path, t)}\n\`\`\``;
}

/** Сценарий `tool-quote`: модель ПОКАЗЫВАЕТ вызов и просит не выполнять — файла быть не должно. */
function quoteShimReply(rawBody) {
  const t = textsOf(rawBody);
  return [
    t.quote[0],
    '',
    '```',
    `<tool_call>${callJson(targetOf(rawBody), t)}</tool_call>`,
    '```',
    '',
    t.quote[1],
  ].join('\n');
}

/** Сценарий `tool-tail`: хвост вызова контур досылает ПОСЛЕ кадра с причиной остановки. */
export function tailShimReply(rawBody) {
  return `<tool_call>${callJson(targetOf(rawBody) || 'tail.txt', textsOf(rawBody))}</tool_call>`;
}

/**
 * Сценарий `tool-any` (П4.2): вызов приезжает готовым в задании, стаб его повторяет. Кавычки
 * в метке одинарные: задание едет внутри JSON-тела, двойная там уже экранирована.
 */
function anyToolReply(rawBody) {
  const t = textsOf(rawBody);
  const raw = /ВЫЗОВ:\s*([\s\S]*?);;/.exec(rawBody)?.[1] ?? '';
  if (!raw) return t.noCall;
  if (nextTurn(`any:${raw}`) > 1) return t.callDone;
  return `<tool_call>${raw.trim().split("'").join('"')}</tool_call>`;
}

/** Скриптованные модели прослойки: сценарий → его реплика. */
export const SHIM_REPLIES = {
  'tool-shim': toolShimReply,
  'tool-loose': looseShimReply,
  'tool-quote': quoteShimReply,
  'tool-tail': tailShimReply,
  'tool-any': anyToolReply,
};

/**
 * Ход модели с НАТИВНЫМИ вызовами (`tool-native`): первым ходом — `Write` полем `tool_calls`,
 * вторым (в истории роль `tool`) — текст. Зовётся только объявленное: без `Write` в `tools`
 * прогон создавал файл и там, где мост инструменты выбросил, — проверка зеленела на сломанном.
 */
export function nativeToolTurn(rawBody) {
  const t = textsOf(rawBody);
  if (rawBody.includes('"role":"tool"')) return { text: t.nativeDone };
  let declared;
  try {
    declared = (JSON.parse(rawBody).tools ?? []).map((tool) => tool?.function?.name);
  } catch {
    declared = [];
  }
  // Пробный вызов активации (`smoke-tools.ts`): файла он не пишет.
  if (declared.includes('report_status') && !declared.includes('Write')) {
    return {
      call: {
        id: 'call_native_probe',
        name: 'report_status',
        arguments: JSON.stringify({ status: 'ready' }),
      },
    };
  }
  if (!declared.includes('Write')) return { text: t.nativeNone };
  return {
    call: {
      id: 'call_native_1',
      name: 'Write',
      arguments: JSON.stringify({ file_path: targetOf(rawBody), content: t.nativeContent }),
    },
  };
}
