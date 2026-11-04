import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJournal, clearJournal, readJournal } from './journal.ts';
import { resolveDlpUpstream } from './proxy-config.ts';

/**
 * Журнал срабатываний и выбор адреса наверх — общие для панели (страница, проверка перед
 * включением) и прокси ядра (C3c перенёс их из сервера; раньше их держал `DlpProxy.test.ts`).
 */

const entry = (path: string) => ({
  at: '2026-01-01T00:00:00Z',
  path,
  apiKind: 'anthropic',
  decision: 'passed' as const,
  bytes: 1,
  hits: [],
});

describe('журнал', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dlp-journal-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('свежие записи идут первыми, лимит берёт самые свежие', () => {
    for (const path of ['/a', '/b', '/c']) appendJournal(dir, entry(path));
    expect(readJournal(dir).map((item) => item.path)).toEqual(['/c', '/b', '/a']);
    expect(readJournal(dir, 2).map((item) => item.path)).toEqual(['/c', '/b']);
  });

  it('битая строка пропускается, а не роняет чтение', () => {
    appendJournal(dir, entry('/a'));
    writeFileSync(join(dir, 'dlp-journal.jsonl'), '{битое\n{"path":"/b"}\n', { flag: 'a' });
    expect(readJournal(dir)).toHaveLength(2);
  });

  it('очистка оставляет пустую ленту, а не отсутствующий файл', () => {
    appendJournal(dir, entry('/a'));
    clearJournal(dir);
    expect(readFileSync(join(dir, 'dlp-journal.jsonl'), 'utf8')).toBe('');
    expect(readJournal(dir)).toEqual([]);
  });

  it('нет файла — пустая лента', () => {
    expect(readJournal(dir)).toEqual([]);
  });
});

describe('адрес наверх', () => {
  const profiles = [{ id: 'local', baseUrl: 'http://127.0.0.1:8080/v1/' }];

  it('прямой адрес выигрывает у профиля, хвостовой слэш срезан', () => {
    expect(
      resolveDlpUpstream(
        { upstreamUrl: ' https://api.example.com/ ', upstreamProfileId: 'local' },
        profiles,
      ),
    ).toEqual({ url: 'https://api.example.com' });
  });

  it('без прямого адреса — baseUrl профиля', () => {
    expect(resolveDlpUpstream({ upstreamUrl: '', upstreamProfileId: 'local' }, profiles)).toEqual({
      url: 'http://127.0.0.1:8080/v1',
    });
  });

  it('пусто и там и там — отказ «не задан», а не облако вендора', () => {
    expect(resolveDlpUpstream({ upstreamUrl: '', upstreamProfileId: '' }, profiles)).toMatchObject({
      code: 'dlp-upstream-missing',
    });
    expect(
      resolveDlpUpstream({ upstreamUrl: '', upstreamProfileId: 'gone' }, profiles),
    ).toMatchObject({ code: 'dlp-upstream-missing' });
  });

  it('неразборчивый адрес и чужая схема называются своими кодами', () => {
    expect(resolveDlpUpstream({ upstreamUrl: 'не адрес', upstreamProfileId: '' }, [])).toEqual({
      code: 'dlp-upstream-unparsed',
      detail: 'адрес «не адрес» не разбирается',
      value: 'не адрес',
    });
    expect(
      resolveDlpUpstream({ upstreamUrl: 'ftp://x.example', upstreamProfileId: '' }, []),
    ).toMatchObject({ code: 'dlp-upstream-scheme' });
  });
});
