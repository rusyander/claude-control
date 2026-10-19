import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STAGE_ARTIFACTS_MAX } from '@agentdeck/contracts/model-cascade';
import { gitSync } from '../../project-git/exec/exec.ts';

/**
 * Файловая половина контекста звена — то, что планировщик (`ChatCascadeStages.ts`,
 * чистый) получает функциями: план группы файлом в копии (L2.1) и пути того, что
 * прошлые звенья в ней оставили (L7.4). Обе функции ничего не бросают: файла нет
 * или каталог не читается — звено получает план целиком и без списка, как раньше.
 */

/** Каталог планов групп в копии — рядом с остальными рабочими заметками `.agent/`. */
export const GROUP_PLAN_DIR = '.agent/plans';

/**
 * Путь файла плана от корня копии. Имя — по содержимому: две группы в одном
 * общем каталоге (разделение без копий) или новый план той же группы не
 * перезапишут друг другу файл, на который уже ссылается задание звена.
 */
export function groupPlanPath(plan: string): string {
  const hash = createHash('sha256').update(plan).digest('hex').slice(0, 12);
  return `${GROUP_PLAN_DIR}/group-plan-${hash}.agent.md`;
}

/**
 * Положить план группы в копию и вернуть путь от её корня (L2.1). Только туда,
 * где git этот путь игнорирует: иначе файл плана попал бы в `git status`,
 * панель сочла бы его работой группы (`hasWorkSince`), а доставка — кандидатом
 * в коммит. Не игнорируется, git не ответил, запись не удалась — `undefined`, и
 * звено получает план целиком.
 */
export function writeGroupPlanFile(cwd: string, plan: string): string | undefined {
  const rel = groupPlanPath(plan);
  // `check-ignore -q`: код 0 — путь игнорируется; 1 — нет; 128 — не репозиторий.
  if (gitSync(cwd, ['check-ignore', '-q', '--', rel]) === undefined) return undefined;
  const file = join(cwd, rel);
  const content = `${plan.replace(/\r\n/g, '\n').trimEnd()}\n`;
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === content) return rel;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
    return rel;
  } catch {
    return undefined;
  }
}

/**
 * Где прошлые звенья оставляют то, что следующему звену иначе пришлось бы искать
 * (журнал 19.10 01:53: доставка пять ходов искала снимки по копии и основному
 * каталогу). Каталоги снимков — подкаталог на задачу; остальное — файлы.
 * Сколько показывать из каждого места — чтобы одно место не съело весь список.
 */
const ARTIFACT_PLACES: readonly {
  dir: string;
  take: number;
  /** Что считается артефактом: подкаталоги или файлы с этим окончанием. */
  entry: { kind: 'dir' } | { kind: 'file'; suffix: string };
}[] = [
  // Снимки до/после: место по умолчанию и место проекта, где правила проекта
  // кладут их в свой каталог e2e.
  { dir: '.agent/screenshots/before-after', take: 2, entry: { kind: 'dir' } },
  { dir: 'e2e/screenshots/before-after', take: 2, entry: { kind: 'dir' } },
  // Журнал проверок задачи (verify ledger) навыка доставки.
  { dir: '.agent/tickets', take: 3, entry: { kind: 'file', suffix: '.agent.md' } },
  // Записанные прогоны блока «Тесты».
  { dir: '.agent/tests/runs', take: 2, entry: { kind: 'file', suffix: '.run.json' } },
  // Логи гейтов и живых проверок.
  { dir: '.agent/tmp', take: 3, entry: { kind: 'file', suffix: '.log' } },
];

/**
 * С какого момента файл копии — работа этой цепочки, а не перенесённое из
 * основного каталога. У копии-worktree `.git` — файл, созданный вместе с копией,
 * а локальный слой переносится с прежним временем изменения (`mirror-local.ts`):
 * всё старше копии — чужое. Общий каталог (не копия) такой отметки не имеет —
 * тогда только `since` вызывающего, а без него список пуст: старые файлы
 * человека за артефакты группы не выдаём.
 */
function artifactsSince(cwd: string, since: string | undefined): number | undefined {
  try {
    const dotGit = statSync(join(cwd, '.git'));
    if (dotGit.isFile()) return dotGit.mtimeMs;
  } catch {
    // Нет `.git` — не копия; ниже решит `since`.
  }
  const at = since ? Date.parse(since) : Number.NaN;
  return Number.isFinite(at) ? at : undefined;
}

/** Время изменения записи; у каталога снимков — самое новое из него и его детей. */
function freshness(path: string, dir: boolean): number {
  const own = statSync(path).mtimeMs;
  if (!dir) return own;
  let newest = own;
  for (const child of readdirSync(path)) {
    try {
      newest = Math.max(newest, statSync(join(path, child)).mtimeMs);
    } catch {
      // Ребёнок исчез между чтением каталога и stat — не повод терять запись.
    }
  }
  return newest;
}

/**
 * Пути артефактов от корня копии, самые новые первыми, не больше
 * `STAGE_ARTIFACTS_MAX` (L7.4). Каталог снимков — с косой чертой в конце.
 */
export function readStageArtifacts(cwd: string, since?: string): string[] {
  const from = artifactsSince(cwd, since);
  if (from === undefined) return [];
  const out: string[] = [];
  for (const place of ARTIFACT_PLACES) {
    const root = join(cwd, place.dir);
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    const found: { rel: string; at: number }[] = [];
    for (const name of names) {
      const path = join(root, name);
      try {
        const isDir = statSync(path).isDirectory();
        const { entry } = place;
        if (entry.kind === 'dir' ? !isDir : isDir || !name.endsWith(entry.suffix)) continue;
        const at = freshness(path, isDir);
        if (at < from) continue;
        found.push({ rel: `${place.dir}/${name}${isDir ? '/' : ''}`, at });
      } catch {
        continue;
      }
    }
    found.sort((a, b) => b.at - a.at);
    out.push(...found.slice(0, place.take).map((item) => item.rel));
  }
  return out.slice(0, STAGE_ARTIFACTS_MAX);
}
