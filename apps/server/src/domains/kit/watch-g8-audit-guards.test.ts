import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Находки наблюдения за группой g8 (26.10), стражи набора.
 *
 * N1: только читающий `node -e "…execSync('git log -1')…console.log('a','->',o.count||1)"` судился как
 * запись в `<пакет>\,o.count`: режим spawn оставлял весь код интерпретатора, и стрелка `=>` и строка
 * `'->'` читались как перенаправления оболочки — карточка правила отказывала чтению как правке пакета.
 * Теперь в коде, который запускает процессы, оболочкой считаются только строки, а цель перенаправления
 * должна быть похожа на путь. Настоящая запись `execSync('cat a > b.ts')` по-прежнему цель.
 */

const LIB = join(builtinKitDir(), 'hooks', 'lib');
type Guard = {
  codeWrites: (raw: string, cwd?: string) => string[];
  markdownWrites: (raw: string, cwd?: string) => string[];
  inlineEdit: (raw: string, cwd?: string) => string | null;
};
type ShellText = { executedText: (raw: string, o?: { code?: string }) => string };
const guard = (await import(pathToFileURL(join(LIB, 'inline-edit-guard.mjs')).href)) as Guard;
const shell = (await import(pathToFileURL(join(LIB, 'shell-text.mjs')).href)) as ShellText;

const PKG = join('C:', 'work', 'proj', 'inst-docs-ui');
const MINIMAL = `node -e "const {execSync}=require('child_process');const o=execSync('git log -1').toString();console.log('a','->',o.count||1)"`;

describe('inline-edit-guard: запись в коде, который запускает процессы (g8 N1)', () => {
  it('только читающий node -e с execSync и «->» целей не называет', () => {
    expect(guard.codeWrites(MINIMAL, PKG)).toEqual([]);
  });

  it('стрелка и «->» в строке журнала из стенограммы целей не называют', () => {
    const transcript =
      `node -e "const {execSync}=require('child_process'); const a=JSON.parse(execSync('git show HEAD:q.json').toString()); ` +
      `const om=new Map(); const k=e=>e.page+'|'+e.kind; for (const e of a) om.set(k(e),e); ` +
      `for (const [key,e] of om) console.log('  ',key,om.get(key).count||1,'->',e.count||1)"`;
    expect(guard.codeWrites(transcript, PKG)).toEqual([]);
  });

  it('стрелка, возвращающая строку пути, — не перенаправление', () => {
    const arrow = `node -e "const {execSync}=require('child_process');const p=f=>'content/en/'+f;console.log(execSync('git ls-files').toString().split(' ').map(p))"`;
    expect(guard.codeWrites(arrow, PKG)).toEqual([]);
  });

  it('слово, не похожее на путь, после > целью не считается', () => {
    expect(guard.codeWrites('node x.mjs 2>&1 >&2; echo hi > ,o.count', PKG)).toEqual([]);
  });

  it('настоящая запись в запускаемой команде остаётся целью', () => {
    expect(
      guard.codeWrites(`node -e "require('child_process').execSync('cat a > b.ts')"`, PKG),
    ).toEqual([join(PKG, 'b.ts')]);
    expect(
      guard.codeWrites(
        `node -e "const c='echo x >> src/log.ts'; require('child_process').execSync(c)"`,
        PKG,
      ),
    ).toEqual([join(PKG, 'src', 'log.ts')]);
    expect(
      guard.codeWrites(
        `node <<'EOF'\nconst {execSync}=require('child_process');\nconst f=x=>x.count;\nexecSync('git show HEAD:a.json | tee out/a.json');\nEOF`,
        PKG,
      ),
    ).toEqual([join(PKG, 'out', 'a.json')]);
    expect(guard.codeWrites('cat x > src/a.tsx', PKG)).toEqual([join(PKG, 'src', 'a.tsx')]);
  });

  it('запись Markdown через запуск и правка кодом не ослаблены', () => {
    expect(
      guard.markdownWrites(`node -e "require('child_process').execSync('cat a > notes.md')"`, PKG),
    ).toHaveLength(1);
    expect(guard.inlineEdit(`node -e "require('fs').writeFileSync('src/a.ts','x')"`, PKG)).toBe(
      'inline code writing a file',
    );
  });

  it('режим spawn других стражей прежний; режим strings оставляет только строки', () => {
    const spawn = `node -e "const c='git push'; require('child_process').execSync(c)"`;
    expect(shell.executedText(spawn, { code: 'spawn' })).toContain('execSync(c)');
    const strings = shell.executedText(MINIMAL, { code: 'strings' });
    expect(strings).toContain('git log -1');
    expect(strings).not.toContain('console.log');
    expect(strings).toHaveLength(MINIMAL.length);
  });
});

/**
 * N5: план мутантов искался только от `--cwd`. `--cwd inst-docs-ui --mutants .agent/tmp/mutants.json`
 * падал ENOENT, хотя план лежал в корне, где стояла оболочка, — лишний ход на повтор с `../`. Теперь
 * сначала `--cwd`, затем каталог оболочки; не найден нигде — названы оба пути.
 */
