import { describe, it, expect } from 'vitest';
import type { DlpRule } from '@claude-control/contracts';
import { scanText } from './rules.ts';
import { AliasVault, maskText } from './mask.ts';
import { maskRequestBody } from './request-filter.ts';
import { ResponseStreamFilter, restoreJsonResponse } from './response-filter.ts';
import { apiKindForPath } from './api-shapes.ts';

/**
 * Прокси защиты данных. Проверяется ровно то, чем он либо полезен, либо вреден:
 * находит ли он то, что обещал; НЕ трогает ли то, чего трогать нельзя; и
 * возвращается ли ответ в исходный вид при любой нарезке потока.
 */

function rule(patch: Partial<DlpRule>): DlpRule {
  return {
    id: 'r1',
    name: 'Правило',
    enabled: true,
    kind: 'builtin',
    terms: [],
    pattern: '',
    action: 'mask',
    label: 'ДАННЫЕ',
    ...patch,
  };
}

const people = rule({
  id: 'people',
  name: 'Сотрудники',
  kind: 'terms',
  terms: ['Рустам Урманов', 'Иванов'],
  label: 'ИМЯ',
});

describe('правила: встроенные образцы', () => {
  it('ИНН принимается только с верной контрольной суммой', () => {
    const inn = rule({ kind: 'builtin', builtin: 'inn', label: 'ИНН' });
    // 7707083893 — реальный публичный ИНН организации: контрольный разряд сходится.
    expect(scanText('ИНН 7707083893 в договоре', [inn])).toHaveLength(1);
    // Та же длина, разряд не сходится — это просто число, и трогать его нельзя.
    expect(scanText('счётчик дошёл до 7707083894', [inn])).toHaveLength(0);
    expect(scanText('версия 1234567890 сборки', [inn])).toHaveLength(0);
  });

  it('СНИЛС проверяется по правилу остатка', () => {
    const snils = rule({ kind: 'builtin', builtin: 'snils', label: 'СНИЛС' });
    expect(scanText('СНИЛС 112-233-445 95', [snils])).toHaveLength(1);
    expect(scanText('СНИЛС 112-233-445 96', [snils])).toHaveLength(0);
  });

  it('номер карты — по алгоритму Луна', () => {
    const card = rule({ kind: 'builtin', builtin: 'card', label: 'КАРТА' });
    expect(scanText('карта 4111 1111 1111 1111 оплачена', [card])).toHaveLength(1);
    expect(scanText('карта 4111 1111 1111 1112 оплачена', [card])).toHaveLength(0);
  });

  it('почта и телефон находятся в бытовых написаниях', () => {
    const mail = rule({ id: 'mail', kind: 'builtin', builtin: 'email', label: 'ПОЧТА' });
    const phone = rule({ id: 'phone', kind: 'builtin', builtin: 'phone_ru', label: 'ТЕЛЕФОН' });
    expect(scanText('пишите на user@example.com', [mail])).toHaveLength(1);
    expect(scanText('звоните +7 (900) 123-45-67', [phone])).toHaveLength(1);
    expect(scanText('звоните 8 900 1234567', [phone])).toHaveLength(1);
  });

  it('ключи с опознаваемым началом — да, случайный хеш — нет', () => {
    const keys = rule({ kind: 'builtin', builtin: 'secret_key', label: 'КЛЮЧ' });
    expect(scanText('ключ sk-abcdefghijklmnopqrstuvwxyz', [keys])).toHaveLength(1);
    expect(scanText('коммит 9f3c1b2a8d4e5f6071829304a5b6c7d8e9f0', [keys])).toHaveLength(0);
  });
});

describe('правила: свой словарь', () => {
  it('ищется без учёта регистра и по границам слова', () => {
    expect(scanText('рустам урманов пришёл', [people])).toHaveLength(1);
    // «Ивановский» — другое слово, и портить его заменой нельзя.
    expect(scanText('Ивановский район', [people])).toHaveLength(0);
    expect(scanText('подписал Иванов', [people])).toHaveLength(1);
  });

  it('склонения ловятся: словарь только в именительном падеже бесполезен', () => {
    expect(scanText('дело Иванова', [people])).toHaveLength(1);
    expect(scanText('передал Иванову', [people])).toHaveLength(1);
    expect(scanText('помощник Рустама Урманова', [people])).toHaveLength(1);
    expect(scanText('подписано Рустамом Урмановым', [people])).toHaveLength(1);
  });

  it('перекрытия сняты: одно место — одно правило', () => {
    const mail = rule({ id: 'mail', kind: 'builtin', builtin: 'email', label: 'ПОЧТА' });
    const wide = rule({ id: 'wide', kind: 'regex', pattern: 'user@example\\.com', label: 'АДРЕС' });
    const matches = scanText('адрес user@example.com', [mail, wide]);
    expect(matches).toHaveLength(1);
  });
});

