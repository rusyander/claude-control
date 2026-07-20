import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readDecision,
  scriptCommand,
  runHookProbe,
  tryParse,
  EVENT_FIXTURES,
  type EventFixture,
} from './HookProbe.ts';

/**
 * Тесты разбора решения хука. Стенд обязан понимать оба способа, которыми
 * хук сообщает вердикт: старый (код выхода 2) и новый (JSON с
 * permissionDecision). Аудит нашёл, что вторая ветка работала не сразу, —
 * поэтому она закреплена тестами.
 */
describe('HookProbe.readDecision', () => {
  it('код выхода 2 — это блокировка', () => {
    expect(readDecision(2, undefined).decision).toBe('block');
  });

  it('permissionDecision "deny" — блокировка', () => {
    const parsed = { hookSpecificOutput: { permissionDecision: 'deny' } };
    expect(readDecision(0, parsed).decision).toBe('block');
  });

  it('permissionDecision "ask" — запрос подтверждения', () => {
    const parsed = { hookSpecificOutput: { permissionDecision: 'ask' } };
    expect(readDecision(0, parsed).decision).toBe('ask');
  });

  it('permissionDecision "allow" — пропуск', () => {
    const parsed = { hookSpecificOutput: { permissionDecision: 'allow' } };
    expect(readDecision(0, parsed).decision).toBe('pass');
  });

  it('пустой ответ и код 0 — пропуск', () => {
    expect(readDecision(0, undefined).decision).toBe('pass');
  });

  it('continue:false — блокировка со stopReason', () => {
    const result = readDecision(0, { continue: false, stopReason: 'нельзя' });
    expect(result.decision).toBe('block');
    expect(result.reason).toBe('нельзя');
  });

  it('переносит пояснение и добавленный контекст', () => {
    const parsed = {
      hookSpecificOutput: {
        permissionDecision: 'ask',
        permissionDecisionReason: 'опасно',
        additionalContext: 'подсказка',
      },
    };
    const result = readDecision(0, parsed);
    expect(result.reason).toBe('опасно');
    expect(result.addedContext).toBe('подсказка');
  });
});

/**
 * Разбор вердикта-JSON из вывода хука. Хук волен печатать логи вокруг JSON —
 * прежний слепой срез «от первого { до последнего }» ломался о скобки в логах.
 * Разбор должен доставать вердикт и в этом случае, не ломая простые заготовки.
 */
describe('HookProbe.tryParse', () => {
  it('весь вывод — компактный JSON', () => {
    expect(tryParse('{"decision":"deny"}')).toEqual({ decision: 'deny' });
  });

  it('весь вывод — JSON с отступами в несколько строк', () => {
    const pretty = '{\n  "hookSpecificOutput": {\n    "permissionDecision": "ask"\n  }\n}';
    expect(tryParse(pretty)).toEqual({ hookSpecificOutput: { permissionDecision: 'ask' } });
  });

  it('пустой вывод — undefined (хук ничего не сказал)', () => {
    expect(tryParse('')).toBeUndefined();
    expect(tryParse('   \n  ')).toBeUndefined();
  });

  it('строка-JSON среди логов, где в логах есть фигурные скобки', () => {
    // Прежний срез от первого `{` (внутри `{id: 42}`) до последнего `}` захватил
    // бы мусор и не распарсился — вердикт бы потерялся.
    const output = [
      'processing tool call {id: 42}',
      '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"низзя"}}',
      'done in {12}ms',
    ].join('\n');

    expect(tryParse(output)).toEqual({
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'низзя' },
    });
  });

  it('несколько JSON-строк — берётся последняя (итоговый вердикт печатается в конце)', () => {
    const output = '{"decision":"allow"}\n{"decision":"deny"}';
    expect(tryParse(output)).toEqual({ decision: 'deny' });
  });

  it('логи без JSON — undefined, а не мусор', () => {
    expect(tryParse('starting\nworking\ndone')).toBeUndefined();
  });

  it('разобранный вердикт доезжает до readDecision', () => {
    const output = 'log line\n{"hookSpecificOutput":{"permissionDecision":"ask"}}\ntrailing log';
    expect(readDecision(0, tryParse(output)).decision).toBe('ask');
  });
});

