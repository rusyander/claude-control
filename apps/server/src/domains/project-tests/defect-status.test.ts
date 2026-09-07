import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store.ts';
import { writeSettings, writeToken } from '../integrations/store.ts';
import { readGroups } from './store.ts';
import { defectRef, refreshDefectStates, type DefectStatusDeps } from './defect-status.ts';

/**
 * Обратный ход от трекера: закрыт ли дефект, из-за которого кейс красный.
 *
 * Две вещи проверяются как главные. Первая — статус кейса не меняется ничем из
 * трекера: результат ставит только прогон. Вторая — отказ или отсутствие
 * интеграции остаётся строкой в `skipped`, а не исключением: человек нажал
 * «обновить статусы», и раздел обязан выжить.
 */

let dir: string;
let store: AppStore;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-defstate-'));
  store = new AppStore(dir);
  root = join(dir, 'repo');
  mkdirSync(root, { recursive: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const deps = (): DefectStatusDeps => ({ store, appDataDir: dir, root });

function writeGroup(id: string, cases: unknown[]): void {
  const groupDir = join(root, '.agent', 'tests');
  mkdirSync(groupDir, { recursive: true });
  writeFileSync(join(groupDir, `${id}.tests.json`), JSON.stringify({ version: 1, cases }, null, 2));
}

function readGroupFile(id: string): { cases: { defects?: { state?: string }[] }[] } {
  return JSON.parse(readFileSync(join(root, '.agent', 'tests', `${id}.tests.json`), 'utf8'));
}

function testCase(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'gui-001',
    type: 'case',
    title: 'Вход с верными данными',
    status: 'failed',
    source: 'human',
    ...over,
  };
}

function connectJira(): void {
  writeSettings(store, 'atlassian', {
    enabled: true,
    baseUrl: 'https://acme.atlassian.net',
    email: 'qa@acme.io',
    deployment: 'cloud',
    confluenceUrl: '',
  });
  writeToken(dir, 'atlassian', 'ATL-SECRET');
}

function connectForge(): void {
  writeSettings(store, 'forge', { enabled: true, kind: 'github', baseUrl: '', repo: 'acme/panel' });
  writeToken(dir, 'forge', 'GH-SECRET');
}

function stub(routes: [RegExp, { status?: number; body?: unknown }][]): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    urls.push(String(url));
    const found = routes.find(([pattern]) => pattern.test(String(url)));
    const reply = found?.[1] ?? { status: 404, body: { message: 'нет такой задачи' } };
    return Promise.resolve(
      new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
      }),
    );
  });
  return { urls };
}

const jiraIssue = (key: string, name: string, category: string) => ({
  key,
  fields: { summary: 'Падает вход', status: { name, statusCategory: { key: category } } },
});

describe('project-tests/defect-status: опознание адреса', () => {
  it('задача Jira узнаётся по /browse и приводится к верхнему регистру', () => {
    expect(defectRef('https://acme.atlassian.net/browse/qa-42')).toEqual({
      kind: 'jira',
      key: 'QA-42',
    });
  });

  it('issue обоих форджей узнаётся по номеру, хвост отбрасывается', () => {
    expect(defectRef('https://github.com/acme/panel/issues/7')).toEqual({
      kind: 'forge',
      number: 7,
    });
    expect(defectRef('https://gitlab.com/acme/panel/-/issues/12#note_1')).toEqual({
      kind: 'forge',
      number: 12,
    });
  });

  it('чужой адрес не выдаётся за задачу', () => {
    expect(defectRef('https://wiki.acme/page/bug')).toBeUndefined();
  });
});

