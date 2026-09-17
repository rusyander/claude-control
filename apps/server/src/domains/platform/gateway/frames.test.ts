import { describe, it, expect } from 'vitest';
import { enterprisePlatformDriver } from '../drivers/enterprise-platform.ts';
import { StreamTranslator, classifyFrame, type FrameKind } from './frames.ts';

/**
 * Вендорные кадры потока: табличная проверка на КАЖДЫЙ вид.
 *
 * Критерий партии — «ни один вендорный кадр не доехал до клиента». Проверять
 * его примерами бессмысленно: пропущенный вид кадра ломает не наш код, а чужой
 * CLI, на чужой машине, через месяц. Поэтому здесь перечислены все виды из
 * справочника §7, и каждый прогоняется в обоих диалектах.
 */

/** Кадры из справочника §7 — ровно в том виде, в каком их шлёт контур. */
const VENDOR: { kind: FrameKind; frame: string; why: string }[] = [
  { kind: 'status', frame: '{"platform_status":"thinking"}', why: 'смена стадии' },
  { kind: 'status', frame: '{"platform_status":"summarizing"}', why: 'сжатие истории' },
  { kind: 'reasoning', frame: '{"platform_reasoning":"я думаю"}', why: 'размышления модели' },
  {
    kind: 'sanitized',
    frame: '{"platform_sanitized":true,"violations":[{"category":"pii_phone"}]}',
    why: 'вход замаскирован проверками',
  },
  {
    kind: 'anonymization',
    frame: '{"platform_deanonymized_entities":{"ИМЯ_1":"Иванов"}}',
    why: 'кадр чата платформы, не для API-клиента',
  },
  {
    kind: 'anonymization',
    frame: '{"platform_anonymization_mapping":{"a":"b"}}',
    why: 'то же самое обратной картой',
  },
  { kind: 'unknown', frame: '{"platform_невиданное":1}', why: 'кадр, которого шлюз не знает' },
];

function sse(...frames: string[]): string {
  return frames.map((frame) => `data: ${frame}\n\n`).join('');
}

const DELTA = '{"id":"c1","model":"gpt-x","choices":[{"index":0,"delta":{"content":"да"}}]}';
const USAGE =
  '{"id":"c1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}';

describe('распознавание кадров', () => {
  it.each(VENDOR)('$frame → $kind ($why)', ({ kind, frame }) => {
    expect(classifyFrame(JSON.parse(frame), enterprisePlatformDriver)).toBe(kind);
  });

  it('обычный чанк и финальный расход различаются', () => {
    expect(classifyFrame(JSON.parse(DELTA), enterprisePlatformDriver)).toBe('delta');
    expect(classifyFrame(JSON.parse(USAGE), enterprisePlatformDriver)).toBe('usage');
  });
});

describe('ни один вендорный кадр не доезжает до клиента', () => {
  it.each(VENDOR)('$frame не появляется в потоке клиента (openai)', ({ frame }) => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'openai-compat',
      model: 'gpt-x',
      includeUsage: false,
    });
    const out = translator.push(sse(frame, DELTA)) + translator.end();
    expect(out).not.toContain('platform_');
    expect(out).toContain('"content":"да"');
  });

  it.each(VENDOR)('$frame не появляется в потоке клиента (anthropic)', ({ frame }) => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'anthropic',
      model: 'gpt-x',
      includeUsage: false,
    });
    const out = translator.push(sse(frame, DELTA)) + translator.end();
    expect(out).not.toContain('platform_');
    expect(out).toContain('content_block_delta');
  });
});

