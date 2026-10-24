import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lastAskedInput, PendingAsks } from './pending-asks.ts';
import type { RunFinished } from '../ChatRunRegistry/ChatRunRegistry.ts';

/**
 * Усыновлённый прогон (панель перезапускалась посреди работы группы): потока
 * нет, и вызов `AskUserQuestion` известен только из транскрипта CLI. Файл —
 * настоящий JSON Lines в каталоге проектов, как его пишет Claude Code.
 */
describe('PendingAsks: вопрос усыновлённого прогона из транскрипта', () => {
  let projects: string;
  const QUESTION = { questions: [{ question: 'Что делать с коммитом 5dac2a9e7?', options: [] }] };

  const line = (record: unknown): string => `${JSON.stringify(record)}\n`;
  const writeTranscript = (records: unknown[]): void => {
    mkdirSync(join(projects, 'p'), { recursive: true });
    writeFileSync(join(projects, 'p', 'sess-g1.jsonl'), records.map(line).join(''));
  };
  const finished = (text: string): RunFinished => ({
    chatId: 'new-g1',
    sessionId: 'sess-g1',
    text,
    ok: true,
    asked: true,
    startedAt: 0,
    options: { prompt: '', cwd: projects },
    contextTokens: 0,
  });
  const asks = () =>
    new PendingAsks({
      isTreeChat: () => true,
      readAsked: (chatId, sessionId) => lastAskedInput(projects, sessionId ?? chatId),
    });
  const assistant = (content: unknown[]) => ({
    type: 'assistant',
    message: { id: 'm1', role: 'assistant', content },
  });

  beforeEach(() => {
    projects = mkdtempSync(join(tmpdir(), 'cc-pending-asks-'));
  });
  afterEach(() => rmSync(projects, { recursive: true, force: true }));

  it('берёт тело вызова из транскрипта — карточка с вариантами, а не текст', () => {
    writeTranscript([
      { type: 'user', message: { role: 'user', content: 'работа группы' } },
      assistant([{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: QUESTION }]),
      assistant([{ type: 'text', text: 'Жду вашего ответа.' }]),
    ]);
    const store = asks();
    store.finished(finished('Жду вашего ответа.'));
    expect(store.of(['sess-g1'], () => false)).toEqual([
      expect.objectContaining({ kind: 'question', runId: 'new-g1', input: QUESTION }),
    ]);
  });

  it('на вопрос уже ответили в чате — остаётся только текст хода', () => {
    writeTranscript([
      assistant([{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: QUESTION }]),
      { type: 'user', message: { role: 'user', content: 'Оставь коммит' } },
      assistant([{ type: 'text', text: 'Какой базой ребейзить?' }]),
    ]);
    const store = asks();
    store.finished(finished('Какой базой ребейзить?'));
    expect(store.of(['new-g1'], () => false)).toEqual([
      expect.objectContaining({ kind: 'text', text: 'Какой базой ребейзить?' }),
    ]);
  });
});

// Живой случай RBAC 23.10: ход кончился ожиданием словами без «?» — вопрос
// дерева не загорался, и человек в режиме «вопросы — человеку» его не видел.
describe('PendingAsks: ожидание ответа словами — тоже вопрос дерева', () => {
  const finished = (text: string): RunFinished => ({
    chatId: 'new-g2',
    sessionId: 'sess-g2',
    text,
    ok: true,
    startedAt: 0,
    options: { prompt: '', cwd: '/w' },
    contextTokens: 0,
  });
  const asks = () => new PendingAsks({ isTreeChat: () => true, readAsked: () => undefined });

  it('«начну после ответа» — текстовый вопрос; метка HUMAN: и отчёт — нет', () => {
    const store = asks();
    store.finished(
      finished('Этапы D и E начну после ответа. Вопросы и рекомендации записаны в PROGRESS.md'),
    );
    expect(store.of(['sess-g2'], () => false)).toEqual([
      expect.objectContaining({ kind: 'text', runId: 'new-g2' }),
    ]);

    const other = asks();
    other.finished(finished('HUMAN: merge — MR !12 first. Once you confirm I will push.'));
    other.finished(finished('Сделал этапы A–E.'));
    expect(other.of(['sess-g2'], () => false)).toEqual([]);
  });
});
