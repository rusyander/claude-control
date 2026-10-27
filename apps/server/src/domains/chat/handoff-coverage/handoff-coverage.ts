import {
  OWNER_POINT_ID,
  SPLIT_STAGE_EVIDENCE,
  TASK_POINT_ID,
} from '@agentdeck/contracts/quality-floor';
import type { SieveReportRow } from '@agentdeck/contracts/sieves';
import type {
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../lib/app-store/app-store.types.ts';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { trackerKeys } from '../tracker-keys.ts';

/**
 * Отданные пункты и передачи между группами одного разделения (живой аудит 26.10).
 *
 * Десять групп сдали «готово» без половины пунктов тикетов: g9 записала
 * «D1/D14/D15/D20 — группа 6», а у группы 6 не было ни одного файла той админки;
 * пункт «править поверх после её слияния» никто не держал; передачи из заметок
 * соседей до получателя не доходили. Доставка верила строке «n/a: other group» на
 * слово. Здесь — проверка, которую можно сделать без модели: названа ли группа
 * этого разделения, жива ли она, лежит ли названный путь в её списке, влита ли
 * группа, слияния которой пункт ждал. Пункт без настоящего владельца — пробел
 * доставки той же группы: доделывает она сама, напоминанием своей сессии.
 */

type Plan = Pick<SplitPlanRecord, 'proposal' | 'groups'>;

/**
 * Группы разбора. Запись читается из state.json как есть (проверка доставки в
 * `tests-cli` в том числе) — запись без разбора даёт пустой список, а не падение.
 */
function proposalGroups(plan: Plan): SplitPlanRecord['proposal']['groups'] {
  return plan.proposal?.groups ?? [];
}

/** Строка `n/a`, которая отдаёт пункт мимо группы: «other group», «группа 6», «вне скоупа». */
const DEFERRAL =
  /other group|another group|sibling group|друг(?:ая|ой|ую|ие|им) групп|групп(?:а|е|у|ы|ой|ам)\s*(?:№\s*)?\d|\bgroup\s*#?\s*\d|чуж(?:ая|ой|ую|ие) зон|вне (?:скоупа|охвата|зоны)|out of (?:scope|my zone)|not (?:in )?(?:this|my) (?:group|zone|scope)/iu;

/** Номер группы так, как его пишут разбор и группы: с единицы («Group 6», «группа 6»). */
const GROUP_REF = /(?:групп(?:а|е|у|ы|ой|ам)|\bgroups?)\s*(?:№|#)?\s*(\d{1,2})\b/giu;

/** Пункт ждёт слияния другой группы: «после её слияния», «after group 6 merges». */
const AFTER_MERGE = /\bafter\b.{0,60}\bmerg|после.{0,60}(?:слияни|влити|мерж)/iu;

/**
 * Пункт слов владельца сделало само разделение: «split stage: …» и то, как это
 * пишут группы без формы, — «разделяющий агент», «агент, разделивший задачи»,
 * «этап разделения», «делала панель» (живая проба 26.10, шесть групп из десяти).
 */
const SPLIT_STAGE = new RegExp(
  [
    String.raw`\b${SPLIT_STAGE_EVIDENCE}\b`,
    String.raw`\bsplit(?:ting)?\s+(?:step|agent)\b`,
    String.raw`\bsplitter\b`,
    String.raw`\b(?:done|made) by the (?:panel|split)\b`,
    String.raw`разделяющ\S*\s+агент`,
    String.raw`агент\S*,?\s+(?:раздел|подел)ивш`,
    String.raw`агент\S*[\s-]+разделител`,
    String.raw`(?:этап|план|стади)\S*\s+разделени`,
    String.raw`(?:сделал|делал|собрал|разделил|отобрал)\S*\s+панел`,
    String.raw`панел\S*\s+(?:сделал|делал|собрал|разделил|отобрал)`,
  ].join('|'),
  'iu',
);

/** Номер MR в тексте: «MR 932», «MR !932», «!932», `…/merge_requests/932`. */
const MR_REF = /(?:\bMR\s*!?\s*|!|merge_requests\/)(\d{2,})\b/giu;

/** Заметка о порядке слияния без номера группы: «мержится последней». */
const MERGE_ORDER = /merg|слия|влит|мерж/iu;

const SEGMENT = String.raw`(?:\{[^{}\s]+\}|[\p{L}\p{N}_.@*\-])+`;
const PATH = new RegExp(`${SEGMENT}(?:/${SEGMENT})+`, 'gu');

/** Сколько путей списка группы называет строка пробела. */
const OWNS_SHOWN = 6;
const OWNS_TEXT_MAX = 300;
const NOTE_MAX = 400;
const LIST_MAX = 12;
const EVIDENCE_SHOWN = 300;

/** Пути в тексте как есть (`{a,b}` не раскрыты), без точки конца фразы. */
export function pathTokens(text: string): string[] {
  const found = (text.replace(/\\/g, '/').match(PATH) ?? []).map((token) =>
    token.replace(/\.+$/, ''),
  );
  return [...new Set(found.filter((token) => token.includes('/')))];
}

/** `{a,b}` → оба пути (без вложенности, не больше 64). */
function expand(token: string): string[] {
  const open = token.indexOf('{');
  const close = open < 0 ? -1 : token.indexOf('}', open);
  if (close < 0) return [token];
  const head = token.slice(0, open);
  const tail = token.slice(close + 1);
  return token
    .slice(open + 1, close)
    .split(',')
    .flatMap((alt) => expand(`${head}${alt}${tail}`))
    .slice(0, 64);
}

/** Путь для сравнения: нижний регистр, без `./`, ведущего и хвостового `/`, до первой `*`. */
function normal(path: string): string {
  const star = path.indexOf('*');
  return (star < 0 ? path : path.slice(0, star))
    .toLowerCase()
    .replace(/^\.?\/+/, '')
    .replace(/\/+$/, '');
}

/** Пути списка группы (`owns`), раскрытые и приведённые. */
export function ownedPaths(owns: readonly string[] | undefined): string[] {
  const paths = (owns ?? []).flatMap((line) => pathTokens(line).flatMap(expand)).map(normal);
  return [...new Set(paths.filter((path) => path.includes('/')))];
}

/** Первые сегменты путей всех групп плана — корни приложений этого репозитория. */
function planRoots(plan: Plan): Set<string> {
  return new Set(
    proposalGroups(plan).flatMap((group) =>
      ownedPaths(group.owns).map((path) => path.split('/')[0] ?? ''),
    ),
  );
}

/**
 * Лежит ли путь в списке. Путь с корнем приложения — только по префиксу (папка
 * выше списка — если в ней хотя бы три сегмента); путь без корня
 * (`pages/users/RolesTab`) — по хвосту списка из двух и более сегментов.
 */
export function covers(owned: string, path: string, roots: ReadonlySet<string>): boolean {
  if (path === owned || path.startsWith(`${owned}/`)) return true;
  const depth = path.split('/').length;
  if (owned.startsWith(`${path}/`) && depth >= 3) return true;
  if (roots.has(path.split('/')[0] ?? '')) return false;
  const segments = owned.split('/');
  for (let from = 1; from <= segments.length - 2; from += 1) {
    const tail = segments.slice(from).join('/');
    if (path === tail || path.startsWith(`${tail}/`)) return true;
  }
  return false;
}

/** Группы, названные в тексте: номером (с единицы) и названием, кроме `self`. */
function namedGroups(plan: Plan, text: string, self: number): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(GROUP_REF)) {
    const index = Number(match[1]) - 1;
    if (index >= 0 && index < plan.groups.length) found.add(index);
  }
  const lower = text.toLowerCase();
  plan.groups.forEach((group, index) => {
    if (group.title.length >= 6 && lower.includes(group.title.toLowerCase())) found.add(index);
  });
  found.delete(self);
  return [...found];
}

