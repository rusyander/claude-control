import { join, resolve } from 'node:path';
import type { EstimateFields } from '@agentdeck/contracts/core/estimate';
import type { SendImage } from '@agentdeck/contracts/core/ask';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { longForm, projectRootOf } from '../../platform/paths.ts';
import { listDir, readBytesSync } from '../../platform/safe-io/files.ts';
import { pathsFoldCase } from '../../platform/user-dirs.ts';

/**
 * Место работы и чат (этап 10, решение 06:98). По умолчанию задача идёт в копии; основная папка
 * проекта — только с грантом человека на ЭТОТ корень и только для чата: чат, начатый из панели,
 * несёт грант сам (начало чата и есть разрешение), задача с хвостом доставки в основной папке
 * писала бы ветки и коммиты прямо в рабочее дерево человека.
 */

export const CHAT_PRESET = 'chat';

export function isChatScenario(scenario: EstimateFields['scenario']): boolean {
  return ('preset' in scenario ? scenario.preset : scenario.id) === CHAT_PRESET;
}

/**
 * Пути сравниваются разрешёнными: `C:/w/p` и `C:\w\p\` — один корень, а не повод для отказа.
 * Существующий путь — ещё и настоящим (`longForm` платформы): Windows отдаёт короткое имя 8.3
 * (`RUSYAN~1`), а оценка закрепляет репозиторий длинным — один корень двумя написаниями. Диск
 * читает платформа: дирижёру `node:fs` не положен (depcruise `core-io-only-in-platform`).
 */
