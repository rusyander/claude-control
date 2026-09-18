import type { CiSettings } from '@agentdeck/contracts';
import { readZip } from '../../lib/zip.ts';
import { invalidField, unreachable } from './errors.ts';
import { failedResponse, parseJson, sendRequest } from './http.ts';
import { repoFromOrigin } from './forge.ts';
import { coded } from '../../lib/server-text.ts';

/**
 * Отчёт последнего прогона CI — сюда, в кейсы.
 *
 * Панель уже умеет принимать junit файлом (раздел «Обмен»), но за файлом надо
 * идти в браузер, в чужой интерфейс, найти нужный прогон и скачать артефакт.
 * Здесь то же самое делается по кнопке: панель знает репозиторий и токен, а
 * дальше — три запроса и распаковка.
 *
 * Своего разбора junit тут НЕТ: содержимое отдаётся существующему импорту
 * (`domains/project-tests/import-results.ts`), который уже знает и про
 * playwright, и про allure, и про то, как ложатся статусы. Второй разбор того
 * же формата разошёлся бы с первым на первой же нестандартной выгрузке.
 */

export interface CiReport {
  /** Содержимое junit-отчёта. */
  content: string;
  /** Откуда он взялся — строка для человека: прогон, задание, имя файла. */
  source: string;
}

interface CiAccess {
  kind: 'github' | 'gitlab';
  api: string;
  repo: string;
  token: string;
  workflow: string;
  artifact: string;
}

/**
 * Что нужно сверх самой настройки CI.
 *
 * `baseUrl` приходит СНАРУЖИ, а не из `CiSettings`: своего адреса у карточки CI
 * нет намеренно — CI живёт там же, где репозиторий, и второй адрес той же
 * инсталляции человек рано или поздно ввёл бы с опечаткой. Маршрут подаёт сюда
 * адрес форджа, когда вид совпадает.
 */
export interface CiContext {
  projectRoot?: string;
  /** Своя инсталляция: корень сайта, у которого API живёт под `/api/v3|v4`. */
  baseUrl?: string;
}

function toAccess(settings: CiSettings, token: string, context: CiContext = {}): CiAccess {
  const kind = settings.kind;
  if (kind !== 'github' && kind !== 'gitlab') {
    throw invalidField(
      'kind',
      'не выбрана система CI (github или gitlab)',
      'request-ci-kind-missing',
      { field: 'kind' },
    );
  }
  const repo =
    settings.repo.trim() || (context.projectRoot ? repoFromOrigin(context.projectRoot) : '');
  if (!repo) {
    throw invalidField(
      'repo',
      'не указан репозиторий и его не удалось вывести из origin',
      'request-repo-missing',
      { field: 'repo' },
    );
  }
  const site = (context.baseUrl ?? '').trim().replace(/\/+$/, '');
  return {
    kind,
    api: apiRoot(kind, site),
    repo,
    token,
    workflow: settings.workflow.trim(),
    artifact: settings.artifact.trim(),
  };
}

function apiRoot(kind: 'github' | 'gitlab', site: string): string {
  if (kind === 'gitlab') return `${site || 'https://gitlab.com'}/api/v4`;
  return site && site !== 'https://github.com' ? `${site}/api/v3` : 'https://api.github.com';
}

function headers(access: CiAccess): Record<string, string> {
  return access.kind === 'github'
    ? { Authorization: `Bearer ${access.token}`, Accept: 'application/vnd.github+json' }
    : { 'PRIVATE-TOKEN': access.token };
}

function systemName(access: CiAccess): string {
  return access.kind === 'github' ? 'GitHub Actions' : 'GitLab CI';
}

async function get<T>(access: CiAccess, path: string): Promise<T> {
  const response = await sendRequest({
    url: `${access.api}${path}`,
    system: systemName(access),
    headers: { ...headers(access), Accept: 'application/json' },
  });
  if (!response.ok) {
    throw failedResponse(systemName(access), response, 500);
  }
  return parseJson<T>(systemName(access), response);
}

async function getBytes(access: CiAccess, path: string): Promise<Buffer> {
  const response = await sendRequest({
    url: `${access.api}${path}`,
    system: systemName(access),
    headers: headers(access),
    binary: true,
  });
  if (!response.ok) {
    throw failedResponse(systemName(access), response, 500);
  }
  return response.bytes ?? Buffer.alloc(0);
}

/**
 * XML-запись архива. Имя из настройки сильнее: в артефакте рядом с junit часто
 * лежат скриншоты и трассы, и «первый попавшийся xml» — это лотерея.
 */
