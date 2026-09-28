import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Справка агента панели («Что агент умеет») стережётся описью
 * `apps/web/public/help/sources.json`: правка файла из описи краснит
 * `pnpm shots`, пока человек не перечитает документ. Файл действий, которого
 * в описи нет, меняет умения агента молча — справка врёт, и никто не узнаёт.
 * Здесь каждый файл действий обязан быть в описи темы panelAgent.
 */
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const ACTIONS_DIR = 'apps/server/src/routes/panel-agent/';

describe('опись справки агента панели', () => {
  it('каждый файл действий агента — под наблюдением темы panelAgent', () => {
    const manifest = JSON.parse(
      readFileSync(`${REPO}apps/web/public/help/sources.json`, 'utf8'),
    ) as { topics: Array<{ topic: string; sources: Array<{ path: string }> }> };
    const entry = manifest.topics.find((topic) => topic.topic === 'panelAgent');
    expect(entry).toBeDefined();
    const watched = new Set(entry!.sources.map((source) => source.path));
    const actionFiles = readdirSync(`${REPO}${ACTIONS_DIR}`)
      .filter((name) => /^actions(-[\w-]+)?\.ts$/.test(name) && !/\.test\.ts$/.test(name))
      .map((name) => `${ACTIONS_DIR}${name}`);
    expect(actionFiles.length).toBeGreaterThan(10);
    expect(actionFiles.filter((path) => !watched.has(path))).toEqual([]);
  });
});
