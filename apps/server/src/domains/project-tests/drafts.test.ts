import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestCase } from '@agentdeck/contracts';
import { readGroups, upsertCase } from './store.ts';
import {
  applyDraft,
  draftFile,
  readDraft,
  readDraftSummaries,
  rejectDraft,
  rollbackDraft,
} from './drafts.ts';

/**
 * Черновик генерации. Проверяется ровно то, ради чего он заведён: библиотеку
 * меняет ПАНЕЛЬ, а не прогон, и всё, что она применила, можно вернуть обратно.
 *
 * Отдельная тема — что откат НЕ делает: работу, сделанную после приёмки, он
 * стирать не имеет права, иначе «отменить» однажды сотрёт живой результат.
 */
const NOW = '2026-09-08T10:00:00.000Z';
const LATER = '2026-09-08T12:00:00.000Z';
const RUN = 'a1b2c3d4-0000-4000-8000-000000000001';

function proposedCase(id: string, title: string): Record<string, unknown> {
  return {
    id,
    type: 'case',
    title,
    steps: [{ action: 'Открыть форму', expected: 'Видна' }],
    oracle: 'Заголовок на экране',
    priority: 'high',
    status: 'unknown',
  };
}

function writeDraftFile(root: string, runId: string, items: unknown[], extra = {}): void {
  const dir = join(root, '.agent', 'tests', 'drafts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${runId}.draft.json`),
    JSON.stringify({ version: 1, runId, createdAt: NOW, items, ...extra }, null, 2),
  );
}

function writeGroupFile(root: string, id: string, cases: ProjectTestCase[]): void {
  const dir = join(root, '.agent', 'tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.tests.json`),
    JSON.stringify({ version: 1, title: id.toUpperCase(), cases }, null, 2),
  );
}

function caseIn(root: string, groupId: string, caseId: string): ProjectTestCase | undefined {
  return readGroups(root)
    .find((group) => group.id === groupId)
    ?.cases.find((item) => item.id === caseId);
}

