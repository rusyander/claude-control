import { liveGrants } from '../../conductor/human/permit-point.ts';
import { readHumanLedger } from '../../conductor/human/ledger.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { listEnvFilesSync } from '../../platform/env-files.ts';
import { readCoreConfig, sectionProblem } from '../../platform/core-config/read.ts';
import { pathKey } from '../../platform/paths.ts';
import { readBytesSync } from '../../platform/safe-io/files.ts';
import type { GlobOps, PermitContext } from '../../policy/permit/permit.types.ts';
import { classifyEnv, isCopyEnvFile, parseEnvText } from '../../verifier/env/index.ts';
import { enterDir } from '../../verifier/profile/inputs.ts';

/**
 * Факты пунктов человека 3 и 5 для права сессии (06 §grantRequired, §Human points; P130): без них
 * судья права не отказывает ни правкой под `grantRequired`, ни чтением источника адреса сервиса,
 * и пункт человека в настоящем прогоне не поднимается.
 *
 * - `grantRequired` — из конфига ядра, как список чтения (`read-allow.ts`): `config.json` →
 *   `grantRequired: [{project: "<путь репозитория>", globs: [...], ops: [...]}]`, только записи
 *   исходного репозитория шага. Пишет его API ядра (фаза 7); файлы репозитория и модель — никогда.
 * - `grants` — гранты ЭТОЙ задачи из журнала по ключу репозитория единицы; грант посреди шага
 *   подбирает судья на отказе (`judgeWithGrants`), здесь — данные до запуска и после перезапуска.
 * - `endpointSources` — файлы окружения с адресом сервиса, который ядро не подменило своим:
 *   в исходном репозитории — любой такой файл (контейнеров ядра там нет, каждый адрес настоящий),
 *   в копии — файл с удалённым адресом (локальные адреса копии ядро переписало на свои контейнеры
 *   или убрало, P84). Нечитаемый файл окружения — источник: что в нём, не известно.
 */

export interface PermitSourcesOutcome {
  grantRequired: GlobOps[];
  grants: PermitContext['grants'];
  endpointSources: string[];
  /** Что не прочитано — называется сигналом дороги, область не расширяется. */
  problems: { subject: string; why: string }[];
}

/** Обход ограничен: входы окружения глубже не живут, а обход дорожает на каждом запуске. */
const MAX_DEPTH = 4;
const MAX_ENTRIES = 20_000;

/**
 * Записи `grantRequired` исходного репозитория через единого читателя настройки. Кривая строка —
 * проблема с номером, а не тихий пропуск (она могла защищать этот репозиторий); годные строки
 * при этом действуют — читатель спасает раздел по строкам, одна кривая маска не снимает защиту
 * остальных. Правка мимо API (дрейф, G6) не действует: маски — из последней записи ядра.
 */
export function grantRequiredFor(
  configPath: string,
  repo: string | undefined,
): { entries: GlobOps[]; problem?: string } {
  if (repo === undefined) return { entries: [] };
  const read = readCoreConfig({ config: configPath });
  if ('absent' in read) return { entries: [] };
  if ('unknown' in read) return { entries: [], problem: `core config unreadable: ${read.unknown}` };
  const want = pathKey(repo);
  const entries: GlobOps[] = (read.value.doc.grantRequired ?? [])
    .filter((row) => pathKey(row.project) === want)
    .map((row) => ({ globs: row.globs, ops: row.ops }));
  const problem = sectionProblem(read.value, 'grantRequired');
  return problem ? { entries, problem } : { entries };
}

/** Файлы окружения под корнем (без образцов), обход как у профиля: без `node_modules`, `.git/…`. */
function envFilesUnder(root: string): { files: string[]; problem?: string } {
  return listEnvFilesSync(root, {
    isEnvFile: isCopyEnvFile,
    enterDir,
    maxDepth: MAX_DEPTH,
    maxEntries: MAX_ENTRIES,
  });
}

function holdsEndpoint(file: string, remoteOnly: boolean): boolean {
  const bytes = readBytesSync(file);
  if ('absent' in bytes) return false;
  if (!('value' in bytes)) return true;
  const sample = parseEnvText(bytes.value.toString('utf8')).map((r) => ({
    name: r.name,
    value: r.value,
  }));
  return classifyEnv(sample).some((v) => !remoteOnly || v.hostKind === 'remote');
}

export function endpointSourcesFor(
  copyRoot: string,
  sourceRepo: string | undefined,
): { sources: string[]; problems: { subject: string; why: string }[] } {
  const sources: string[] = [];
  const problems: { subject: string; why: string }[] = [];
  const roots: [string, boolean][] = [[copyRoot, true]];
  if (sourceRepo !== undefined && pathKey(sourceRepo) !== pathKey(copyRoot)) {
    roots.push([sourceRepo, false]);
  }
  for (const [root, remoteOnly] of roots) {
    const found = envFilesUnder(root);
    if (found.problem) problems.push({ subject: root, why: found.problem });
    for (const file of found.files) if (holdsEndpoint(file, remoteOnly)) sources.push(file);
  }
  return { sources, problems };
}

export function permitSourcesFor(
  task: LiveTask,
  where: { stepId: string; copyRoot: string; sourceRepo: string | undefined; config: string },
): PermitSourcesOutcome {
  const required = grantRequiredFor(where.config, where.sourceRepo);
  const ledger = readHumanLedger(task);
  const unitId = ledger.steps[where.stepId]?.unitId;
  const endpoints = endpointSourcesFor(where.copyRoot, where.sourceRepo);
  return {
    grantRequired: required.entries,
    grants: unitId ? liveGrants(ledger, unitId) : [],
    endpointSources: endpoints.sources,
    problems: [
      ...(required.problem ? [{ subject: where.config, why: required.problem }] : []),
      ...endpoints.problems,
    ],
  };
}
