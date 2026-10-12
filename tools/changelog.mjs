/**
 * Описания для вкладки «Что нового» (`changelog/entries/*.json`).
 *
 *   node tools/changelog.mjs new [--slug имя]   черновик описания из коммитов и правок
 *   node tools/changelog.mjs remind             напоминание перед коммитом (всегда код 0)
 *
 * Черновик — заготовка, а не текст: заголовок и пункты берутся из сообщений коммитов
 * после последнего коммита, трогавшего `changelog/entries`, и переписываются человеком
 * по правилу из AGENTS.md. Существующий файл не перезаписывается.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ENTRIES = join(ROOT, 'changelog', 'entries');

const git = (...args) =>
  execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1 << 26,
  });

const PREFIX_KIND = {
  feat: 'added',
  fix: 'fixed',
  perf: 'improved',
  docs: 'docs',
  refactor: 'internal',
  test: 'internal',
  tests: 'internal',
  chore: 'internal',
  build: 'internal',
  ci: 'internal',
  style: 'internal',
};
const SUBJECT = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.+)$/;
const TRAILER = /^(co-authored-by|signed-off-by|reviewed-by|acked-by)\s*:/i;

const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);

function parseSubject(subject) {
  const match = SUBJECT.exec(subject.trim());
  const known = match && match[1] in PREFIX_KIND;
  return {
    kind: known ? PREFIX_KIND[match[1]] : 'changed',
    title: capitalize((match ? match[3] : subject).trim()),
  };
}

/** Пункты из строк `- ` тела коммита; продолжение пункта клеится к нему, трейлеры отбрасываются. */
function bodyBullets(body) {
  const bullets = [];
  let current;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (TRAILER.test(line)) continue;
    const bullet = /^\s{0,2}[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      if (current) bullets.push(current);
      current = bullet[1].trim();
    } else if (line === '') {
      if (current) bullets.push(current);
      current = undefined;
    } else if (current !== undefined) {
      current += ` ${line}`;
    }
  }
  if (current) bullets.push(current);
  return bullets;
}

function sinceAnchor() {
  const anchor = git('log', '-1', '--format=%H', '--', 'changelog/entries').trim();
  const range = anchor ? [`${anchor}..HEAD`] : [];
  const log = git('log', '--no-merges', '--format=%x1e%s%x1f%b', ...range);
  return log
    .split('\x1e')
    .filter(Boolean)
    .map((record) => {
      const [subject, body = ''] = record.split('\x1f');
      return { subject: subject.trim(), body };
    });
}

function slugOf(text) {
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii || 'draft';
}

function newEntry(args) {
  const slugAt = args.indexOf('--slug');
  const commits = sinceAnchor();
  const dirty = git('status', '--porcelain')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.includes('changelog/entries/'));

  const items = [];
  for (const { subject, body } of commits) {
    const { kind, title } = parseSubject(subject);
    const bullets = bodyBullets(body);
    if (bullets.length === 0) items.push({ kind, text: { ru: title } });
    else for (const text of bullets) items.push({ kind, text: { ru: text } });
  }
  if (items.length === 0) items.push({ kind: 'added', text: { ru: 'ЗАПОЛНИТЬ: что изменилось' } });

  const title = commits[0]
    ? parseSubject(commits[0].subject).title
    : 'ЗАПОЛНИТЬ: итог одной строкой';
  const slug =
    slugAt >= 0 ? args[slugAt + 1] : slugOf(commits[0]?.subject.replace(SUBJECT, '$3') ?? '');
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    console.error('Имя (--slug) — латиница, цифры и дефисы, например backend-environment.');
    return 1;
  }

  const today = new Date().toISOString().slice(0, 10);
  const file = join(ENTRIES, `${today}-${slug}.json`);
  if (existsSync(file)) {
    console.error(
      `Уже есть: ${file}. Перезаписывать не буду — правьте его или задайте другой --slug.`,
    );
    return 1;
  }
  mkdirSync(ENTRIES, { recursive: true });
  const draft = { title: { ru: title }, items };
  writeFileSync(file, `${JSON.stringify(draft, null, 2)}\n`);
  console.log(`Черновик: ${file}`);
  console.log(
    `  из коммитов после последнего описания: ${commits.length}; несохранённых правок: ${dirty.length}`,
  );
  console.log(
    '  Перепишите: заголовок — итог, пункты по видам, «how» только где важен путь, без авторства.',
  );
  return 0;
}

/** Предупреждение, не запрет: правка кода приложения без описания в том же коммите. */
function remind() {
  try {
    const staged = git('diff', '--cached', '--name-only').split(/\r?\n/).filter(Boolean);
    const code = staged.filter(
      (path) => /^apps\/[^/]+\/src\//.test(path) && !/\.(test|spec)\.[^/]+$/.test(path),
    );
    const described = staged.some((path) => /^changelog\/entries\/.+\.json$/.test(path));
    if (code.length > 0 && !described) {
      console.log(
        `[changelog] ${code.length} файл(ов) кода приложения без описания в changelog/entries. ` +
          'Видимое пользователю изменение — pnpm changelog:new; внутренняя работа описания не требует.',
      );
    }
  } catch {
    // Напоминание не должно мешать коммиту ни при каких обстоятельствах.
  }
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'new') process.exit(newEntry(rest));
if (command === 'remind') process.exit(remind());
console.error('Команды: new [--slug имя] | remind');
process.exit(command ? 1 : 0);
