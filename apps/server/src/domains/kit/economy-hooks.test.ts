import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Охранники экономии окна в ките: проверка всего проекта посреди задачи (`check-cost`),
 * выученная длительность команды (`cmd-duration`), серия одиночных чтений (`batch-nudge`)
 * и правка файла встроенным кодом мимо Edit/Write (`inline-edit-guard`). Запуск — через
 * диспетчер событий, как его зовёт hooks.json: глобальный набор проверяет только свою копию.
 */

const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-economy-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Каталог в ключе выученной длительности — как у кита (`cmd-duration.mjs`): регистр складывается
 * только там, где диск его не различает. Модуль кита сюда не импортируется: при загрузке он
 * заводит каталог состояния в настоящем доме.
 */
const foldCase = (path: string): string =>
  process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;

let n = 0;
const prompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
// Отказ хука доходит до модели как результат с меткой охранника — по нему кит узнаёт повтор.
const bashTurn = (command: string, body = 'ok') => {
  const id = `u${++n}`;
  return [
    {
      type: 'assistant',
      message: {
        id: `m${n}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
      },
    },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body }] },
    },
  ];
};

function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}

function run(
  event: 'pre' | 'post-any' | 'post-fail',
  payload: object,
  env: NodeJS.ProcessEnv = {},
): string {
  const out = spawnSync(process.execPath, [DISPATCH, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      AGENTDECK_KIT_STATE: join(dir, 'state'),
      ...env,
    },
    timeout: 15_000,
  });
  return out.stdout.trim();
}

const reason = (stdout: string): string | undefined =>
  stdout
    ? (
        JSON.parse(stdout) as {
          hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
        }
      ).hookSpecificOutput?.permissionDecisionReason
    : undefined;

const pre = (command: string, records: object[], extra: Record<string, unknown> = {}) =>
  reason(
    run('pre', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command, ...((extra.tool_input as object) ?? {}) },
      transcript_path: transcript(records),
      session_id: 'kit-economy',
      cwd: (extra.cwd as string) ?? dir,
      tool_use_id: extra.tool_use_id,
    }),
  );

// Репозиторий с одной правкой: check-cost судит только при тронутых файлах.
const repo = join(dir, 'repo');
mkdirSync(repo, { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: repo });
writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');

describe('check-cost: проверка всего проекта посреди задачи', () => {
  it('pnpm lint при тронутом файле — отказ с узкой командой на этот файл', () => {
    const text = pre('pnpm lint', [prompt('поправь a')], { cwd: repo });
    expect(text).toMatch(/check-cost: a whole-project lint/);
    expect(text).toContain('npx eslint "a.ts"');
  });

  it('узкий запуск, просьба человека и повтор той же команды проходят', () => {
    expect(pre('npx eslint a.ts', [prompt('поправь a')], { cwd: repo })).toBeUndefined();
    expect(pre('pnpm lint', [prompt('прогони линт')], { cwd: repo })).toBeUndefined();
    const refused = [prompt('поправь a'), ...bashTurn('pnpm lint', '[ctx-guard] check-cost: …')];
    expect(pre('pnpm lint', refused, { cwd: repo })).toBeUndefined();
  });

  it('тайпчек и тесты отклоняются, только когда выучено, что они медленные', () => {
    // Отказ стоит хода модели — дороже быстрой проверки; 45 % отклонённых шли меньше 20 с.
    const command = 'npx tsc --noEmit';
    expect(pre(command, [prompt('поправь a')], { cwd: repo })).toBeUndefined();
    const file = join(dir, 'state', 'durations', 'cmd-durations.json');
    mkdirSync(dirname(file), { recursive: true });
    const write = (runs: number[]) =>
      writeFileSync(
        file,
        JSON.stringify({
          keys: { [`${foldCase(repo)}|${command}`]: { runs, kills: 0, last: Date.now() } },
          pending: {},
        }),
      );
    write([12, 14, 15]);
    expect(pre(command, [prompt('поправь a')], { cwd: repo })).toBeUndefined();
    write([80, 95, 90]);
    expect(pre(command, [prompt('поправь a')], { cwd: repo })).toMatch(/whole-project types/);
    rmSync(file);
  });

  it('скрипт-раннер по пути — проверка всего проекта, именованный тест — узкий', () => {
    // Слово с косой чертой из разбора выпадает: `node scripts/lint.mjs` читался узким.
    expect(pre('node scripts/lint.mjs', [prompt('поправь a')], { cwd: repo })).toMatch(
      /whole-project lint/,
    );
    expect(pre('node tests/a.test.mjs', [prompt('поправь a')], { cwd: repo })).toBeUndefined();
  });

  it('без тронутых файлов молчит', () => {
    const clean = join(dir, 'clean');
    mkdirSync(clean, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: clean });
    expect(pre('pnpm lint', [prompt('поправь a')], { cwd: clean })).toBeUndefined();
  });
});

describe('cmd-duration: длительность команды выучивается между вызовами', () => {
  it('первый запуск молчит, после долгого прогона та же команда уходит в фон', () => {
    const command = 'node slow-build.mjs';
    expect(pre(command, [prompt('собери')], { tool_use_id: 'slow1' })).toBeUndefined();
    // Пост закрывает отметку старта; длительность подменяем записью в хранилище кита.
    run('post-any', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: 'slow1',
      tool_response: 'ok',
      transcript_path: transcript([prompt('собери')]),
      session_id: 'kit-economy',
      cwd: dir,
    });
    const file = join(dir, 'state', 'durations', 'cmd-durations.json');
    const store = JSON.parse(readFileSync(file, 'utf8')) as {
      keys: Record<string, { runs: number[] }>;
    };
    const entries = Object.values(store.keys);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.runs).toHaveLength(1);
    // Порядок записей — порядок прогонов; медиана берётся по отсортированным.
    for (const entry of entries) entry.runs = [500, 30, 420];
    writeFileSync(file, JSON.stringify(store));
    expect(pre(command, [prompt('собери')])).toMatch(/took ~420 s.*run_in_background: true/);
    // Точный повтор после отказа проходит: человек или модель решили гнать на переднем плане.
    const refused = bashTurn(command, 'PreToolUse:Bash hook error: [ctx-guard] cmd-duration: …');
    expect(pre(command, [prompt('собери'), ...refused])).toBeUndefined();
    // Локальная модель гонит на переднем плане — ей нужен только достаточный timeout.
    const local = reason(
      run(
        'pre',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
          transcript_path: transcript([prompt('собери')]),
          session_id: 'kit-economy',
          cwd: dir,
        },
        { AGENTDECK_KIT_VARIANT: 'local' },
      ),
    );
    expect(local).toMatch(/timeout is 120 s/);
    expect(local).not.toMatch(/run_in_background/);
    // Группа разделения гоняет на переднем плане — ей нужен только достаточный timeout.
    const inGroup = reason(
      run(
        'pre',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
          transcript_path: transcript([prompt('собери')]),
          session_id: 'kit-economy',
          cwd: dir,
        },
        { AGENTDECK_HEAVY_QUEUE_DIR: dir },
      ),
    );
    expect(inGroup).toMatch(/timeout is 120 s/);
    expect(inGroup).not.toMatch(/run_in_background/);
    expect(
      pre(command, [prompt('собери')], { tool_input: { run_in_background: true } }),
    ).toBeUndefined();
  });

  it('упавший вызов закрывается PostToolUseFailure, а незакрытая отметка — не убийство по потолку', () => {
    // Раньше неудачная секундная команда оставалась незакрытой и через 630 с читалась как
    // «600 с, убита» — и её точный повтор после правки отклонялся.
    const command = 'npx vitest run src/a.test.ts';
    const file = join(dir, 'state', 'durations', 'cmd-durations.json');
    expect(pre(command, [prompt('проверь')], { tool_use_id: 'fail1' })).toBeUndefined();
    run('post-fail', {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: 'fail1',
      error: 'Exit code 1',
      transcript_path: transcript([prompt('проверь')]),
      session_id: 'kit-economy',
      cwd: dir,
    });
    type Store = {
      keys: Record<string, { runs: number[]; kills?: number }>;
      pending: Record<string, { key: string; t: number }>;
    };
    const read = () => JSON.parse(readFileSync(file, 'utf8')) as Store;
    const entry = Object.entries(read().keys).find(([k]) => k.endsWith(command))?.[1];
    expect(entry?.runs).toEqual([0]);
    expect(entry?.kills ?? 0).toBe(0);
    expect(read().pending.fail1).toBeUndefined();

    const stale = 'node never-closed.mjs';
    expect(pre(stale, [prompt('проверь')], { tool_use_id: 'gone1' })).toBeUndefined();
    const store = read();
    store.pending.gone1!.t = Date.now() - 700_000;
    writeFileSync(file, JSON.stringify(store));
    expect(pre(stale, [prompt('проверь')], { tool_use_id: 'gone2' })).toBeUndefined();
    expect(read().pending.gone1).toBeUndefined();
    expect(Object.keys(read().keys).some((k) => k.endsWith(stale))).toBe(false);
  });
});

describe('batch-nudge: три хода подряд по одному короткому чтению', () => {
  const post = (records: object[], session: string, agent?: string) =>
    run('post-any', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: 'ok',
      transcript_path: transcript(records),
      session_id: session,
      agent_id: agent,
      cwd: dir,
    });
  const reads = (k: number) =>
    Array.from({ length: k }, (_, i) => bashTurn(`cat f${i}.txt`)).flat();

  it('запись (mv, mkdir, sed -i, > файл) рвёт серию, одиночный git status — чтение', () => {
    for (const write of [
      'mv a.txt b.txt',
      'mkdir -p out',
      "sed -i 's/a/b/' f.txt",
      'echo x > f.txt',
    ])
      expect(
        post([prompt('смотри'), ...reads(2), ...bashTurn(write)], `batch-w-${write.length}`),
      ).not.toContain('[batch]');
    expect(
      post([prompt('смотри'), ...reads(2), ...bashTurn('git status --short')], 'batch-git'),
    ).toContain('[batch]');
    expect(
      post([prompt('смотри'), ...reads(2), ...bashTurn('ls 2>&1 >/dev/null')], 'batch-null'),
    ).toContain('[batch]');
  });

  it('серия из трёх — подсказка, следующий вызов той же серии — тишина', () => {
    const records = [prompt('смотри'), ...reads(3)];
    expect(post(records, 'batch-a')).toContain('[batch]');
    expect(post(records, 'batch-a')).not.toContain('[batch]');
  });

  it('два чтения, запись в серии или субагент — тишина', () => {
    expect(post([prompt('смотри'), ...reads(2)], 'batch-b')).not.toContain('[batch]');
    expect(
      post([prompt('смотри'), ...reads(2), ...bashTurn('pnpm install')], 'batch-c'),
    ).not.toContain('[batch]');
    expect(post([prompt('смотри'), ...reads(3)], 'batch-d', 'agent-1')).not.toContain('[batch]');
  });
});

describe('диспетчер: модули pre импортируются только для своих инструментов', () => {
  it('карта PRE_TOOLS совпадает с фильтром каждого модуля и покрывает весь манифест', async () => {
    // Карта — предфильтр до импорта; расхождение молча сняло бы охранника с инструмента.
    const lib = join(builtinKitDir(), 'hooks');
    const items = (await import(pathToFileURL(join(lib, 'lib', 'items.mjs')).href)) as {
      MANIFEST: { pre: string[] };
      PRE_TOOLS: Record<string, RegExp>;
    };
    for (const name of items.MANIFEST.pre) {
      const mod = (await import(pathToFileURL(join(lib, `${name}.mjs`)).href)) as {
        hooks: { pre: { tools?: RegExp } };
      };
      expect(items.PRE_TOOLS[name]?.source, name).toBe(mod.hooks.pre.tools?.source);
      expect(items.PRE_TOOLS[name]?.flags, name).toBe(mod.hooks.pre.tools?.flags);
    }
  });
});

describe('runIfMain: файл кита — точка входа процесса', () => {
  // Node разрешает ссылки в import.meta.url, но не в argv[1]: кит, подключённый через ссылку
  // (stow, репозиторий dotfiles), сравнивал разные пути и молча ничего не делал.
  it('запуск через ссылку на каталог узнаётся; регистр складывается только на Windows', async () => {
    const itemsUrl = pathToFileURL(join(builtinKitDir(), 'hooks', 'lib', 'items.mjs')).href;
    const real = join(dir, 'entry-real');
    mkdirSync(real);
    const file = join(real, 'item.mjs');
    writeFileSync(
      file,
      `import { isEntry } from ${JSON.stringify(itemsUrl)};\n` +
        `console.log(isEntry(import.meta.url) ? 'MAIN' : 'NOT');\n`,
      'utf8',
    );
    const link = join(dir, 'entry-link');
    symlinkSync(real, link, 'junction');
    const out = spawnSync(process.execPath, [join(link, 'item.mjs')], { encoding: 'utf8' });
    expect(out.stderr).toBe('');
    expect(out.stdout.trim()).toBe('MAIN');
    expect(spawnSync(process.execPath, [file], { encoding: 'utf8' }).stdout.trim()).toBe('MAIN');

    const { isEntry } = (await import(itemsUrl)) as {
      isEntry: (url: string, argv1?: string, platform?: string) => boolean;
    };
    const url = pathToFileURL(file).href;
    const upper = file.toUpperCase();
    expect(isEntry(url, join(real, 'other.mjs'), 'win32')).toBe(false);
    expect(isEntry(url, upper, 'win32')).toBe(true);
    // Различать регистр есть чем только на файловой системе, где `ITEM.MJS` — другой файл (Linux).
    if (!existsSync(upper)) expect(isEntry(url, upper, 'linux')).toBe(false);
  });
});

describe('rule-injector: что из команды исполняется, а что — данные', () => {
  const load = async () =>
    (await import(
      pathToFileURL(join(builtinKitDir(), 'hooks', 'lib', 'rule-injector.mjs')).href
    )) as { runnable: (command: string) => string };

  it('heredoc-заметка — данные, heredoc-код в интерпретатор или в запускаемый файл — исполнение', async () => {
    const { runnable } = await load();
    expect(runnable(`cat >> notes.md <<'EOF'\npnpm test failed\nEOF`)).not.toContain('pnpm test');
    expect(runnable(`cat <<'EOF' | node\nimport { chromium } from 'playwright';\nEOF`)).toContain(
      'playwright',
    );
    expect(
      runnable(
        `cat > .agent/tmp/x.mjs <<'EOF'\nimport { chromium } from 'playwright';\nEOF\nnode .agent/tmp/x.mjs`,
      ),
    ).toContain('playwright');
    expect(
      runnable(
        `cat > .agent/tmp/x.mjs <<'EOF'\nimport { chromium } from 'playwright';\nEOF\nnode other.mjs`,
      ),
    ).not.toContain('playwright');
  });

  it('фраза в кавычках у обычной команды — данные, код после -c/-e и URL — нет', async () => {
    const { runnable } = await load();
    expect(runnable('node inspect.mjs calls.jsonl "npx vitest run src"')).not.toContain('vitest');
    expect(runnable('bash -c "npx vitest run src"')).toContain('vitest');
    expect(runnable('curl -s "http://localhost:5173/x"')).toContain('localhost:5173');
  });
});

describe('inline-edit-guard: правка файла встроенным кодом мимо Edit/Write', () => {
  // Каталог проекта вне Temp: относительная цель разрешается от cwd, а файл во временном каталоге — черновой.
  const PROJECT = 'C:/work/proj';
  const edit = (command: string) => pre(command, [prompt('поправь')], { cwd: PROJECT });

  it('sed -i, node -e с записью, python-heredoc и sed внутри bash -c — отказ', () => {
    expect(edit(`sed -i 's/a/b/' src/x.ts`)).toMatch(/inline-edit-guard: sed -i/);
    expect(edit(`node -e "require('fs').writeFileSync('src/a.ts','x')"`)).toMatch(
      /inline code writing a file/,
    );
    expect(edit(`python - <<'EOF'\nopen('src/a.py','w').write('x')\nEOF`)).toMatch(
      /inline code writing a file/,
    );
    expect(edit(`bash -c "sed -i 's/a/b/' src/x.ts"`)).toMatch(/sed -i/);
    expect(edit(`node -e "require('child_process').execSync('sed -i s/a/b/ src/a.ts')"`)).toMatch(
      /sed -i/,
    );
  });

  it('текст, а не исполнение: заметка, шаблон grep, строка в коде node — проходят', () => {
    expect(
      edit(`cat >> .agent/tmp/notes.md <<'EOF'\nfixed: sed -i resets the file\nEOF`),
    ).toBeUndefined();
    expect(edit(`grep -n "inline\\|sed -i" a.test.mjs`)).toBeUndefined();
    expect(edit(`node -e "const c = ['sed -i x src/a.ts']; console.log(c)"`)).toBeUndefined();
  });

  it('черновая цель, скрипт по пути и повтор той же команды проходят', () => {
    expect(edit(`sed -i 's/a/b/' "C:/Users/u/AppData/Local/Temp/x.ts"`)).toBeUndefined();
    expect(edit('node scratch/fix.mjs src/a.ts')).toBeUndefined();
    const command = `sed -i 's/a/b/' src/x.ts`;
    // CLI записывает отказ с вводной «PreToolUse:Bash hook error:» — повтор всё равно проходит.
    const refused = [
      prompt('поправь'),
      ...bashTurn(command, 'PreToolUse:Bash hook error: [ctx-guard] inline-edit-guard: …'),
    ];
    expect(pre(command, refused, { cwd: PROJECT })).toBeUndefined();
  });

  it('цели судятся по сегменту правки и от его каталога', () => {
    // Путь соседней команды — не цель правки; относительная цель после `cd` в черновик — черновая.
    expect(
      edit(`sed -i 's/a/b/' .agent/tmp/case.json && node tools/tests-cli.mjs run --project .`),
    ).toBeUndefined();
    expect(edit(`cd .agent/tmp/review; sed -i 's/a/b/' x.mjs`)).toBeUndefined();
    expect(edit(`cd .agent/tmp/review; sed -i 's/a/b/' ../../../src/x.mjs`)).toMatch(/sed -i/);
    expect(edit(`sed -i 's/a/b/' src/x.ts && ls .agent/tmp`)).toMatch(/sed -i/);
  });

  it('в субагенте повтор ищется в его собственном транскрипте, а не у родителя', () => {
    // CLI отдаёт субагенту transcript_path родителя; отказ лежит в файле самого субагента.
    const command = `sed -i 's/a/b/' src/y.ts`;
    const parent = transcript([prompt('поручи')]);
    const own = join(parent.replace(/\.jsonl$/, ''), 'subagents', 'agent-sub1.jsonl');
    mkdirSync(dirname(own), { recursive: true });
    const records = [
      prompt('задание'),
      ...bashTurn(command, 'PreToolUse:Bash hook error: [ctx-guard] inline-edit-guard: …'),
    ];
    writeFileSync(own, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const call = (agent: string) =>
      reason(
        run('pre', {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
          transcript_path: parent,
          session_id: 'kit-economy',
          agent_id: agent,
          cwd: PROJECT,
        }),
      );
    expect(call('sub1')).toBeUndefined();
    expect(call('sub2')).toMatch(/inline-edit-guard/);
  });
});

describe('inline-edit-guard: запись в Markdown через оболочку (W7)', () => {
  const PROJECT = 'C:/work/proj';
  const md = (command: string) => pre(command, [prompt('допиши')], { cwd: PROJECT });

  it('heredoc, >>, tee и Set-Content в .md проекта — отказ со своим текстом', () => {
    expect(md(`cat > docs/NOTES.md <<'EOF'\nx\nEOF`)).toMatch(/shell write into a Markdown file/);
    expect(md('echo x >> README.md')).toMatch(/Write the doc with Write/);
    expect(md('echo x | tee CHANGELOG.md')).toMatch(/Markdown file/);
    expect(md(`Set-Content -Path notes.md -Value 'x'`)).toMatch(/Markdown file/);
  });

  it('черновик и .agent/tmp, чтение .md и запись не в .md — проходят', () => {
    expect(md(`cat > .agent/tmp/review.md <<'EOF'\nx\nEOF`)).toBeUndefined();
    expect(md('echo x > "C:/Users/u/AppData/Local/Temp/x.md"')).toBeUndefined();
    expect(md('cat README.md')).toBeUndefined();
    expect(md('grep -n x README.md > .agent/tmp/out.txt')).toBeUndefined();
  });
});

describe('check-cost: узкая команда только по своим правкам (N8)', () => {
  const own = join(dir, 'repo-own');
  mkdirSync(own, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: own });
  writeFileSync(join(own, 'mine.ts'), 'export const m = 1;\n');
  writeFileSync(join(own, 'theirs.ts'), 'export const t = 1;\n');
  const editTurn = (file: string) => [
    {
      type: 'assistant',
      message: {
        id: `m${++n}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id: `e${n}`, name: 'Edit', input: { file_path: file } }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `e${n}`, content: 'ok' }],
      },
    },
  ];

  it('чужая незакоммиченная правка в дереве в узкую команду не попадает', () => {
    const text = pre('pnpm lint', [prompt('поправь'), ...editTurn(join(own, 'mine.ts'))], {
      cwd: own,
    });
    expect(text).toContain('"mine.ts"');
    expect(text).not.toContain('theirs.ts');
  });

  it('сессия ничего не правила — названы все изменённые файлы', () => {
    const text = pre('pnpm lint', [prompt('поправь')], { cwd: own });
    expect(text).toContain('"mine.ts"');
    expect(text).toContain('"theirs.ts"');
  });

  it('у каждого -p своя память инкрементального tsc', async () => {
    const lib = join(builtinKitDir(), 'hooks', 'lib', 'check-cost.mjs');
    const { narrowFor } = (await import(pathToFileURL(lib).href)) as {
      narrowFor: (kind: string, files: string[], command?: string) => string;
    };
    expect(
      narrowFor('types', ['a.ts'], 'npx tsc --noEmit -p apps/web/tsconfig.app.json'),
    ).toContain('tsc-tsconfig.app.tsbuildinfo');
    expect(narrowFor('types', ['a.ts'], 'npx tsc --noEmit')).toContain('tsc-tsconfig.tsbuildinfo');
  });
});