/** Ключи задач трекера самой группы: «tracker: GOR-55» на свою же задачу владельцем не считается. */
function ownKeys(plan: Plan, index: number): Set<string> {
  const group = plan.groups[index];
  const tasks = proposalGroups(plan)[index]?.tasks ?? [];
  return new Set(trackerKeys([...tasks, group?.branch ?? '', group?.title ?? ''].join('\n')));
}

function mrNumbers(text: string | undefined): string[] {
  return [...(text ?? '').matchAll(MR_REF)].map((match) => match[1] ?? '');
}

/** MR из текста, не принадлежащий ни одной группе плана, — владелец вне разделения. */
function foreignMr(plan: Plan, evidence: string): boolean {
  const planMrs = new Set(plan.groups.flatMap((group) => mrNumbers(group.mr)));
  return mrNumbers(evidence).some((number) => !planMrs.has(number));
}

function ownsText(owns: readonly string[] | undefined): string {
  const shown = (owns ?? []).flatMap(pathTokens).slice(0, OWNS_SHOWN).join(', ');
  return shown ? shown.slice(0, OWNS_TEXT_MAX) : '—';
}

function closed(group: SplitPlanGroupRecord | undefined): boolean {
  return Boolean(group?.droppedAt || group?.status === 'failed');
}

