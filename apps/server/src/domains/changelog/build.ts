import type {
  ChangelogArea,
  ChangelogCommit,
  ChangelogEntry,
  ChangelogEntryFile,
  ChangelogKind,
} from '@agentdeck/contracts/changelog';

/**
 * Правила сборки ленты «Что нового» — чистая функция без git и файлов: на входе
 * коммиты, привязки описаний и сами описания, на выходе записи ленты. Всё, что
 * решает, как коммит превращается в запись, живёт здесь и проверяется без репозитория.
 */

export interface GitFileStat {
  path: string;
  insertions: number;
  deletions: number;
}

export interface GitCommitRecord {
  hash: string;
  date: string;
  subject: string;
  body: string;
  files: GitFileStat[];
}

export interface CuratedFile {
  /** Имя файла без `.json`. */
  id: string;
  entry: ChangelogEntryFile;
  /** Время изменения файла — дата записи, у которой ещё нет коммита. */
  mtime: string;
}

export interface BuildInput {
  /** Все коммиты без слияний, новые первыми. */
  commits: GitCommitRecord[];
  /** id описания → хэши коммитов, где этот файл появился или правился. */
  anchors: Map<string, string[]>;
  curated: CuratedFile[];
  /** Правки рабочей копии против HEAD — статистика записей без коммита. */
  workingTree: GitFileStat[];
  gitAvailable: boolean;
  /** Для даты карточки рабочей копии; в тестах задаётся, чтобы результат не плавал. */
  now?: string;
}

const AREA_ORDER: ChangelogArea[] = [
  'web',
  'server',
  'mobile',
  'contracts',
  'tools',
  'tests',
  'docs',
  'other',
];

/** Область по пути; тесты проверяются раньше всего, чтобы тест веба не считался вебом. */
export function areaOfPath(path: string): ChangelogArea {
  const p = path.replaceAll('\\', '/');
  if (/\.(test|spec)\.[^/]+$/.test(p) || p.startsWith('tools/qa/')) return 'tests';
  if (p.startsWith('apps/web/')) return 'web';
  if (p.startsWith('apps/server/')) return 'server';
  if (p.startsWith('apps/mobile/')) return 'mobile';
  if (p.startsWith('packages/')) return 'contracts';
  if (p.startsWith('tools/')) return 'tools';
  if (p.startsWith('docs/') || p.startsWith('changelog/') || p.endsWith('.md')) return 'docs';
  return 'other';
}

const PREFIX_KIND: Record<string, ChangelogKind> = {
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

interface ParsedCommit {
  title: string;
  kind: ChangelogKind;
  scope?: string;
  bullets: string[];
  summary?: string;
}

function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/**
 * Сообщение коммита → заголовок, вид, пункты из `- ` и пояснение — все остальные
 * абзацы тела. Строка без пустой строки перед ней продолжает предыдущий пункт;
 * трейлеры авторства отбрасываются — авторство в ленту не попадает.
 */
export function parseCommitMessage(subject: string, body: string): ParsedCommit {
  const match = SUBJECT.exec(subject.trim());
  const prefix = match?.[1];
  const known = prefix !== undefined && prefix in PREFIX_KIND;
  const title = capitalize((match ? match[3]! : subject).trim());
  const kind: ChangelogKind = known ? PREFIX_KIND[prefix]! : 'changed';
  const scope = match?.[2]?.trim() || undefined;

  const bullets: string[] = [];
  const paragraphs: string[] = [];
  let paragraph: string[] = [];
  let current: string | undefined;
  let afterBlank = false;
  const close = (): void => {
    if (current) bullets.push(current);
    current = undefined;
  };
  const closeParagraph = (): void => {
    if (paragraph.length > 0) paragraphs.push(paragraph.join(' '));
    paragraph = [];
  };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (TRAILER.test(line)) continue;
    const bullet = /^\s{0,2}[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      close();
      closeParagraph();
      current = bullet[1]!.trim();
      afterBlank = false;
    } else if (line === '') {
      close();
      closeParagraph();
      afterBlank = true;
    } else if (current !== undefined && !afterBlank) {
      current += ` ${line}`;
    } else {
      paragraph.push(line);
    }
  }
  close();
  closeParagraph();

  // Всё, что не пункт, остаётся пояснением: ничего из присланного git не теряется.
  const summary = paragraphs.join('\n\n');
  return {
    title,
    kind,
    ...(scope ? { scope } : {}),
    bullets,
    ...(summary ? { summary } : {}),
  };
}

interface Counts {
  files: number;
  insertions: number;
  deletions: number;
}

function sumFiles(files: GitFileStat[]): {
  totals: Counts;
  areas: ChangelogEntry['areas'];
} {
  // Один путь в нескольких коммитах записи — один файл, строки суммируются.
  const byPath = new Map<string, GitFileStat>();
  for (const file of files) {
    const seen = byPath.get(file.path);
    if (seen) {
      seen.insertions += file.insertions;
      seen.deletions += file.deletions;
    } else {
      byPath.set(file.path, { ...file });
    }
  }
  const totals: Counts = { files: byPath.size, insertions: 0, deletions: 0 };
  const perArea = new Map<ChangelogArea, Counts>();
  for (const file of byPath.values()) {
    totals.insertions += file.insertions;
    totals.deletions += file.deletions;
    const area = areaOfPath(file.path);
    const row = perArea.get(area) ?? { files: 0, insertions: 0, deletions: 0 };
    row.files += 1;
    row.insertions += file.insertions;
    row.deletions += file.deletions;
    perArea.set(area, row);
  }
  const areas = [...perArea.entries()]
    .map(([area, counts]) => ({ area, ...counts }))
    .sort(
      (a, b) =>
        b.insertions + b.deletions - (a.insertions + a.deletions) ||
        AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area),
    );
  return { totals, areas };
}

