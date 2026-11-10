import { createHash } from 'node:crypto';
import {
  INTAKE_BODY_MAX,
  intakeSourceSchema,
  type IntakeSource,
} from '@agentdeck/contracts/core/intake';
import { fromAdf } from '@agentdeck/trackers/adf';
import {
  browseUrl,
  JIRA_SYSTEM,
  linksOf as issueLinks,
  readIssueRaw,
} from '@agentdeck/trackers/jira';
import type { AtlassianAccess } from '../integrations/atlassian/client.ts';
import { viaTracker } from '../integrations/atlassian/tracker-port.ts';
import { coded } from '../../lib/server-text/server-text.ts';
import { invalidField, unreachable } from '../integrations/errors.ts';
import type { RawTrackerIssue } from './tracker-snapshot.types.ts';

/**
 * Снимок задачи трекера для приёма ведущего (этап 11, P133, W3-16). Трекер читает панель, ядро
 * получает текст, поля, критерии и отпечаток и больше в трекер не ходит: снимок — данные, ни
 * настройку, ни права, ни правила публикации он не меняет (это судит приём ядра).
 *
 * Критерии приёмки — только из ПОЛЯ трекера (имя поля «Acceptance Criteria» / «Критерии
 * приёмки», найденное по `expand=names`), а не из прозы описания: критерии из прозы — вывод
 * модели, их собирает шаг разбора. Отпечаток — sha256 содержимого без времени снимка: тот же
 * тикет без правок даёт тот же отпечаток, повтор приёма не нужен.
 */

/** Пределы схемы источника (`intakeSourceSchema`): больше — срез, и он назван в полях. */
const TITLE_MAX = 300;
const LINE_MAX = 2000;
const ACCEPTANCE_MAX = 100;
const LINKS_MAX = 50;

/** Ключ задачи Jira: проект и номер (`PROJ-12`). Иное — не ключ, в трекер не идём. */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,49}-\d{1,12}$/;

/** Маркер пункта списка в начале строки критерия: «- », «* », «• », «1. », «[ ] ». */
const BULLET = /^\s*(?:[-*•]|\d{1,3}[.)]|\[[ xX]?\])\s+/;

const text = (value: unknown): string | undefined => {
  const out = fromAdf(value);
  return out === undefined ? undefined : out.trim();
};

const name = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * Имя поля критериев на двух языках интерфейса Jira: «Acceptance Criteria» / «Критерии приёмки»
 * (с хвостом вида «(DoD)»). Одно слово «acceptance» или «критерий» — не то поле: «Acceptance
 * Date», «UAT acceptance status», «Критерий сложности» дали бы критерии, которых в тикете нет, а
 * структурные критерии решают самоприём карточки (P133).
 */
const ACCEPTANCE_FIELD = /\bacceptance\s+criteri|критери\S*\s+при[её]мк/iu;

function isAcceptanceField(fieldName: unknown): boolean {
  return typeof fieldName === 'string' && ACCEPTANCE_FIELD.test(fieldName);
}

/** Строки критериев одного значения поля: строка, документ ADF или список строк (чек-лист). */
function acceptanceLines(value: unknown): string[] {
  const parts = Array.isArray(value) ? value.map((v) => text(v) ?? '') : [text(value) ?? ''];
  return parts
    .flatMap((part) => part.replaceAll('\r\n', '\n').split('\n'))
    .map((line) => line.replace(BULLET, '').trim())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(0, LINE_MAX));
}

function acceptanceOf(issue: RawTrackerIssue): string[] {
  const out: string[] = [];
  for (const [id, fieldName] of Object.entries(issue.names ?? {})) {
    if (isAcceptanceField(fieldName)) out.push(...acceptanceLines(issue.fields?.[id]));
  }
  return out;
}

function linksOf(
  access: AtlassianAccess,
  key: string,
  raw: unknown,
): { url: string; title?: string }[] {
  const own = { url: browseUrl(access, key), title: key };
  const linked = issueLinks(raw).map((link) => ({
    url: browseUrl(access, link.key),
    title: (link.relation ? `${link.relation} ${link.key}` : link.key).slice(0, TITLE_MAX),
  }));
  return [own, ...linked].slice(0, LINKS_MAX);
}