describe('Qwen и Codex: охранники говорят на языке своего CLI', () => {
  const PROJECT = 'C:/work/proj';
  const foreign = (session: string, payload: Record<string, unknown>) =>
    reason(
      run('pre', {
        hook_event_name: 'PreToolUse',
        transcript_path: transcript([]),
        session_id: session,
        cwd: PROJECT,
        ...payload,
      }),
    );

  it('повтор той же команды проходит и без транскрипта Claude — по журналу сессии кита', () => {
    // Транскрипт Codex и Qwen кит не читает: обещанный «повтор проходит» отказывал снова и снова.
    const codex = (command: string) =>
      foreign('codex-repeat', { tool_name: 'Bash', tool_input: { command }, turn_id: 't1' });
    const sed = `sed -i 's/a/b/' src/x.ts`;
    expect(codex(sed)).toMatch(/inline-edit-guard/);
    expect(codex('git status')).toBeUndefined();
    expect(codex(sed)).toBeUndefined();
    // Последний такой же вызов прошёл — следующий судится заново, как у Claude.
    expect(codex(sed)).toMatch(/inline-edit-guard/);

    const qwen = (command: string) =>
      foreign('qwen-repeat', { tool_name: 'run_shell_command', tool_input: { command } });
    expect(qwen(sed)).toMatch(/inline-edit-guard/);
    expect(qwen(sed)).toBeUndefined();
  });

  it('согласие повтором не открывается: git push на Codex отклоняется и второй раз', () => {
    const push = () =>
      foreign('codex-consent', {
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
        turn_id: 't1',
        cwd: repo,
      });
    expect(push()).toMatch(/git-guard\(push\)/);
    expect(push()).toMatch(/git-guard\(push\)/);
  });

  it('выученная долгая команда: Qwen — is_background, Codex без фона и таймаута — тишина', () => {
    const command = 'node slow-foreign.mjs';
    const file = join(dir, 'state', 'durations', 'cmd-durations.json');
    mkdirSync(dirname(file), { recursive: true });
    const key = `${foldCase(PROJECT)}|${command}`;
    writeFileSync(
      file,
      JSON.stringify({
        keys: { [key]: { runs: [420, 420, 420], kills: 0, last: Date.now() } },
        pending: {},
      }),
    );
    const qwen = (tool_input: Record<string, unknown>) =>
      foreign('qwen-slow', {
        tool_name: 'run_shell_command',
        tool_input: { command, ...tool_input },
      });
    const text = qwen({});
    expect(text).toMatch(/is_background: true/);
    expect(text).not.toMatch(/run_in_background/);
    expect(qwen({ is_background: true })).toBeUndefined();
    expect(
      foreign('codex-slow', { tool_name: 'Bash', tool_input: { command }, turn_id: 't1' }),
    ).toBeUndefined();
    rmSync(file);
  });
});
