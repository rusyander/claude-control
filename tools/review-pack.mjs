/**
 * Пакет ревью одним файлом (5.3 плана экономии, 17.10.2026): шапка ветки,
 * коммиты, изменённые файлы, план и весь дифф — то, что каждый ревьюер группы
 * иначе собирает сам.
 *
 * Замер 16.10: шесть ревьюеров четырёх групп сделали 57 вызовов `git diff` /
 * `git show` — 408 тыс. знаков, треть всего, что им вернули инструменты; один
 * и тот же дифф каждый перечитывал по 5–14 раз, и каждый следующий вызов модели
 * нёс все копии. Пакет собирается один раз, ревьюер читает его один раз.
 *
 * Дифф — от общей с основной веткой точки до РАБОЧЕЙ копии: незакоммиченное
 * ревьюер тоже должен видеть. Новые неотслеживаемые файлы git в дифф не
 * кладёт — они названы списком. Lock-файлы названы, но без тела: их дифф
 * бывает в сотни тысяч знаков и ничего не говорит ревью.
 *
 *   node tools/review-pack.mjs [--base <ref>] [--plan <file>] [--out <file>]
 *
 * По умолчанию основа — первая из origin/main, origin/master, main, master;
 * файл — `<корень репозитория>/.agent/tmp/review-pack.md`. В stdout — одна
 * строка: путь, число файлов, строки, размер. Код 1 — не репозиторий или нет
 * основы.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Lock-файлы: в пакете только имя и счёт строк. */
const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
]);
const AGENT_NOTES = /(^|\/)\.agent\//;
const BASES = ['origin/main', 'origin/master', 'main', 'master'];

function git(cwd, args) {
  // Имена не по-латински git иначе отдаёт в кавычках с восьмеричными кодами — такого файла нет.
  const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  return { ok: result.status === 0, out: result.stdout ?? '', err: result.stderr ?? '' };
}

function argOf(argv, flag) {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}

/** Строки `--numstat`: добавлено, удалено, путь (у переименования — новый путь). */
function parseNumstat(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, ...rest] = line.split('\t');
      const raw = rest.join('\t');
      // Переименование: `a/{old => new}/b` или `old => new`.
      const path = raw.includes(' => ')
        ? raw.replace(/\{([^}]*) => ([^}]*)\}/, '$2').replace(/^.* => /, '')
        : raw;
      return {
        path,
        shown: raw,
        added: added === '-' ? 0 : Number(added),
        deleted: deleted === '-' ? 0 : Number(deleted),
        binary: added === '-',
      };
    });
}

/** Новый файл больше этого — в списке, но без тела: читать его ревьюер будет сам. */
const NEW_FILE_MAX = 256 * 1024;

/** Потолок одного Read в токенах: CLI берёт его из этой переменной, без неё — 25 000. */
const READ_CAP_ENV = 'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS';
const READ_CAP_DEFAULT = 25_000;
/** Доля потолка на кусок карты чтения: оценка ниже завышена, запас — на её промах. */
const READ_CAP_SHARE = 0.85;

/**
 * Во сколько токенов строка обойдётся в Read, с запасом вверх. Подогнано по трём
 * отказам Read на пакете 198 КБ (группа #5 25.10, потолок 10 000): 29 090 знаков —
 * 11 567 токенов, 28 252 — 11 338, 50 710 — 19 295; оценка выше факта на 4–9 %.
 * Латиница дешевле кириллицы; номер строки, который Read ставит впереди, — тоже цена.
 */
