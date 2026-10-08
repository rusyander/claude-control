import type { PanelActionPreview, PanelTextCode } from '@agentdeck/contracts/panel-agent';
import {
  findSecretSpans,
  isSecretFree,
  isSecretName,
  maskNamedValue,
  maskSecretsInText,
  restoreMaskedSecrets,
  SECRET_MASK,
} from '../../../lib/secret-mask/secret-mask.ts';
import { unifiedDiff } from '../../../domains/config-preview/unified-diff.ts';
import type {
  ConfigPreviewRequest,
  ConfigPreviewResponse,
} from '../../../domains/config-preview/config-preview.ts';
import { fingerprintOf, type InjectRoute } from '../registry.ts';
import { isLabelField, labelsSecretValue } from '../result-net/result-net.ts';
import { dataField, summaryText, textField } from '../texts/texts.ts';

/**
 * Общие приёмы действий волны A: чтение маршрутом, маска секретов для модели,
 * карточка состояния (дифф записи в state.json глазами человека) и карточка
 * файла через `/api/config-preview`.
 */

export const encode = encodeURIComponent;

/**
 * id из нескольких сегментов (`dir/notify.sh`) — в путь адреса, каждый сегмент
 * закодирован. `encodeURIComponent('..')` — это `..`: `inject` снял бы его вместе с
 * соседним сегментом и исполнил чужой маршрут (ревью U0, M1). Пустой, `.` и `..` —
 * отказ до любого вызова; реестр возможностей отказывает и сам, это первая линия.
 */
export function encodePathId(id: string, field = 'id'): string {
  const parts = id.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(
      `${field}: «${id}» is not a valid id — a path part cannot be empty, '.' or '..'. ` +
        'Nothing was executed.',
    );
  }
  return parts.map(encode).join('/');
}

/** Ответ маршрута чтения или исключение с его текстом: карточка без данных — отказ. */
export async function readRoute<T>(inject: InjectRoute, url: string): Promise<T> {
  const answer = await inject({ method: 'GET', url });
  if (answer.status >= 400) throw routeError(url, answer.status, answer.body);
  return answer.body as T;
}

/**
 * Отказ маршрута словами раздела, а не адресом: промпт запрещает модели
 * рассказывать про вызовы API, а `/api/…` в тексте отказа сам к этому звал.
 * Раздел — первый сегмент пути (`/api/history/diff?…` → «history»).
 */
export function routeError(url: string, status: number, body: unknown): Error {
  const section = url.replace(/^\/api\//, '').split(/[/?]/)[0] || 'panel';
  const text = withoutRoutes(textOf(body));
  return new Error(
    `The panel section «${section}» answered HTTP ${status}${text ? `: ${text}` : ''}`,
  );
}

/** Метод и адрес маршрута панели (с хостом или без) в тексте отказа. */
const ROUTE_ADDRESS =
  /(?:\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)[:\s]\s*)?(?:https?:\/\/[^\s/]+)?\/api\/[^\s"'`<>)\]]*/g;

/**
 * Текст отказа для модели без адресов маршрутов. Адрес — это устройство панели
 * изнутри: Fastify кладёт его в свой 404 («Route GET:/api/rules not found»),
 * сетевая ошибка — в текст исключения; модель пересказывала его человеку, хотя
 * промпт запрещает ей говорить про вызовы API. Причина отказа остаётся.
 */
export function withoutRoutes(text: string): string {
  return text.replace(ROUTE_ADDRESS, '(internal)');
}

/**
 * Страница длинного списка для модели: всего, смещение и где продолжить. Молча
 * обрезанный список модель читала как полный, а хвост за пределом был недостижим.
 */
export function listPage<T>(items: readonly T[], offset: number, limit: number) {
  const slice = items.slice(offset, offset + limit);
  const end = offset + slice.length;
  return {
    meta: { total: items.length, offset, ...(end < items.length ? { nextOffset: end } : {}) },
    slice,
  };
}

/** Вход смещения у страничных чтений — одно описание на всех. */
export const OFFSET_DESCRIPTION = 'Skip this many items; pass nextOffset from the previous page';

/**
 * Текст отказа маршрута для модели: код сообщения с параметрами, затем `message`,
 * `error`, тело строкой. Код — английский идентификатор, а `message` у маршрутов
 * русский (он для человека); агенту панель пишет по-английски.
 */
export function textOf(body: unknown): string {
  if (body && typeof body === 'object') {
    const record = body as { message?: unknown; error?: unknown; messageCode?: unknown };
    if (typeof record.messageCode === 'string' && record.messageCode) {
      const params = (body as { params?: unknown }).params;
      return params && typeof params === 'object' && Object.keys(params).length > 0
        ? `${record.messageCode} ${JSON.stringify(params)}`
        : record.messageCode;
    }
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
  }
  return typeof body === 'string' ? body.slice(0, 300) : '';
}

/**
 * Значение для глаз модели: секретные имена прячут значение целиком, остальное
 * проходит детектор. Идёт вглубь объектов и массивов — ответы маршрутов разные.
 * Голое `key` — подпись записи, а не секрет (решение и его цена — у
 * `LABEL_FIELDS` в `result-net.ts`); значение записи с секретной подписью
 * (`{ key: 'API_TOKEN', value }`) прячется по подписи.
 */
export function maskDeep(value: unknown, name = ''): unknown {
  if (typeof value === 'string')
    return name && !isLabelField(name) ? maskNamedValue(name, value) : maskSecretsInText(value);
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, name));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        key,
        ((isSecretName(key) && !isLabelField(key)) || labelsSecretValue(record, key)) &&
        typeof item === 'string' &&
        item &&
        !isSecretFree(item)
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