describe('факты, которые кадры оставляют панели', () => {
  it('стадии копятся без повторов, а summarizing поднимает признак сжатия', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'openai-compat',
      model: 'm',
      includeUsage: false,
    });
    translator.push(
      sse(
        '{"platform_status":"thinking"}',
        '{"platform_status":"summarizing"}',
        '{"platform_status":"thinking"}',
        '{"platform_status":"generating"}',
      ),
    );
    expect(translator.facts.stages).toEqual(['thinking', 'summarizing', 'generating']);
    // Человек обязан узнать, что модель видела пересказ, а не его текст.
    expect(translator.facts.summarized).toBe(true);
  });

  it('кадры размышления в поток не идут, но оставляют стадию `reasoning` в следе', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'anthropic',
      model: 'm',
      includeUsage: false,
    });
    const out = translator.push(
      sse('{"platform_reasoning":"я думаю"}', '{"platform_reasoning":" дальше"}', DELTA),
    );
    // Единственное свидетельство, что правило «Размышления модели» дошло до модели.
    expect(translator.facts.stages).toEqual(['reasoning']);
    expect(out).not.toContain('я думаю');
  });

  it('расход снимается всегда, даже когда клиент его не просил', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'openai-compat',
      model: 'm',
      includeUsage: false,
    });
    const out = translator.push(sse(DELTA, USAGE)) + translator.end();
    expect(out).not.toContain('usage');
    expect(translator.facts.totalTokens).toBe(12);
    expect(translator.facts.promptTokens).toBe(10);
  });

  it('расход уходит клиенту, если он сам его просил', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'openai-compat',
      model: 'm',
      includeUsage: true,
    });
    const out = translator.push(sse(DELTA, USAGE));
    expect(out).toContain('"total_tokens":12');
  });

  it('незнакомый кадр попадает в след ИМЕНАМИ ПОЛЕЙ, а не содержимым', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'openai-compat',
      model: 'm',
      includeUsage: false,
    });
    translator.push(sse('{"platform_новое":"секретный текст"}'));
    expect(translator.facts.unknownFrames).toEqual(['platform_новое']);
    expect(JSON.stringify(translator.facts)).not.toContain('секретный текст');
  });

  it('нечитаемый кадр наружу не идёт', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'openai-compat',
      model: 'm',
      includeUsage: false,
    });
    const out = translator.push('data: {это не json\n\n');
    expect(out).toBe('');
    expect(translator.facts.unknownFrames).toEqual(['нечитаемый кадр']);
  });
});

describe('обрыв по проверкам содержимого', () => {
  const guard =
    '{"platform_guardrails":{"stream_interrupted":true,"violations":[{"category":"pii_inn"},{"text":"тут был телефон 89001234567"}]}}';

  it('openai получает терминальную ошибку и [DONE], а не тихий конец', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'openai-compat',
      model: 'm',
      includeUsage: false,
    });
    const out = translator.push(sse(DELTA, guard)) + translator.end();
    expect(out).toContain('content_policy_violation');
    expect(out).toContain('pii_inn');
    expect(out.trimEnd().endsWith('data: [DONE]')).toBe(true);
    // Текст, на котором сработала проверка, наружу не уходит НИКОГДА.
    expect(out).not.toContain('89001234567');
    expect(translator.facts.violations).toEqual(['pii_inn']);
    expect(translator.facts.interrupted).toBe(true);
  });

  it('anthropic получает событие error', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'anthropic',
      model: 'm',
      includeUsage: false,
    });
    const out = translator.push(sse(DELTA, guard)) + translator.end();
    expect(out).toContain('event: error');
    expect(out).not.toContain('message_stop');
  });

  it('флаг остановки читается и снаружи кадра, а не только внутри', () => {
    // Живого кадра гардрейлов никто ещё не видел, форма — обещание документации.
    // Строгое чтение одного уровня давало худший исход: флаг терялся, `[DONE]`
    // следом закрывал поток, и ОБОРВАННЫЙ ответ приезжал человеку законченным.
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'openai-compat',
      model: 'm',
      includeUsage: false,
    });
    const outside =
      '{"platform_guardrails":{"violations":[{"category":"pii"}]},"stream_interrupted":true}';
    const out = translator.push(sse(DELTA, outside, '[DONE]')) + translator.end();

    expect(out).toContain('content_policy_violation');
    expect(translator.facts.interrupted).toBe(true);
    expect(translator.facts.violations).toEqual(['pii']);
  });

  it('перечень, присланный массивом, тоже читается', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'openai-compat',
      model: 'm',
      includeUsage: false,
    });
    translator.push(sse(DELTA, '{"platform_guardrails":["pii_inn"]}'));

    expect(translator.facts.violations).toEqual(['pii_inn']);
  });

  it('кадр гардрейлов без имени и без вердикта становится незнакомым, а не тишиной', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'openai-compat',
      model: 'm',
      includeUsage: false,
    });
    translator.push(sse(DELTA, '{"platform_guardrails":"сработало"}'));

    expect(translator.facts.violations).toEqual([]);
    expect(translator.facts.unknownFrames.join(' ')).toContain('platform_guardrails');
  });

  it('чанк с вердиктом И текстом отдаёт текст, а не проглатывается целиком', () => {
    // В цельном теле вердикт стоит рядом с `choices`. Проглоченный вместе с
    // вердиктом чанк уносил и текст, и `finish_reason`, после чего законченный
    // ответ приезжал человеку как оборванный.
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'openai-compat',
      model: 'm',
      includeUsage: false,
    });
    const both =
      '{"id":"1","choices":[{"index":0,"delta":{"content":"часть два"},"finish_reason":"stop"}],' +
      '"platform_guardrails":{"violations":[{"category":"toxicity"}]}}';
    const out = translator.push(sse(DELTA, both)) + translator.end();

    expect(out).toContain('часть два');
    expect(out).not.toContain('оборв');
    expect(translator.facts.violations).toEqual(['toxicity']);
  });

  it('после обрыва в поток клиента больше ничего не пишется', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'openai-compat',
      model: 'm',
      includeUsage: true,
    });
    translator.push(sse(guard));
    const after = translator.push(sse(DELTA, USAGE)) + translator.end();
    expect(after).toBe('');
    // Расход при этом всё равно посчитан: контур его уже потратил.
    expect(translator.facts.totalTokens).toBe(12);
  });
});