/** Тело коммита как есть, без трейлеров авторства и пустых краёв. */
export function commitBody(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !TRAILER.test(line.trim()))
    .join('\n')
    .trim();
}

function commitView(commit: GitCommitRecord): ChangelogCommit {
  const { totals } = sumFiles(commit.files);
  const body = commitBody(commit.body);
  return {
    hash: commit.hash,
    shortHash: commit.hash.slice(0, 8),
    date: commit.date,
    subject: commit.subject,
    ...(body ? { body } : {}),
    ...totals,
  };
}

const assetUrl = (id: string, file: string): string =>
  `/api/changelog/assets/${encodeURIComponent(id)}/${encodeURIComponent(file)}`;

function curatedEntry(file: CuratedFile, commits: GitCommitRecord[]): ChangelogEntry {
  const { id, entry } = file;
  const released = commits.length > 0;
  // Запись без коммита чисел не несёт: правки рабочей копии ей не принадлежат (их там
  // может быть на пять других задач) и показываются отдельной карточкой.
  const stats = sumFiles(released ? commits.flatMap((c) => c.files) : []);
  return {
    id,
    source: 'curated',
    status: released ? 'released' : 'pending',
    date: released ? commits[0]!.date : file.mtime,
    kind: entry.items[0]!.kind,
    title: entry.title,
    ...(entry.summary ? { summary: entry.summary } : {}),
    items: entry.items.map((item) => ({
      kind: item.kind,
      text: item.text,
      ...(item.how ? { how: item.how } : {}),
      ...(item.area ? { area: item.area } : {}),
      images: (item.images ?? []).map((name) => assetUrl(id, name)),
    })),
    images: (entry.images ?? []).map((image) => ({
      url: assetUrl(id, image.file),
      ...(image.caption ? { caption: image.caption } : {}),
      ...(image.role ? { role: image.role } : {}),
    })),
    links: entry.links ?? [],
    commits: commits.map(commitView),
    ...stats,
  };
}

function gitEntry(commit: GitCommitRecord): ChangelogEntry {
  const parsed = parseCommitMessage(commit.subject, commit.body);
  const area = parsed.scope ? { ru: parsed.scope } : undefined;
  return {
    id: `git-${commit.hash.slice(0, 8)}`,
    source: 'git',
    status: 'released',
    date: commit.date,
    kind: parsed.kind,
    title: { ru: parsed.title },
    ...(parsed.summary ? { summary: { ru: parsed.summary } } : {}),
    items: parsed.bullets.map((text) => ({
      kind: parsed.kind,
      text: { ru: text },
      ...(area ? { area } : {}),
      images: [],
    })),
    images: [],
    links: [],
    commits: [commitView(commit)],
    ...sumFiles(commit.files),
  };
}

export function buildChangelog(input: BuildInput): ChangelogEntry[] {
  const byHash = new Map(input.commits.map((commit) => [commit.hash, commit]));
  const bound = new Set<string>();
  const entries: ChangelogEntry[] = [];

  for (const file of input.curated) {
    const hashes = input.gitAvailable ? (input.anchors.get(file.id) ?? []) : [];
    const own = hashes
      .map((hash) => byHash.get(hash))
      .filter((commit): commit is GitCommitRecord => commit !== undefined)
      // История идёт от новых к старым — порядок записи тот же.
      .sort((a, b) => b.date.localeCompare(a.date));
    for (const commit of own) bound.add(commit.hash);
    const entry = curatedEntry(file, own);
    // Без git записи нечем быть «в работе»: она просто опубликована.
    if (!input.gitAvailable) entry.status = 'released';
    entries.push(entry);
  }
  for (const commit of input.commits) {
    if (!bound.has(commit.hash)) entries.push(gitEntry(commit));
  }

  // Правки рабочей копии без коммита — одной карточкой с числами; заголовок и
  // пояснение ей даёт вкладка (русских строк сервер не выдаёт).
  if (input.gitAvailable && input.workingTree.length > 0) {
    entries.push({
      id: 'working-tree',
      source: 'tree',
      status: 'pending',
      date: input.now ?? new Date().toISOString(),
      kind: 'changed',
      title: { ru: 'working-tree' },
      items: [],
      images: [],
      links: [],
      commits: [],
      ...sumFiles(input.workingTree),
    });
  }

  // В работе — сверху: сначала описания, потом числа рабочей копии, потом выпущенное.
  const rank = (entry: ChangelogEntry): number =>
    entry.source === 'tree' ? 1 : entry.status === 'pending' ? 0 : 2;
  return entries.sort((a, b) => rank(a) - rank(b) || b.date.localeCompare(a.date));
}