describe('метки', () => {
  it('одно значение — одна метка, повтор не плодит новых', () => {
    const vault = new AliasVault();
    const first = maskText('Рустам Урманов и снова Рустам Урманов', [people], vault);
    expect(first.text).toBe('[ИМЯ_1] и снова [ИМЯ_1]');

    // Следующий запрос в том же разговоре — метка та же.
    const second = maskText('снова Рустам Урманов', [people], vault);
    expect(second.text).toBe('снова [ИМЯ_1]');
    expect(vault.size).toBe(1);
  });

  it('разные значения получают разные номера', () => {
    const vault = new AliasVault();
    const result = maskText('Рустам Урманов и Иванов', [people], vault);
    expect(result.text).toBe('[ИМЯ_1] и [ИМЯ_2]');
  });

  it('сводка срабатываний не содержит самого значения', () => {
    const vault = new AliasVault();
    const result = maskText('Рустам Урманов', [people], vault);
    expect(JSON.stringify(result.hits)).not.toContain('Рустам');
    expect(result.hits[0]).toMatchObject({ ruleId: 'people', count: 1, placeholder: '[ИМЯ_1]' });
  });

  it('правило «отклонить» перевешивает замену и текст не меняется', () => {
    const vault = new AliasVault();
    const stop = rule({ id: 'stop', kind: 'terms', terms: ['Иванов'], action: 'block' });
    const result = maskText('Рустам Урманов и Иванов', [people, stop], vault);
    expect(result.blockedBy?.ruleId).toBe('stop');
    expect(result.text).toBe('Рустам Урманов и Иванов');
  });
});

describe('тело запроса: Anthropic', () => {
  const body = JSON.stringify({
    model: 'claude-opus-5',
    max_tokens: 1024,
    system: 'Ты помощник Рустама Урманова',
    messages: [
      { role: 'user', content: 'Привет от Рустам Урманов' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Рустам Урманов просит…', signature: 'sig' },
          { type: 'tool_use', id: 'tu1', name: 'read', input: { path: 'C:/Рустам Урманов/x.txt' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'внутри файла: Иванов' }],
      },
    ],
  });

  it('заменяет системную часть, реплики, результат инструмента и аргументы', () => {
    const vault = new AliasVault();
    const result = maskRequestBody(body, 'anthropic', [people], vault);
    const sent = JSON.parse(result?.body ?? '');

    // В системной части фамилия стоит в родительном падеже — метка встаёт
    // вместо всей формы, а не оставляет от неё хвост. Именительный падеж дальше
    // — вторая ФОРМА того же человека: номер общий, метка своя, чтобы обратная
    // подстановка вернула ровно то, что было (в пути к файлу это критично).
    expect(sent.system).toBe('Ты помощник [ИМЯ_1]');
    expect(sent.messages[0].content).toBe('Привет от [ИМЯ_1.2]');
    expect(sent.messages[1].content[1].input.path).toBe('C:/[ИМЯ_1.2]/x.txt');
    expect(sent.messages[2].content[0].content).toBe('внутри файла: [ИМЯ_2]');
  });

  it('блок размышлений и служебные поля не трогаются', () => {
    const vault = new AliasVault();
    const sent = JSON.parse(maskRequestBody(body, 'anthropic', [people], vault)?.body ?? '');
    // Правка текста размышлений сделала бы недействительной его подпись.
    expect(sent.messages[1].content[0].thinking).toBe('Рустам Урманов просит…');
    expect(sent.model).toBe('claude-opus-5');
    expect(sent.max_tokens).toBe(1024);
  });

  it('запрос с правилом «отклонить» наверх не уходит', () => {
    const vault = new AliasVault();
    const stop = rule({ id: 'stop', kind: 'terms', terms: ['Иванов'], action: 'block' });
    const result = maskRequestBody(body, 'anthropic', [stop], vault);
    expect(result?.blockedBy?.ruleId).toBe('stop');
  });

  it('не-JSON телом не притворяется разобранным', () => {
    expect(maskRequestBody('это не json', 'anthropic', [people], new AliasVault())).toBeUndefined();
  });
});

describe('тело запроса: OpenAI', () => {
  it('заменяет содержимое реплик и аргументы вызова инструмента', () => {
    const vault = new AliasVault();
    const body = JSON.stringify({
      model: 'qwen2.5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'от Рустам Урманов' }] },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'c1', function: { name: 'read', arguments: '{"path":"/home/Иванов/x"}' } },
          ],
        },
      ],
    });

    const sent = JSON.parse(maskRequestBody(body, 'openai-compat', [people], vault)?.body ?? '');
    expect(sent.messages[0].content[0].text).toBe('от [ИМЯ_1]');
    expect(sent.messages[1].tool_calls[0].function.arguments).toBe('{"path":"/home/[ИМЯ_2]/x"}');
    expect(sent.model).toBe('qwen2.5');
  });
});

describe('путь запроса определяет вид API', () => {
  it('знакомые пути опознаются с префиксом /v1 и без него', () => {
    expect(apiKindForPath('/v1/messages')).toBe('anthropic');
    expect(apiKindForPath('/messages?beta=true')).toBe('anthropic');
    expect(apiKindForPath('/v1/messages/count_tokens')).toBe('anthropic');
    expect(apiKindForPath('/v1/chat/completions')).toBe('openai-compat');
    expect(apiKindForPath('/chat/completions')).toBe('openai-compat');
  });

  it('незнакомый путь не притворяется знакомым', () => {
    expect(apiKindForPath('/v1/models')).toBeUndefined();
    expect(apiKindForPath('/v1beta/models/gemini:generateContent')).toBeUndefined();
  });
});