function pickXml(entries: { path: string; data: Buffer }[], wanted: string): string {
  const named = wanted
    ? entries.find((entry) => entry.path === wanted || entry.path.endsWith(`/${wanted}`))
    : undefined;
  const found = named ?? entries.find((entry) => entry.path.toLowerCase().endsWith('.xml'));
  if (!found) {
    throw wanted
      ? coded(unreachable(`В артефакте нет файла «${wanted}».`), 'ci-artifact-file-missing', {
          name: wanted,
        })
      : coded(
          unreachable('В артефакте нет ни одного XML-отчёта — укажите имя файла в настройках CI.'),
          'ci-artifact-no-xml',
        );
  }
  return found.data.toString('utf8');
}

interface GhRun {
  id: number;
  name?: string;
  display_title?: string;
  head_branch?: string;
  conclusion?: string;
}

async function fetchGithub(access: CiAccess): Promise<CiReport> {
  const runs = await get<{ workflow_runs?: GhRun[] }>(
    access,
    `/repos/${access.repo}/actions/runs?status=completed&per_page=20`,
  );
  const candidates = runs.workflow_runs ?? [];
  const run = access.workflow
    ? candidates.find((item) => item.name === access.workflow)
    : candidates[0];
  if (!run) {
    throw access.workflow
      ? coded(
          unreachable(`Завершённых прогонов workflow «${access.workflow}» не нашлось.`),
          'ci-workflow-runs-missing',
          { workflow: access.workflow },
        )
      : coded(
          unreachable('В репозитории нет ни одного завершённого прогона Actions.'),
          'ci-no-finished-runs',
        );
  }

  const artifacts = await get<{ artifacts?: { id: number; name: string }[] }>(
    access,
    `/repos/${access.repo}/actions/runs/${run.id}/artifacts`,
  );
  const list = artifacts.artifacts ?? [];
  const artifact = access.artifact
    ? (list.find((item) => item.name === access.artifact) ?? list[0])
    : list[0];
  if (!artifact)
    throw coded(unreachable(`У прогона ${run.id} нет артефактов.`), 'ci-run-no-artifacts', {
      id: run.id,
    });

  const zip = await getBytes(access, `/repos/${access.repo}/actions/artifacts/${artifact.id}/zip`);
  return {
    content: pickXml(readZip(zip), access.artifact),
    source: `${run.display_title ?? run.name ?? 'прогон'} #${run.id} · артефакт «${artifact.name}»`,
  };
}

interface GlJob {
  id: number;
  name?: string;
  artifacts_file?: { filename?: string };
}

async function fetchGitlab(access: CiAccess): Promise<CiReport> {
  const project = encodeURIComponent(access.repo);
  const pipelines = await get<{ id: number; ref?: string }[]>(
    access,
    `/projects/${project}/pipelines?per_page=5&order_by=id&sort=desc`,
  );
  const pipeline = pipelines?.[0];
  if (!pipeline) throw coded(unreachable('В проекте нет ни одного конвейера.'), 'ci-no-pipelines');

  const jobs = await get<GlJob[]>(
    access,
    `/projects/${project}/pipelines/${pipeline.id}/jobs?per_page=100`,
  );
  const withArtifacts = (jobs ?? []).filter((job) => job.artifacts_file?.filename);
  const job = access.workflow
    ? withArtifacts.find((item) => item.name === access.workflow)
    : withArtifacts[0];
  if (!job) {
    throw access.workflow
      ? coded(
          unreachable(`В конвейере ${pipeline.id} нет задания «${access.workflow}» с артефактами.`),
          'ci-pipeline-job-missing',
          { pipeline: pipeline.id, workflow: access.workflow },
        )
      : coded(
          unreachable(`В конвейере ${pipeline.id} ни одно задание не оставило артефактов.`),
          'ci-pipeline-no-artifacts',
          { pipeline: pipeline.id },
        );
  }

  // Путь к файлу внутри артефактов GitLab отдаёт напрямую — это дешевле, чем
  // тянуть архив целиком ради одного XML.
  if (access.artifact.toLowerCase().endsWith('.xml')) {
    const raw = await getBytes(
      access,
      `/projects/${project}/jobs/${job.id}/artifacts/${access.artifact
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`,
    );
    return {
      content: raw.toString('utf8'),
      source: `конвейер ${pipeline.id} · задание «${job.name ?? job.id}» · ${access.artifact}`,
    };
  }

  const zip = await getBytes(access, `/projects/${project}/jobs/${job.id}/artifacts`);
  return {
    content: pickXml(readZip(zip), access.artifact),
    source: `конвейер ${pipeline.id} · задание «${job.name ?? job.id}»`,
  };
}

/** Забрать junit последнего прогона CI. Формат разбора — существующий импорт. */
export async function fetchCiReport(
  settings: CiSettings,
  token: string,
  context: CiContext = {},
): Promise<CiReport> {
  const access = toAccess(settings, token, context);
  return access.kind === 'github' ? fetchGithub(access) : fetchGitlab(access);
}