describe('перевод потока в диалект Anthropic', () => {
  it('поток разворачивается в полный набор событий', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'anthropic',
      model: 'gpt-x',
      includeUsage: false,
    });
    const out =
      translator.push(
        sse(
          DELTA,
          '{"choices":[{"index":0,"delta":{"content":" и ещё"},"finish_reason":"length"}]}',
          USAGE,
        ),
      ) + translator.push('data: [DONE]\n\n');

    expect(out).toContain('event: message_start');
    expect(out).toContain('event: content_block_start');
    expect(out).toContain('"text":"да"');
    expect(out).toContain('"text":" и ещё"');
    expect(out).toContain('event: content_block_stop');
    expect(out).toContain('"stop_reason":"max_tokens"');
    expect(out).toContain('"output_tokens":2');
    expect(out).toContain('event: message_stop');
  });

  it('пустой поток закрывается ОШИБКОЙ, а не пустым удачным ответом', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'anthropic',
      model: 'gpt-x',
      includeUsage: false,
    });
    const out = translator.end();
    // Контур не сказал ни слова и закрыл соединение: `message_stop` со
    // `stop_reason: end_turn` клиент показал бы как законченный пустой ответ.
    expect(out).toContain('event: error');
    expect(out).not.toContain('message_stop');
    expect(translator.facts.truncated).toBe(true);
  });

  it('поток без [DONE] и без причины остановки объявляется оборванным', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'anthropic',
      model: 'gpt-x',
      includeUsage: false,
    });
    const out = translator.push(sse(DELTA)) + translator.end();
    expect(out).toContain('event: message_start');
    expect(out).toContain('event: error');
    expect(out).not.toContain('"stop_reason":"end_turn"');
    expect(translator.facts.truncated).toBe(true);
  });

  it('причина остановки без [DONE] считается законным концом', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'anthropic',
      model: 'gpt-x',
      includeUsage: false,
    });
    const out =
      translator.push(
        sse('{"choices":[{"index":0,"delta":{"content":"да"},"finish_reason":"stop"}]}', USAGE),
      ) + translator.end();
    expect(out).toContain('"stop_reason":"end_turn"');
    expect(out).toContain('event: message_stop');
    expect(out).not.toContain('event: error');
    expect(translator.facts.truncated).toBe(false);
  });

  it('итоговый расход входа доезжает до клиента', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'anthropic',
      model: 'gpt-x',
      includeUsage: false,
    });
    // `message_start` уходит на первой дельте, когда расхода ещё нет: единственное
    // место, где `input_tokens` вообще может быть правдой, — `message_delta`.
    const out =
      translator.push(sse(DELTA, USAGE)) + translator.push('data: [DONE]\n\n') + translator.end();
    const delta = out.slice(out.indexOf('event: message_delta'));
    expect(delta).toContain(`"input_tokens":${translator.facts.promptTokens}`);
    expect(translator.facts.promptTokens).toBeGreaterThan(0);
  });

  it('кадр, разорванный между кусками TCP, не теряется', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'openai-compat',
      model: 'm',
      includeUsage: false,
    });
    const whole = sse(DELTA);
    const out =
      translator.push(whole.slice(0, 12)) + translator.push(whole.slice(12)) + translator.end();
    expect(out).toContain('"content":"да"');
  });

  it('кириллица в escape-последовательностях доезжает как есть', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'anthropic',
      model: 'm',
      includeUsage: false,
    });
    // Контур сериализует поток с ensure_ascii (справочник §7).
    const out = translator.push(
      sse(
        '{"choices":[{"index":0,"delta":{"content":"\\u043f\\u0440\\u0438\\u0432\\u0435\\u0442"}}]}',
      ),
    );
    expect(out).toContain('привет');
  });
});

describe('сборка ответа для клиента, просившего не поток', () => {
  it('текст, причина и расход собираются из потока', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'openai-compat',
      model: 'gpt-x',
      includeUsage: false,
    });
    translator.push(
      sse(
        DELTA,
        '{"choices":[{"index":0,"delta":{"content":"!"},"finish_reason":"stop"}]}',
        USAGE,
        '[DONE]',
      ),
    );
    const answer = translator.assembled();
    expect(answer.text).toBe('да!');
    expect(answer.finishReason).toBe('stop');
    expect(answer.totalTokens).toBe(12);
    expect(answer.model).toBe('gpt-x');
    expect(answer.id).toBe('c1');
  });
});