const sameRoot = (a: string, b: string): boolean => {
  const norm = (p: string) => longForm(resolve(p)).replace(/[\\/]+$/, '');
  return pathsFoldCase() ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/**
 * Чат на месте в папке без git (s10 G12 p7): прежний чат панели шёл в любой папке, под ядром — так
 * же (этап 10 — паритет; спец не оставляет чат за репозиториями). Такой корень не закрепляется:
 * базы нет, копии, ветки и MR у чата нет и не будет; разговор идёт в самой папке по гранту
 * человека. Не чат, не на месте, не один корень или корень в git — `undefined`, путь как был:
 * подпапка репозитория остаётся репозиторием, негодная база отказывает, как отказывала. Папки нет
 * (git вне репозитория её не отличает) — отказ с её именем: сеанс без своей папки не начинается.
 */
export async function folderChatRoot(
  fields: EstimateFields,
  workTreeOf: (path: string) => Promise<object>,
): Promise<{ root: string } | { problem: string } | undefined> {
  if (!isChatScenario(fields.scenario) || fields.placement?.kind !== 'in-place') return undefined;
  const only = fields.repos.length === 1 ? fields.repos[0] : undefined;
  if (!only) return undefined;
  const tree = await workTreeOf(only.path);
  if (!('absent' in tree)) return undefined;
  const root = longForm(resolve(only.path));
  return 'value' in listDir(root) ? { root } : { problem: `${only.path}: no such folder` };
}

/** Почему `in-place` негоден для этих полей; пусто — годен (или поля просят копию). */
export function placementProblems(fields: EstimateFields): string[] {
  const p = fields.placement;
  // Сценарий «ask» — только своей ручкой: оценка дала бы ему репозиторий, копию и грант.
  if (
    'preset' in fields.scenario ? fields.scenario.preset === 'ask' : fields.scenario.id === 'ask'
  ) {
    return ['scenario ask: created only by POST /v1/ask'];
  }
  // Продолжение чужого разговора — только чат в самом корне: транскрипт CLI привязан к папке, где
  // разговор шёл, а копия — другая папка, и переходник его там не подтвердит.
  if (fields.resume && p?.kind !== 'in-place') {
    return ['resume: only an in-place chat continues an outside conversation'];
  }
  if (!p || p.kind === 'copy') return [];
  const out: string[] = [];
  if (!isChatScenario(fields.scenario)) {
    out.push(`placement in-place: only the ${CHAT_PRESET} scenario runs in the project root`);
  }
  if (fields.repos.length !== 1) {
    out.push(`placement in-place: one repository, got ${fields.repos.length}`);
  }
  const root = fields.repos[0]?.path;
  if (root !== undefined && !sameRoot(p.grant.project, root)) {
    out.push(`placement in-place: grant names ${p.grant.project}, the task root is ${root}`);
  }
  return out;
}

/** Грант человека на корень — строкой `grant.given` с ключом оценки (06:108-112). */
export function journalPlacementGrant(task: LiveTask, fields: EstimateFields, cmdId: string): void {
  const p = fields.placement;
  if (p?.kind !== 'in-place') return;
  task.append({
    kind: 'grant.given',
    actor: 'core',
    cmdId,
    data: { cmdId, project: p.grant.project, globs: ['**'], ops: p.grant.ops },
  });
}

/**
 * Лёгкая сессия «ask» (этап 10, F2): задача без репозитория, место — временный каталог ядра.
 * Признак — `placement: 'scratch'` в `task.created` вместе со сценарием `ask`; иначе — не она.
 */
export function isScratchTask(task: LiveTask): boolean {
  const created = task.state.created;
  return created?.placement === 'scratch' && created.scenario.id === 'ask';
}

/**
 * Корень, в котором единица чата идёт НА МЕСТЕ (этап 10, решение Q1 владельца): задача создана
 * `in-place`, её сценарий — чат, и грант человека с ключом оценки (`origin.cmdId`) назван на
 * корень репозитория этой единицы. Чего-то нет — `undefined`, и единица идёт в копии, как любая
 * задача: основная папка без гранта человека — защищённый корень (06:98), а не рабочее место.
 */
export function inPlaceRootOf(task: LiveTask, unitId: string): string | undefined {
  const created = task.state.created;
  if (!created || created.placement !== 'in-place') return undefined;
  if (created.scenario.id !== CHAT_PRESET) return undefined;
  const cmdId = created.origin?.cmdId;
  if (!cmdId) return undefined;
  // Папка без git (G12 p7): корень — сама папка, репозитория у задачи нет. Проект в подпапке
  // репозитория — корень и есть подпапка: грант назван на неё, сравнение с вершиной его не находило,
  // и чат молча уходил в копию всего репозитория.
  const repoKey = task.state.units[unitId]?.repoKey;
  const repo =
    created.repos.find((r) => r.repoKey === repoKey) ?? (repoKey ? undefined : created.repos[0]);
  const root = created.folder ?? (repo ? projectRootOf(repo) : undefined);
  if (!root) return undefined;
  const granted = readJournalLines(task.dir, task.taskId).lines.some((line) => {
    if (line.kind !== 'grant.given' || line.cmdId !== cmdId) return false;
    const d = line.data as { project?: unknown; ops?: unknown };
    return (
      typeof d.project === 'string' &&
      sameRoot(d.project, root) &&
      Array.isArray(d.ops) &&
      d.ops.includes('edit')
    );
  });
  return granted ? root : undefined;
}

/**
 * Первое слово чата — сообщение человека, с которым он открыл чат (`request.md` задачи), как он
 * его написал: чат — разговор, а не шаг с брифом. Файла нет или он пуст — `null` (вызывающий
 * отправит обычный бриф, сессия без слова не остаётся).
 */
export function chatOpeningOf(task: LiveTask): string | null {
  const source = task.state.created?.requirementsSource;
  if (!source) return null;
  const read = readBytesSync(join(task.dir, source));
  if (!('value' in read)) return null;
  const text = read.value.toString('utf8').trim();
  return text.length > 0 ? text : null;
}

/** Картинки первого слова вопроса «ask» — файлы каталога задачи из фактов `task.created`. */
export function chatImagesOf(task: LiveTask): SendImage[] {
  return (task.state.created?.ask?.images ?? []).map((image) => ({
    mediaType: image.mediaType,
    path: join(task.dir, image.file),
  }));
}

/**
 * Чат не оценивается: у сценария нет точки деления, и `estimating` ждало бы его вечно. Задача
 * остаётся черновиком до запуска человеком, а `auto` запускает сразу (`draft → running`); единицу
 * создаёт дирижёр (`create-unit`), как у задачи без деления.
 */
export function startChatTask(task: LiveTask, fields: EstimateFields, cmdId: string): void {
  if (fields.launchPolicy !== 'auto') return;
  task.append({
    kind: 'task.transition',
    actor: 'core',
    cmdId,
    data: { taskId: task.taskId, event: 'launch', from: 'draft', to: 'running' },
  });
}