export const MASK_REFUSAL =
  `The text carries ${SECRET_MASK} (a masked secret) that does not line up with the secrets ` +
  `saved there, so the real values cannot be put back. Keep every line carrying ${SECRET_MASK} ` +
  'exactly as the read showed it (it may move whole, never be rewritten) and add none; a secret ' +
  'value, or the line around it, is changed by the human in the panel.';

/**
 * Текст, который модель прочла маской и прислала обратно: маски — секретами с
 * диска (`saved`), по порядку. Не сходится (лишняя маска, нечего вернуть) —
 * отказ до карточки: записать маску значит молча стереть секрет.
 */
export function unmasked(field: string, saved: string | undefined, sent: string): string {
  if (!sent.includes(SECRET_MASK)) return sent;
  const restored = saved === undefined ? undefined : restoreMaskedSecrets(saved, sent);
  if (restored === undefined) throw new Error(`${field}: ${MASK_REFUSAL}`);
  return restored;
}

/** Потолок окна текста уже в JSON — после экранирования. */
const TEXT_WINDOW_JSON = 15_000;

/**
 * Длинный текст для модели: окно по смещению, чтобы большой файл читался частями.
 * Переходник режет ответ на 20 000 символов JSON (`tools/mcp/panel.mjs`), а
 * экранирование раздувает кавычки и переводы строк: окно ужимается, пока его
 * JSON не влезет с запасом, и `nextOffset` стоит перед текстом — иначе обрезка
 * съедала хвост окна и само обещание «читай дальше».
 */
export function textWindow(text: string, offset = 0, limit = TEXT_WINDOW_JSON) {
  let slice = text.slice(offset, offset + limit);
  while (slice.length > 1 && JSON.stringify(slice).length > TEXT_WINDOW_JSON) {
    slice = slice.slice(0, Math.floor(slice.length * 0.9));
  }
  // Край окна не режет суррогатную пару: половинки эмодзи иначе ломали его в
  // обоих окнах. Пара целиком уходит в следующее.
  const last = slice.charCodeAt(slice.length - 1);
  if (slice.length > 1 && last >= 0xd800 && last <= 0xdbff) slice = slice.slice(0, -1);
  const end = offset + slice.length;
  return {
    offset,
    length: text.length,
    ...(end < text.length ? { nextOffset: end } : {}),
    text: slice,
  };
}

const json = (value: unknown): string =>
  value === undefined ? '' : `${JSON.stringify(maskDeep(value), null, 2)}\n`;

/**
 * Карточка правки состояния панели (группа, настройки, правила защиты данных,
 * интеграция): дифф маскированного JSON «было → станет» той записи, которую
 * пишет маршрут. Файла конфигурации тут нет — запись идёт в `state.json` или
 * файл данных панели, — поэтому дифф назван по записи, а не по пути.
 *
 * `en` — те же «было → станет» с английскими сторонами двуязычных данных
 * (заголовки шагов): английское окно читает `diffEn`. Не влез хоть один из
 * двух — карточка неполная целиком: одобряют по тому, что видно на любом языке.
 */
export function stateCard(
  label: string,
  before: unknown,
  after: unknown,
  summary: ReturnType<typeof summaryText>,
  fields: PanelActionPreview['fields'] = [],
  en?: { before: unknown; after: unknown },
): PanelActionPreview {
  const diff = unifiedDiff(label, json(before), json(after));
  const diffEn = en ? unifiedDiff(label, json(en.before), json(en.after)) : undefined;
  // «Ничего не изменится» — только когда молчат ОБА языка: правка одной
  // английской стороны двуязычных данных — тоже правка.
  const sameEn = !diffEn || (!diffEn.truncated && diffEn.diff === '');
  if (!diff.truncated && diff.diff === '' && sameEn && before !== undefined) {
    throw new Error('Nothing would change: the current state already matches the request.');
  }
  return {
    ...summary,
    fields,
    ...(diff.truncated || diffEn?.truncated
      ? {
          truncated: true,
          diff: `--- a/${label}\n+++ b/${label}\n(правка слишком велика для построчного диффа)`,
        }
      : { diff: diff.diff, ...(diffEn ? { diffEn: diffEn.diff } : {}) }),
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
      ...preview.notes.map((note) => textField('label-besides-file', note.code, note.params)),
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

/** Сводка кодом — короткая запись для действий этого набора; `paramsEn` — см. `summaryText`. */
export const card = (
  code: PanelTextCode,
  params: Record<string, string | number> = {},
  paramsEn?: Record<string, string | number>,
) => summaryText(code, params, paramsEn);

/**
 * Итог записи, дополненный id сущности ПОСЛЕ неё. Id правила — слаг заголовка,
 * хука — от содержимого, скилла — папка из имени: у созданного его нет во входе,
 * у переименованного вход несёт прежний, и экран фокусировал пустоту. Никогда
 * не бросает: запись уже прошла, и сбой чтения списка не делает её отказом.
 */
export async function withSavedId<T extends { id: string }>(
  inject: InjectRoute,
  url: string,
  body: unknown,
  pick: (items: T[]) => T | undefined,
): Promise<unknown> {
  try {
    const item = pick(await readRoute<T[]>(inject, url));
    if (!item) return body;
    const base = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    return { ...base, id: item.id };
  } catch {
    return body;
  }
}

/** Id из итога `withSavedId`, если он там есть. */
export function savedId(result: unknown): string | undefined {
  const id = (result as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' && id ? id : undefined;
}
