import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Каждый съёмщик справки, который сам поднимает сервер панели, отдаёт ему окружение через
 * `panel-core.mjs` (`panelEnv`) и снимает ядро в `finally` (`reapPanelCores`) — этап 10, зона C,
 * проход 7. Иначе надзор новой панели съёмки сядет на `~/.agentdeck/core` человека и шлюз 5179.
 * Съёмщики на `startStand` (`tools/qa/throwaway-stand.mjs`) изолированы стендом и сюда не входят.
 * `HELP_SHOTS_DIR` — каталог под проверкой (прежние копии для «красного до»).
 */

const DIR = process.env.HELP_SHOTS_DIR
  ? resolve(process.env.HELP_SHOTS_DIR)
  : resolve(import.meta.dirname, '..', '..', '..', '..', 'tools', 'help-shots');

/**
 * Исключения — со своим ядром без надзора и своим домом ядра (`AGENTDECK_CORE_HOME`): шлюз такого
 * ядра не открывается, дом человека не трогается.
 */
const OWN_CORE = new Set(['panel-agent-panel.mjs']);

const SPAWNS_SERVER = /['"/](?:apps\/server\/)?src\/index\.ts['"]/;

describe('help-shot shooters route the panel through panel-core', () => {
  it('every shooter that spawns the server uses panelEnv and reapPanelCores', () => {
    const shooters = readdirSync(DIR).filter(
      (name) => name.endsWith('.mjs') && SPAWNS_SERVER.test(readFileSync(join(DIR, name), 'utf8')),
    );
    expect(shooters.length).toBeGreaterThan(0);
    const missing = shooters
      .filter((name) => !OWN_CORE.has(name))
      .filter((name) => {
        const text = readFileSync(join(DIR, name), 'utf8');
        return !/await panelEnv\(/.test(text) || !/reapPanelCores\(\)/.test(text);
      });
    expect(missing).toEqual([]);
  });
});
