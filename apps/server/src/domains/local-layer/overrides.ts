import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitSyncOutcome } from '../project-git/exec/exec.ts';
import type { LayerOverrideSpec, OverrideStatus } from './local-layer.types.ts';

/**
 * Замена командных хуков их версией из коммита — например, ускоренной, чей MR
 * ещё не влит. Действует строго, пока командный файл ТОТ, что она улучшает:
 *
 * - каждый файл замыкания (скрипты `entries` и их относительные импорты)
 *   сравнивается в трёх версиях: у команды сейчас, в коммите замены и в общей
 *   базе (`merge-base`) — как при слиянии;
 * - коммит = база → замена файл не меняет, в копию идёт КОМАНДНЫЙ текст (ветка
 *   могла его править — её правка остаётся);
 * - команда = база ≠ коммит → замена его улучшает; команда = коммит → совпал;
 *   иначе файл правили обе стороны — конфликт: замена снимается целиком, иначе
 *   слой тихо откатил бы командную правку;
 * - улучшать нечего → замена отработала (MR влит) и снимается сама.
 *
 * Скрипт хука часто находит корень репозитория по своему месту на диске
 * (`dirname(dirname(import.meta.filename))`), а данные — рядом с собой
 * (`new URL('./x.json', import.meta.url)`). Копия лежит в другом каталоге,
 * поэтому каждое такое обращение заменяется путём ОРИГИНАЛА: копия видит
 * репозиторий ровно так, как видел бы его командный скрипт. Не трогается одно —
 * сравнение с `process.argv[1]` («запущен ли я сам»): там нужен путь самой
 * копии. Обращение к своему месту в любой другой форме (`import.meta.resolve`)
 * делает перенос недоказуемым, и замена не включается.
 *
 * git здесь синхронный: старт чата в реестре синхронный, а сборка слоя редкая —
 * только когда изменился отпечаток командного слоя.
 */

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;