describe('project-tests/defect-status: ответ Jira', () => {
  it('закрытый дефект на красном кейсе — повод перепроверить, но не позеленеть', async () => {
    connectJira();
    writeGroup('gui', [
      testCase({ defects: [{ url: 'https://acme.atlassian.net/browse/QA-42' }] }),
    ]);
    stub([[/\/issue\/QA-42/, { body: jiraIssue('QA-42', 'Готово', 'done') }]]);

    const result = await refreshDefectStates(deps(), readGroups(root));

    expect(result).toMatchObject({ checked: 1, closed: 1, skipped: [] });
    expect(result.recheck).toEqual([
      {
        groupId: 'gui',
        caseId: 'gui-001',
        title: 'Вход с верными данными',
        url: 'https://acme.atlassian.net/browse/QA-42',
        key: 'QA-42',
      },
    ]);

    const [item] = readGroups(root)[0]!.cases;
    expect(item!.status).toBe('failed');
    expect(item!.defects?.[0]).toMatchObject({
      state: 'closed',
      stateLabel: 'Готово',
      key: 'QA-42',
    });
    expect(item!.defects?.[0]?.stateCheckedAt).toBeTruthy();
    // Ответ должен лежать в файле, а не только в ответе ручки: следующий вид
    // раздела рисуется по диску.
    expect(readGroupFile('gui').cases[0]?.defects?.[0]?.state).toBe('closed');
  });

  it('судят по категории, а не по названию статуса', async () => {
    connectJira();
    writeGroup('gui', [
      testCase({ defects: [{ url: 'https://acme.atlassian.net/browse/QA-42' }] }),
    ]);
    // Название «Закрыт» при живой категории — обычное дело у команд, которые
    // закрывают вопрос, а не задачу.
    stub([[/\/issue\/QA-42/, { body: jiraIssue('QA-42', 'Закрыт', 'indeterminate') }]]);

    const result = await refreshDefectStates(deps(), readGroups(root));
    expect(result).toMatchObject({ checked: 1, closed: 0, recheck: [] });
    expect(readGroups(root)[0]!.cases[0]!.defects?.[0]).toMatchObject({
      state: 'open',
      stateLabel: 'Закрыт',
    });
  });

  it('закрытый дефект на зелёном кейсе никого не зовёт', async () => {
    connectJira();
    writeGroup('gui', [
      testCase({
        status: 'passed',
        defects: [{ url: 'https://acme.atlassian.net/browse/QA-42' }],
      }),
    ]);
    stub([[/\/issue\/QA-42/, { body: jiraIssue('QA-42', 'Готово', 'done') }]]);

    const result = await refreshDefectStates(deps(), readGroups(root));
    expect(result).toMatchObject({ checked: 1, closed: 1, recheck: [] });
  });

  it('молчание Jira — строка причины, а не падение ручки', async () => {
    connectJira();
    writeGroup('gui', [
      testCase({ defects: [{ url: 'https://acme.atlassian.net/browse/QA-42' }] }),
    ]);
    stub([[/\/issue\/QA-42/, { status: 500, body: { message: 'boom' } }]]);

    const result = await refreshDefectStates(deps(), readGroups(root));
    expect(result.checked).toBe(0);
    expect(result.skipped.join(' ')).toContain('QA-42');
  });
});

describe('project-tests/defect-status: фордж и отсутствие интеграций', () => {
  it('закрытый issue форджа читается так же, как задача Jira', async () => {
    connectForge();
    writeGroup('gui', [testCase({ defects: [{ url: 'https://github.com/acme/panel/issues/7' }] })]);
    stub([
      [/\/repos\/acme\/panel\/issues\/7/, { body: { state: 'closed', title: 'Падает вход' } }],
    ]);

    const result = await refreshDefectStates(deps(), readGroups(root));
    expect(result).toMatchObject({ checked: 1, closed: 1 });
    expect(result.recheck[0]?.key).toBe('#7');
    expect(readGroups(root)[0]!.cases[0]!.defects?.[0]).toMatchObject({
      state: 'closed',
      stateLabel: 'закрыт',
    });
  });

  it('без подключения спрашивать некого — причина названа один раз на все дефекты', async () => {
    const { urls } = stub([]);
    writeGroup('gui', [
      testCase({
        defects: [
          { url: 'https://acme.atlassian.net/browse/QA-42' },
          { url: 'https://acme.atlassian.net/browse/QA-43' },
        ],
      }),
    ]);

    const result = await refreshDefectStates(deps(), readGroups(root));
    expect(urls).toEqual([]);
    expect(result).toMatchObject({ checked: 0, closed: 0, recheck: [] });
    expect(result.skipped).toEqual(['Atlassian не подключён — статусы задач Jira не спрашивали.']);
  });

  it('нераспознанный адрес не роняет обход остальных дефектов', async () => {
    connectJira();
    writeGroup('gui', [
      testCase({
        defects: [
          { url: 'https://wiki.acme/page/bug' },
          { url: 'https://acme.atlassian.net/browse/QA-42' },
        ],
      }),
    ]);
    stub([[/\/issue\/QA-42/, { body: jiraIssue('QA-42', 'Готово', 'done') }]]);

    const result = await refreshDefectStates(deps(), readGroups(root));
    expect(result.checked).toBe(1);
    expect(result.skipped.join(' ')).toContain('не похож');
  });

  it('проект без дефектов не требует ни одной интеграции', async () => {
    const { urls } = stub([]);
    writeGroup('gui', [testCase({ status: 'passed' })]);

    expect(await refreshDefectStates(deps(), readGroups(root))).toEqual({
      checked: 0,
      closed: 0,
      recheck: [],
      skipped: [],
    });
    expect(urls).toEqual([]);
  });
});
