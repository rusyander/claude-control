import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { expectedObservation, probeLayers } from '@agentdeck/contracts/portable-probe';
import type { ProbeLayer, ProbeRow } from '@agentdeck/contracts/portable-probe';
import { claudeProvider } from '../../../providers/claude.ts';
import { getProvider } from '../../../providers/registry.ts';
import {
  PROBE_ENV_NAME,
  PROBE_MARKS,
  probeEnvironment,
  writeProbeScripts,
} from '../probe-canon.ts';
import { startProbeStub } from '../probe-stub.ts';
import { probeRowsFrom, runProbe, runTarget } from './probe.ts';

/**
 * Приёмочная проба: таблица приговоров и ступени отказа (П2.4).
 *
 * Здесь НЕ проверяется, что перенос доезжает до настоящего CLI, — это делает
 * `tools/qa/check-portability-probe.mjs` на поддельном CLI, прогоняя всю дорогу
 * целиком. Юниты держат ровно то, что обязано уметь краснеть без единого чужого
 * бинаря на машине: решение «обещано против проверено» и правило «зелёного по
 * умолчанию не бывает».
 */

/** Один слой из шести — по имени, а не по месту в массиве. */
function row(rows: readonly ProbeRow[], layer: ProbeLayer): ProbeRow {
  const found = rows.find((candidate) => candidate.layer === layer);
  if (!found) throw new Error(`в отчёте пробы нет строки слоя «${layer}»`);
  return found;
}

/**
 * Разговор идеально сработавшего переноса: всё условленное доехало, ничего
 * запрещённого не выполнилось.
 */
function goodTranscript(): Record<string, unknown>[] {
  return [
    {
      system: `Доступные скиллы: agentdeck-probe — ${PROBE_MARKS.skill}`,
      tools: [{ name: `mcp__agentdeck-probe__${PROBE_MARKS.mcpTool}` }, { name: 'Bash' }],
      messages: [{ role: 'user', content: `Ответь словом ${PROBE_MARKS.command}` }],
    },
    {
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'probe_forbidden', content: 'operation blocked' },
            {
              type: 'tool_result',
              tool_use_id: 'probe_env',
              content: `${PROBE_MARKS.envEcho}${PROBE_MARKS.env}`,
            },
            { type: 'tool_result', tool_use_id: 'probe_denied', content: 'permission denied' },
          ],
        },
      ],
    },
  ];
}

describe('пробная среда', () => {
  it('несёт ровно по одной записи на слой, и у каждой — условленное слово', () => {
    const env = probeEnvironment({
      source: 'agentdeck-probe',
      scope: 'global',
      root: '/tmp/probe',
      scripts: {
        hookPath: '/tmp/probe/hook.mjs',
        mcpPath: '/tmp/probe/mcp.mjs',
        skillDir: '/tmp',
        forbiddenPath: '/tmp/probe/forbidden.mjs',
        envPath: '/tmp/probe/env.mjs',
        mcpAskedPath: '/tmp/probe/mcp-asked.txt',
      },
      capturedAt: '2026-09-20T00:00:00.000Z',
    });

    expect(env.items.map((item) => item.kind).sort()).toEqual([...probeLayers].sort());
    // Слово скилла обязано лежать в теле — именно его ищут в запросе к модели.
    const skill = env.items.find((item) => item.kind === 'skill');
    expect(JSON.stringify(skill)).toContain(PROBE_MARKS.skill);
    const variable = env.items.find((item) => item.kind === 'envVar');
    expect(JSON.stringify(variable)).toContain(PROBE_ENV_NAME);
  });
});