/** Поля трекера как есть: статус, тип, приоритет, метки, исполнитель, правка. Пустые — без ключа. */
function fieldsOf(issue: RawTrackerIssue): Record<string, string | string[]> {
  const f = issue.fields ?? {};
  const out: Record<string, string | string[]> = {};
  const put = (key: string, value: string | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  put('status', name(f.status?.name));
  put('statusCategory', name(f.status?.statusCategory?.key));
  put('type', name(f.issuetype?.name));
  put('priority', name(f.priority?.name));
  put('assignee', name(f.assignee?.displayName) ?? name(f.assignee?.name));
  put('updated', name(f.updated));
  const labels = Array.isArray(f.labels)
    ? f.labels.filter((l): l is string => typeof l === 'string' && l.length > 0)
    : [];
  if (labels.length > 0) out.labels = labels;
  return out;
}

/** Отпечаток содержимого снимка — без времени снимка, порядок ключей задан здесь. */
export function snapshotDigest(source: Omit<IntakeSource, 'fetchedAt' | 'digest'>): string {
  const canonical = JSON.stringify([
    source.kind,
    source.key ?? null,
    source.title ?? null,
    source.body,
    source.fields ?? null,
    source.acceptance ?? null,
    source.links ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export interface TrackerSnapshotOptions {
  /** Часы стены (мс): время снимка. */
  now?: () => number;
}

/**
 * Снимок задачи Jira по ключу: одно чтение `GET /issue/:key?expand=names`, отказ Jira — как у
 * прочих чтений интеграции (401 — токен отклонён, 404 — задачи нет). Тело длиннее предела
 * источника срезается, и срез назван полем `bodyTruncatedFrom`; критериев больше ста — полем
 * `acceptanceTotal`: тихо потерянный критерий выглядел бы принятой задачей без него.
 */
export async function trackerSnapshot(
  access: AtlassianAccess,
  rawKey: string,
  options: TrackerSnapshotOptions = {},
): Promise<IntakeSource> {
  const key = rawKey.trim();
  if (!ISSUE_KEY.test(key))
    throw invalidField(
      'key',
      'нужен ключ задачи трекера вида PROJ-12',
      'request-tracker-key-invalid',
      {
        field: 'key',
      },
    );
  const issue = (await viaTracker(access, (site, send) =>
    readIssueRaw(site, send, key, 'expand=names'),
  )) as RawTrackerIssue | null;
  // Пустое тело клиент отдаёт как `null` (204 у части ручек Atlassian): у задачи это не ответ, а
  // отказ — назван, а не 500 «Cannot read properties of null».
  if (issue === null || typeof issue !== 'object')
    throw coded(
      unreachable(`Jira не вернула задачу ${key}: тело ответа пустое.`),
      'integration-issue-empty',
      { system: JIRA_SYSTEM, key },
    );
  const issueKey = name(issue.key) ?? key;
  const title = name(text(issue.fields?.summary))?.slice(0, TITLE_MAX);
  const description = text(issue.fields?.description) ?? '';
  const fields: Record<string, string | string[] | number> = fieldsOf(issue);
  if (description.length > INTAKE_BODY_MAX) fields.bodyTruncatedFrom = description.length;
  const allAcceptance = acceptanceOf(issue);
  if (allAcceptance.length > ACCEPTANCE_MAX) fields.acceptanceTotal = allAcceptance.length;
  const acceptance = allAcceptance.slice(0, ACCEPTANCE_MAX);
  const content: Omit<IntakeSource, 'fetchedAt' | 'digest'> = {
    kind: 'tracker',
    key: issueKey,
    ...(title ? { title } : {}),
    body: description.slice(0, INTAKE_BODY_MAX),
    fields,
    ...(acceptance.length > 0 ? { acceptance } : {}),
    links: linksOf(access, issueKey, issue.fields?.issuelinks),
  };
  const snapshot: IntakeSource = {
    ...content,
    fetchedAt: (options.now ?? Date.now)(),
    digest: snapshotDigest(content),
  };
  // Та же схема, что разбирает ядро: снимок, который ядро вернёт 400, панель не отдаёт.
  return intakeSourceSchema.parse(snapshot);
}
