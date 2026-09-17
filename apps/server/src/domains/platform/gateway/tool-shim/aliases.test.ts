import type { DlpRule } from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import { AliasVault, maskText } from '../../../dlp/mask.ts';
import { ResponseStreamFilter, restoreJsonResponse } from '../../../dlp/response-filter.ts';
import { enterprisePlatformDriver } from '../../drivers/enterprise-platform.ts';
import { StreamTranslator } from '../frames.ts';
import { expandContourAliases, strayAliases } from './aliases.ts';

/**
 * Круговой тест Р11 (Т5.7): значение из аргумента инструмента обязано вернуться
 * к CLI байт в байт.
 *
 * Метки минтит НАСТОЯЩЕЕ хранилище защиты данных, а не строки, написанные
 * здесь: вся эта проверка держится на том, что форма метки у маски и у
 * прослойки одна, и таблица собственных строк доказывала бы только саму себя.
 */

const RULES: DlpRule[] = [
  {
    id: 'r1',
    name: 'Почта',
    enabled: true,
    kind: 'builtin',
    builtin: 'email',
    action: 'mask',
    label: 'ПОЧТА',
    terms: [],
    pattern: '',
  },
  {
    id: 'r2',
    name: 'Адрес в сети',
    enabled: true,
    kind: 'regex',
    pattern: '\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b',
    action: 'mask',
    label: 'IP',
    terms: [],
  },
  {
    id: 'r3',
    name: 'UUID',
    enabled: true,
    kind: 'regex',
    pattern: '\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b',
    action: 'mask',
    label: 'UUID',
    terms: [],
  },
  {
    id: 'r4',
    name: 'Путь в профиле',
    enabled: true,
    kind: 'regex',
    pattern: 'C:\\\\Users\\\\[A-Za-z0-9_.-]+',
    action: 'mask',
    label: 'ПУТЬ',
    terms: [],
  },
];

/** Аргументы `Write`, в которых лежат все четыре вида сразу. */
const SECRETS = {
  email: 'ivanov@example.com',
  ip: '10.1.2.3',
  uuid: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  path: 'C:\\Users\\rusyander',
};

function maskedArguments(): { args: Record<string, unknown>; vault: AliasVault } {
  const vault = new AliasVault();
  const content = `почта ${SECRETS.email}, адрес ${SECRETS.ip}, идентификатор ${SECRETS.uuid}`;
  const masked = maskText(content, RULES, vault);
  const file = maskText(`${SECRETS.path}\\notes.md`, RULES, vault);
  return { args: { file_path: file.text, content: masked.text }, vault };
}

/** Что клиент обязан получить обратно — байт в байт то, что он прислал. */
const ORIGINAL = {
  file_path: `${SECRETS.path}\\notes.md`,
  content: `почта ${SECRETS.email}, адрес ${SECRETS.ip}, идентификатор ${SECRETS.uuid}`,
};

