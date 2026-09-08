import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectTestGroup, ProjectTestRunRecord } from '@agentdeck/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStore } from '../../lib/app-store.ts';
import { writeSettings, writeToken } from '../integrations/store.ts';
import {
  collectSource,
  DEFAULT_DIFF_RANGE,
  stampOf,
  type GenerateSourceDeps,
} from './generate-sources.ts';
import { writeRun } from './runs-store.ts';

/**
 * Материал для генерации.
 *
 * Главное здесь — отказы. Источник, который не собрался, обязан остановить
 * прогон с причиной: генерация «по требованию QA-42», не увидевшая QA-42,
 * напишет правдоподобные кейсы ни о чём, и отличить их от настоящих будет
 * нечем. Поэтому в каждом источнике проверяется и удачный сбор, и то, что
 * пустое место названо словами.
 */

let dir = '';
let store: AppStore;
let root = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-gensrc-'));
  store = new AppStore(dir);
  root = join(dir, 'repo');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const deps = (): GenerateSourceDeps => ({ store, appDataDir: dir, root });

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

function stubIssue(reply: { status?: number; body?: unknown }): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
      }),
    ),
  );
}

const groups = (): ProjectTestGroup[] => [
  {
    id: 'gui',
    title: 'GUI',
    file: '.agent/tests/gui.tests.json',
    cases: [
      {
        id: 'gui-001',
        type: 'case',
        title: 'Отправка сообщения',
        steps: [{ action: 'нажать «Отправить»', expected: 'сообщение в ленте' }],
        status: 'failed',
        source: 'human',
        defects: [{ url: 'https://acme.atlassian.net/browse/QA-77' }],
      },
    ],
  },
];

describe('project-tests/generate-sources: по коду', () => {
  it('источник «код» материала не собирает — это обычная генерация', async () => {
    expect(
      await collectSource(deps(), { projectPath: root, mode: 'generate' }, []),
    ).toBeUndefined();
    expect(
      await collectSource(deps(), { projectPath: root, mode: 'generate', source: 'code' }, []),
    ).toBeUndefined();
  });
});

describe('project-tests/generate-sources: след источника', () => {
  it('генерация по коду следа не оставляет — проставлять нечего', () => {
    expect(stampOf(undefined)).toBeUndefined();
    expect(stampOf({ source: 'code' })).toBeUndefined();
  });

  it('из требования в след уходят ссылка и ключ — их панель кладёт кейсу сама', () => {
    expect(
      stampOf({
        source: 'requirement',
        requirement: { key: 'QA-42', url: 'https://acme/browse/QA-42', title: 'Вход' },
      }),
    ).toMatchObject({ requirementUrl: 'https://acme/browse/QA-42', requirementKey: 'QA-42' });
  });

  it('пути диффа режутся: сотня файлов в codePaths — это «всегда задето»', () => {
    const files = Array.from({ length: 40 }, (_, index) => `src/file-${index}.ts`);
    const stamp = stampOf({ source: 'diff', diff: { range: 'HEAD', files } });

    expect(stamp?.codePaths).toHaveLength(20);
    expect(stamp?.codePaths?.[0]).toBe('src/file-0.ts');
  });
});

describe('project-tests/generate-sources: требование', () => {
  const request = { projectPath: root, mode: 'generate', source: 'requirement' } as const;

  it('задача читается целиком: кейсы пишут по тексту, а не по заголовку', async () => {
    connectJira();
    stubIssue({
      body: {
        key: 'QA-42',
        fields: { summary: 'Вход по ссылке', description: 'Ссылка живёт 15 минут.' },
      },
    });

    const material = await collectSource(
      deps(),
      { ...request, projectPath: root, sourceRef: 'https://acme.atlassian.net/browse/qa-42' },
      [],
    );

    expect(material).toEqual({
      source: 'requirement',
      requirement: {
        key: 'QA-42',
        url: 'https://acme.atlassian.net/browse/QA-42',
        title: 'Вход по ссылке',
        description: 'Ссылка живёт 15 минут.',
      },
    });
  });

  it('без подключённой Jira прогон не начинается — причина названа', async () => {
    await expect(
      collectSource(deps(), { ...request, projectPath: root, sourceRef: 'QA-42' }, []),
    ).rejects.toThrow(/Jira не подключена/);
  });

  it('пустая ссылка — отказ, а не генерация по всему приложению', async () => {
    connectJira();
    await expect(
      collectSource(deps(), { ...request, projectPath: root, sourceRef: '  ' }, []),
    ).rejects.toThrow(/Не указано требование/);
  });

  it('молчание трекера доходит до человека вместе с ключом задачи', async () => {
    connectJira();
    stubIssue({ status: 500, body: { message: 'boom' } });

    await expect(
      collectSource(deps(), { ...request, projectPath: root, sourceRef: 'QA-42' }, []),
    ).rejects.toThrow(/QA-42/);
  });
});

