import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SUMMARIZED_CAP,
  adoptPanelSummarized,
  noteSummarized,
  resetSummarizedCache,
  summarizedInRun,
  summarizedMessageIds,
  summarizedReport,
} from './summarized-ledger.ts';

/**
 * Журнал сжатий: подпись под ответом держится на нём, поэтому проверяется то,
 * что её гасило бы, — перезапуск процесса, переполнение, испорченный файл — и
 * то, что подписало бы чужой ответ.
 */
describe('журнал сжатий истории', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-summarized-'));
    resetSummarizedCache();
  });

  afterEach(() => {
    resetSummarizedCache();
    rmSync(dir, { recursive: true, force: true });
  });

  const at = '2026-09-17T10:00:00.000Z';

  it('случай переживает перезапуск процесса: читается с диска, а не из памяти', () => {
    noteSummarized(dir, { at, platformId: 'c', path: '/c/v1/messages', messageId: 'msg_a-1' });
    resetSummarizedCache();
    expect([...summarizedMessageIds(dir)]).toEqual(['msg_a-1']);
    expect(JSON.parse(readFileSync(join(dir, 'platform-summarized.json'), 'utf8'))).toHaveLength(1);
  });

  it('метка прогона находит только свой прогон', () => {
    noteSummarized(dir, { at, platformId: 'c', path: '/c/v1/chat/completions', runTag: 'run-1' });
    expect(summarizedInRun(dir, 'run-1')).toBe(true);
    expect(summarizedInRun(dir, 'run-2')).toBe(false);
    // Пустая метка не совпадает с запросом без метки.
    noteSummarized(dir, { at, platformId: 'c', path: '/c/v1/chat/completions' });
    expect(summarizedInRun(dir, '')).toBe(false);
    expect(summarizedMessageIds(dir).size).toBe(0);
  });

  it('сводка: свежие сверху, привязка названа, всего — по журналу', () => {
    noteSummarized(dir, { at: '1', platformId: 'c', path: '/p', messageId: 'm' });
    noteSummarized(dir, { at: '2', platformId: 'c', path: '/p', runTag: 'r' });
    noteSummarized(dir, { at: '3', platformId: 'c', path: '/p' });
    const report = summarizedReport(dir);
    expect(report.total).toBe(3);
    expect(report.recent.map((item) => [item.at, item.link])).toEqual([
      ['3', 'none'],
      ['2', 'run'],
      ['1', 'message'],
    ]);
    // Ключи привязки наружу не уходят: карточке они не нужны.
    expect(report.recent[0]).not.toHaveProperty('messageId');
  });

  it('журнал ограничен: старейший случай уходит первым', () => {
    // Полный журнал — одной записью файла, а не SUMMARIZED_CAP перезаписями: 501 полная
    // перезапись растущего файла упиралась в 20 с под нагрузкой Linux-контейнера (07.11).
    const full = Array.from({ length: SUMMARIZED_CAP }, (_, i) => ({
      at: String(i),
      platformId: 'c',
      path: '/p',
      messageId: `m${i}`,
    }));
    writeFileSync(join(dir, 'platform-summarized.json'), JSON.stringify(full));
    noteSummarized(dir, {
      at: String(SUMMARIZED_CAP),
      platformId: 'c',
      path: '/p',
      messageId: `m${SUMMARIZED_CAP}`,
    });
    resetSummarizedCache();
    const ids = summarizedMessageIds(dir);
    expect(ids.size).toBe(SUMMARIZED_CAP);
    expect(ids.has('m0')).toBe(false);
    expect(ids.has(`m${SUMMARIZED_CAP}`)).toBe(true);
  });

  it('испорченный файл не роняет ленту и не даёт чужих подписей', () => {
    writeFileSync(join(dir, 'platform-summarized.json'), '{ не json');
    expect(summarizedMessageIds(dir).size).toBe(0);
    resetSummarizedCache();
    writeFileSync(join(dir, 'platform-summarized.json'), JSON.stringify([{ messageId: 'x' }, 5]));
    expect(summarizedMessageIds(dir).size).toBe(0);
  });

  describe('переезд журнала панели (C3b)', () => {
    let panel: string;
    beforeEach(() => {
      panel = mkdtempSync(join(tmpdir(), 'cc-summarized-panel-'));
    });
    afterEach(() => rmSync(panel, { recursive: true, force: true }));

    const legacy = (records: unknown[]) =>
      writeFileSync(join(panel, 'platform-summarized.json'), JSON.stringify(records));

    it('первый запуск звена: подписи старых ответов переезжают на диск звена', () => {
      legacy([
        { at, platformId: 'c', path: '/c/v1/messages', messageId: 'msg_old' },
        { at, platformId: 'c', path: '/c/r1/v1/chat', runTag: 'run-old' },
        { junk: true },
      ]);
      adoptPanelSummarized(dir, panel);
      resetSummarizedCache();
      expect([...summarizedMessageIds(dir)]).toEqual(['msg_old']);
      expect(summarizedInRun(dir, 'run-old')).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, 'platform-summarized.json'), 'utf8'))).toHaveLength(
        2,
      );
    });

    it('свой журнал уже есть — панель больше не читается', () => {
      noteSummarized(dir, { at, platformId: 'c', path: '/c/v1/messages', messageId: 'msg_new' });
      legacy([{ at, platformId: 'c', path: '/c/v1/messages', messageId: 'msg_old' }]);
      resetSummarizedCache();
      adoptPanelSummarized(dir, panel);
      expect([...summarizedMessageIds(dir)]).toEqual(['msg_new']);
    });

    it('у панели журнала нет или он испорчен — звено начинает с чистого листа', () => {
      adoptPanelSummarized(dir, panel);
      adoptPanelSummarized(dir, undefined);
      writeFileSync(join(panel, 'platform-summarized.json'), '{ не json');
      adoptPanelSummarized(dir, panel);
      expect(summarizedMessageIds(dir).size).toBe(0);
      expect(existsSync(join(dir, 'platform-summarized.json'))).toBe(false);
    });
  });
});
