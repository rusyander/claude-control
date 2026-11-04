import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KIT_ASSETS,
  LEDGER,
  checkTwins,
  fingerprint,
  globalDirOf,
  recordTwins,
  type TwinLedger,
} from '../../../../../tools/kit-twins.mjs';

/**
 * Одно и то же поведение живёт в двух копиях: в наборе панели и в личном слое
 * `~/.claude`. Сверка `tools/kit-twins.mjs` превращает «поддерживать в обоих»
 * из привычки в проверку: правка одной копии без переноса во вторую — красная.
 * Здесь каждый вид расхождения подложен в песочницу и обязан покраснеть, а
 * последний блок гоняет настоящий реестр по настоящим файлам.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const KIT_HOOKS = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash|AskUserQuestion',
        hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/lib/run.mjs" pre' }],
      },
    ],
  },
});
const settingsWith = (matcher: string) =>
  JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher,
          hooks: [{ type: 'command', command: 'node "/h/.claude/hooks/pre-tool-dispatch.mjs"' }],
        },
      ],
    },
  });

/** Песочница: обе стороны, одна пара `same`, один перенос, по файлу на каждой стороне без пары. */
function fixture(): { kitAssets: string; globalDir: string; ledger: TwinLedger } {
  const root = mkdtempSync(join(tmpdir(), 'kit-twins-'));
  dirs.push(root);
  const kitAssets = join(root, 'assets');
  const globalDir = join(root, 'claude');
  const kitLib = join(kitAssets, 'agentdeck-kit', 'hooks', 'lib');
  put(join(kitLib, 'guard.mjs'), 'export default () => null;\n');
  put(join(kitLib, 'ported.mjs'), 'export const where = "kit";\n');
  put(join(kitLib, 'items.mjs'), "export const MANIFEST = { pre: ['guard'] };\n");
  put(join(kitAssets, 'agentdeck-kit', 'hooks', 'hooks.json'), KIT_HOOKS);
  put(join(kitAssets, 'agentdeck-kit', 'rules', 'forge.md'), '# forge, de-branded\n');
  put(join(kitAssets, 'agentdeck-kit', 'tools', 'helper.mjs'), '// kit only, loose root\n');
  // Та же пара с CRLF: концы строк не расхождение.
  put(join(globalDir, 'hooks', 'lib', 'guard.mjs'), 'export default () => null;\r\n');
  put(join(globalDir, 'hooks', 'lib', 'ported.mjs'), 'export const where = "global";\n');
  put(join(globalDir, 'hooks', 'lib', 'audit.mjs'), '// owner only\n');
  put(join(globalDir, 'hooks', 'pre-tool-dispatch.mjs'), "const groups = ['guard'];\n");
  put(join(globalDir, 'rules', 'company-protocol.md'), '# forge, company names\n');
  put(join(globalDir, 'rules', 'acme-frontend.md'), '# a private project card\n');
  put(join(globalDir, 'settings.json'), settingsWith('Bash|AskUserQuestion'));
  const base: TwinLedger = {
    roots: [
      {
        id: 'lib',
        kit: 'agentdeck-kit/hooks/lib',
        global: 'hooks/lib',
        pattern: '\\.mjs$',
        strict: true,
      },
      {
        id: 'rules',
        kit: 'agentdeck-kit/rules',
        global: 'rules',
        pattern: '^[^/]+\\.md$',
        strict: true,
        rename: { 'forge.md': 'company-protocol.md' },
        globalPrivate: { pattern: '^[^/]+-frontend\\.md$', why: 'private' },
      },
      {
        id: 'tools',
        kit: 'agentdeck-kit/tools',
        global: 'tools',
        pattern: '\\.mjs$',
        strict: false,
      },
    ],
    pairs: {},
    kitOnly: { 'lib:items.mjs': 'kit plumbing' },
    globalOnly: { 'lib:audit.mjs': 'owner only' },
    wiring: [
      { module: 'guard', tools: ['Bash', 'AskUserQuestion'], apply: 'node apply.mjs --apply' },
    ],
  };
  const ledger = recordTwins({ kitAssets, globalDir, ledger: base, init: true });
  return { kitAssets, globalDir, ledger };
}

const problemKeys = (result: ReturnType<typeof checkTwins>) => result.problems.map((p) => p.key);