describe('чего ждать от уровня', () => {
  it('блокирующий слой на «нативно» обязан ОСТАНОВИТЬ, остальные — лишь доехать', () => {
    expect(expectedObservation('hook', 'native')).toBe('enforced');
    expect(expectedObservation('permission', 'native')).toBe('enforced');
    expect(expectedObservation('skill', 'native')).toBe('present');
    expect(expectedObservation('envVar', 'native')).toBe('present');
  });

  it('«текстом» — доехало, «невозможно» — не доехало и это верный исход', () => {
    expect(expectedObservation('hook', 'text')).toBe('present');
    expect(expectedObservation('permission', 'impossible')).toBe('absent');
  });

  it('«эмуляцию» и «провод» проба не меряет вовсе', () => {
    expect(expectedObservation('hook', 'emulated')).toBeNull();
    expect(expectedObservation('mcpServer', 'wired')).toBeNull();
  });
});

describe('приговоры по разговору с заглушкой', () => {
  it('сработавший перенос даёт шесть совпадений', () => {
    const rows = probeRowsFrom(goodTranscript(), claudeProvider, 'global');

    expect(rows).toHaveLength(6);
    expect(rows.every((candidate) => candidate.verdict === 'match')).toBe(true);
    expect(row(rows, 'hook').observed).toBe('enforced');
    expect(row(rows, 'permission').observed).toBe('enforced');
    expect(row(rows, 'skill').observed).toBe('present');
  });

  it('хук не доехал — красным становится ОН, и только он', () => {
    const transcript = goodTranscript();
    // Запрещённый вызов отработал: его вывод вернулся ответом инструмента.
    transcript[1] = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', content: PROBE_MARKS.forbiddenRan },
            { type: 'tool_result', content: `${PROBE_MARKS.envEcho}${PROBE_MARKS.env}` },
            { type: 'tool_result', content: 'permission denied' },
          ],
        },
      ],
    };

    const rows = probeRowsFrom(transcript, claudeProvider, 'global');
    expect(row(rows, 'hook').verdict).toBe('mismatch');
    expect(row(rows, 'hook').observed).toBe('absent');
    expect(rows.filter((candidate) => candidate.verdict === 'mismatch')).toHaveLength(1);
  });

  it('право не доехало — вернулось содержимое запрещённого файла', () => {
    const transcript = goodTranscript();
    transcript[1] = {
      messages: [
        { role: 'user', content: [{ type: 'tool_result', content: PROBE_MARKS.deniedContent }] },
      ],
    };

    const rows = probeRowsFrom(transcript, claudeProvider, 'global');
    expect(row(rows, 'permission').verdict).toBe('mismatch');
    expect(row(rows, 'envVar').verdict).toBe('mismatch');
  });

  it('переменная не доехала — приставка пришла без значения', () => {
    const transcript = goodTranscript();
    transcript[1] = {
      messages: [
        { role: 'user', content: [{ type: 'tool_result', content: PROBE_MARKS.envEcho }] },
      ],
    };

    const rows = probeRowsFrom(transcript, claudeProvider, 'global');
    expect(row(rows, 'envVar').verdict).toBe('mismatch');
    expect(row(rows, 'envVar').observed).toBe('absent');
  });

  it('скилл, MCP и команда судятся по ПЕРВОМУ запросу, а не по ответам инструментов', () => {
    const transcript = goodTranscript();
    transcript[0] = { system: 'пусто', tools: [], messages: [{ role: 'user', content: 'привет' }] };

    const rows = probeRowsFrom(transcript, claudeProvider, 'global');
    expect(row(rows, 'skill').verdict).toBe('mismatch');
    expect(row(rows, 'mcpServer').verdict).toBe('mismatch');
    expect(row(rows, 'command').verdict).toBe('mismatch');
    // А блокирующие слои по-прежнему судятся по ответам — они не пострадали.
    expect(row(rows, 'hook').verdict).toBe('match');
  });

  it('до инструментов дело не дошло — три слоя «не проверены», а не зелены', () => {
    const rows = probeRowsFrom([goodTranscript()[0] ?? {}], claudeProvider, 'global');

    for (const layer of ['hook', 'permission', 'envVar'] as const) {
      expect(row(rows, layer).verdict).toBe('not_checked');
      expect(row(rows, layer).skip).toBe('run_failed');
      expect(row(rows, layer).observed).toBe('unknown');
    }
    expect(row(rows, 'skill').verdict).toBe('match');
  });
});

