import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * search-discipline комплекта, ветка Bash: `grep -r` от корня дерева с node_modules обходит каждый
 * файл зависимостей до любого `| grep -v node_modules` (фильтр режет вывод, не обход) — в прогоне
 * группы 71 с там, где инструмент Grep (ripgrep, учитывает .gitignore) или `git grep` укладываются
 * в секунды. Запуск — через диспетчер событий, как его зовёт hooks.json.
 */

const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-search-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Деревья: repo — node_modules в корне, mono — уровнем ниже (рабочая копия из нескольких
// приложений), plain — без них.
const REPO = join(dir, 'repo');
const MONO = join(dir, 'mono');
const PLAIN = join(dir, 'plain');
mkdirSync(join(REPO, 'node_modules', 'dep'), { recursive: true });
mkdirSync(join(REPO, 'inst-api'), { recursive: true });
mkdirSync(join(MONO, 'web-ui', 'node_modules'), { recursive: true });
mkdirSync(PLAIN, { recursive: true });

let n = 0;
const say = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const use = (name: string, input: object, id: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, content: string, isError = false) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
  },
});

function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}

/** Причина отказа search-discipline; '' — пропуск (чужие стражи сюда не считаются). */
function pre(tool_name: string, tool_input: object, cwd: string, records: object[]): string {
  const out = spawnSync(process.execPath, [DISPATCH, 'pre'], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name,
      tool_input,
      transcript_path: transcript(records),
      session_id: 'kit-search',
      cwd,
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
  const reason = out
    ? ((JSON.parse(out) as { hookSpecificOutput?: { permissionDecisionReason?: string } })
        .hookSpecificOutput?.permissionDecisionReason ?? '')
    : '';
  return reason.includes('search-discipline') ? reason : '';
}

const ASK = [say('find where X is used')];
const bash = (command: string, cwd: string, records: object[] = ASK) =>
  pre('Bash', { command }, cwd, records);
const G0 =
  'grep -rln "tool_guardrails\\|tool_display_name" --include=*.go --include=*.ts . | grep -v node_modules | head -20';
const REFUSED = '[ctx-guard] search-discipline (grep): walks';

describe('search-discipline: grep -r по дереву с node_modules', () => {
  it('B1 grep -r от корня с node_modules — к инструменту Grep', () => {
    const r = bash('grep -rn "x" --include=*.go .', REPO);
    expect(r).toContain('Grep tool');
    expect(r).toContain('git grep -n');
    expect(r).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('B2 node_modules уровнем ниже тоже считается', () => {
    expect(bash('grep -R x .', MONO)).not.toBe('');
  });

  it('B3 конвейер из прогона группы ловится', () => {
    expect(bash(G0, REPO)).not.toBe('');
  });

  it('B4 grep -r без пути ищет в рабочей папке', () => {
    expect(bash('grep -rn needle', REPO)).not.toBe('');
  });

  it('B5 дерево без node_modules — пропуск', () => {
    expect(bash('grep -rn x .', PLAIN)).toBe('');
  });

  it('B6 --exclude-dir=node_modules — пропуск', () => {
    expect(bash('grep -rn x . --exclude-dir=node_modules', REPO)).toBe('');
  });

  it('B7 нерекурсивный grep — пропуск', () => {
    expect(bash('git log --oneline | grep -n fix', REPO)).toBe('');
  });

  it('B8 git grep и rg — пропуск', () => {
    expect(bash('git grep -n x; rg -n x .', REPO)).toBe('');
  });

  it('B9 cd в чистое поддерево до grep — пропуск', () => {
    expect(bash('cd inst-api && grep -rn x .', REPO)).toBe('');
  });

  it('B10 cd в дерево с node_modules — отказ', () => {
    expect(bash(`cd "${REPO}" && grep -r x`, PLAIN)).not.toBe('');
  });

  it('B11 подпапка без node_modules — пропуск', () => {
    expect(bash('grep -rn x inst-api --include=*.go', REPO)).toBe('');
  });

  it('B12 с -e первое слово — путь, а не шаблон', () => {
    expect(bash('grep -r -e x -e y inst-api', REPO)).toBe('');
  });

  // g5 27.10: шаблон `"<Button"` в кавычках читался перенаправлением и пропадал — путь становился
  // шаблоном, и grep по подпапке отказывался как обход `.`.
  it('B16 «<» в кавычках — шаблон; перенаправление без кавычек по-прежнему снимается', () => {
    expect(bash('grep -rn "<Button" -A4 inst-api | grep -n "icon=" | head -5', REPO)).toBe('');
    expect(bash("grep -rn '>x' inst-api", REPO)).toBe('');
    expect(bash('grep -rn x 2>/dev/null', REPO)).not.toBe('');
  });

  // g9 26.10: `grep -rn … inst-admin-ui/*.json` отказан как обход всего inst-admin-ui.
  it('B15 маска в последнем сегменте называет файлы, а не дерево', () => {
    writeFileSync(join(MONO, 'web-ui', 'package.json'), '{}');
    expect(bash('grep -rn x web-ui/*.json web-ui/.tests* 2>/dev/null | head', MONO)).toBe('');
  });

  it('B16 маска в последнем сегменте, задевшая node_modules, — отказ', () => {
    expect(bash('grep -rn x web-ui/*', MONO)).not.toBe('');
  });

  it('B17 маска выше последнего сегмента читается осторожно — отказ', () => {
    expect(bash('grep -rn x */src', MONO)).not.toBe('');
  });

  it('B13 тот же вызов после отказа проходит', () => {
    expect(
      bash(G0, REPO, [
        say('find it'),
        use('Bash', { command: G0 }, 'g1'),
        result('g1', REFUSED, true),
      ]),
    ).toBe('');
  });

  it('B14 отказ grep не считается подсказкой об обходе', () => {
    const records: object[] = [
      say('do it, use agents for the search'),
      use('Bash', { command: G0 }, 'g2'),
      result('g2', REFUSED, true),
    ];
    for (let i = 0; i < 13; i += 1)
      records.push(use('Grep', { pattern: `q${i}` }, `s${i}`), result(`s${i}`, `hit ${i}`));
    expect(pre('Grep', { pattern: 'newSymbol' }, REPO, records)).toContain('read-only calls');
  });
});
