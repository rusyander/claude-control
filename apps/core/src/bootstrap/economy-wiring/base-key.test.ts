import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../../adapters/index.ts';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import type { Prepared } from '../session-road/road.types.ts';
import { baseKeyOf } from './base-start.ts';

/**
 * Ключ замера базы (P87): слой человека входит хешем описи — правка CLAUDE.md, навыка или хука
 * меняет системную часть первого запроса, и прежний замер под новым слоем не годится.
 */

function prepared(config: string, cwd: string): Prepared {
  return {
    // Настоящий переходник: опись слоя читает он (`CliAdapter.inventory`), не загрузка.
    adapter: createAdapterRegistry().get('claude'),
    start: { stepKind: 'work' },
    spec: {
      layer: { hooks: 'off', skills: 'on' },
      tools: 'all',
      cwd,
      env: { pin: { CLAUDE_CONFIG_DIR: config, HOME: cwd, USERPROFILE: cwd } },
    },
  } as unknown as Prepared;
}

describe('baseKeyOf', () => {
  it('the layer hash follows the user layer inventory: same files → same key, an edit → another', () => {
    const root = tempDir('base-key-');
    const config = join(root, 'cfg');
    const cwd = join(root, 'work');
    mkdirSync(config, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(config, 'CLAUDE.md'), 'one\n');
    const first = baseKeyOf(prepared(config, cwd), 'mcp', '2.1.310');
    expect(baseKeyOf(prepared(config, cwd), 'mcp', '2.1.310')).toEqual(first);
    writeFileSync(join(config, 'CLAUDE.md'), 'two\n');
    const second = baseKeyOf(prepared(config, cwd), 'mcp', '2.1.310');
    expect(second.layerHash).not.toBe(first.layerHash);
    mkdirSync(join(cwd, '.claude', 'skills', 's'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'skills', 's', 'SKILL.md'), '---\nname: s\n---\nx\n');
    expect(baseKeyOf(prepared(config, cwd), 'mcp', '2.1.310').layerHash).not.toBe(second.layerHash);
  });
});