/**
 * Тот же сработавший перенос, но у цели с ручкой `/responses`: реплики лежат в
 * `input`, а не в `messages`. Форма снята живым прогоном `codex-cli 0.155.1`
 * 22.09.2026 — выдумывать её нельзя, иначе тест проверял бы выдумку.
 */
function codexTranscript(): Record<string, unknown>[] {
  return [
    {
      instructions: `## Право: запрещено \`Read(${PROBE_MARKS.deniedFile})\``,
      tools: [],
      input: [
        // Скилл у Codex с MAP 26 нативный: CLI называет модели имя и описание
        // скилла, а описание несёт метку. Где именно — проба не различает: она
        // ищет метку во всём первом запросе.
        { type: 'message', role: 'developer', content: `- agentdeck-probe: ${PROBE_MARKS.skill}` },
        { type: 'message', role: 'user', content: 'проба' },
      ],
    },
    {
      input: [
        // Запрещённый вызов ОТРАБОТАЛ: хук у этой цели обещан «невозможно», и
        // останавливать его нечему — это верный исход, а не провал.
        {
          type: 'function_call_output',
          call_id: 'probe_forbidden',
          output: PROBE_MARKS.forbiddenRan,
        },
        {
          type: 'function_call_output',
          call_id: 'probe_env',
          output: `${PROBE_MARKS.envEcho}${PROBE_MARKS.env}`,
        },
        {
          type: 'function_call_output',
          call_id: 'probe_denied',
          output: PROBE_MARKS.deniedContent,
        },
      ],
    },
  ];
}

describe('цель с ручкой /responses', () => {
  it('реплики берутся по ИМЕНИ поля — иначе ответы инструментов не находятся вовсе', () => {
    const rows = probeRowsFrom(codexTranscript(), getProvider('codex'), 'global');

    // Эхо переменной лежит в ответе инструмента (`function_call_output`). Читай
    // наблюдение только `messages`, оно бы его не нашло — и переменная, которая
    // доехала, объявлялась бы потерянной.
    expect(row(rows, 'envVar').observed).toBe('present');
    expect(row(rows, 'envVar').verdict).toBe('match');
  });

  it('хук Codex обещан при одобрении в /hooks — проба его не меряет, а не красит', () => {
    // Запрещённый вызов отработал: одобрения нет, и хук честно не исполнился.
    // Красный здесь обвинил бы перенос, зелёный — обещал бы непроверенное.
    const rows = probeRowsFrom(codexTranscript(), getProvider('codex'), 'global');
    expect(row(rows, 'hook').promised).toBe('native');
    expect(row(rows, 'hook').verdict).toBe('not_checked');
    expect(row(rows, 'hook').skip).toBe('needs_cli_approval');
  });

  it('личный скилл Codex на Windows берётся из НАСТОЯЩЕГО дома — проба его не судит', () => {
    // Скилл в разговоре есть, но доказать, что он из временного дома, нельзя:
    // codex читает `~/.agents/skills` через профиль ОС мимо HOME/USERPROFILE.
    const global = probeRowsFrom(codexTranscript(), getProvider('codex'), 'global');
    const project = probeRowsFrom(codexTranscript(), getProvider('codex'), 'project');
    if (process.platform === 'win32') {
      expect(row(global, 'skill').verdict).toBe('not_checked');
      expect(row(global, 'skill').skip).toBe('target_reads_real_home');
    } else {
      expect(row(global, 'skill').verdict).toBe('match');
    }
    // Проектный `.agents/skills` лежит в рабочем каталоге пробы — судится всегда.
    expect(row(project, 'skill').skip).toBeNull();
    expect(row(project, 'skill').verdict).toBe('match');
  });

  it('право, обещанное ТЕКСТОМ, судится присутствием запрета, а не отказом', () => {
    // Содержимое запрещённого файла в ответах ЕСТЬ: на этом уровне панель
    // ничего не принуждает и не обещала принуждать.
    const rows = probeRowsFrom(codexTranscript(), getProvider('codex'), 'global');

    expect(row(rows, 'permission').promised).toBe('text');
    expect(row(rows, 'permission').observed).toBe('present');
    expect(row(rows, 'permission').verdict).toBe('match');
  });

  it('запрет НЕ доехал словами — краснеет право, и только оно', () => {
    const transcript = codexTranscript();
    // Ровно то, что делал перенос до 22.09.2026: до цели ехал пересказ
    // намерения, в котором нет ни имени файла, ни слова «запрещено».
    transcript[0] = {
      instructions: '## Проба: право обязано отказать в чтении условленного файла.',
      tools: [],
      input: [
        { type: 'message', role: 'developer', content: `- agentdeck-probe: ${PROBE_MARKS.skill}` },
        { type: 'message', role: 'user', content: 'проба' },
      ],
    };

    const rows = probeRowsFrom(transcript, getProvider('codex'), 'global', true);
    expect(row(rows, 'permission').verdict).toBe('mismatch');
    expect(row(rows, 'permission').observed).toBe('absent');
    expect(rows.filter((candidate) => candidate.verdict === 'mismatch')).toHaveLength(1);
  });
});

