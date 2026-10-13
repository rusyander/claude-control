import {
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { git } from './exec/exec.ts';

/**
 * `node_modules` копии из `node_modules` оригинала — без новой установки.
 *
 * Самодостаточный каталог (ни workspace, ни `file:`/`link:` на соседние папки)
 * получает `node_modules` ОДНОЙ ССЫЛКОЙ на каталог оригинала (junction на
 * Windows): ноль места, ноль установки (владелец, 13.10.2026). Цена известна и
 * принята: пакет, поставленный агентом в копии, попадает и в оригинал. Каталогу
 * с локальными пакетами ссылка не годится: его `node_modules` ведут в соседние
 * папки ОРИГИНАЛА, и копия импортировала бы чужие исходники вместо своих — у
 * npm ему остаются жёсткие ссылки ниже, у pnpm и yarn — обычная установка
 * (pnpm и так кладёт файлы ссылками из своего хранилища).
 *
 * Жёсткие ссылки (npm, каталог с локальными пакетами):
 *
 * У npm нет общего хранилища, как у pnpm: `npm ci` в каждой копии кладёт
 * пакеты заново, и у фронтенда из шести приложений это полтора-два гигабайта
 * на копию (замер 13.10.2026 на настоящем проекте). Когда `package.json` и
 * `package-lock.json` каталога в копии те же, что в оригинале, дерево пакетов
 * то же самое — его можно не качать и не распаковывать, а сослаться на файлы
 * оригинала. Место на диске файл занимает один раз, сколько бы копий на него
 * ни ссылалось; удаление копии снимает только её ссылки.
 *
 * Чего ссылкой НЕ делаем:
 * - каталоги-ссылки (`file:`-зависимости npm — junction на соседний каталог
 *   ОРИГИНАЛА): копия обязана ссылаться на свой каталог, эти npm создаст сам;
 * - служебные каталоги верхнего уровня с точкой, кроме `.bin`: туда инструменты
 *   пишут поверх существующих файлов (`.prisma`, `.vite`), и запись через
 *   жёсткую ссылку испортила бы оригинал. Кэши пропускаем, остальное копируем.
 *
 * После посева идёт `npm install --no-save` вместо `npm ci`: он сверяет дерево с
 * lock-файлом и доставляет только расхождение, а `ci` начал бы с того, что
 * снёс бы посеянное.
 */

/**
 * Кэши сборщиков: в копии они собираются заново, чужие только мешают. Имена у
 * инструментов свои (`.experimental-vitest-cache` у vitest 3) — поэтому и по слову.
 */
const SKIP_DOT_DIRS = new Set(['.vite', '.vite-temp', '.tmp', '.turbo', '.angular']);
const CACHE_NAME = /cache/i;
/** Сколько файловых операций идёт разом: больше — диск не быстрее, меньше — медленно. */
const SEED_CONCURRENCY = 32;

export const NPM_SEEDED_INSTALL = 'npm install --no-save --prefer-offline --no-audit --no-fund';

/** Lock-файл, по которому сверяется, что дерево пакетов копии то же, что у оригинала. */
export const LOCKFILES = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
} as const;

/** Зависимость на соседнюю папку: в `node_modules` она — ссылка на каталог рядом. */
const LOCAL_SPEC = /^(?:link|workspace|portal):/;
/** `file:` на архив пакета ставится копией и наружу не ведёт; на папку — ведёт. */
const FILE_SPEC = /^file:/;
const TARBALL = /\.(?:tgz|tar\.gz|tar)$/i;

