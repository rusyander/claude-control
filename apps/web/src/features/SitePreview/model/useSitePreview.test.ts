import { describe, expect, it } from 'vitest';
import type { ProjectRunnerView } from '@agentdeck/contracts';
import { sameRun, siteTarget } from './useSitePreview';

const run = (over: Partial<ProjectRunnerView> = {}): ProjectRunnerView =>
  ({
    path: 'C:/proj',
    dir: '',
    name: 'proj',
    status: 'running',
    port: 5999,
    url: 'http://127.0.0.1:5999/',
    startedAt: '2026-11-09T09:00:00.000Z',
    ...over,
  }) as ProjectRunnerView;

describe('окно сайта: тот же запуск', () => {
  it('тот же путь, порт, адрес и старт — тот же запуск', () => {
    expect(sameRun(run(), run())).toBe(true);
  });

  // Перезапуск между двумя опросами реестра: путь прежний, прокси прежнего запуска уже закрыт.
  it('перезапуск с новым портом и стартом — уже другой запуск', () => {
    const restarted = run({ port: 6001, url: 'http://127.0.0.1:6001/' });
    expect(sameRun(run(), restarted)).toBe(false);
  });

  it('перезапуск на том же порту, но с новым временем старта — тоже другой запуск', () => {
    expect(sameRun(run(), run({ startedAt: '2026-11-09T09:05:00.000Z' }))).toBe(false);
  });

  it('другая цель — другой запуск', () => {
    expect(sameRun(run(), run({ path: 'C:/proj/docs' }))).toBe(false);
  });
});

describe('окно сайта: какую цель открыть', () => {
  it('корень проекта — первым, без адреса цель не открывается', () => {
    const docs = run({ path: 'C:/proj/docs', dir: 'docs' });
    const root = run();
    const silent = run({ path: 'C:/proj/api', dir: 'api', port: undefined, url: undefined });
    expect(siteTarget([docs, silent, root])).toBe(root);
    expect(siteTarget([silent])).toBeUndefined();
  });
});
