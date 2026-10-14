import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { findComposeFile } from '../../compose/compose-file.ts';
import { DockerStateProbe, shortDetail, type DockerExec } from '../../compose/docker.ts';

/**
 * Стенд для ревью MR (T5, T7): группа ревью с риском T2 доказывает дефекты
 * запросом к живому стенду, а конкурентные — на базе нужной версии. Живая
 * группа на MR 988 нашла `curl localhost:5173` с кодом 7 и «БД нет» в брифе
 * линий: часть уровня L3 молча пропала. Панель знает больше, чем агент, и
 * говорит это ДО старта группы — одним абзацем в задании:
 *
 * - есть ли стенд (запущенные цели панели) и чьё это дерево — оригинала, а не
 *   головы MR;
 * - есть ли Docker, и какая база описана в compose проекта;
 * - база нужной версии поднимается панелью — одноразовый контейнер с меткой,
 *   на 127.0.0.1, со своим паролем; снимается, когда группа закрыта.
 *
 * Чужую базу не трогаем НИКОГДА: ни строки подключения из `.env`, ни
 * запущенных контейнеров проекта — только свой контейнер, созданный здесь.
 * Не вышло — абзац прямо говорит «L3 в `uncovered` с причиной», а не молчит.
 */

/** Метка контейнеров, которые создаёт панель для ревью: по ней их находят и убирают. */
export const REVIEW_STAND_LABEL = 'agentdeck.ephemeral';
export const REVIEW_STAND_LABEL_VALUE = 'review';
const GROUP_LABEL = 'agentdeck.review-group';

/** Старше этого одноразовый контейнер при старте панели считается забытым. */
export const STALE_STAND_MS = 12 * 60 * 60 * 1000;

export interface ReviewStandDeps {
  docker: DockerExec;
  /** Цели панели для проекта: что работает и что можно запустить. */
  runner?: (projectDir: string) => {
    running: { name: string; url?: string }[];
    startable: string[];
  };
  /** Пауза между опросами готовности базы — в тесте нулевая. */
  sleep?: (ms: number) => Promise<void>;
  /** Сколько раз спросить `pg_isready`. */
  readyTries?: number;
  random?: () => string;
  now?: () => number;
}

/** Поднятый панелью контейнер — по нему группа и убирает его при закрытии. */
export interface ReviewStandContainer {
  name: string;
  image: string;
  startedAt: string;
}

export interface ReviewStand {
  /** Абзац для задания группы ревью (английский: читает модель). */
  text: string;
  container?: ReviewStandContainer;
}

const DB_IMAGE = /(postgres|pgvector|postgis|timescale)/i;
const IMAGE_LINE = /^\s*image:\s*["']?([^\s"'#]+)/;

/** Образ базы из compose-файла: тот, под который проект и пишет код. */
export function composePostgresImage(
  projectDir: string,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string | undefined {
  const location = findComposeFile(projectDir);
  if (!location) return undefined;
  for (const path of location.absolute) {
    let text: string;
    try {
      text = read(path);
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = IMAGE_LINE.exec(line);
      let image = match?.[1];
      if (!image) continue;
      // `${PG_IMAGE:-postgres:16}` — берём значение по умолчанию; без него версии нет.
      const fallback = /^\$\{[^:}]+:?-([^}]+)\}$/.exec(image);
      if (fallback?.[1]) image = fallback[1];
      if (image.includes('$')) continue;
      if (DB_IMAGE.test(image)) return image;
    }
  }
  return undefined;
}

/** Образ без хоста реестра — официальный или пользовательский с Docker Hub: его тянуть безопасно. */
function isHubImage(image: string): boolean {
  const first = image.split('/')[0] ?? '';
  return !(
    image.includes('/') &&
    (first.includes('.') || first.includes(':') || first === 'localhost')
  );
}

/** Версия сервера из тега образа, как её видит человек: `postgres:18.1-bookworm` → `18.1`. */
export function imageVersion(image: string): string {
  const tag = image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : '';
  return tag || 'latest';
}