describe('kit-twins drift check', () => {
  it('records the pairs it finds and stays green on a consistent fixture', () => {
    const { kitAssets, globalDir, ledger } = fixture();
    expect(ledger.pairs['lib:guard.mjs']?.same).toBe(true);
    expect(ledger.pairs['lib:ported.mjs']?.same).toBe(false);
    // Пара под разными именами сошлась на одном ключе, личная карточка проекта не названа.
    expect(ledger.pairs['rules:forge.md']).toBeDefined();
    expect(Object.keys(ledger.globalOnly)).toEqual(['lib:audit.mjs']);
    expect(checkTwins({ kitAssets, globalDir, ledger })).toEqual({ problems: [], warnings: [] });
  });

  it('a `same` pair edited on one side only is red', () => {
    const { kitAssets, globalDir, ledger } = fixture();
    put(
      join(globalDir, 'hooks', 'lib', 'guard.mjs'),
      'export default () => ({ decision: "deny" });\n',
    );
    const result = checkTwins({ kitAssets, globalDir, ledger });
    expect(result.problems).toContainEqual({
      key: 'lib:guard.mjs',
      text: 'marked same, but the two copies differ: copy one over the other',
    });
    // Перезапись отпечатков не лечит `same`: пара так и остаётся красной, пока копии не равны.
    const accepted = recordTwins({ kitAssets, globalDir, ledger, accept: 'lib:guard.mjs' });
    expect(problemKeys(checkTwins({ kitAssets, globalDir, ledger: accepted }))).toEqual([
      'lib:guard.mjs',
    ]);
  });

  it('a ported pair is red when EITHER side moves, green again after --accept', () => {
    const { kitAssets, globalDir, ledger } = fixture();
    put(
      join(kitAssets, 'agentdeck-kit', 'hooks', 'lib', 'ported.mjs'),
      'export const where = "kit2";\n',
    );
    const kitMoved = checkTwins({ kitAssets, globalDir, ledger });
    expect(kitMoved.problems.map((p) => p.text)).toEqual([
      expect.stringMatching(
        /^kit side changed .*port the change to hooks\/lib\/ported\.mjs, then --accept lib:ported\.mjs$/,
      ),
    ]);
    const accepted = recordTwins({ kitAssets, globalDir, ledger, accept: 'lib:ported.mjs' });
    expect(checkTwins({ kitAssets, globalDir, ledger: accepted }).problems).toEqual([]);
    put(join(globalDir, 'rules', 'company-protocol.md'), '# forge, company names, new step\n');
    const globalMoved = checkTwins({ kitAssets, globalDir, ledger: accepted });
    expect(globalMoved.problems).toEqual([
      { key: 'rules:forge.md', text: expect.stringMatching(/^global side changed /) },
    ]);
  });

  it('a file outside the ledger on a strict root is red, on a loose root it is not', () => {
    const { kitAssets, globalDir, ledger } = fixture();
    put(join(kitAssets, 'agentdeck-kit', 'hooks', 'lib', 'new-guard.mjs'), '//\n');
    put(join(globalDir, 'hooks', 'lib', 'new-audit.mjs'), '//\n');
    put(join(globalDir, 'tools', 'personal.mjs'), '//\n');
    put(join(globalDir, 'rules', 'other-frontend.md'), '# private card\n');
    const { problems } = checkTwins({ kitAssets, globalDir, ledger });
    expect(problems).toHaveLength(2);
    expect(problems).toEqual(
      expect.arrayContaining([
        {
          key: 'lib:new-audit.mjs',
          text: 'global-only file not in the ledger: say why in globalOnly (--init)',
        },
        {
          key: 'lib:new-guard.mjs',
          text: 'kit-only file not in the ledger: say why in kitOnly (--init)',
        },
      ]),
    );
  });

  it('a file appearing on both sides without a pair is red, and so is a one-sided entry that became two', () => {
    const { kitAssets, globalDir, ledger } = fixture();
    put(join(globalDir, 'hooks', 'lib', 'items.mjs'), '// now global too\n');
    put(join(kitAssets, 'agentdeck-kit', 'tools', 'shared.mjs'), '//\n');
    put(join(globalDir, 'tools', 'shared.mjs'), '//\n');
    expect(checkTwins({ kitAssets, globalDir, ledger }).problems).toEqual([
      {
        key: 'lib:items.mjs',
        text: 'on both sides but not in the ledger: add it as a pair (--init), port or mark same',
      },
      {
        key: 'tools:shared.mjs',
        text: 'on both sides but not in the ledger: add it as a pair (--init), port or mark same',
      },
    ]);
  });

  it('stale entries are red: a pair whose file is gone, a one-sided entry whose file is gone', () => {
    const { kitAssets, globalDir, ledger } = fixture();
    rmSync(join(globalDir, 'hooks', 'lib', 'guard.mjs'));
    rmSync(join(globalDir, 'hooks', 'lib', 'audit.mjs'));
    rmSync(join(kitAssets, 'agentdeck-kit', 'hooks', 'lib', 'items.mjs'));
    const texts = checkTwins({ kitAssets, globalDir, ledger }).problems.map(
      (p) => `${p.key} ${p.text}`,
    );
    expect(texts).toContain(
      'lib:guard.mjs pair recorded but hooks/lib/guard.mjs is missing in the global layer',
    );
    expect(texts).toContain('lib:audit.mjs globalOnly entry is stale: the file is gone');
    expect(texts).toContain('lib:items.mjs kitOnly entry is stale: the file is gone');
  });

  it('without a personal layer (CI, another machine) the kit side is still held to its fingerprints', () => {
    const { kitAssets, ledger } = fixture();
    expect(checkTwins({ kitAssets, globalDir: null, ledger }).problems).toEqual([]);
    put(join(kitAssets, 'agentdeck-kit', 'hooks', 'lib', 'guard.mjs'), 'export default () => 1;\n');
    expect(problemKeys(checkTwins({ kitAssets, globalDir: null, ledger }))).toEqual([
      'lib:guard.mjs',
    ]);
  });

  it('wiring: the kit manifest and matcher are red, the owner settings.json is a warning naming the script', () => {
    const { kitAssets, globalDir, ledger } = fixture();
    put(join(globalDir, 'settings.json'), settingsWith('Bash'));
    const settingsMiss = checkTwins({ kitAssets, globalDir, ledger });
    expect(settingsMiss.problems).toEqual([]);
    expect(settingsMiss.warnings).toEqual([
      {
        key: 'wiring:guard',
        text: 'settings.json PreToolUse matcher misses AskUserQuestion — owner runs: node apply.mjs --apply',
      },
    ]);
    put(
      join(kitAssets, 'agentdeck-kit', 'hooks', 'lib', 'items.mjs'),
      'export const MANIFEST = { pre: [] };\n',
    );
    put(join(globalDir, 'hooks', 'pre-tool-dispatch.mjs'), 'const groups = [];\n');
    const unwired = recordTwins({ kitAssets, globalDir, ledger, accept: '*' });
    expect(checkTwins({ kitAssets, globalDir, ledger: unwired }).problems).toEqual([
      { key: 'wiring:guard', text: 'kit manifest (hooks/lib/items.mjs) does not run guard' },
      { key: 'wiring:guard', text: 'global hooks/pre-tool-dispatch.mjs does not load guard' },
    ]);
  });

  it('globalDirOf: --global wins, a directory without hooks/lib is no personal layer', () => {
    const { globalDir } = fixture();
    expect(globalDirOf(['--global', globalDir], {})).toBe(globalDir);
    expect(globalDirOf([], { KIT_TWINS_GLOBAL: join(globalDir, 'rules') })).toBeNull();
    expect(fingerprint('a\r\nb')).toBe(fingerprint('a\nb'));
  });
});

describe('kit-twins on the real ledger', () => {
  it('the shipped kit and this machine’s personal layer carry no unported drift', () => {
    const ledger = JSON.parse(readFileSync(LEDGER, 'utf8')) as TwinLedger;
    const globalDir = globalDirOf([], process.env);
    const { problems } = checkTwins({ kitAssets: KIT_ASSETS, globalDir, ledger });
    expect(problems).toEqual([]);
    // Новые стражи обязаны быть побайтно равными в обеих копиях, а не «перенесёнными».
    for (const key of [
      'hooks-lib:forge-merge-guard.mjs',
      'hooks-lib:mcp-shape-guard.mjs',
      'hooks-lib:nvm-use-guard.mjs',
    ])
      expect(ledger.pairs[key]?.same).toBe(true);
  });
});
