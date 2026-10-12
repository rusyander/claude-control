import { randomUUID } from 'node:crypto';
import type {
  ApiExplorerInfo,
  ApiHistoryEntry,
  ApiMethod,
  ApiRunningService,
  ApiSendResult,
  ApiSource,
  ApiSpec,
  ProjectRunnerView,
} from '@agentdeck/contracts';
import { normalizeProjectPath } from '../../lib/app-store/projects.ts';
import { ApiSendError, ApiSpecError } from './api-explorer.types.ts';
import { findSpecFiles, probeServices } from './discover.ts';
import { findEnvUrls } from './env-urls.ts';
import { loadSpecCollection, loadSpecFile, loadSpecUrl } from './load.ts';
import { sendRequest } from './send.ts';
import { collectionsDir, maskSecret, pushHistory, readAuth, readProject } from './store.ts';
import { checkResponse } from './validate.ts';

/**
 * Вкладка «API» окна «Окружение»: источники контракта проекта, разбор,
 * отправка запроса со сверкой ответа и запись в историю. Маршруты — тонкий
 * слой над этим модулем.
 */

export { ApiSendError, ApiSpecError } from './api-explorer.types.ts';
export {
  addCollection,
  addUrlSource,
  clearHistory,
  readProject,
  removeCollection,
  removeUrlSource,
  setAuth,
  setBaseUrl,
} from './store.ts';
export { loadSpecUrl, parseSpecText } from './load.ts';

/** Работающие цели «Dev-сервера» этого проекта с известным адресом. */
export function runningServices(root: string, runs: ProjectRunnerView[]): ApiRunningService[] {
  const own = normalizeProjectPath(root);
  return runs
    .filter(
      (run) =>
        run.status === 'running' &&
        Boolean(run.url) &&
        normalizeProjectPath(run.projectPath) === own,
    )
    .map((run) => ({ name: run.name, url: (run.url ?? '').replace(/\/$/, '') }));
}

export async function describeExplorer(
  appData: string,
  root: string,
  services: ApiRunningService[],
  fresh = false,
): Promise<ApiExplorerInfo> {
  const record = readProject(appData, root);
  const sources: ApiSource[] = findSpecFiles(root).map((rel) => ({
    id: `file:${rel}`,
    kind: 'file',
    label: rel,
    removable: false,
  }));
  const saved = new Set(record.urlSources ?? []);
  for (const url of await probeServices(services, fresh)) {
    if (!saved.has(url))
      sources.push({ id: `url:${url}`, kind: 'url', label: url, removable: false });
  }
  for (const url of saved)
    sources.push({ id: `url:${url}`, kind: 'url', label: url, removable: true });
  for (const collection of record.collections ?? []) {
    sources.push({
      id: `postman:${collection.id}`,
      kind: 'postman',
      label: collection.name,
      removable: true,
    });
  }
  const auth = readAuth(appData, root);
  return {
    sources,
    services,
    envUrls: findEnvUrls(root),
    ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
    ...(auth ? { auth: { header: auth.header, masked: maskSecret(auth.value) } } : {}),
  };
}

/**
 * Разобрать источник. Файл — только внутри проекта и только `.json/.yaml`;
 * коллекция — только своя этого проекта; адрес — любой, его вписал человек
 * или нашёл опрос работающего сервиса.
 */
export async function loadSource(
  appData: string,
  root: string,
  sourceId: string,
  fresh = false,
): Promise<ApiSpec> {
  if (sourceId.startsWith('file:')) {
    const rel = sourceId.slice('file:'.length);
    if (!/\.(json|ya?ml)$/i.test(rel)) throw new ApiSpecError('missing', rel);
    return loadSpecFile(root, rel, sourceId);
  }
  if (sourceId.startsWith('url:'))
    return loadSpecUrl(sourceId.slice('url:'.length), sourceId, fresh);
  if (sourceId.startsWith('postman:')) {
    const id = sourceId.slice('postman:'.length);
    const own = readProject(appData, root).collections ?? [];
    if (!own.some((item) => item.id === id)) throw new ApiSpecError('missing', id);
    return loadSpecCollection(collectionsDir(appData), id, sourceId);
  }
  throw new ApiSpecError('missing', sourceId);
}

export interface SendCommand {
  method: ApiMethod;
  url: string;
  headers: [string, string][];
  body?: string;
  sourceId?: string;
  endpointId?: string;
  useAuth?: boolean;
}

/** Сохранённый заголовок авторизации поверх заданного в форме (форма его не знает). */
function withAuth(
  headers: [string, string][],
  auth: { header: string; value: string } | undefined,
) {
  if (!auth) return headers;
  const name = auth.header.toLowerCase();
  return [
    ...headers.filter(([key]) => key.trim().toLowerCase() !== name),
    [auth.header, auth.value],
  ] as [string, string][];
}

export async function sendAndRecord(
  appData: string,
  root: string,
  command: SendCommand,
  send: typeof sendRequest = sendRequest,
): Promise<ApiSendResult> {
  const headers = withAuth(command.headers, command.useAuth ? readAuth(appData, root) : undefined);
  const entry: ApiHistoryEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    method: command.method,
    url: command.url,
    ...(command.sourceId ? { sourceId: command.sourceId } : {}),
    ...(command.endpointId ? { endpointId: command.endpointId } : {}),
    headers,
    ...(command.body ? { body: command.body } : {}),
  };
  let result: ApiSendResult;
  try {
    result = await send({
      method: command.method,
      url: command.url,
      headers,
      ...(command.body !== undefined ? { body: command.body } : {}),
    });
  } catch (error) {
    if (error instanceof ApiSendError) pushHistory(appData, root, { ...entry, error: error.kind });
    throw error;
  }
  if (command.sourceId && command.endpointId && !result.bodyTruncated && !result.binary) {
    try {
      const spec = await loadSource(appData, root, command.sourceId);
      const endpoint = spec.endpoints.find((item) => item.id === command.endpointId);
      const check = endpoint
        ? checkResponse(endpoint, result.status, result.contentType, result.body)
        : undefined;
      if (check) result.check = check;
    } catch {
      // Контракт за это время пропал или сломался — ответ всё равно показываем, без сверки.
    }
  }
  pushHistory(appData, root, {
    ...entry,
    status: result.status,
    durationMs: result.durationMs,
    ...(result.check ? { verdict: result.check.verdict } : {}),
  });
  return result;
}