describe('MCP-сервер: «не назвали» против «не доехал»', () => {
  it('сервер СПРОСИЛИ, а модели не назвали — не проверено, а не красный', () => {
    const rows = probeRowsFrom(codexTranscript(), getProvider('codex'), 'global', true);

    expect(row(rows, 'mcpServer').verdict).toBe('not_checked');
    expect(row(rows, 'mcpServer').skip).toBe('target_defers_tools');
  });

  it('сервера никто не спрашивал — это непереехавшая запись, и она красная', () => {
    const rows = probeRowsFrom(codexTranscript(), getProvider('codex'), 'global', false);

    expect(row(rows, 'mcpServer').observed).toBe('absent');
    expect(row(rows, 'mcpServer').verdict).toBe('mismatch');
  });

  it('имя инструмента в списке у модели сильнее обоих — это совпадение', () => {
    const transcript = codexTranscript();
    transcript[0] = {
      ...transcript[0],
      tools: [{ type: 'namespace', name: `mcp__${PROBE_MARKS.mcpTool}` }],
    };

    const rows = probeRowsFrom(transcript, getProvider('codex'), 'global', true);
    expect(row(rows, 'mcpServer').observed).toBe('present');
    expect(row(rows, 'mcpServer').verdict).toBe('match');
  });

  /**
   * Настоящий скрипт пробного сервера, настоящим node, тем порядком, каким его
   * поднимает Goose 1.54: сперва `server/discover`. Пустой `result` на него
   * Goose принимал за ответ и бросал сервер до `initialize` (живая проба
   * 09.10.2026), и MCP «не доезжал» там, где доехал.
   */
  it('незнакомый метод — ошибка «Method not found», после неё сервер поднимается', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-mcp-'));
    try {
      const { mcpPath, mcpAskedPath } = writeProbeScripts(dir);
      const child = spawn(process.execPath, [mcpPath], { stdio: ['pipe', 'pipe', 'inherit'] });
      const lines: Record<string, unknown>[] = [];
      let buffer = '';
      const got = new Promise<void>((done) => {
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let at;
          while ((at = buffer.indexOf('\n')) >= 0) {
            lines.push(JSON.parse(buffer.slice(0, at)) as Record<string, unknown>);
            buffer = buffer.slice(at + 1);
          }
          if (lines.length >= 3) done();
        });
      });
      const ask = (id: number, method: string): void => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })}\n`);
      };
      ask(0, 'server/discover');
      ask(1, 'initialize');
      ask(2, 'tools/list');
      await got;
      child.kill();

      expect(lines[0]).toMatchObject({ id: 0, error: { code: -32601 } });
      expect(lines[0]).not.toHaveProperty('result');
      expect(lines[1]).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } });
      expect(JSON.stringify(lines[2])).toContain(PROBE_MARKS.mcpTool);
      expect(readdirSync(dir)).toContain(basename(mcpAskedPath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('заглушка вместо модели', () => {
  it('служебный запрос без реплик НЕ считается ходом разговора', async () => {
    // Дефект, найденный живым прогоном 20.09.2026 (claude 2.1.263): CLI перед
    // разговором дёргает `HEAD /api/hello`, тот вставал нулевым ходом, и весь
    // сценарий съезжал на шаг. Отчёт тогда показал не только четыре
    // расхождения, но и ДВА ЗЕЛЁНЫХ — наблюдение по негативу подтверждало
    // работу хука и права ровно потому, что вызовов не делали вовсе.
    const seen: number[] = [];
    const stub = await startProbeStub((turn) => {
      seen.push(turn);
      return [{ type: 'text', text: `ход ${turn}` }];
    });

    try {
      await fetch(`${stub.baseUrl}/api/hello`, { method: 'HEAD' });
      await fetch(`${stub.baseUrl}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'probe', system: 'x' }),
      });
      await fetch(`${stub.baseUrl}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({
          model: 'probe',
          tools: [{ name: 'Bash' }],
          messages: [{ role: 'user', content: 'привет' }],
        }),
      });

      // Настоящая первая реплика обязана получить ход НОЛЬ, а не второй.
      expect(seen).toEqual([0]);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]?.messages).toBeDefined();
    } finally {
      await stub.close();
    }
  });

  it('запрос БЕЗ инструментов (подпись сессии) — тоже не ход', async () => {
    // Живая проба 09.10.2026 (opencode 1.18.35): подпись сессии малой моделью
    // встала нулевым ходом, вызовы ушли в неё и не исполнились — и право по
    // негативу вышло зелёным без единого вызова.
    const seen: number[] = [];
    const stub = await startProbeStub((turn) => {
      seen.push(turn);
      return [{ type: 'text', text: `ход ${turn}` }];
    });
    const chat = (body: Record<string, unknown>) =>
      fetch(`${stub.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify(body) });

    try {
      const title = await chat({ messages: [{ role: 'user', content: 'назови сессию' }] });
      expect(((await title.json()) as { choices: unknown[] }).choices).toHaveLength(1);
      await chat({
        messages: [{ role: 'user', content: 'привет' }],
        tools: [{ type: 'function', function: { name: 'bash' } }],
      });

      expect(seen).toEqual([0]);
      expect(stub.requests).toHaveLength(1);
    } finally {
      await stub.close();
    }
  });

  it('/chat/completions: вызовы — `tool_calls` строкой аргументов и конец `tool_calls`', async () => {
    const stub = await startProbeStub(() => [
      { type: 'tool_use', id: 'probe_a', name: 'bash', input: { command: 'node a.js' } },
      { type: 'tool_use', id: 'probe_b', name: 'read', input: { filePath: 'x' } },
    ]);
    const body = {
      messages: [{ role: 'user', content: 'привет' }],
      tools: [{ type: 'function', function: { name: 'bash' } }],
    };
    try {
      const whole = (await (
        await fetch(`${stub.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      ).json()) as {
        choices: {
          finish_reason: string;
          message: { tool_calls: { id: string; function: { arguments: string } }[] };
        }[];
      };
      expect(whole.choices[0]?.finish_reason).toBe('tool_calls');
      expect(whole.choices[0]?.message.tool_calls.map((call) => call.id)).toEqual([
        'probe_a',
        'probe_b',
      ]);
      expect(JSON.parse(whole.choices[0]?.message.tool_calls[0]?.function.arguments ?? '')).toEqual(
        { command: 'node a.js' },
      );

      const streamed = await (
        await fetch(`${stub.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          body: JSON.stringify({ ...body, stream: true }),
        })
      ).text();
      const chunks = streamed
        .split('\n\n')
        .filter((frame) => frame.startsWith('data: {'))
        .map((frame) => JSON.parse(frame.slice(6)) as { choices: Record<string, unknown>[] });
      const calls = chunks.flatMap(
        (chunk) =>
          (chunk.choices[0]?.delta as { tool_calls?: { id: string; index: number }[] })
            ?.tool_calls ?? [],
      );
      expect(calls.map((call) => [call.index, call.id])).toEqual([
        [0, 'probe_a'],
        [1, 'probe_b'],
      ]);
      expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('tool_calls');
      expect(streamed.trimEnd().endsWith('data: [DONE]')).toBe(true);
      // Тот же `messages`, что у Anthropic, — но ответ НЕ в диалекте Anthropic.
      expect(streamed).not.toContain('message_start');
    } finally {
      await stub.close();
    }
  });

  it('Gemini (`contents`): вызов — часть `functionCall` объектом; счёт токенов и подпись — не ход', async () => {
    // Живая проба 10.10.2026 (gemini 0.63.0): поток просится хвостом
    // `?alt=sse`, а без диалекта заглушка отвечала `{ok:true}` — ноль ходов.
    const seen: number[] = [];
    const stub = await startProbeStub((turn) => {
      seen.push(turn);
      return [{ type: 'tool_use', id: 'probe_a', name: 'read_file', input: { file_path: 'x' } }];
    });
    const model = `${stub.baseUrl}/v1beta/models/probe`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'привет' }] }],
      tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
    };
    try {
      const counted = await fetch(`${model}:countTokens`, {
        method: 'POST',
        body: JSON.stringify({ contents: body.contents }),
      });
      expect(await counted.json()).toEqual({ totalTokens: 1 });
      await fetch(`${model}:generateContent`, {
        method: 'POST',
        body: JSON.stringify({ contents: body.contents }),
      });

      const streamed = await (
        await fetch(`${model}:streamGenerateContent?alt=sse`, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      ).text();
      expect(streamed.startsWith('data: {')).toBe(true);
      const chunk = JSON.parse(streamed.slice(6)) as {
        candidates: { content: { parts: { functionCall?: { name: string; args: unknown } }[] } }[];
      };
      expect(chunk.candidates[0]?.content.parts[0]?.functionCall).toEqual({
        id: 'probe_a',
        name: 'read_file',
        args: { file_path: 'x' },
      });

      expect(seen).toEqual([0]);
      expect(stub.requests).toHaveLength(1);
    } finally {
      await stub.close();
    }
  });
});