const NO_DB =
  'Database: none available for this review. A concurrency or data-integrity defect cannot be proven live — ' +
  'list that check in "uncovered" with the reason "no database of the right version", never silently.';

/**
 * Одноразовая база для ревью. Любая неудача — текст причины, а не исключение:
 * группа стартует в любом случае.
 */
async function startThrowawayDatabase(
  image: string,
  groupKey: string,
  cwd: string,
  deps: ReviewStandDeps,
): Promise<{ container?: ReviewStandContainer; line: string }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const probe = await new DockerStateProbe(deps.docker, deps.now).read(cwd);
  if (probe.state !== 'ok') {
    const why =
      probe.state === 'missing'
        ? 'Docker is not installed'
        : `the Docker daemon is not running${probe.detail ? ` (${probe.detail.split('\n')[0]})` : ''}`;
    return {
      line:
        `Database: the project declares ${image}, but ${why}, so no throwaway database could be started. ` +
        'A concurrency or data-integrity defect cannot be proven live — list that check in "uncovered" ' +
        `with the reason "${probe.state === 'missing' ? 'no Docker' : 'Docker daemon stopped'}", never silently.`,
    };
  }

  const local = await deps.docker(['image', 'inspect', image], cwd, 15_000);
  if (local.code !== 0) {
    if (!isHubImage(image)) {
      return {
        line:
          `Database: the project declares ${image} from a private registry that the panel does not pull from. ` +
          NO_DB.replace('Database: none available for this review. ', ''),
      };
    }
    const pulled = await deps.docker(['pull', image], cwd, 240_000);
    if (pulled.code !== 0) {
      return {
        line:
          `Database: the image ${image} is not on this machine and pulling it failed (${shortDetail(pulled.stderr || pulled.stdout, 160)}). ` +
          NO_DB.replace('Database: none available for this review. ', ''),
      };
    }
  }

  const suffix = (deps.random ?? (() => randomBytes(4).toString('hex')))();
  const name = `agentdeck-review-${suffix}`;
  const password = randomBytes(9).toString('hex');
  const created = await deps.docker(
    [
      'run',
      '-d',
      '--name',
      name,
      '--label',
      `${REVIEW_STAND_LABEL}=${REVIEW_STAND_LABEL_VALUE}`,
      '--label',
      `${GROUP_LABEL}=${groupKey}`,
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      'POSTGRES_DB=review',
      '-p',
      '127.0.0.1::5432',
      image,
    ],
    cwd,
    60_000,
  );
  if (created.code !== 0) {
    return {
      line:
        `Database: starting ${image} failed (${shortDetail(created.stderr || created.stdout, 160)}). ` +
        NO_DB.replace('Database: none available for this review. ', ''),
    };
  }
  const forget = async (): Promise<void> => {
    await deps.docker(['rm', '-f', name], cwd, 30_000);
  };

  let ready = false;
  const tries = deps.readyTries ?? 40;
  for (let attempt = 0; attempt < tries && !ready; attempt += 1) {
    const check = await deps.docker(
      ['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'review'],
      cwd,
      10_000,
    );
    ready = check.code === 0;
    if (!ready) await sleep(1000);
  }
  if (!ready) {
    await forget();
    return {
      line:
        `Database: ${image} did not become ready in time and was removed. ` +
        NO_DB.replace('Database: none available for this review. ', ''),
    };
  }
  const mapped = await deps.docker(['port', name, '5432/tcp'], cwd, 10_000);
  const port = /:(\d+)\s*$/m.exec(mapped.stdout.trim().split(/\r?\n/)[0] ?? '')?.[1];
  if (mapped.code !== 0 || !port) {
    await forget();
    return {
      line:
        `Database: ${image} started but its port could not be read, so it was removed. ` +
        NO_DB.replace('Database: none available for this review. ', ''),
    };
  }
  const startedAt = new Date((deps.now ?? Date.now)()).toISOString();
  return {
    container: { name, image, startedAt },
    line:
      `Database: a throwaway PostgreSQL ${imageVersion(image)} (image ${image}, the version the project declares) ` +
      `runs for THIS review only at postgresql://postgres:${password}@127.0.0.1:${port}/review (container ${name}). ` +
      'It is empty: apply the schema and migrations of the head of this MR into it yourself and use it for concurrency ' +
      'and data-integrity probes (two sessions, locks, races). It is removed when this group closes. ' +
      'It is the ONLY database you may write to: never use a connection string from .env, the compose services or ' +
      'any other running database.',
  };
}