function lineTokens(line) {
  let ascii = 0;
  let other = 0;
  for (const ch of line) {
    if (ch.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return ascii / 2.6 + other / 1.2 + 2;
}

/**
 * Куски по одному Read: каждый в бюджете, режем по началу файла диффа, если до
 * него набралась хотя бы половина бюджета. Строка длиннее бюджета — свой кусок.
 * Ответ — номера строк с единицы, включительно.
 */
function readChunks(lines, budget) {
  const out = [];
  let from = 0;
  let used = 0;
  let fileAt = -1;
  let usedBeforeFile = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const cost = lineTokens(lines[i]);
    if (i > from && used + cost > budget) {
      const atFile = fileAt > from && usedBeforeFile >= budget / 2;
      const cut = atFile ? fileAt : i;
      out.push({ from: from + 1, to: cut });
      used = atFile ? used - usedBeforeFile : 0;
      from = cut;
      fileAt = -1;
    }
    if (lines[i].startsWith('diff --git ') && i > from) {
      fileAt = i;
      usedBeforeFile = used;
    }
    used += cost;
  }
  if (from < lines.length) out.push({ from: from + 1, to: lines.length });
  return out;
}

/** Строки каждого файла в диффе пакета: от его `diff --git` до начала следующего. */
function fileLines(lines, files) {
  const starts = [];
  lines.forEach((line, at) => {
    if (line.startsWith('diff --git ')) starts.push(at);
  });
  const fenceEnd = lines.length - 1; // последняя строка пакета — ограда диффа
  const ranges = new Map();
  for (const file of files) {
    const at = starts.find((s) => lines[s].endsWith(` b/${file.path}`));
    if (at === undefined) continue;
    const next = starts.find((s) => s > at) ?? fenceEnd;
    ranges.set(file.path, { from: at + 1, to: next });
  }
  return ranges;
}

/**
 * Неотслеживаемый файл как дифф «новый файл». Git сам его не покажет, а
 * `git add -N` поменял бы индекс копии; двоичный и слишком большой — без тела.
 */
function newFile(root, path) {
  const entry = { path, shown: path, added: 0, deleted: 0, binary: false, untracked: true };
  // Каталог — вложенный репозиторий (копия задачи, клон рядом): git отдаёт его строкой
  // `dir/`, своих файлов не показывает, и читать его как файл — EISDIR.
  let bytes;
  try {
    if (path.endsWith('/') || statSync(join(root, path)).isDirectory()) {
      return { ...entry, skipped: 'nested repository' };
    }
    bytes = readFileSync(join(root, path));
  } catch (error) {
    return { ...entry, skipped: `unreadable (${error.code ?? error.message})` };
  }
  if (bytes.includes(0)) return { ...entry, binary: true };
  if (bytes.length > NEW_FILE_MAX) return { ...entry, skipped: `${bytes.length} bytes` };
  if (bytes.length === 0) return entry;
  const lines = bytes.toString('utf8').replace(/\n$/, '').split('\n');
  return {
    ...entry,
    added: lines.length,
    diff: [
      `diff --git a/${path} b/${path}`,
      'new file (untracked)',
      '--- /dev/null',
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join('\n'),
  };
}

/** Собрать пакет; ответ — путь файла и сводка или текст отказа. */
export function buildReviewPack({ cwd, base, plan, out, now = new Date(), readCap }) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { error: 'review-pack: not a git repository' };
  const root = top.out.trim();
  const ref =
    base ?? BASES.find((name) => git(root, ['rev-parse', '--verify', '--quiet', name]).ok);
  if (!ref)
    return { error: `review-pack: no base branch (${BASES.join(', ')}); pass --base <ref>` };
  const mergeBase = git(root, ['merge-base', ref, 'HEAD']);
  if (!mergeBase.ok) return { error: `review-pack: no common ancestor of ${ref} and HEAD` };
  const point = mergeBase.out.trim();

  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
  const head = git(root, ['rev-parse', '--short', 'HEAD']).out.trim();
  const commits = git(root, ['log', '--oneline', '--no-decorate', `${point}..HEAD`]).out.trim();
  const target = out
    ? isAbsolute(out)
      ? out
      : resolve(cwd, out)
    : join(root, '.agent', 'tmp', 'review-pack.md');
  const self = relative(root, target).split(sep).join('/');
  const tracked = parseNumstat(git(root, ['diff', '-M', '--numstat', point]).out);
  // Сам пакет в список не идёт: иначе следующий пакет нёс бы предыдущий целиком. Новые
  // заметки агентов (`.agent/`) — тоже: это не правка, а ревьюеру лишнее чтение.
  const fresh = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .out.split('\0')
    .filter((path) => path && path !== self && !AGENT_NOTES.test(path))
    .map((path) => newFile(root, path));
  const files = [...tracked, ...fresh];
  const locks = files.filter((file) => LOCKFILES.has(basename(file.path)));
  const excludes = locks.map((file) => `:(exclude)${file.path}`);
  const diff = [
    git(root, ['diff', '-M', point, '--', '.', ...excludes]).out.trimEnd(),
    ...fresh
      .filter((file) => file.diff && !LOCKFILES.has(basename(file.path)))
      .map((file) => file.diff),
  ]
    .filter(Boolean)
    .join('\n');

  // Ограда длиннее любой серии обратных кавычек в диффе: правленый markdown со своими
  // блоками кода иначе закрывал бы её посреди диффа.
  const fence = '`'.repeat(
    Math.max(3, ...[...diff.matchAll(/`+/g)].map((run) => run[0].length + 1)),
  );
  const planPath = plan ? (isAbsolute(plan) ? plan : resolve(cwd, plan)) : undefined;
  const planText = planPath && existsSync(planPath) ? readFileSync(planPath, 'utf8').trim() : '';
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const deleted = files.reduce((sum, file) => sum + file.deleted, 0);

  // Пакет больше потолка одного Read (198 КБ при потолке 10 000 токенов, группа #5 25.10):
  // ревьюеры гадали границы кусков — три отказа Read и чтение в обход потолка. Карта
  // чтения даёт куски под потолок, у каждого файла — его строки. Номера строк зависят от
  // длины самой карты, поэтому сборка повторяется, пока карта не совпадёт с текстом.
  const cap = Number(readCap ?? process.env[READ_CAP_ENV]) || READ_CAP_DEFAULT;
  const budget = Math.floor(cap * READ_CAP_SHARE);
  const assemble = (ranges, chunks) =>
    [
      '# Review package',
      '',
      `Branch \`${branch}\` at ${head}; base \`${ref}\`, common ancestor ${point.slice(0, 9)}. ` +
        `Built ${now.toISOString()}. The diff is from the common ancestor to the working copy ` +
        '(uncommitted changes included). Read this file once, chunk by chunk from «Reading map»: ' +
        'it already holds the whole diff; a file’s own lines are next to it in «Changed files».',
      '',
      '## Reading map',
      '',
      `One Read per chunk, offset and limit as written — each fits under the Read cap (${cap} tokens).`,
      ...chunks.map(
        (chunk) =>
          `- offset=${chunk.from} limit=${chunk.to - chunk.from + 1} (lines ${chunk.from}–${chunk.to})`,
      ),
      '',
      '## Commits',
      '',
      commits || '(none — the change is uncommitted)',
      '',
      `## Changed files (${files.length}, +${added} −${deleted})`,
      '',
      ...files.map((file) => {
        const at = ranges.get(file.path);
        return (
          `- ${file.shown} ${file.binary ? '(binary)' : `+${file.added} −${file.deleted}`}` +
          (file.untracked ? ' (new, untracked)' : '') +
          (file.skipped ? ` — ${file.skipped}, read it directly` : '') +
          (LOCKFILES.has(basename(file.path)) ? ' — lockfile, diff omitted' : '') +
          (at ? ` · lines ${at.from}–${at.to}` : '')
        );
      }),
      ...(planText ? ['', '## Plan', '', planText] : []),
      '',
      '## Diff',
      '',
      `${fence}diff`,
      diff,
      fence,
      '',
    ].join('\n');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let ranges = new Map();
  let chunks = [];
  let text = assemble(ranges, chunks);
  for (let pass = 0; pass < 6; pass += 1) {
    // Текст кончается переводом строки: пустой хвост split — не строка файла.
    const lines = text.replace(/\n$/, '').split('\n');
    const nextRanges = fileLines(lines, files);
    const nextChunks = readChunks(lines, budget);
    if (same([...nextRanges], [...ranges]) && same(nextChunks, chunks)) break;
    ranges = nextRanges;
    chunks = nextChunks;
    text = assemble(ranges, chunks);
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, 'utf8');
  return {
    path: target,
    summary:
      `review-pack: ${target} · files ${files.length}${fresh.length ? ` (${fresh.length} untracked)` : ''} · ` +
      `+${added} −${deleted} · ${text.length} chars · base ${ref}@${point.slice(0, 9)}`,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const result = buildReviewPack({
    cwd: process.cwd(),
    base: argOf(argv, '--base'),
    plan: argOf(argv, '--plan'),
    out: argOf(argv, '--out'),
  });
  if (result.error) {
    console.error(result.error);
    process.exitCode = 1;
  } else {
    console.log(result.summary);
  }
}