const SELF_COMPARE =
  /[=!]==\s*(?:realpathSync(?:\.native)?\(\s*)?import\.meta\.(?:filename|url)|(?:realpathSync(?:\.native)?\(\s*)?import\.meta\.(?:filename|url)\s*\)?\s*[=!]==/g;

/** Метка маскировки — символ из области частного использования, в исходниках его нет. */
const MASK = '';

const eol = (text: string): string => text.replace(/\r\n/g, '\n');

function show(root: string, rev: string, path: string): string | undefined {
  const outcome = gitSyncOutcome(root, ['show', `${rev}:${path}`], 10_000);
  return outcome.ok ? outcome.stdout : undefined;
}

/** Командный файл исполняемый: бит на диске или режим 100755 в коммите замены. */
function executable(root: string, rev: string, rel: string): boolean {
  try {
    if (statSync(join(root, rel)).mode & 0o111) return true;
  } catch {
    // Командного файла нет — решает коммит.
  }
  const outcome = gitSyncOutcome(root, ['ls-tree', rev, '--', rel], 10_000);
  return outcome.ok && outcome.stdout.startsWith('100755');
}

function revParse(root: string, args: string[]): string | undefined {
  const outcome = gitSyncOutcome(root, args, 10_000);
  return outcome.ok ? outcome.stdout.trim() || undefined : undefined;
}

/** Обращения копии к своему месту → место оригинала; сравнения «запущен ли я сам» остаются. */
export function relocate(text: string, originalFile: string): { text: string; unsafe: string[] } {
  const file = originalFile.replaceAll('\\', '/');
  const kept: string[] = [];
  const masked = text.replace(SELF_COMPARE, (whole) => {
    kept.push(whole);
    return `${MASK}${kept.length - 1}${MASK}`;
  });
  const rewritten = masked
    .replace(/fileURLToPath\(\s*import\.meta\.url\s*\)|import\.meta\.filename/g, () =>
      JSON.stringify(file),
    )
    .replace(/import\.meta\.dirname/g, () => JSON.stringify(posix.dirname(file)))
    .replace(/import\.meta\.url/g, () => JSON.stringify(pathToFileURL(originalFile).href));
  const unsafe = [...rewritten.matchAll(/import\.meta\.\w+/g)].map((match) => match[0]);
  const restore = new RegExp(`${MASK}(\\d+)${MASK}`, 'g');
  return {
    text: rewritten.replace(restore, (_whole, at: string) => kept[Number(at)] as string),
    unsafe,
  };
}

export interface MaterializedOverride {
  status: OverrideStatus;
  /** Командные файлы замыкания от корня — их изменение пересобирает слой. */
  closure: string[];
  /** Командный путь → путь копии, для подмены в командах хуков. */
  mapped: Map<string, string>;
}

function refused(
  base: OverrideStatus,
  state: OverrideStatus['state'],
  detail: string,
  closure: string[],
  improved: string[] = [],
): MaterializedOverride {
  return { status: { ...base, state, improved, detail }, closure, mapped: new Map() };
}

export function materializeOverride(
  root: string,
  spec: LayerOverrideSpec,
  outDir: string,
): MaterializedOverride {
  const base: OverrideStatus = {
    ref: spec.ref,
    entries: spec.entries,
    ...(spec.why ? { why: spec.why } : {}),
    state: 'missing-ref',
    improved: [],
  };
  const commit = revParse(root, ['rev-parse', '--verify', '--quiet', `${spec.ref}^{commit}`]);
  const head = commit && revParse(root, ['merge-base', commit, 'HEAD']);
  if (!commit || !head) {
    return refused(base, 'missing-ref', `коммит ${spec.ref} не найден в репозитории`, []);
  }

  // Копия — дерево, каким его дал бы git-слияние коммита в командную ветку:
  // файл, который замена меняет, берётся из коммита, остальные — командные.
  // Замыкание идёт по импортам ВЫБРАННОГО текста, поэтому новый командный
  // импорт тоже попадает в копию.
  const closure: string[] = [];
  const texts = new Map<string, string>();
  const improved: string[] = [];
  const queue = spec.entries.map((entry) => posix.normalize(entry.replaceAll('\\', '/')));
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    if (texts.has(rel)) continue;
    closure.push(rel);
    const fromRef = show(root, commit, rel);
    const ours = fromRef === undefined ? undefined : eol(fromRef);
    const was = show(root, head, rel);
    const merged = was === undefined ? undefined : eol(was);
    const theirs = join(root, rel);
    const team = existsSync(theirs) ? eol(readFileSync(theirs, 'utf8')) : undefined;
    const changes = ours !== merged;
    if (changes && team !== merged && team !== ours) {
      return refused(
        base,
        'stale',
        `командный ${rel} изменился после ${spec.ref.slice(0, 12)} — замена снята, работает командная версия`,
        closure,
      );
    }
    if (changes && team !== ours) improved.push(rel);
    const text = changes ? ours : team;
    if (text === undefined) {
      return refused(
        base,
        changes ? 'missing-ref' : 'stale',
        changes ? `в ${spec.ref} нет файла ${rel}` : `командного ${rel} больше нет — замена снята`,
        closure,
      );
    }
    texts.set(rel, text);
    for (const match of text.matchAll(IMPORT)) {
      queue.push(posix.normalize(posix.join(posix.dirname(rel), match[2] as string)));
    }
  }
  if (improved.length === 0) {
    return refused(base, 'retired', 'командная версия уже совпадает с заменой', closure);
  }

  const relocated = new Map<string, string>();
  for (const rel of closure) {
    const moved = relocate(texts.get(rel) as string, join(root, rel));
    if (moved.unsafe.length > 0) {
      return refused(
        base,
        'unrelocatable',
        `${rel} обращается к своему месту на диске (${[...new Set(moved.unsafe)].join(', ')}) — копию нельзя запускать из другого каталога`,
        closure,
        improved,
      );
    }
    relocated.set(rel, moved.text);
  }
  const mapped = new Map<string, string>();
  for (const [rel, text] of relocated) {
    const target = join(outDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf8');
    // Хук, вызванный прямо (`"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh`), без бита
    // исполнения падал бы с кодом 126, а панель показывала бы замену действующей.
    if (process.platform !== 'win32' && executable(root, commit, rel)) chmodSync(target, 0o755);
    mapped.set(rel, target);
  }
  return { status: { ...base, state: 'active', improved }, closure, mapped };
}

/**
 * Команда хука с путями замены: `$CLAUDE_PROJECT_DIR/<путь>` (в любой из
 * записей переменной) → абсолютный путь копии. Только для точных путей из
 * замыкания — остальные команды едут как были.
 */
export function remapCommand(command: string, mapped: ReadonlyMap<string, string>): string {
  if (mapped.size === 0) return command;
  return command.replace(/\$\{?CLAUDE_PROJECT_DIR\}?[\\/]([\w.\-/\\]+)/g, (whole, rel: string) => {
    const target = mapped.get(posix.normalize(rel.replaceAll('\\', '/')));
    return target ? target.replaceAll('\\', '/') : whole;
  });
}