type Verdict = { code: Parameters<typeof serverText>[0]; params: Record<string, string> };

/** Почему получатель не держит пункт; держит — `undefined`. */
function receiverWhy(
  plan: Plan,
  receiver: number,
  point: string,
  evidence: string,
  roots: ReadonlySet<string>,
): Verdict | undefined {
  const group = plan.groups[receiver];
  const base = { point, group: String(receiver + 1), title: group?.title ?? '' };
  if (closed(group)) return { code: 'delivery-gap-defer-closed', params: base };
  if (AFTER_MERGE.test(evidence) && group?.mrClosed === 'merged') {
    return { code: 'delivery-gap-defer-merged', params: base };
  }
  const owns = proposalGroups(plan)[receiver]?.owns;
  const owned = ownedPaths(owns);
  // Список без путей (одни слова) — сверять не с чем: пункт остаётся у получателя.
  if (owned.length === 0) return undefined;
  const named = pathTokens(evidence).flatMap(expand).map(normal);
  if (named.length === 0) {
    return { code: 'delivery-gap-defer-no-path', params: { ...base, owns: ownsText(owns) } };
  }
  if (named.some((path) => owned.some((own) => covers(own, path, roots)))) return undefined;
  return {
    code: 'delivery-gap-defer-not-owned',
    params: { ...base, paths: pathTokens(evidence).slice(0, 3).join(', '), owns: ownsText(owns) },
  };
}

/** Суд одной отданной строки: `undefined` — у пункта есть настоящий владелец. */
function judgeDeferral(
  plan: Plan,
  index: number,
  row: SieveReportRow,
  roots: ReadonlySet<string>,
): Verdict | undefined {
  const own = ownKeys(plan, index);
  // Заведённая задача трекера — владелец вне разделения: проверять её нечем и незачем.
  if (trackerKeys(row.evidence).some((key) => !own.has(key))) return undefined;
  // Чужой MR вне разделения — тот же владелец снаружи, что и задача трекера.
  if (foreignMr(plan, row.evidence)) return undefined;
  // Пункт слов владельца, сделанный самим разделением; задачу группы оно за неё не делает.
  if (OWNER_POINT_ID.test(row.id) && SPLIT_STAGE.test(row.evidence)) return undefined;
  const receivers = namedGroups(plan, row.evidence, index);
  if (receivers.length === 0) {
    const self = [...row.evidence.matchAll(GROUP_REF)].some((m) => Number(m[1]) - 1 === index);
    return self
      ? { code: 'delivery-gap-defer-self', params: { point: row.id, group: String(index + 1) } }
      : {
          code: 'delivery-gap-defer-unowned',
          params: { point: row.id, evidence: row.evidence.slice(0, EVIDENCE_SHOWN) },
        };
  }
  let first: Verdict | undefined;
  for (const receiver of receivers) {
    const why = receiverWhy(plan, receiver, row.id, row.evidence, roots);
    if (!why) return undefined;
    first ??= why;
  }
  return first;
}

