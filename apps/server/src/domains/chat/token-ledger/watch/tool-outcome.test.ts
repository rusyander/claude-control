import { describe, expect, it } from 'vitest';
import { outsideCopyDenial } from '../../ChatBranchGate/ChatBranchGate.ts';
import { MAIN_SYNC_DENIED, MAIN_SYNC_UNKNOWN } from '../../main-sync/main-sync.ts';
import {
  alreadyQueuedDenial,
  deferralDenial,
  groupMainCopyRefusal,
  humanRefusedDenial,
  keepDraftRefusal,
  mergeRefusal,
  mrMentionRefusal,
  selfApprovalRefusal,
} from '../../deferred-asks/deferred-asks.ts';
import { guardLabel, OUTSIDE_COPY_PREFIX, toolOutcome } from './tool-outcome.ts';
import { createTranscriptReader } from './transcript-events.ts';

/**
 * Итог вызова (R15, R18): одна функция на транскрипт и поток. Тексты — формы,
 * которые пишет сам CLI (транскрипты групп 29.09–20.10 и поток 2.1.286).
 */
describe('toolOutcome', () => {
  it('имя стража: `[метка] имя(...)`, имя с двоеточием, русская фраза', () => {
    expect(
      guardLabel('PreToolUse:Bash hook error: [ctx-guard] push-sieves(foreign-removal) `git push`'),
    ).toBe('push-sieves');
    expect(
      guardLabel('PreToolUse:Bash hook error: [ctx-guard] inline-edit-guard: a shell write'),
    ).toBe('inline-edit-guard');
    expect(guardLabel('PreToolUse:Bash hook error: Отправка закрыта: какой чекаут уезжает')).toBe(
      'Отправка закрыта',
    );
    expect(
      guardLabel('PreToolUse:mcp__forge__jobs hook error: [ctx-guard] pipeline-watch A pipeline'),
    ).toBe('pipeline-watch');
  });

  it('отказ — только ошибка; автовыбор и «нет вердикта» — не стена', () => {
    const text = 'PreToolUse:Bash hook error: [g] destructive-guard(rm) deletes';
    expect(toolOutcome({ is_error: true, content: text })).toEqual({ denied: 'destructive-guard' });
    expect(toolOutcome({ is_error: false, content: text })).toEqual({});
    expect(
      toolOutcome({
        is_error: true,
        content: 'PreToolUse:AskUserQuestion hook error: autonomous-pick chose A',
      }),
    ).toEqual({});
    expect(
      toolOutcome({ is_error: true, content: 'Auto mode: no verdict, asking the user' }),
    ).toEqual({});
    expect(
      toolOutcome({ is_error: true, content: 'Permission for this action was denied by the user' }),
    ).toEqual({ denied: 'permission' });
    // Обычная ошибка команды — не отказ, а ошибка своего рода.
    expect(toolOutcome({ is_error: true, content: 'Exit code 1\nnpm ERR!' })).toEqual({
      isError: true,
      errorKind: 'exit',
      errorHead: 'npm ERR!',
    });
  });

  it('род ошибки: код выхода, нет инструмента, сеть только в голове ответа, размер (R24, R29, R30)', () => {
    const kind = (content: string) => toolOutcome({ is_error: true, content }).errorKind;
    expect(kind('Exit code 2\nsrc/a.ts(3,1): error TS2304')).toBe('exit');
    expect(
      kind('<tool_use_error>No such tool available: mcp__forge__create_mr</tool_use_error>'),
    ).toBe('no-tool');
    // Так пишет настоящий CLI 2.1.x (транскрипт 23.10): «Error:» после обёртки.
    expect(
      kind(
        "<tool_use_error>Error: No such tool available: mcp__forge__create_mr. Its MCP server 'forge' is connected but does not offer this tool here.</tool_use_error>",
      ),
    ).toBe('no-tool');
    expect(kind('TypeError: fetch failed\n  cause: UND_ERR_SOCKET other side closed')).toBe(
      'network',
    );
    expect(kind('MCP error -32001: Connection lost mid-response')).toBe('network');
    expect(kind('Error: 503 Service Unavailable')).toBe('network');
    // «502» глубоко в выводе упавших тестов — не сбой связи.
    expect(kind(`Exit code 1\n${'x'.repeat(500)}\n502 Bad Gateway in a fixture`)).toBe('exit');
    expect(kind('File content (42000 tokens) exceeds maximum allowed tokens (25000)')).toBe('size');
    expect(kind('something odd')).toBe('other');
  });

  it('голова ошибки: без обёрток, цифры и хэши под маской, две строки, не длиннее 120', () => {
    const head = (content: string) => toolOutcome({ is_error: true, content }).errorHead;
    expect(
      head('Exit code 1\n\u001b[31mTimeoutError: locator.click: Timeout 5000ms exceeded.\u001b[0m'),
    ).toBe('TimeoutError: locator.click: Timeout Nms exceeded.');
    // Тот же сбой при другом номере и хэше — та же голова (повтор R24).
    expect(head('Error: commit 1f3a9c2d failed at line 12\nretry')).toBe(
      head('Error: commit 9b8e7f6a failed at line 40\nretry'),
    );
    expect(head('### Error\nfirst\nsecond\nthird')).toBe('first | second');
    expect(head(`Exit code 1\n${'y'.repeat(300)}`)?.length).toBe(120);
  });

  it('отказы брокера панели — по началу текста, даже без рода CLI (C14)', () => {
    expect(toolOutcome({ is_error: true, content: MAIN_SYNC_DENIED }).denied).toBe('main-sync');
    expect(toolOutcome({ is_error: true, content: MAIN_SYNC_UNKNOWN }).denied).toBe('main-sync');
    // Начало сверено с настоящим текстом отказа: его правка без правки начала покраснит тест.
    const outside = outsideCopyDenial('/work/app-copy', '/work/app');
    expect(outside.startsWith(OUTSIDE_COPY_PREFIX)).toBe(true);
    expect(
      toolOutcome({ is_error: true, content: outside }, { denialKind: 'permission-rule' }),
    ).toEqual({ denied: 'outside-copy' });
  });

  it('D-n и отказ панели с известным ответом — свой род, даже поверх рода CLI', () => {
    // Настоящие тексты отказа: правка их начала без правки метки покраснит тест.
    const deferred = [
      deferralDenial('D-2', 'row database'),
      alreadyQueuedDenial('D-2'),
      humanRefusedDenial('D-2', 'no'),
    ];
    for (const content of deferred) {
      expect(
        toolOutcome({ is_error: true, content }, { denialKind: 'permission' }),
        content,
      ).toEqual({ denied: 'deferred' });
    }
    const refused = [
      mergeRefusal(),
      groupMainCopyRefusal('/work/app-copy'),
      keepDraftRefusal(['D-2']),
      mrMentionRefusal(['D-2']),
      selfApprovalRefusal(),
    ];
    for (const content of refused) {
      expect(toolOutcome({ is_error: true, content }).denied, content).toBe('panel-refused');
    }
  });

  it('срок: флаг источника, увод в фон, убийство `-p` в любых единицах', () => {
    expect(toolOutcome({ content: 'x' }, { timedOutAfterMs: 600_000 })).toEqual({
      timedOutMs: 600_000,
    });
    expect(
      toolOutcome({
        content: 'Command did not complete within its 600s timeout and was moved to the background',
      }),
    ).toEqual({ timedOutMs: 600_000 });
    expect(
      toolOutcome({ is_error: true, content: 'Exit code 143\nCommand timed out after 3s' }),
    ).toEqual({
      timedOutMs: 3000,
    });
    expect(toolOutcome({ is_error: true, content: 'Command timed out after 2m 30s' })).toEqual({
      timedOutMs: 150_000,
    });
  });

  it('та же фраза в обычном выводе команды (не ошибка) — не упор в срок', () => {
    expect(toolOutcome({ content: 'Command timed out after 3s' })).toEqual({});
  });

  it('срок длиннее суток — битое число: потолок сутки; нечисло и ноль — срока нет', () => {
    const day = 86_400_000;
    expect(toolOutcome({ content: 'x' }, { timedOutAfterMs: 1e300 })).toEqual({ timedOutMs: day });
    expect(
      toolOutcome({ is_error: true, content: 'Command timed out after 99999999999h' }),
    ).toEqual({ timedOutMs: day });
    expect(
      toolOutcome({
        content: `Command did not complete within its ${'9'.repeat(400)}s timeout`,
      }),
    ).toEqual({});
    // Срока нет — остаётся обычной ошибкой, не упором в срок.
    expect(
      toolOutcome({ is_error: true, content: 'Command timed out after 0s' }),
    ).not.toHaveProperty('timedOutMs');
  });
});