describe('project-tests/generate-sources: дифф', () => {
  const request = { projectPath: root, mode: 'generate', source: 'diff' } as const;

  /** Репозиторий с одним коммитом и одной несохранённой правкой. */
  function repo(): void {
    const run = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true });
    run('init', '-q');
    run('config', 'user.email', 'qa@acme.io');
    run('config', 'user.name', 'QA');
    writeFileSync(join(root, 'send.ts'), 'export const send = () => 1;\n');
    mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
    writeFileSync(join(root, '.agent', 'tests', 'gui.tests.json'), '{"version":1,"cases":[]}\n');
    run('add', '-A');
    run('commit', '-qm', 'first');
    writeFileSync(join(root, 'send.ts'), 'export const send = () => 2;\n');
    writeFileSync(join(root, '.agent', 'tests', 'gui.tests.json'), '{"version":1,"cases":[1]}\n');
  }

  it('собираются пути, а не хунки: патч вытеснил бы из окна библиотеку', async () => {
    repo();

    const material = await collectSource(
      deps(),
      { ...request, projectPath: root, diffRange: 'HEAD' },
      [],
    );

    expect(material?.diff?.range).toBe('HEAD');
    expect(material?.diff?.files).toEqual(['send.ts']);
    expect(material?.diff?.summary).toBeTruthy();
  });

  it('сами кейсы из диффа выкинуты — иначе агент писал бы тесты на тесты', async () => {
    repo();

    const material = await collectSource(
      deps(),
      { ...request, projectPath: root, diffRange: 'HEAD' },
      [],
    );

    expect(material?.diff?.files.join(' ')).not.toContain('.agent/tests/');
  });

  it('пустое сравнение — отказ: генерировать нечего', async () => {
    repo();
    execFileSync('git', ['stash', '-u'], { cwd: root, stdio: 'ignore', windowsHide: true });

    await expect(
      collectSource(deps(), { ...request, projectPath: root, diffRange: 'HEAD' }, []),
    ).rejects.toThrow(/нет изменений/);
  });

  it('не репозиторий — отказ с названным диапазоном по умолчанию', async () => {
    await expect(collectSource(deps(), { ...request, projectPath: root }, [])).rejects.toThrow(
      new RegExp(DEFAULT_DIFF_RANGE.replace('..', '\\.\\.')),
    );
  });
});

describe('project-tests/generate-sources: провал', () => {
  const request = { projectPath: root, mode: 'generate', source: 'defect' } as const;

  const record = (): ProjectTestRunRecord => ({
    id: 'run-1',
    mode: 'run',
    actor: 'agent',
    status: 'done',
    startedAt: '2026-09-08T10:00:00.000Z',
    finishedAt: '2026-09-08T10:05:00.000Z',
    results: [
      {
        pointId: 'gui:gui-001',
        groupId: 'gui',
        caseId: 'gui-001',
        status: 'failed',
        note: 'сообщение пропало после перезагрузки',
        attachments: ['shot.png'],
      },
    ],
    summary: { total: 1, passed: 0, failed: 1, skipped: 0, blocked: 0 },
  });

  it('к шагам кейса добавляются заметка, вложения и ссылка на дефект', async () => {
    writeRun(root, record());

    const material = await collectSource(
      deps(),
      {
        ...request,
        projectPath: root,
        sourceCase: { groupId: 'gui', caseId: 'gui-001', runId: 'run-1' },
      },
      groups(),
    );

    expect(material?.defect).toEqual({
      groupId: 'gui',
      caseId: 'gui-001',
      title: 'Отправка сообщения',
      steps: ['нажать «Отправить» · ожидание: сообщение в ленте'],
      note: 'сообщение пропало после перезагрузки',
      attachments: ['shot.png'],
      url: 'https://acme.atlassian.net/browse/QA-77',
    });
  });

  it('без прогона кейс всё равно собирается — шаги есть, заметки нет', async () => {
    const material = await collectSource(
      deps(),
      { ...request, projectPath: root, sourceCase: { groupId: 'gui', caseId: 'gui-001' } },
      groups(),
    );

    expect(material?.defect?.note).toBeUndefined();
    expect(material?.defect?.attachments).toEqual([]);
    expect(material?.defect?.steps).toHaveLength(1);
  });

  it('кейса нет — отказ, а не пустое задание', async () => {
    await expect(
      collectSource(
        deps(),
        { ...request, projectPath: root, sourceCase: { groupId: 'gui', caseId: 'gui-404' } },
        groups(),
      ),
    ).rejects.toThrow(/gui-404/);
  });

  it('кейс не назван — отказ', async () => {
    await expect(
      collectSource(deps(), { ...request, projectPath: root }, groups()),
    ).rejects.toThrow(/Не указан кейс/);
  });
});
