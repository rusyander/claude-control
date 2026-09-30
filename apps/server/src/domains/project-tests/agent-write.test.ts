import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentUpsertCase, recordAgentResults } from './agent-write.ts';
import { readDraft } from './drafts.ts';
import { e2eChatLine } from './e2e-chat.ts';
import { readRuns } from './runs-store.ts';
import { readGroup, upsertCase } from './store.ts';

/**
 * Агент чата ведёт блок «Тесты» сам (решение владельца 30.09): заводит кейс на
 * изменённое и записывает проверенное прогоном. Кейс человека — только черновиком.
 */
describe('запись в блок «Тесты» от агента чата', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });
  const NOW = '2026-09-30T12:00:00.000Z';

  it('новый кейс — агентский, группа заводится сама, статус правкой не ставится', () => {
    root = mkdtempSync(join(tmpdir(), 'agent-write-'));
    const result = agentUpsertCase(
      root,
      'auth',
      {
        title: 'Вход по Enter',
        steps: ['Нажать Enter'],
        codePaths: ['src/login.tsx'],
        status: 'passed',
      },
      NOW,
    );
    expect(result).toMatchObject({ kind: 'saved', created: true });
    const saved = readGroup(root, 'auth').cases[0];
    expect(saved).toMatchObject({ id: 'auth-001', source: 'agent', status: 'unknown' });
    expect(saved?.codePaths).toEqual(['src/login.tsx']);
  });

  it('кейс человека не переписывается — правка уходит черновиком', () => {
    root = mkdtempSync(join(tmpdir(), 'agent-write-'));
    agentUpsertCase(root, 'auth', { title: 'заготовка' }, NOW);
    upsertCase(root, 'auth', { id: 'auth-001', title: 'Вход — человек' }, NOW, 'human');

    const result = agentUpsertCase(root, 'auth', { id: 'auth-001', title: 'Вход — агент' }, NOW);
    expect(result).toMatchObject({ kind: 'draft', caseId: 'auth-001' });
    expect(readGroup(root, 'auth').cases[0]?.title).toBe('Вход — человек');
    const draft = readDraft(root, result.kind === 'draft' ? result.runId : '');
    expect(draft?.items[0]).toMatchObject({ op: 'update', caseId: 'auth-001', state: 'pending' });
    expect(draft?.items[0]?.testCase.title).toBe('Вход — агент');
  });

  it('проверенное пишется прогоном агента в историю и ложится на кейсы', () => {
    root = mkdtempSync(join(tmpdir(), 'agent-write-'));
    agentUpsertCase(root, 'auth', { title: 'Раз' }, NOW);
    agentUpsertCase(root, 'auth', { title: 'Два' }, NOW);

    const run = recordAgentResults(
      root,
      [
        { groupId: 'auth', caseId: 'auth-001', status: 'passed', note: 'в браузере' },
        { groupId: 'auth', caseId: 'auth-002', status: 'failed' },
      ],
      NOW,
    );
    expect(run).toMatchObject({ mode: 'run', actor: 'agent', status: 'done' });
    expect(run.summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(readRuns(root).map((item) => item.id)).toEqual([run.id]);
    const cases = readGroup(root, 'auth').cases;
    expect(cases.map((item) => [item.id, item.status, item.lastRunId])).toEqual([
      ['auth-001', 'passed', run.id],
      ['auth-002', 'failed', run.id],
    ]);
    expect(cases[0]?.note).toBe('в браузере');
  });

  it('результат для несуществующего кейса — отказ до записи', () => {
    root = mkdtempSync(join(tmpdir(), 'agent-write-'));
    agentUpsertCase(root, 'auth', { title: 'Раз' }, NOW);
    expect(() =>
      recordAgentResults(
        root as string,
        [{ groupId: 'auth', caseId: 'auth-404', status: 'passed' }],
        NOW,
      ),
    ).toThrow(/auth-404/);
    expect(readRuns(root)).toEqual([]);
  });

  it('строка чата велит вести кейсы и записывать проверенное на любой правке поведения', () => {
    const line = e2eChatLine({
      root: '/repo',
      folder: { state: 'missing', framework: 'unknown', specs: 0 } as never,
      cliPath: '/panel/tools/tests-cli.mjs',
      hasStandUrl: true,
    });
    expect(line).toContain('whenever you change how the product behaves');
    expect(line).toContain('case --project "/repo" --group <group>');
    expect(line).toContain('record --project "/repo" <group>:<case>=passed|failed|blocked');
    expect(line).not.toContain('\n');
  });
});