describe('читатель транскрипта: итог вызова', () => {
  const t = '2026-10-18T22:08:26.500Z';
  it('`toolUseResult.timedOutAfterMs` и `toolDenialKind` строки — к единственному результату', () => {
    const read = createTranscriptReader();
    expect(
      read({
        type: 'user',
        timestamp: t,
        message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'moved' }] },
        toolUseResult: { timedOutAfterMs: 600_000 },
      }),
    ).toEqual([{ kind: 'toolResult', t: Date.parse(t), id: 'a', chars: 5, timedOutMs: 600_000 }]);
    expect(
      read({
        type: 'user',
        timestamp: t,
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'b', content: 'no', is_error: true }],
        },
        toolDenialKind: 'permission-rule',
      }),
    ).toEqual([
      { kind: 'toolResult', t: Date.parse(t), id: 'b', chars: 2, denied: 'permission-rule' },
    ]);
  });

  it('при нескольких результатах поля строки не делятся: ни одному', () => {
    const read = createTranscriptReader();
    const events = read({
      type: 'user',
      timestamp: t,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'one' },
          { type: 'tool_result', tool_use_id: 'b', content: 'two' },
        ],
      },
      toolUseResult: { timedOutAfterMs: 600_000 },
    });
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.kind === 'toolResult' && event.timedOutMs)).toEqual([
      undefined,
      undefined,
    ]);
  });
});