/**
 * Придержанный хвост и конец потока.
 *
 * Прослойка держит ответ, который весь может оказаться вызовом, до последнего
 * знака — и вопрос «когда его отдать» решается не в разборщике, а здесь: у
 * каждого диалекта свой знак конца, и отдать хвост ПОСЛЕ него значит не отдать
 * вовсе. Клиент, прочитавший `data: [DONE]`, закрывает чтение.
 */
describe('хвост прослойки на конце потока', () => {
  const CALL = '{"name":"Write","arguments":{"file_path":"a.ts"}}';

  function withShim(dialect: 'openai-compat' | 'anthropic'): StreamTranslator {
    return new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect,
      model: 'gpt-x',
      includeUsage: false,
      shim: { allowed: new Set(['Write']) },
    });
  }

  it('вызов уходит клиенту РАНЬШЕ [DONE], а не после него', () => {
    const translator = withShim('openai-compat');
    // Контур прислал `[DONE]` без причины остановки — так он и делает, когда
    // ответ кончился сам. Весь ответ при этом один объект вызова: разборщик
    // держал его до конца и отдать обязан ДО закрывающего кадра.
    const out = translator.push(
      sse(`{"choices":[{"index":0,"delta":{"content":${JSON.stringify(CALL)}}}]}`, '[DONE]'),
    );

    expect(out).toContain('tool_calls');
    expect(out.indexOf('tool_calls')).toBeLessThan(out.indexOf('[DONE]'));
    expect(translator.facts.toolCalls).toBe(1);
  });

  it('обрыв отдаёт прочитанное текстом, но вызова из него не собирает', () => {
    const translator = withShim('openai-compat');
    // Половина вызова и обрыв связи: выполнить её — записать половину файла,
    // а потерять текст значило бы показать пустой ответ там, где модель успела
    // написать половину.
    translator.push(sse('{"choices":[{"index":0,"delta":{"content":"{\\"name\\":\\"Wr"}}]}'));
    const out = translator.fail('связь с контуром оборвалась');

    expect(out).toContain('{\\"name\\":\\"Wr');
    expect(out.indexOf('{\\"name\\":\\"Wr')).toBeLessThan(out.indexOf('связь с контуром'));
    expect(translator.facts.toolCalls).toBe(0);
    expect(translator.facts.truncated).toBe(true);
  });

  it('поток, кончившийся без слова контура, тоже не съедает придержанное', () => {
    const translator = withShim('openai-compat');
    translator.push(sse('{"choices":[{"index":0,"delta":{"content":"{\\"name\\":\\"Wr"}}]}'));
    const out = translator.end();

    expect(out).toContain('{\\"name\\":\\"Wr');
    expect(translator.facts.truncated).toBe(true);
  });
});

/**
 * Пометка «описала действие и не вызвала ничего» — эвристика, и цена у неё
 * ровно одна: она обязана молчать на удачном ходе. Загораясь на каждом втором
 * успешном прогоне, она обесценивается за день, и человек перестаёт её читать
 * ровно к тому моменту, когда она права.
 */
describe('пометка заявки без вызова', () => {
  function say(text: string, priorCalls: boolean): boolean {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'openai-compat',
      model: 'gpt-x',
      includeUsage: false,
      shim: { allowed: new Set(['Write']), priorCalls },
    });
    // `[DONE]` здесь обязателен: без слова контура поток считается оборванным,
    // и пометка не выставляется вовсе — проверять было бы нечего.
    translator.push(
      sse(`{"choices":[{"index":0,"delta":{"content":${JSON.stringify(text)}}}]}`, '[DONE]'),
    );
    translator.end();
    return translator.facts.claimedWithoutCall;
  }

  it('горит там, где модель описала действие и не вызвала ничего', () => {
    expect(say('Файл создан.', false)).toBe(true);
  });

  it('молчит в итоговой реплике удачного хода', () => {
    // Последний запрос любого удачного хода — это «файл создан по протоколу», и
    // вызовов в нём нет по устройству: они были в предыдущем.
    expect(say('Файл создан.', true)).toBe(false);
  });

  it('молчит на честном признании неудачи', () => {
    // Иначе «файл не создан — инструмент вернул ошибку» панель показывает теми
    // же словами, что галлюцинацию «файл создан»: два противоположных исхода
    // человек не различает никак.
    expect(say('Файл не создан — инструмент вернул ошибку доступа.', false)).toBe(false);
    expect(say('The file was not created because the tool call failed.', false)).toBe(false);
    expect(say("I didn't create the file: the path is not writable.", false)).toBe(false);
  });
});