describe('метки защиты данных внутри вызова', () => {
  it('цельный ответ: аргументы возвращаются к клиенту байт в байт', () => {
    const { args, vault } = maskedArguments();

    // Наверх ушли метки, а не значения.
    const sent = JSON.stringify(args);
    for (const secret of Object.values(SECRETS)) expect(sent).not.toContain(secret);
    expect(() => JSON.parse(sent) as unknown).not.toThrow();

    // Разворачивает НАСТОЯЩАЯ граница шлюза, на теле той же формы, какое
    // собирает `collectForClient`.
    const body = restoreJsonResponse(
      {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'Write', arguments: sent } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'openai-compat',
      vault.reverse(),
    ) as {
      choices: { message: { tool_calls: { function: { arguments: string } }[] } }[];
    };

    const restored = body.choices[0]!.message.tool_calls[0]!.function.arguments;
    // Разбирается — то есть путь с обратными косыми не сломал упакованный JSON.
    expect(JSON.parse(restored)).toEqual(ORIGINAL);
  });

  it('поток, диалект Anthropic: `input_json_delta` разбирается после подстановки', () => {
    const { args, vault } = maskedArguments();
    const filter = new ResponseStreamFilter('anthropic', vault.reverse());
    const frame = (payload: unknown): string =>
      `event: content_block_delta\ndata: ${JSON.stringify(payload)}\n\n`;

    const out =
      filter.push(
        frame({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) },
        }),
      ) + filter.end();

    const data = out.split('data: ')[1]?.split('\n')[0] ?? '';
    const event = JSON.parse(data) as { delta: { partial_json: string } };
    expect(JSON.parse(event.delta.partial_json)).toEqual(ORIGINAL);
  });

  it('поток, диалект OpenAI: `tool_calls` тоже разворачивается', () => {
    const { args, vault } = maskedArguments();
    const filter = new ResponseStreamFilter('openai-compat', vault.reverse());

    const out =
      filter.push(
        `data: ${JSON.stringify({
          id: 'c1',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'Write', arguments: JSON.stringify(args) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      ) + filter.end();

    const data = out.split('data: ')[1]?.split('\n')[0] ?? '';
    const event = JSON.parse(data) as {
      choices: { delta: { tool_calls: { function: { arguments: string } }[] } }[];
    };
    const restored = event.choices[0]!.delta.tool_calls[0]!.function.arguments;
    expect(JSON.parse(restored)).toEqual(ORIGINAL);
  });

  /**
   * Весь путь, а не стык (ревью Т5, m15): вызов СОБИРАЕТ прослойка из текста
   * модели (`StreamTranslator`), а метки разворачивает граница шлюза
   * (`ResponseStreamFilter`) — в том порядке, в каком их соединяет конвейер.
   * Кадр вызова здесь не написан руками: его синтезирует сам переводчик.
   */
  it.each(['anthropic', 'openai-compat'] as const)(
    'поток %s: вызов, синтезированный прослойкой, возвращает значения байт в байт',
    (dialect) => {
      const { args, vault } = maskedArguments();
      const translator = new StreamTranslator({
        driver: enterprisePlatformDriver,
        dialect,
        model: 'qwen',
        includeUsage: false,
        shim: { allowed: new Set(['Write']), aliases: vault.reverse() },
      });
      const restore = new ResponseStreamFilter(dialect, vault.reverse());
      const upstream = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
      const content = `<tool_call>${JSON.stringify({ name: 'Write', arguments: args })}</tool_call>`;

      const out =
        restore.push(
          translator.push(
            upstream({
              id: 'c1',
              object: 'chat.completion.chunk',
              model: 'qwen',
              choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
            }) + 'data: [DONE]\n\n',
          ),
        ) +
        restore.push(translator.end()) +
        restore.end();

      expect(translator.facts.toolCalls).toBe(1);
      expect(translator.facts.maskStop).toEqual([]);
      expect(out).not.toMatch(/\[(ПОЧТА|IP|UUID|ПУТЬ)_\d/u);
      const pieces: string[] = [];
      for (const line of out.split('\n')) {
        if (!line.startsWith('data: {')) continue;
        const event = JSON.parse(line.slice('data: '.length)) as {
          delta?: { type?: string; partial_json?: string };
          choices?: { delta?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
        };
        if (event.delta?.type === 'input_json_delta') pieces.push(event.delta.partial_json ?? '');
        for (const call of event.choices?.[0]?.delta?.tool_calls ?? []) {
          pieces.push(call.function?.arguments ?? '');
        }
      }
      expect(JSON.parse(pieces.join(''))).toEqual(ORIGINAL);
    },
  );

  it('выданные метки остановкой не считаются', () => {
    const { args, vault } = maskedArguments();
    expect(strayAliases(args, vault.reverse())).toEqual([]);
  });

  it('искажённая моделью метка останавливает ход', () => {
    const { vault } = maskedArguments();
    // Тот же вид метки, номер, которого панель не выдавала: развернуть нечем, а
    // выполненный вызов записал бы `[ПОЧТА_9]` в файл вместо адреса.
    const stray = strayAliases({ content: 'пишу [ПОЧТА_9]' }, vault.reverse());
    expect(stray).toEqual(['[ПОЧТА_9]']);
  });

  it('чужой текст в квадратных скобках ходу не мешает', () => {
    const { vault } = maskedArguments();
    expect(
      strayAliases({ content: '- [ ] сделать\n[TODO_1] и [ISSUE_42]' }, vault.reverse()),
    ).toEqual([]);
  });

  it('защита выключена — останавливать нечего', () => {
    expect(strayAliases({ content: 'пишу [ПОЧТА_9]' }, new Map())).toEqual([]);
  });

  it('карта контура разворачивается в аргументах на любой глубине', () => {
    const map = new Map([['ИМЯ_1', 'Иванов']]);
    const args = expandContourAliases(
      { content: 'здравствуйте, ИМЯ_1', edits: [{ new_string: 'от ИМЯ_1' }], count: 2 },
      map,
    );
    expect(args).toEqual({
      content: 'здравствуйте, Иванов',
      edits: [{ new_string: 'от Иванов' }],
      count: 2,
    });
  });

  it('карта контура не разворачивается в обратную сторону', () => {
    // Значение уже развёрнуто контуром — второй прогон не смеет замаскировать
    // его обратно: в файл уехала бы метка вместо фамилии.
    const args = expandContourAliases({ content: 'Иванов' }, new Map([['ИМЯ_1', 'Иванов']]));
    expect(args).toEqual({ content: 'Иванов' });
  });
});