/**
 * Что панель знает про стенд и базу к началу группы ревью. Ничего не бросает:
 * при любом сбое группа получает абзац «стенда нет — L3 в `uncovered`».
 */
export async function prepareReviewStand(
  input: { originDir: string; copyDir: string; groupKey: string },
  deps: ReviewStandDeps,
): Promise<ReviewStand> {
  const parts: string[] = [];
  let container: ReviewStandContainer | undefined;

  try {
    const runner = deps.runner?.(input.originDir);
    if (runner && runner.running.length > 0) {
      parts.push(
        `Stand: the panel runs ${runner.running
          .map((item) => `${item.name}${item.url ? ` at ${item.url}` : ''}`)
          .join(
            ', ',
          )}. That is the project's ORIGINAL checkout, not the head of this MR — a probe against it ` +
          'answers for the base; say so in the review wherever you rely on it.',
      );
    } else if (runner && runner.startable.length > 0) {
      parts.push(
        `Stand: none is running now (the panel can start ${runner.startable.slice(0, 5).join(', ')} from the original ` +
          'checkout, not from this copy). Live checks against a stand (level L3) are not possible unless you start ' +
          'one yourself from this copy; without a stand, name L3 in "uncovered" with the reason "no stand".',
      );
    } else {
      parts.push(
        'Stand: none — no running target and nothing the panel can start. Level L3 (live checks against a stand) goes ' +
          'to "uncovered" with the reason "no stand", never silently.',
      );
    }
  } catch {
    parts.push(
      'Stand: unknown; if live checks are needed and nothing answers, name L3 in "uncovered".',
    );
  }

  try {
    const image = composePostgresImage(input.copyDir);
    if (image) {
      const started = await startThrowawayDatabase(image, input.groupKey, input.copyDir, deps);
      container = started.container;
      parts.push(started.line);
    } else {
      parts.push(NO_DB);
    }
  } catch {
    parts.push(NO_DB);
  }

  return { text: parts.join('\n'), ...(container ? { container } : {}) };
}

/** Убрать одноразовый контейнер ревью. `true` — его больше нет (в том числе не было). */
export async function removeReviewStand(
  docker: DockerExec,
  name: string,
  cwd: string,
): Promise<boolean> {
  if (!/^agentdeck-review-[a-z0-9]+$/.test(name)) return false;
  const result = await docker(['rm', '-f', name], cwd, 30_000);
  return result.code === 0 || /No such container/i.test(result.stderr);
}

/**
 * Страховка на старт панели: контейнеры ревью, забытые упавшей панелью. Только
 * свои — по метке, и только старше `STALE_STAND_MS`: группа, живая в другой
 * панели на этой машине, свою базу сохраняет.
 */
export async function sweepStaleReviewStands(
  docker: DockerExec,
  cwd: string,
  now: () => number = Date.now,
): Promise<string[]> {
  const listed = await docker(
    [
      'ps',
      '-a',
      '--filter',
      `label=${REVIEW_STAND_LABEL}=${REVIEW_STAND_LABEL_VALUE}`,
      '--format',
      '{{.Names}}',
    ],
    cwd,
    15_000,
  );
  if (listed.code !== 0) return [];
  const removed: string[] = [];
  for (const name of listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    const info = await docker(['inspect', '-f', '{{.Created}}', name], cwd, 10_000);
    const created = Date.parse(info.stdout.trim());
    if (info.code !== 0 || !Number.isFinite(created) || now() - created < STALE_STAND_MS) continue;
    if (await removeReviewStand(docker, name, cwd)) removed.push(name);
  }
  return removed;
}