describe('ответ: обратная подстановка', () => {
  const reverse = new Map([
    ['[ИМЯ_1]', 'Рустам Урманов'],
    ['[ИМЯ_2]', 'Иванов'],
  ]);

  /** Кадры настоящего потока Anthropic — форма взята из документации. */
  function anthropicStream(texts: string[]): string {
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","content":[]}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: ping\ndata: {"type": "ping"}\n\n',
      ...texts.map(
        (text) =>
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          })}\n\n`,
      ),
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    return frames.join('');
  }

  /** Собрать текст ответа обратно так, как его собрал бы CLI. */
  function textOf(stream: string): string {
    let out = '';
    for (const raw of stream.split('\n\n')) {
      const line = raw.split('\n').find((item) => item.startsWith('data: '));
      if (!line) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          out += event.delta.text;
        }
      } catch {
        // `[DONE]` и прочее не-JSON — не текст ответа.
      }
    }
    return out;
  }

  it('метка, разорванная между кадрами, восстанавливается целиком', () => {
    // Ровно тот случай, ради которого всё это написано: `[ИМЯ_1]` приезжает
    // тремя событиями.
    const stream = anthropicStream(['Здравствуйте, ', '[ИМ', 'Я_1', ']!', ' Ваш файл готов.']);
    const filter = new ResponseStreamFilter('anthropic', reverse);
    const out = filter.push(stream) + filter.end();

    expect(textOf(out)).toBe('Здравствуйте, Рустам Урманов! Ваш файл готов.');
    expect(out).not.toContain('[ИМЯ_1]');
  });

  it('результат не зависит от нарезки байтов', () => {
    const stream = anthropicStream(['Привет, ', '[ИМЯ_1] и ', '[ИМЯ', '_2]', '.']);
    const expected = 'Привет, Рустам Урманов и Иванов.';

    for (let cut = 0; cut <= stream.length; cut += 7) {
      const filter = new ResponseStreamFilter('anthropic', reverse);
      const out = filter.push(stream.slice(0, cut)) + filter.push(stream.slice(cut)) + filter.end();
      expect(textOf(out)).toBe(expected);
    }
  });

  it('служебные кадры проходят нетронутыми', () => {
    const stream = anthropicStream(['[ИМЯ_1]']);
    const filter = new ResponseStreamFilter('anthropic', reverse);
    const out = filter.push(stream) + filter.end();

    expect(out).toContain('event: message_start');
    expect(out).toContain('event: ping');
    expect(out).toContain('event: content_block_stop');
    expect(out).toContain('event: message_stop');
  });

  it('удержанный хвост выпускается до конца блока, а не теряется', () => {
    // Ответ заканчивается началом метки, которая меткой так и не стала.
    const stream = anthropicStream(['итог: [ИМ']);
    const filter = new ResponseStreamFilter('anthropic', reverse);
    const out = filter.push(stream) + filter.end();
    expect(textOf(out)).toBe('итог: [ИМ');
  });

  it('аргументы инструмента — свой канал, текст блока в них не перетекает', () => {
    const stream =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"открываю [ИМ"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"[ИМЯ_2]\\"}"}}\n\n';
    const filter = new ResponseStreamFilter('anthropic', reverse);
    const out = filter.push(stream) + filter.end();

    // Хвост текстового блока выпущен своим кадром как текст, а не подмешан в
    // аргументы: собранный текст блока сохраняет незавершённую метку целиком.
    expect(textOf(out)).toBe('открываю [ИМ');
    expect(out).toContain('Иванов');
    expect(out).not.toContain('[ИМЯ_2]');
  });

  it('поток OpenAI: подстановка в choices[].delta.content, [DONE] не трогается', () => {
    const chunk = (content: string): string =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`;
    const stream = chunk('привет, [ИМЯ') + chunk('_1]!') + 'data: [DONE]\n\n';

    const filter = new ResponseStreamFilter('openai-compat', reverse);
    const out = filter.push(stream) + filter.end();

    expect(out).toContain('Рустам Урманов');
    expect(out.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('без меток поток проходит байт в байт', () => {
    const stream = anthropicStream(['ничего заменять не нужно']);
    const filter = new ResponseStreamFilter('anthropic', new Map());
    expect(filter.push(stream) + filter.end()).toBe(stream);
  });

  it('цельный ответ восстанавливается по документированным полям', () => {
    const body = {
      id: 'msg_1',
      content: [
        { type: 'text', text: 'готово, [ИМЯ_1]' },
        { type: 'tool_use', input: { path: '/home/[ИМЯ_2]' } },
      ],
    };
    const restored = restoreJsonResponse(body, 'anthropic', reverse) as {
      content: Array<{ text?: string; input?: { path: string } }>;
    };
    expect(restored.content[0]?.text).toBe('готово, Рустам Урманов');
    expect(restored.content[1]?.input?.path).toBe('/home/Иванов');
  });
});