describe('mustfail: путь плана мутантов (g8 N5)', () => {
  const TOOL = join(builtinKitDir(), 'tools', 'mustfail.mjs');
  const work = mkdtempSync(join(tmpdir(), 'kit-mf-plan-'));
  const shellDir = mkdtempSync(join(tmpdir(), 'kit-mf-shell-'));
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(shellDir, { recursive: true, force: true });
  });
  const LIB = 'exports.cap = (v) => (v > 100 ? 100 : v);\n';
  writeFileSync(join(work, 'lib.js'), LIB);
  writeFileSync(
    join(work, 't.cjs'),
    "const ok = require('./lib.js').cap(150) === 100;\n" +
      "console.log(`${ok ? 'ok' : 'not ok'} - caps at 100`);\nprocess.exit(ok ? 0 : 1);\n",
  );
  mkdirSync(join(shellDir, 'plans'));
  writeFileSync(
    join(shellDir, 'plans', 'p.json'),
    JSON.stringify([
      { file: 'lib.js', find: 'v > 100 ? 100', replace: 'v > 100 ? v', test: 'caps at 100' },
    ]),
  );
  const run = (plan: string) => {
    const r = spawnSync(
      process.execPath,
      [TOOL, '--cwd', work, '--cmd', 'node t.cjs', '--mutants', plan],
      { encoding: 'utf8', cwd: shellDir, timeout: 60_000 },
    );
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };

  it('план относительно каталога оболочки найден и прогнан, файл восстановлен', () => {
    const v = run('plans/p.json');
    expect(v.out).toMatch(/killed by the named test: not ok - caps at 100/);
    expect(v.status).toBe(0);
    expect(readFileSync(join(work, 'lib.js'), 'utf8')).toBe(LIB);
  });

  it('план, не найденный нигде, — выход 2 и оба испробованных пути', () => {
    const v = run('plans/none.json');
    expect(v.status).toBe(2);
    expect(v.out).toContain(join(work, 'plans', 'none.json'));
    expect(v.out).toContain(join(shellDir, 'plans', 'none.json'));
  });
});

/**
 * N7: сразу после сжатия `grep …; cat ../.agent/PROGRESS.md` прошёл дважды за 4 с — повтор чтения внутри
 * цепочки не судился (в наборе страж смотрел только Read). Теперь каждое звено цепочки — `cat`, `head`,
 * `sed -n a,bp`, `tail` — судится как Read того же файла: та же граница сжатия, тот же выход повтором,
 * вывод, ушедший в файл, чтением не считается, конвейер — работа. Через диспетчер `run.mjs`.
 */
describe('read-discipline: повтор чтения внутри цепочки Bash (g8 N7)', () => {
  const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
  const root = mkdtempSync(join(tmpdir(), 'kit-reread-'));
  const pkg = join(root, 'pkg');
  mkdirSync(join(root, '.agent'), { recursive: true });
  mkdirSync(pkg);
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const progress = join(root, '.agent', 'PROGRESS.md');
  writeFileSync(progress, '# PROGRESS\n\n- done: F-01..F-11\n');
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(progress, old, old);

  let k = 0;
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const use = (name: string, input: object, id: string, ts = at(-60_000)) => ({
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
  const result = (id: string, content: string, isError = false) => ({
    type: 'user',
    timestamp: at(-59_000),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
  });
  const say = (text: string) => ({
    type: 'user',
    timestamp: at(-120_000),
    message: { role: 'user', content: text },
  });
  const compact = () => ({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    timestamp: at(-90_000),
  });
  const pre = (command: string, records: object[]) => {
    const tp = join(root, `t${++k}.jsonl`);
    writeFileSync(tp, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const out = spawnSync(process.execPath, [DISPATCH, 'pre'], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        cwd: pkg,
        tool_name: 'Bash',
        tool_input: { command },
        transcript_path: tp,
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTDECK_KIT_VARIANT: '',
        AGENTDECK_HEAVY_QUEUE_DIR: '',
        AGENTDECK_KIT_STATE: join(root, 'state'),
      },
      timeout: 15_000,
    }).stdout.trim();
    const hook = out ? (JSON.parse(out) as { hookSpecificOutput?: Record<string, string> }) : {};
    return hook.hookSpecificOutput?.permissionDecision === 'deny'
      ? String(hook.hookSpecificOutput.permissionDecisionReason)
      : '';
  };
  const FIRST = 'grep -n "F-" ../.agent/PROGRESS.md | head -60; cat ../.agent/PROGRESS.md';
  const SECOND = 'ls ..; cat ../.agent/PROGRESS.md';
  const afterFirst = (body = '# PROGRESS …') => [
    say('продолжай'),
    compact(),
    use('Bash', { command: FIRST }, 'b1'),
    result('b1', body),
  ];

  it('второй cat неизменного файла в цепочке — отказ с советом убрать звено', () => {
    const reason = pre(SECOND, afterFirst());
    expect(reason).toMatch(/PROGRESS\.md \(whole file\) was already read/);
    expect(reason).toContain('Drop `cat ../.agent/PROGRESS.md`');
  });

  it('повтор той же команды после отказа проходит', () => {
    const records = [
      ...afterFirst(),
      use('Bash', { command: SECOND }, 'b2'),
      result('b2', '[ctx-guard] PROGRESS.md (whole file) was already read this session', true),
    ];
    expect(pre(SECOND, records)).toBe('');
  });

  it('чтение до сжатия, вывод в файле и конвейер повтором не считаются', () => {
    const before = [
      say('продолжай'),
      use('Bash', { command: FIRST }, 'b3', at(-200_000)),
      result('b3', '# PROGRESS …'),
      compact(),
    ];
    expect(pre(SECOND, before)).toBe('');
    expect(
      pre(SECOND, afterFirst('<persisted-output>Output too large (8.6KB)</persisted-output>')),
    ).toBe('');
    expect(pre('ls ..; cat ../.agent/PROGRESS.md | grep done', afterFirst())).toBe('');
  });

  it('Read файла, затем cat его же в цепочке после cd — отказ', () => {
    const records = [
      say('продолжай'),
      compact(),
      use('Read', { file_path: progress }, 'r1'),
      result('r1', '#'),
    ];
    expect(pre(`cd .. && cat .agent/PROGRESS.md`, records)).toMatch(/already read/);
    expect(pre(`cd "$D" && cat .agent/PROGRESS.md`, records)).toBe('');
  });
});
