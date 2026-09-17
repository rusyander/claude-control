import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTION_QUERY_KEYS, sectionQueryKeys } from './sectionKeys';

/**
 * Разделы и риски читаются из исходников реестра сервера, а не из списка,
 * переписанного сюда руками: новый раздел с правками без ключей оставил бы
 * открытую страницу на старом снимке после «выполнено».
 */
function registrySections(): { writes: Set<string>; all: Set<string> } {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', '..', '..', '..', '..', 'server', 'src', 'routes', 'panel-agent');
  const writes = new Set<string>();
  const all = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!/^actions.*\.ts$/.test(file) || file.includes('.test.')) continue;
    const source = readFileSync(join(dir, file), 'utf8');
    // Блок одного действия — от его `definePanelAction({` до следующего.
    const blocks = source.split('definePanelAction({').slice(1);
    for (const block of blocks) {
      const section = /\bsection:\s*'([a-z-]+)'/.exec(block)?.[1];
      const risk = /\brisk:\s*'([a-z]+)'/.exec(block)?.[1];
      if (!section) continue;
      all.add(section);
      if (risk && risk !== 'read') writes.add(section);
    }
    // Фабрика переключателей: раздел вычисляется, а не пишется литералом.
    if (source.includes('function toggleAction(')) {
      for (const section of ['skills', 'mcp', 'permissions']) {
        all.add(section);
        writes.add(section);
      }
    }
  }
  return { writes, all };
}

describe('ключи разделов агента панели', () => {
  const { writes, all } = registrySections();

  it('реестр прочитан (скан не пустой)', () => {
    expect(writes.size).toBeGreaterThan(10);
    expect(writes).toContain('plugins');
    expect(all).toContain('help');
  });

  it('у каждого раздела с правками есть ключи', () => {
    expect([...writes].filter((section) => !SECTION_QUERY_KEYS[section]?.length)).toEqual([]);
  });

  it('в карте нет разделов, которых нет в реестре', () => {
    expect(Object.keys(SECTION_QUERY_KEYS).filter((section) => !all.has(section))).toEqual([]);
  });

  it('неизвестный раздел и навигация — ничего не перечитываем', () => {
    expect(sectionQueryKeys(undefined)).toEqual([]);
    expect(sectionQueryKeys('navigation')).toEqual([]);
    expect(sectionQueryKeys('help')).toEqual([]);
  });

  it('смена провайдера перечитывает всё (пустой ключ совпадает с любым)', () => {
    expect(sectionQueryKeys('provider')).toEqual([[]]);
  });
});
