import { describe, expect, it } from 'vitest';
import type { Record } from './ChatRecords.ts';
import { caseFromChat, chatCaseDraft } from './chat-case-draft.ts';

/** «Сделать кейс» из разговора: шаги — реплики человека и то, что делалось (решение 30.09). */

const human = (text: string): Record => ({ type: 'user', message: { content: text } });
const assistant = (content: unknown[]): Record =>
  ({ type: 'assistant', message: { content } }) as Record;
const toolUse = (id: string, name: string, input: unknown) => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const result = (id: string, text: string, isError = false): Record =>
  ({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }],
    },
  }) as Record;

const INPUT = { chatId: 'ABCDEF12-3456', projectPath: '/repo', now: '2026-09-30T12:00:00.000Z' };

describe('кейс из разговора', () => {
  const records: Record[] = [
    human('Кнопка «Войти» не реагирует на Enter\nпочини'),
    assistant([toolUse('r', 'Read', { file_path: '/repo/src/login.tsx' })]),
    result('r', 'export …'),
    assistant([toolUse('e1', 'Edit', { file_path: '/repo/src/login.tsx' })]),
    assistant([toolUse('e2', 'Edit', { file_path: '/repo/src/login.tsx' })]),
    assistant([toolUse('b', 'Bash', { command: 'pnpm test login' })]),
    result('b', '✓ 3 passed\nDone'),
    { type: 'user', isMeta: true, message: { content: 'служебное' } } as Record,
    assistant([{ type: 'text', text: 'Готово: Enter отправляет форму.\n\nПодробности ниже.' }]),
  ];

  it('шаги — реплика человека, правка файла одним шагом, команда с ожиданием из ответа', () => {
    const testCase = caseFromChat(records, INPUT);
    expect(testCase?.steps).toEqual([
      { action: 'Кнопка «Войти» не реагирует на Enter почини' },
      { action: 'Изменить файл src/login.tsx' },
      { action: 'Выполнить: pnpm test login', expected: '✓ 3 passed' },
    ]);
    expect(testCase).toMatchObject({
      title: 'Кнопка «Войти» не реагирует на Enter почини',
      expected: 'Готово: Enter отправляет форму.',
      codePaths: ['src/login.tsx'],
      readiness: 'draft',
      status: 'unknown',
    });
  });

  it('упавшая команда ожидания не даёт', () => {
    const testCase = caseFromChat(
      [
        human('прогони'),
        assistant([toolUse('b', 'Bash', { command: 'false' })]),
        result('b', 'err', true),
      ],
      INPUT,
    );
    expect(testCase?.steps[1]).toEqual({ action: 'Выполнить: false' });
  });

  it('ни реплик, ни шагов — кейса нет', () => {
    expect(caseFromChat([assistant([{ type: 'text', text: 'привет' }])], INPUT)).toBeUndefined();
  });

  it('черновик — одна правка «добавить» в группу чата, ждёт приёмки', () => {
    const draft = chatCaseDraft(records, INPUT);
    expect(draft).toMatchObject({
      version: 1,
      source: 'chat',
      status: 'pending',
      items: [{ op: 'add', groupId: 'chat', state: 'pending' }],
    });
    expect(draft?.runId).toMatch(/^chat-abcdef12-[a-z0-9]+$/);
    expect(draft?.items[0]?.caseId).toBe(draft?.runId);
    // Второй кейс из того же чата — новый, а не правка первого.
    const later = chatCaseDraft(records, { ...INPUT, now: '2026-09-30T12:05:00.000Z' });
    expect(later?.items[0]?.caseId).not.toBe(draft?.items[0]?.caseId);
    expect(chatCaseDraft(records, { ...INPUT, groupId: 'auth' })?.items[0]?.groupId).toBe('auth');
  });
});
