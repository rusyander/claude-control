import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Подсказка про `/tmp` в коде node на Windows (живой случай g8 #76, повтор #23): Git Bash
 * переводит `/tmp/x` только целым аргументом, а внутри `-e`, here-doc или строки в кавычках
 * node.exe получает `/tmp/x` как есть и читает `C:\tmp\x`. Подсказка — контекст, не отказ;
 * команда только оболочки, перенаправление и целый аргумент её не вызывают.
 */

const KIT = builtinKitDir();
const LIB = join(KIT, 'hooks', 'lib', 'node-tmp-hint.mjs');
const DISPATCH = join(KIT, 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-node-tmp-hint-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Lib = {
  HINT: string;
  rawTmpInNode: (command: string) => boolean;
  default: (input: object, platform?: string) => string | null;
};
const lib = (await import(pathToFileURL(LIB).href)) as Lib;

// Живой провал g8: bash записал в MSYS-temp, node искал C:\tmp.
const LIVE = `node -e "const o=require('/tmp/laneA-oldbase.json'); console.log(o.length)"`;
const BASH_ONLY = 'cat /tmp/x.json | head -5';

const HITS = [
  LIVE,
  `node -p "require('fs').readFileSync('/tmp/x.json','utf8').length"`,
  `cd /c/w && node -e 'require("fs").writeFileSync("/tmp/out.txt", "1")' && cat /tmp/out.txt`,
  `node --input-type=module <<'EOF'\nimport { readFileSync } from 'node:fs';\nreadFileSync('/tmp/a.json');\nEOF`,
  `node <<< "require('/tmp/b.json')"`,
  `MSYS_NO_PATHCONV=1 node script.mjs /tmp/c.json`,
  `git diff > /tmp/d.diff; node -e "require('fs').statSync('/tmp/d.diff')"`,
];

const MISSES = [
  BASH_ONLY,
  'ls /tmp && rm -f /tmp/old.log',
  'node script.mjs /tmp/out.json',
  'node script.mjs --out=/tmp/out.json',
  `node -e "console.log(1)" > /tmp/out.txt 2>/tmp/err.txt`,
  `node -e "require('$(cygpath -m /tmp)/x.json')"`,
  `cat > /tmp/s.mjs <<'EOF'\nconsole.log('/tmp/not-node')\nEOF\nnode /tmp/s.mjs`,
  `node -e "require(process.argv[1])" /tmp/x.json`,
  // Перенаправление — дело bash и при выключенном переводе путей.
  `MSYS_NO_PATHCONV=1 node -e "console.log(1)" > /tmp/out.txt`,
  // Текст файла, записанный here-doc'ом, — не команда.
  `cat > notes.md <<'EOF'\nnode -e "require('/tmp/x.json')"\nEOF`,
  'echo /tmp/nodes',
];

describe('node-tmp-hint — /tmp внутри кода node на win32', () => {
  it.each(HITS)('подсказка: %s', (c) => expect(lib.rawTmpInNode(c)).toBe(true));
  it.each(MISSES)('молчит: %s', (c) => expect(lib.rawTmpInNode(c)).toBe(false));

  it('только Windows и только Bash', () => {
    const input = { tool_name: 'Bash', tool_input: { command: LIVE } };
    expect(lib.default(input, 'win32')).toBe(lib.HINT);
    expect(lib.default(input, 'linux')).toBeNull();
    expect(lib.default({ ...input, tool_name: 'PowerShell' }, 'win32')).toBeNull();
    // Совет подсказки сам по себе — верная форма и не вызывает её снова.
    expect(lib.HINT).toContain('$(cygpath -m /tmp)');
  });

  // Сквозной путь: диспетчер run.mjs pre → пункт rules → additionalContext, никакого отказа.
  it.skipIf(process.platform !== 'win32')(
    'диспетчер набора отдаёт подсказку контекстом, не отказом',
    () => {
      const run = (command: string) => {
        const out = spawnSync(process.execPath, [DISPATCH, 'pre'], {
          input: JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command },
            session_id: 'nodetmphint01',
            cwd: dir,
          }),
          encoding: 'utf8',
          env: {
            ...process.env,
            AGENTDECK_KIT_VARIANT: '',
            AGENTDECK_STEP_KIND: '',
            AGENTDECK_KIT_STATE: join(dir, 'state'),
          },
          timeout: 15_000,
        }).stdout.trim();
        return out
          ? (JSON.parse(out) as {
              hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string };
            })
          : {};
      };
      const hit = run(LIVE);
      expect(hit.hookSpecificOutput?.additionalContext ?? '').toContain('node-tmp-hint');
      expect(hit.hookSpecificOutput?.permissionDecision).not.toBe('deny');
      expect(run(BASH_ONLY).hookSpecificOutput?.additionalContext ?? '').not.toContain(
        'node-tmp-hint',
      );
    },
  );
});
