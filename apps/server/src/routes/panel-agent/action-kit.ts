import type { PanelActionPreview, PanelTextCode } from '@agentdeck/contracts/panel-agent';
import {
  findSecretSpans,
  isSecretFree,
  isSecretName,
  maskNamedValue,
  maskSecretsInText,
  SECRET_MASK,
} from '../../lib/secret-mask.ts';
import { unifiedDiff } from '../../domains/config-preview/unified-diff.ts';
import type { ConfigPreviewRequest, ConfigPreviewResponse } from '../../domains/config-preview.ts';
import { fingerprintOf, type InjectRoute } from './registry.ts';
import { dataField, summaryText, textField } from './texts.ts';

/**
 * Общие приёмы действий волны A: чтение маршрутом, маска секретов для модели,
 * карточка состояния (дифф записи в state.json глазами человека) и карточка
 * файла через `/api/config-preview`.
 */

export const encode = encodeURIComponent;

/** Ответ маршрута чтения или исключение с его текстом: карточка без данных — отказ. */
export async function readRoute<T>(inject: InjectRoute, url: string): Promise<T> {
  const answer = await inject({ method: 'GET', url });
  if (answer.status >= 400)
    throw new Error(`${url} answered ${answer.status}: ${textOf(answer.body)}`);
  return answer.body as T;
}

/** Текст отказа маршрута: `message`, затем `error`, затем тело строкой. */
export function textOf(body: unknown): string {
  if (body && typeof body === 'object') {
    const record = body as { message?: unknown; error?: unknown };
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
  }
  return typeof body === 'string' ? body.slice(0, 300) : '';
}

/**
 * Значение для глаз модели: секретные имена прячут значение целиком, остальное
 * проходит детектор. Идёт вглубь объектов и массивов — ответы маршрутов разные.
 */
export function maskDeep(value: unknown, name = ''): unknown {
  if (typeof value === 'string')
    return name ? maskNamedValue(name, value) : maskSecretsInText(value);
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, name));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        isSecretName(key) && typeof item === 'string' && item && !isSecretFree(item)
          ? SECRET_MASK
          : maskDeep(item, key),
      ]),
    );
  }
  return value;
}

/**
 * Строки, в которых агент прислал живой секрет. Секреты вводит только человек:
 * поле пароля на странице раздела. Ссылка `${VAR}` секретом не считается.
 */
export function literalSecrets(fields: Record<string, string | undefined>): string[] {
  return Object.entries(fields)
    .filter(([name, value]) => {
      if (!value || isSecretFree(value)) return false;
      return (isSecretName(name) && value.trim() !== '') || findSecretSpans(value).length > 0;
    })
    .map(([name]) => name);
}

export const SECRET_REFUSAL =
  'Secret values are never accepted from the agent: leave it empty — the human enters it in the panel.';

/** Длинный текст для модели: окно по смещению, чтобы большой файл читался частями. */
export function textWindow(text: string, offset = 0, limit = 20_000) {
  const slice = text.slice(offset, offset + limit);
  return {
    text: slice,
    offset,
    length: text.length,
    ...(offset + limit < text.length ? { nextOffset: offset + limit } : {}),
  };
}

const json = (value: unknown): string =>
  value === undefined ? '' : `${JSON.stringify(maskDeep(value), null, 2)}\n`;

/**
 * Карточка правки состояния панели (группа, настройки, правила защиты данных,
 * интеграция): дифф маскированного JSON «было → станет» той записи, которую
 * пишет маршрут. Файла конфигурации тут нет — запись идёт в `state.json` или
 * файл данных панели, — поэтому дифф назван по записи, а не по пути.
 */
export function stateCard(
  label: string,
  before: unknown,
  after: unknown,
  summary: ReturnType<typeof summaryText>,
  fields: PanelActionPreview['fields'] = [],
): PanelActionPreview {
  const diff = unifiedDiff(label, json(before), json(after));
  if (!diff.truncated && diff.diff === '' && before !== undefined) {
    throw new Error('Nothing would change: the current state already matches the request.');
  }
  return {
    ...summary,
    fields,
    ...(diff.truncated
      ? {
          truncated: true,
          diff: `--- a/${label}\n+++ b/${label}\n(правка слишком велика для построчного диффа)`,
        }
      : { diff: diff.diff }),
  };
}

/** Отпечаток записи, прочитанной маршрутом чтения: сверяется перед исполнением. */
export async function routeFingerprint(
  inject: InjectRoute,
  url: string,
  pick: (body: unknown) => unknown = (body) => body,
): Promise<string> {
  return fingerprintOf(pick(await readRoute<unknown>(inject, url)));
}

/** Предпросмотр файла маршрутом; отказ маршрута — исключение с его текстом. */
export async function requestFilePreview(
  inject: InjectRoute,
  request: ConfigPreviewRequest,
): Promise<ConfigPreviewResponse> {
  const answer = await inject({ method: 'POST', url: '/api/config-preview', body: request });
  if (answer.status >= 400)
    throw new Error(textOf(answer.body) || `Preview answered ${answer.status}`);
  return answer.body as ConfigPreviewResponse;
}

export async function fileFingerprint(inject: InjectRoute, request: ConfigPreviewRequest) {
  const preview = await requestFilePreview(inject, request);
  return fingerprintOf({ request, source: preview.fingerprint });
}

/** Карточка файла: дифф по каждому файлу, заметки — полями «Кроме файла». */
export async function fileCard(
  inject: InjectRoute,
  request: ConfigPreviewRequest,
  summary: ReturnType<typeof summaryText>,
  fields: PanelActionPreview['fields'] = [],
): Promise<PanelActionPreview> {
  const preview = await requestFilePreview(inject, request);
  const changed = preview.files.filter((file) => !file.unchanged);
  if (changed.length === 0 && preview.notes.length === 0) {
    throw new Error('Nothing would change: the file already matches the request.');
  }
  const truncated = changed.some((file) => file.truncated);
  return {
    ...(truncated ? { truncated: true } : {}),
    ...summary,
    fields: [
      ...fields,
      ...changed.map((file) =>
        dataField(
          file.exists ? 'label-file' : 'label-new-file',
          `${file.path} (+${file.added} −${file.removed})`,
        ),
      ),
      ...changed
        .filter((file) => file.reformatted)
        .map((file) => textField('label-file-shape', 'value-file-shape', { path: file.path })),
      ...preview.notes.map((note) => dataField('label-besides-file', note)),
    ],
    ...(changed.length > 0
      ? {
          diff: changed
            .map((file) =>
              file.truncated
                ? `--- a/${file.path}\n+++ b/${file.path}\n(правка слишком велика для построчного диффа)`
                : file.diff,
            )
            .join('\n'),
        }
      : {}),
  };
}

/** Сводка кодом — короткая запись для действий этого набора. */
export const card = (code: PanelTextCode, params: Record<string, string | number> = {}) =>
  summaryText(code, params);