describe('ступени отказа', () => {
  it('цель без рецепта пробы — шесть строк «не проверено» с причиной', async () => {
    const report = await runProbe({ target: getProvider('cursor'), scope: 'global' });

    expect(report.rows).toHaveLength(6);
    expect(report.summary).toEqual({ match: 0, mismatch: 0, notChecked: 6 });
    expect(report.rows.every((candidate) => candidate.skip === 'no_probe_recipe')).toBe(true);
  });

  it('обещанный уровень называет причину РАНЬШЕ отсутствия рецепта', async () => {
    // Порядок причин не косметика: «эмуляцию мерит надзиратель рантайма» —
    // ответ про саму запись и останется верным, когда рецепт появится, а
    // «рецепта нет» через тикет П3 исчезнет. Показать второе вместо первого
    // значило бы обещать измерение, которого не будет.
    const report = await runProbe({ target: getProvider('aider'), scope: 'global' });
    const skips = new Map(report.rows.map((candidate) => [candidate.layer, candidate.skip]));
    const promised = new Map(report.rows.map((candidate) => [candidate.layer, candidate.promised]));

    expect(skips.get('skill')).toBe('needs_panel_runtime');
    expect(skips.get('mcpServer')).toBe('no_probe_recipe');
    // Ступень `needs_wire` СЕГОДНЯ недостижима, и это не потеря проверки, а её
    // следствие: пока панель не открывает ворота на пути запроса, уровень
    // «проводом» не обещается никому (`wire/tool-gate.ts`), и хук уезжает
    // «невозможно» — причина у строки становится своя, про рецепт.
    expect(promised.get('hook')).toBe('impossible');
    expect(skips.get('hook')).toBe('no_probe_recipe');
    expect(report.summary.notChecked).toBe(6);
  });

  // У codex адрес модели переменной окружения не задаётся вовсе: он живёт
  // таблицей в его собственном `config.toml`. Пока проба умела только
  // переменные, эта цель отказывалась ступенью `no_stub_endpoint` — то есть
  // была непроверяема при полностью задокументированном способе. Continue —
  // список моделей своего `config.yaml`, OpenCode — окружение одного прогона
  // (`runEndpoint`): оба пути добавлены живой пробой 09.10.2026.
  it.each(['codex', 'continue', 'opencode', 'goose'])(
    'адрес заглушки не в переменной цели — не повод отказаться: %s',
    async (id) => {
      const report = await runProbe({
        target: getProvider(id),
        scope: 'global',
        cliOverride: [process.execPath, '-e', 'process.exit(0)'],
        timeoutMs: 20_000,
      });

      expect(report.rows.every((candidate) => candidate.skip !== 'no_stub_endpoint')).toBe(true);
      expect(report.rows.some((candidate) => candidate.skip === 'run_failed')).toBe(true);
    },
  );

  it('цель не дошла до модели — «не проверено», и после прогона не остаётся каталогов', async () => {
    const before = probeDirs();
    const report = await runProbe({
      target: claudeProvider,
      scope: 'global',
      // Подделка выходит немедленно и заглушке не звонит: это ровно тот случай,
      // в котором «ничего не наблюдали» нельзя читать как «перенос провалился».
      cliOverride: [process.execPath, '-e', 'process.exit(0)'],
      timeoutMs: 20_000,
    });

    expect(report.cliInstalled).toBe(true);
    expect(report.summary.notChecked).toBe(6);
    expect(report.rows.every((candidate) => candidate.skip === 'run_failed')).toBe(true);
    expect(probeDirs()).toEqual(before);
  });
});