/** Строки `n/a`, отдающие пункт владельца или задачи мимо группы. */
function deferredRows(rows: readonly SieveReportRow[] | undefined): SieveReportRow[] {
  return (rows ?? []).filter(
    (row) =>
      row.status === 'n/a' &&
      (OWNER_POINT_ID.test(row.id) || TASK_POINT_ID.test(row.id)) &&
      DEFERRAL.test(row.evidence),
  );
}

/**
 * Пробелы доставки по отданным пунктам группы `index`: отдан без владельца, своей
 * же группе, закрытой группе, без пути из её списка, мимо её списка, или ждал
 * слияния, которое уже случилось.
 */
export function deferralGaps(
  plan: Plan,
  index: number,
  rows: readonly SieveReportRow[] | undefined,
): string[] {
  const roots = planRoots(plan);
  return deferredRows(rows).flatMap((row) => {
    const verdict = judgeDeferral(plan, index, row, roots);
    return verdict ? [serverText(verdict.code, verdict.params)] : [];
  });
}

/** Что знает о соседях перепроверка: кто они, в каком состоянии, что отдали этой группе. */
export interface CompletenessFacts {
  siblings: string[];
  /** Фразы заметок самой группы о других группах и порядке слияния. */
  ownNotes: string[];
  /** Фразы заметок соседей, называющие эту группу. */
  incomingNotes: string[];
  /** Строки `n/a` соседей, отдающие пункт этой группе. */
  incomingRows: string[];
  /** Отданные пункты самой группы без настоящего владельца — строками пробелов. */
  deferrals: string[];
}

function sentences(text: string | undefined): string[] {
  return (text ?? '')
    .split(/(?<=[.!?;])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Состояние группы для модели: статус, MR и влит ли он. */
function stateOf(group: SplitPlanGroupRecord): string {
  const mr = group.mr ? `MR ${group.mr} (${group.mrClosed ?? 'open'})` : 'no MR';
  return `${group.droppedAt ? 'dropped' : group.status}, ${mr}`;
}

/** Факты полноты для «Перепроверить MR» группы `index`. */
export function completenessFacts(plan: Plan, index: number): CompletenessFacts {
  const self = plan.groups[index];
  const siblings = plan.groups
    .filter((group) => group.index !== index)
    .map(
      (group) =>
        `Group ${group.index + 1} «${group.title}»: ${stateOf(group)}; owns ${ownsText(
          proposalGroups(plan)[group.index]?.owns,
        )}`,
    );
  const ownNotes = sentences(proposalGroups(plan)[index]?.notes)
    .filter((part) => namedGroups(plan, part, index).length > 0 || MERGE_ORDER.test(part))
    .slice(0, LIST_MAX)
    .map((part) => cut(part, NOTE_MAX));
  const incomingNotes: string[] = [];
  const incomingRows: string[] = [];
  for (const group of plan.groups) {
    if (group.index === index) continue;
    const from = `Group ${group.index + 1} «${group.title}»`;
    for (const part of sentences(proposalGroups(plan)[group.index]?.notes)) {
      if (namedGroups(plan, part, group.index).includes(index)) {
        incomingNotes.push(`${from}: ${cut(part, NOTE_MAX)}`);
      }
    }
    for (const row of deferredRows(group.sieveRows)) {
      if (namedGroups(plan, row.evidence, group.index).includes(index)) {
        incomingRows.push(`${from}, ${row.id}: ${cut(row.evidence, EVIDENCE_SHOWN)}`);
      }
    }
  }
  return {
    siblings,
    ownNotes,
    incomingNotes: incomingNotes.slice(0, LIST_MAX),
    incomingRows: incomingRows.slice(0, LIST_MAX),
    deferrals: self ? deferralGaps(plan, index, self.sieveRows).slice(0, LIST_MAX) : [],
  };
}
