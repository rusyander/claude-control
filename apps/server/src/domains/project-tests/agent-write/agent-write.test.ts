import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentUpsertCase, recordAgentResults } from './agent-write.ts';
import { readDraft } from '../drafts/drafts.ts';
import { CASE_STANDARD } from '../case-standard.ts';
import { e2eChatLine } from '../e2e-chat.ts';
import { readRuns } from '../runs-store/runs-store.ts';
import { applyResults, readGroup, upsertCase } from '../store/store.ts';

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

  /**
   * 3.4 плана экономии: агент, придумавший id нового кейса, получал отказ
   * «кейса нет» и тратил ход на повтор без id. Теперь кейс заводится с
   * идентификатором блока, а придуманный возвращается — CLI называет оба.
   */
  /** Ревью B2-F19: опечатка в id живого кейса заводила дубль молча. */
  it('id в одну-две буквы от живого кейса — новый кейс, но похожий назван', () => {
    root = mkdtempSync(join(tmpdir(), 'agent-write-'));
    agentUpsertCase(root, 'auth', { title: 'первый' }, NOW);
    agentUpsertCase(root, 'auth', { id: 'auth-login-enter', title: 'Вход по Enter' }, NOW);
    const typo = agentUpsertCase(root, 'auth', { id: 'auth-01', title: 'правка' }, NOW);
    expect(typo).toMatchObject({ kind: 'saved', created: true, similar: 'auth-001' });
    const typoOfOwn = agentUpsertCase(root, 'auth', { id: 'auth-login-entr', title: 'x' }, NOW);
    expect(typoOfOwn).toMatchObject({ created: true, similar: 'auth-002' });
    const far = agentUpsertCase(root, 'auth', { id: 'billing-refund', title: 'y' }, NOW);
    expect(far).not.toHaveProperty('similar');
  });

  it('id, которого в группе нет, — новый кейс с id блока, просимый id назван', () => {
    root = mkdtempSync(join(tmpdir(), 'agent-write-'));
    agentUpsertCase(root, 'auth', { title: 'первый' }, NOW);
    const result = agentUpsertCase(
      root,
      'auth',
      { id: 'auth-login-enter', title: 'Вход по Enter', steps: ['Нажать Enter'] },
      NOW,
    );
    expect(result).toMatchObject({ kind: 'saved', created: true, requested: 'auth-login-enter' });
    const cases = readGroup(root, 'auth').cases;
    expect(cases.map((item) => item.id)).toEqual(['auth-001', 'auth-002']);
    expect(cases[1]).toMatchObject({ title: 'Вход по Enter', source: 'agent' });
    // Существующий id — правка того же кейса, без «просимого».
    const again = agentUpsertCase(root, 'auth', { id: 'auth-002', title: 'Вход по Enter!' }, NOW);
    expect(again).toMatchObject({ kind: 'saved', created: false });
    expect(again).not.toHaveProperty('requested');
    // Тот же придуманный id в следующем ходе — правка заведённого кейса, не дубль (ревью A2-F9).
    const repeat = agentUpsertCase(
      root,
      'auth',
      { id: 'auth-login-enter', title: 'Вход по Enter (уточнено)' },
      NOW,
    );
    expect(repeat).toMatchObject({ kind: 'saved', created: false });
    expect(repeat).not.toHaveProperty('requested');
    const after = readGroup(root, 'auth').cases;
    expect(after.map((item) => `${item.id}:${item.title}`)).toEqual([
      'auth-001:первый',
      'auth-002:Вход по Enter (уточнено)',
    ]);
    expect(after[1]?.attributes).toEqual({ 'agent-id': 'auth-login-enter' });
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

  it('кейс без поля source (написан руками в файле) — тоже человека: черновик, и запись прогона его не перекрашивает', () => {
    root = mkdtempSync(join(tmpdir(), 'agent-write-'));
    const dir = join(root, '.agent', 'tests');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'core.tests.json'),
      JSON.stringify({
        version: 1,
        title: 'Ядро',
        cases: [
          { id: 'core-001', type: 'case', title: 'Сумма', expected: '5', status: 'untested' },
        ],
      }),
    );

    const result = agentUpsertCase(
      root,
      'core',
      { id: 'core-001', title: 'Сумма', expected: '5 без ошибок' },
      NOW,
    );
    expect(result).toMatchObject({ kind: 'draft', caseId: 'core-001' });
    expect(readGroup(root, 'core').cases[0]).toMatchObject({ expected: '5', source: 'human' });

    recordAgentResults(root, [{ groupId: 'core', caseId: 'core-001', status: 'passed' }], NOW);
    const onDisk = JSON.parse(readFileSync(join(dir, 'core.tests.json'), 'utf8')) as {
      cases: Array<{ source?: string }>;
    };
    expect(onDisk.cases[0]?.source).not.toBe('agent');
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

  // Решение владельца 10.10: `record` — только для ручных кейсов. Автокейс в записи —
  // отказ ЦЕЛИКОМ, до записи: ни прогона в истории, ни статуса, ни ручного соседа.
  it('автокейс в записи: отказ целиком, с кодом, кейсами и группой для прогона', () => {
    root = mkdtempSync(join(tmpdir(), 'agent-write-'));
    agentUpsertCase(root, 'auth', { title: 'Ручной' }, NOW);
    agentUpsertCase(root, 'auth', { title: 'заготовка' }, NOW);
    upsertCase(
      root,
      'auth',
      {
        id: 'auth-002',
        title: 'Авто',
        automation: { status: 'automated', file: 'e2e/auth.spec.ts' },
      },
      NOW,
      'human',
    );
    applyResults(
      root,
      [{ groupId: 'auth', caseId: 'auth-002', status: 'failed', runId: 'real-run', at: NOW }],
      NOW,
    );
    let thrown: unknown;
    try {
      recordAgentResults(
        root,
        [
          { groupId: 'auth', caseId: 'auth-001', status: 'passed' },
          { groupId: 'auth', caseId: 'auth-002', status: 'passed' },
        ],
        NOW,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      statusCode: 400,
      messageCode: 'record-automated-case',
      params: { cases: 'auth:auth-002', groups: 'auth' },
    });
    expect(readRuns(root)).toEqual([]);
    expect(readGroup(root, 'auth').cases.map((item) => [item.id, item.status])).toEqual([
      ['auth-001', 'unknown'],
      ['auth-002', 'failed'],
    ]);
  });

  it('ручной кейс записан с пометкой «вручную» (attested)', () => {
    root = mkdtempSync(join(tmpdir(), 'agent-write-'));
    agentUpsertCase(root, 'auth', { title: 'Ручной' }, NOW);
    const run = recordAgentResults(
      root,
      [{ groupId: 'auth', caseId: 'auth-001', status: 'passed' }],
      NOW,
    );
    expect(run.attested).toBe(true);
    expect(readRuns(root)[0]).toMatchObject({ id: run.id, attested: true });
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
    // Стандарт кейса — тот же, что спрашивают линтер и конец хода.
    expect(line).toContain(CASE_STANDARD);
    expect(line).not.toContain('\n');
  });
});