/** Временные дома пробы, оставшиеся в системном каталоге. Их быть не должно. */
function probeDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('agentdeck-probe-'));
}

/**
 * Живая проба 09.10.2026 (cn 1.5.47): через оболочку Node склеивал argv без
 * кавычек, запрос «agentdeck probe» доходил двумя словами, и `cn` молча
 * выходил с кодом 1 — ни одного запроса, шесть «не проверено». Настоящая
 * .cmd-обёртка и настоящий cmd.exe: подделка без оболочки дефекта не видит.
 */
describe.skipIf(process.platform !== 'win32')('запуск .cmd-обёртки через оболочку', () => {
  it('аргумент с пробелом и кавычкой доходит одним аргументом', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdeck-probe-argv-'));
    try {
      const wrapper = join(dir, 'echo-argv.cmd');
      writeFileSync(
        wrapper,
        `@"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*
`,
      );
      const run = await runTarget({
        command: wrapper,
        args: ['-p', 'agentdeck probe', 'a "b" & c'],
        cwd: dir,
        env: {},
        timeoutMs: 20_000,
        shell: true,
      });
      expect(JSON.parse(run.stdout.trim())).toEqual(['-p', 'agentdeck probe', 'a "b" & c']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Живая проба 10.10.2026: codex-cli 0.160 под `cmd.exe` не уложился в срок, а
  // снятие убило только оболочку — CLI и его `git fetch` держали трубы, `close`
  // не пришёл, и запрос пробы висел, пока его не оборвал клиент.
  it('по сроку снимается всё дерево, и ответ приходит, хотя внук держал трубы', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdeck-probe-tree-'));
    const pidFile = join(dir, 'grandchild.pid');
    try {
      const grandchild = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 120000)`;
      const child = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' }); setTimeout(() => {}, 120000)`;
      writeFileSync(join(dir, 'child.js'), child, 'utf8');
      const wrapper = join(dir, 'hold-pipes.cmd');
      writeFileSync(wrapper, `@"${process.execPath}" "${join(dir, 'child.js')}"\r\n`);

      const started = Date.now();
      const run = await runTarget({
        command: wrapper,
        args: [],
        cwd: dir,
        env: {},
        timeoutMs: 3_000,
        shell: true,
      });

      expect(run.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(15_000);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      const alive = (() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })();
      if (alive) process.kill(pid);
      expect(alive).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  }, 30_000);
});