export interface SeedReport {
  linked: number;
  copied: number;
  skipped: string[];
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([readFile(a), readFile(b)]);
    return left.equals(right);
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Каталог оригинала, с которого можно посеять `<copy>/<cwd>/node_modules`, или
 * `undefined`: копия не worktree, в копии `node_modules` уже есть, у оригинала
 * его нет, или манифесты разошлись (тогда дерево другое и ставить надо честно).
 */
export async function seedSourceFor(
  copyDir: string,
  cwd: string,
  lockfile: string = LOCKFILES.npm,
): Promise<string | undefined> {
  const target = join(copyDir, cwd);
  if (await exists(join(target, 'node_modules'))) return undefined;
  let common: string;
  try {
    common = (
      await git(copyDir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).trim();
  } catch {
    return undefined;
  }
  const mainDir = dirname(common);
  // git отдаёт длинный путь, а копия может прийти короткой формой (`RUSYAN~1`).
  const real = await Promise.all([realpath(mainDir), realpath(copyDir)]).catch(() => []);
  if (real.length === 0 || real[0]?.toLowerCase() === real[1]?.toLowerCase()) return undefined;
  const source = join(mainDir, cwd);
  if (!(await exists(join(source, 'node_modules')))) return undefined;
  const same = await Promise.all(
    ['package.json', lockfile].map((name) => sameFile(join(source, name), join(target, name))),
  );
  return same.every(Boolean) ? source : undefined;
}

/**
 * Нет ли у каталога пакетов, лежащих рядом в репозитории: workspace (npm, yarn,
 * pnpm) или зависимость `link:`/`workspace:`/`portal:`/`file:` на папку.
 * Только такой каталог можно подключить к `node_modules` оригинала ссылкой.
 */
export async function selfContained(dir: string): Promise<boolean> {
  if (await exists(join(dir, 'pnpm-workspace.yaml'))) return false;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (pkg.workspaces !== undefined) return false;
  const specs = [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.optionalDependencies,
    pkg.peerDependencies,
  ].flatMap((group) => (group && typeof group === 'object' ? Object.values(group) : []));
  return specs.every(
    (spec) =>
      typeof spec !== 'string' ||
      !(LOCAL_SPEC.test(spec) || (FILE_SPEC.test(spec) && !TARBALL.test(spec))),
  );
}

/**
 * `target` — ссылка на `<source>/node_modules`. Junction на Windows: его
 * создание не требует прав администратора, а удаление снимает только ссылку.
 */
export async function shareNodeModules(source: string, target: string): Promise<void> {
  await symlink(
    join(source, 'node_modules'),
    target,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

type Job = () => Promise<void>;

async function drain(jobs: Job[]): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next++] as Job;
      await job();
    }
  };
  await Promise.all(Array.from({ length: SEED_CONCURRENCY }, worker));
}

/**
 * Посеять `to` из `from`. Отказ ссылки на другой том (EXDEV) или любой другой
 * сбой — исключение, и вызывающий ставит пакеты как раньше; недосеянный
 * каталог при этом убран, чтобы `npm ci` начал с чистого места.
 */
export async function seedNodeModules(from: string, to: string): Promise<SeedReport> {
  const report: SeedReport = { linked: 0, copied: 0, skipped: [] };

  // Сначала каталоги (обход), потом все файлы одной очередью: в `node_modules`
  // тысячи каталогов по два-три файла, и очередь на каталог шла бы почти по одному.
  const files: Job[] = [];
  const walk = async (src: string, dst: string, mode: 'link' | 'copy', top: boolean) => {
    await mkdir(dst, { recursive: true });
    for (const entry of await readdir(src, { withFileTypes: true })) {
      const from = join(src, entry.name);
      const into = join(dst, entry.name);
      // Junction на Windows `readdir` отдаёт каталогом, `lstat` — ссылкой.
      if (entry.isSymbolicLink() || (entry.isDirectory() && (await lstat(from)).isSymbolicLink())) {
        report.skipped.push(from);
        continue;
      }
      if (entry.isDirectory()) {
        const dotted = top && entry.name.startsWith('.') && entry.name !== '.bin';
        if (dotted && (SKIP_DOT_DIRS.has(entry.name) || CACHE_NAME.test(entry.name))) {
          report.skipped.push(from);
          continue;
        }
        await walk(from, into, dotted ? 'copy' : mode, false);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(async () => {
        if (mode === 'link') {
          try {
            await link(from, into);
            report.linked++;
            return;
          } catch (error) {
            // Предел ссылок на файл (NTFS — 1023) — копия этого файла, не провал.
            if ((error as NodeJS.ErrnoException).code !== 'EMLINK') throw error;
          }
        }
        await copyFile(from, into);
        report.copied++;
      });
    }
  };

  try {
    await walk(resolve(from), to, 'link', true);
    await drain(files);
  } catch (error) {
    await rm(to, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return report;
}