describe('project-tests drafts', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-draft-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('файл черновика назван прогоном — двум генерациям не попасть в один', () => {
    expect(draftFile(RUN)).toBe(`.agent/tests/drafts/${RUN}.draft.json`);
  });

  it('пустой проект черновиков не имеет, и это не ошибка', () => {
    expect(readDraftSummaries(root)).toEqual([]);
    expect(readDraft(root, RUN)).toBeUndefined();
  });

  it('предложение применяется в библиотеку и помечается агентским', () => {
    writeDraftFile(root, RUN, [
      { op: 'add', groupId: 'gui', caseId: 'gui-001', case: proposedCase('gui-001', 'Вход') },
    ]);

    const result = applyDraft(root, RUN, { now: NOW });

    expect(result.applied).toBe(1);
    const added = caseIn(root, 'gui', 'gui-001');
    expect(added?.title).toBe('Вход');
    expect(added?.source).toBe('agent');
    // Генерация описывает проверки, а не проходит их: результата у нового кейса нет.
    expect(added?.status).toBe('unknown');
    expect(added?.lastRunAt).toBeUndefined();
  });

  it('до приёмки библиотека не меняется ни на байт', () => {
    writeGroupFile(root, 'gui', []);
    const file = join(root, '.agent', 'tests', 'gui.tests.json');
    const before = readFileSync(file);

    writeDraftFile(root, RUN, [
      { op: 'add', groupId: 'gui', caseId: 'gui-001', case: proposedCase('gui-001', 'Вход') },
    ]);

    expect(readFileSync(file)).toEqual(before);
    expect(readDraftSummaries(root)[0]?.pending).toBe(1);
  });

  it('удаление кейса черновиком не делается — правка отбрасывается с причиной', () => {
    writeDraftFile(root, RUN, [
      { op: 'delete', groupId: 'gui', caseId: 'gui-001', case: proposedCase('gui-001', 'Вход') },
      { op: 'add', groupId: 'gui', caseId: 'gui-002', case: proposedCase('gui-002', 'Выход') },
    ]);

    const draft = readDraft(root, RUN);

    expect(draft?.items).toHaveLength(1);
    expect(draft?.warnings?.[0]).toContain('удаление');
  });

  it('приёмка выборочная: отмеченный кейс уходит в библиотеку, остальные ждут', () => {
    writeDraftFile(root, RUN, [
      { op: 'add', groupId: 'gui', caseId: 'gui-001', case: proposedCase('gui-001', 'Вход') },
      { op: 'add', groupId: 'gui', caseId: 'gui-002', case: proposedCase('gui-002', 'Выход') },
    ]);

    const result = applyDraft(root, RUN, { now: NOW, caseIds: ['gui-001'] });

    expect(result.applied).toBe(1);
    expect(caseIn(root, 'gui', 'gui-002')).toBeUndefined();
    expect(result.draft.status).toBe('pending');
    expect(readDraftSummaries(root)[0]?.pending).toBe(1);
  });

  it('принятое автоматически помечается черновым — на него никто не смотрел', () => {
    writeDraftFile(root, RUN, [
      {
        op: 'add',
        groupId: 'gui',
        caseId: 'gui-001',
        case: { ...proposedCase('gui-001', 'Вход'), readiness: 'ready' },
      },
    ]);

    applyDraft(root, RUN, { now: NOW, auto: true });

    expect(caseIn(root, 'gui', 'gui-001')?.readiness).toBe('draft');
    expect(readDraftSummaries(root)[0]?.auto).toBe(true);
  });

  it('галочка не переписывает кейс человека — такую правку принимают руками', () => {
    upsertCase(root, 'gui', { title: 'Мой кейс', oracle: 'Так и должно быть' }, NOW);
    const mine = caseIn(root, 'gui', 'gui-001');
    expect(mine?.source).toBe('human');

    writeDraftFile(root, RUN, [
      {
        op: 'update',
        groupId: 'gui',
        caseId: 'gui-001',
        case: proposedCase('gui-001', 'Переписанный агентом'),
      },
    ]);

    const auto = applyDraft(root, RUN, { now: LATER, auto: true });

    expect(auto.applied).toBe(0);
    expect(auto.skipped[0]?.reason).toContain('человеком');
    expect(caseIn(root, 'gui', 'gui-001')?.title).toBe('Мой кейс');

    // Руками — можно: человек читает предложение и решает сам. Автор кейса при
    // этом не меняется, иначе кейс потерял бы защиту от удаления прогоном.
    const byHand = applyDraft(root, RUN, { now: LATER });
    expect(byHand.applied).toBe(1);
    expect(caseIn(root, 'gui', 'gui-001')?.title).toBe('Переписанный агентом');
    expect(caseIn(root, 'gui', 'gui-001')?.source).toBe('human');
  });

  it('дополнение не стирает результат прогона: статус и заметка остаются', () => {
    writeGroupFile(root, 'gui', [
      {
        id: 'gui-001',
        type: 'case',
        title: 'Вход',
        steps: [],
        status: 'failed',
        note: 'не пускает',
        lastRunAt: NOW,
        source: 'agent',
      },
    ]);
    writeDraftFile(root, RUN, [
      {
        op: 'update',
        groupId: 'gui',
        caseId: 'gui-001',
        case: { ...proposedCase('gui-001', 'Вход под ролью'), status: 'passed' },
      },
    ]);

    applyDraft(root, RUN, { now: LATER });

    const updated = caseIn(root, 'gui', 'gui-001');
    expect(updated?.title).toBe('Вход под ролью');
    expect(updated?.status).toBe('failed');
    expect(updated?.note).toBe('не пускает');
  });

  it('откат убирает добавленное и возвращает изменённое из снимка', () => {
    writeGroupFile(root, 'gui', [
      {
        id: 'gui-001',
        type: 'case',
        title: 'Старое название',
        steps: [],
        status: 'unknown',
        source: 'agent',
      },
    ]);
    writeDraftFile(root, RUN, [
      { op: 'update', groupId: 'gui', caseId: 'gui-001', case: proposedCase('gui-001', 'Новое') },
      { op: 'add', groupId: 'gui', caseId: 'gui-002', case: proposedCase('gui-002', 'Второй') },
    ]);
    applyDraft(root, RUN, { now: NOW });
    expect(caseIn(root, 'gui', 'gui-001')?.title).toBe('Новое');

    const result = rollbackDraft(root, RUN);

    expect(result.removed).toBe(1);
    expect(result.restored).toBe(1);
    expect(result.kept).toEqual([]);
    expect(caseIn(root, 'gui', 'gui-001')?.title).toBe('Старое название');
    expect(caseIn(root, 'gui', 'gui-002')).toBeUndefined();
  });

  it('откат не трогает кейс, который успели поправить или прогнать', () => {
    writeDraftFile(root, RUN, [
      { op: 'add', groupId: 'gui', caseId: 'gui-001', case: proposedCase('gui-001', 'Вход') },
      { op: 'add', groupId: 'gui', caseId: 'gui-002', case: proposedCase('gui-002', 'Выход') },
    ]);
    applyDraft(root, RUN, { now: NOW });

    // Человек дописал оракул принятому кейсу — это его работа, и она дороже отката.
    upsertCase(root, 'gui', { id: 'gui-001', title: 'Вход', oracle: 'Видно имя' }, LATER);

    const result = rollbackDraft(root, RUN);

    expect(result.kept.map((item) => item.caseId)).toEqual(['gui-001']);
    expect(result.kept[0]?.reason).toContain('поправить');
    expect(caseIn(root, 'gui', 'gui-001')?.oracle).toBe('Видно имя');
    expect(caseIn(root, 'gui', 'gui-002')).toBeUndefined();
  });

  it('отклонённый черновик уезжает в архив и из списка пропадает', () => {
    writeDraftFile(root, RUN, [
      { op: 'add', groupId: 'gui', caseId: 'gui-001', case: proposedCase('gui-001', 'Вход') },
    ]);

    const draft = rejectDraft(root, RUN);

    expect(draft.status).toBe('rejected');
    expect(readDraftSummaries(root)).toEqual([]);
    expect(caseIn(root, 'gui', 'gui-001')).toBeUndefined();
    expect(
      existsSync(join(root, '.agent', 'tests', 'drafts', 'archive', `${RUN}.draft.json`)),
    ).toBe(true);
  });

  it('битый черновик гасит только себя и не роняет список', () => {
    const dir = join(root, '.agent', 'tests', 'drafts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${RUN}.draft.json`), '{"items": [ {');
    writeDraftFile(root, 'a1b2c3d4-0000-4000-8000-000000000002', [
      { op: 'add', groupId: 'gui', caseId: 'gui-001', case: proposedCase('gui-001', 'Вход') },
    ]);

    const summaries = readDraftSummaries(root);

    expect(summaries).toHaveLength(2);
    expect(summaries.some((item) => item.error)).toBe(true);
    expect(() => applyDraft(root, RUN, { now: NOW })).toThrow();
  });

  it('вторая генерация не затирает непринятый черновик', () => {
    const second = 'a1b2c3d4-0000-4000-8000-000000000002';
    writeDraftFile(root, RUN, [
      { op: 'add', groupId: 'gui', caseId: 'gui-001', case: proposedCase('gui-001', 'Вход') },
    ]);
    writeDraftFile(root, second, [
      { op: 'add', groupId: 'gui', caseId: 'gui-002', case: proposedCase('gui-002', 'Выход') },
    ]);

    expect(
      readDraftSummaries(root)
        .map((item) => item.runId)
        .sort(),
    ).toEqual([RUN, second].sort());
  });

  it('приёмка при занятой прогоном группе ничего не пишет и называет причину', () => {
    writeDraftFile(root, RUN, [
      { op: 'add', groupId: 'gui', caseId: 'gui-001', case: proposedCase('gui-001', 'Вход') },
    ]);

    const result = applyDraft(root, RUN, {
      now: NOW,
      assertUnlocked: () => {
        throw new Error('По этой группе идёт прогон (run-7).');
      },
    });

    expect(result.applied).toBe(0);
    expect(result.skipped[0]?.reason).toContain('run-7');
    expect(caseIn(root, 'gui', 'gui-001')).toBeUndefined();
    // Правка осталась ждать: занятость — это «позже», а не «отклонено».
    expect(readDraftSummaries(root)[0]?.pending).toBe(1);
  });

  /**
   * След источника генерации. Задание агенту требует того же словами, но
   * забытая ссылка означала бы строку матрицы, оставшуюся непокрытой после
   * генерации, сделанной ровно ради неё.
   */
  describe('след источника', () => {
    it('ссылка на требование проставляется панелью, даже если агент её забыл', () => {
      writeDraftFile(root, RUN, [
        { op: 'add', groupId: 'gui', caseId: 'gui-001', case: proposedCase('gui-001', 'Вход') },
      ]);

      applyDraft(root, RUN, {
        now: NOW,
        stamp: {
          source: 'requirement',
          requirementUrl: 'https://acme.atlassian.net/browse/QA-42',
          requirementKey: 'QA-42',
        },
      });

      expect(caseIn(root, 'gui', 'gui-001')?.links).toEqual([
        {
          type: 'requirement',
          url: 'https://acme.atlassian.net/browse/QA-42',
          title: 'QA-42',
        },
      ]);
    });

    it('свою ссылку агента панель не дублирует', () => {
      const url = 'https://acme.atlassian.net/browse/QA-42';
      writeDraftFile(root, RUN, [
        {
          op: 'add',
          groupId: 'gui',
          caseId: 'gui-001',
          case: { ...proposedCase('gui-001', 'Вход'), links: [{ type: 'requirement', url }] },
        },
      ]);

      applyDraft(root, RUN, {
        now: NOW,
        stamp: { source: 'requirement', requirementUrl: url, requirementKey: 'QA-42' },
      });

      expect(caseIn(root, 'gui', 'gui-001')?.links).toHaveLength(1);
    });

    it('codePaths из диффа ставятся только пустому кейсу — свои дороже', () => {
      writeDraftFile(root, RUN, [
        { op: 'add', groupId: 'gui', caseId: 'gui-001', case: proposedCase('gui-001', 'Вход') },
        {
          op: 'add',
          groupId: 'gui',
          caseId: 'gui-002',
          case: { ...proposedCase('gui-002', 'Выход'), codePaths: ['src/Exit.tsx'] },
        },
      ]);

      applyDraft(root, RUN, {
        now: NOW,
        stamp: { source: 'diff', codePaths: ['src/Chat/Send.tsx'] },
      });

      expect(caseIn(root, 'gui', 'gui-001')?.codePaths).toEqual(['src/Chat/Send.tsx']);
      expect(caseIn(root, 'gui', 'gui-002')?.codePaths).toEqual(['src/Exit.tsx']);
    });

    it('регрессионный кейс ссылается на дефект, из которого его завели', () => {
      writeDraftFile(root, RUN, [
        { op: 'add', groupId: 'gui', caseId: 'gui-009', case: proposedCase('gui-009', 'Регресс') },
      ]);

      applyDraft(root, RUN, {
        now: NOW,
        stamp: { source: 'defect', defectUrl: 'https://acme.atlassian.net/browse/QA-77' },
      });

      expect(caseIn(root, 'gui', 'gui-009')?.links).toEqual([
        { type: 'issue', url: 'https://acme.atlassian.net/browse/QA-77' },
      ]);
    });

    it('без следа кейс приезжает ровно таким, каким его предложили', () => {
      writeDraftFile(root, RUN, [
        { op: 'add', groupId: 'gui', caseId: 'gui-001', case: proposedCase('gui-001', 'Вход') },
      ]);

      applyDraft(root, RUN, { now: NOW });

      expect(caseIn(root, 'gui', 'gui-001')?.links).toBeUndefined();
      expect(caseIn(root, 'gui', 'gui-001')?.codePaths).toBeUndefined();
    });
  });
});