describe('HookProbe.scriptCommand', () => {
  it('несуществующий файл — пустая команда', () => {
    expect(scriptCommand('C:/nope/missing.mjs')).toBe('');
  });
});

describe('EVENT_FIXTURES', () => {
  it('каждая заготовка несёт имя события в payload', () => {
    for (const fixture of EVENT_FIXTURES) {
      expect(fixture.payload.hook_event_name).toBe(fixture.event);
    }
  });

  it('есть заготовки и на срабатывание, и на пропуск', () => {
    expect(EVENT_FIXTURES.some((f) => f.expectsBlock)).toBe(true);
    expect(EVENT_FIXTURES.some((f) => !f.expectsBlock)).toBe(true);
  });
});

/**
 * Прогон настоящего процесса хука. Здесь важна не столько логика, сколько
 * живучесть: стенд запускает чужие программы, и их поведение непредсказуемо.
 */
describe('HookProbe.runHookProbe', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-hookprobe-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const bigFixture = (payload: Record<string, unknown>): EventFixture => ({
    id: 'custom',
    event: 'PreToolUse',
    title: 'проба',
    description: 'проба',
    expectsBlock: false,
    payload,
  });

  it('хук, который не читает stdin и сразу выходит, не роняет сервер', async () => {
    // Регрессия: раньше запись большого payload в закрытый stdin выбрасывала
    // необработанный `error` (EPIPE/EOF) и валила весь процесс сервера. Хук,
    // игнорирующий ввод, — обычное дело (SessionStart, Stop). Полезная нагрузка
    // намеренно большая, чтобы переполнить буфер канала и добить до ошибки.
    const script = join(dir, 'ignore-stdin.mjs');
    writeFileSync(script, 'process.stdin.destroy(); setTimeout(() => process.exit(0), 150);\n');

    const payload = { hook_event_name: 'PreToolUse', blob: 'y'.repeat(2_000_000) };

    // Сам факт того, что промис штатно разрешился, а не уронил воркер, —
    // и есть проверка: до фикса этот тест не доживал до assert'ов.
    const result = await runHookProbe(`node "${script}"`, bigFixture(payload), dir);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('несуществующая команда — ненулевой код и decision pass, без падения', async () => {
    // Через shell:true пропавшую команду сообщает сама оболочка ненулевым кодом
    // (1 в cmd, 127 в sh), а не событие error процесса. Блокировкой это не
    // считается — код не равен 2, JSON нет, поэтому pass.
    const result = await runHookProbe(
      'нет-такой-команды-xyzzy',
      bigFixture({ hook_event_name: 'PreToolUse' }),
      dir,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.decision).toBe('pass');
  });

  it('хук с кодом выхода 2 распознаётся как блокировка', async () => {
    const script = join(dir, 'exit2.mjs');
    writeFileSync(script, 'process.exit(2);\n');

    const result = await runHookProbe(
      `node "${script}"`,
      bigFixture({ hook_event_name: 'PreToolUse' }),
      dir,
    );
    expect(result.exitCode).toBe(2);
    expect(result.decision).toBe('block');
  });

  it('хук возвращает permissionDecision в JSON — разбирается из stdout', async () => {
    const script = join(dir, 'deny.mjs');
    writeFileSync(
      script,
      'process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "низзя" } }));\n',
    );

    const result = await runHookProbe(
      `node "${script}"`,
      bigFixture({ hook_event_name: 'PreToolUse' }),
      dir,
    );
    expect(result.decision).toBe('block');
    expect(result.reason).toBe('низзя');
  });
});
