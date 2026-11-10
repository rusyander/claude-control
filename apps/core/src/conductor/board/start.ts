import type { BoardEntry } from '@agentdeck/contracts/core/board';
import { parseEstimateBody, type EstimateFields } from '@agentdeck/contracts/core/estimate';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { ReviewLinkBody } from '@agentdeck/contracts/core/review-link';
import { leadConfigOf } from '../classify/flow.ts';
import { estimateTask, scenarioRefOf } from '../estimate/estimate.ts';
import type { CreateSeed, SplitEnv } from '../estimate/estimate.types.ts';
import { isLeadScenario, leadEstimate, type LeadEstimate } from '../intake/estimate-seed.ts';
import { estimateGroup, groupItemsOf, groupMixProblem } from '../intake/group.ts';
import type { TaskRegistry } from '../tasks.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import type { StartOutcome } from './launch.types.ts';

/**
 * Старт записи доски тем же путём, что у человека (этап 12, P156): поля формы — через оценку
 * (`estimateTask`, с приёмом ведущего, как `POST /v1/estimate`), ссылка — через ревью по ссылке.
 * Ключ повтора — `entry.cmdId`: тот же ключ после краха находит ту же задачу. Задача несёт
 * `task.created.boardEntry` — запись, остановку, источник и доказательство старта (08e).
 * Остановка «до плана» — запуск только человеком (`confirm`): задача встаёт после оценки. Запись
 * группы (все источники — `group-item`) стартует N задач путём оценки группы; запись помнит первую.
 */

export interface StartDeps {
  registry: TaskRegistry;
  layout: Pick<CoreHomeLayout, 'config'>;
  split(): SplitEnv | undefined;
  /** Ревью по ссылке проводки дирижёра; нет — ссылку не стартовать. */
  openLink?(
    body: ReviewLinkBody,
    env: SplitEnv,
    extra: { boardEntry: TaskBoardEntry },
  ): Promise<{ status: number; reply?: { taskId: string }; problems?: string[] }>;
}

type TaskBoardEntry = NonNullable<JournalDataV1['task.created']['boardEntry']>;

export function boardEntryOf(entry: BoardEntry): TaskBoardEntry | { refused: string } {
  if (!entry.proof) return { refused: 'no start proof' };
  return {
    entryId: entry.entryId,
    stop: entry.stop,
    source: entry.source.kind,
    proof: { kind: entry.proof.kind, cmdId: entry.proof.cmdId },
  };
}

/** Поля оценки из записи: сценарий — пресет записи, политика запуска — по остановке. */
export function fieldsOf(entry: BoardEntry): Record<string, unknown> {
  if (entry.launch.kind !== 'fields') return {};
  const given = entry.launch.fields;
  return {
    title: entry.source.title.slice(0, 300),
    ...given,
    scenario: given.scenario ?? { preset: entry.preset },
    launchPolicy: entry.stop === 'plan' ? 'confirm' : (given.launchPolicy ?? 'auto'),
    ciWait: given.ciWait ?? false,
  };
}

/**
 * Свой снимок тикета записи (опрос входящих, D17) читает только приём ведущего. Пресет без приёма
 * (bug-fix — тикет с типом Bug или сменённый человеком, P164) идёт своей дорогой — текстом запроса,
 * где тело тикета уже есть; иначе оценка отказала бы снимку и такой тикет не стартовал бы никогда.
 * Снимок на записи остаётся (вернуть tracker-ticket до старта можно). Чужой снимок — поля запуска
 * человека или сценарий библиотеки — не трогается: его потерю называет отказ оценки.
 */
export function roadFields(fields: EstimateFields, entry: BoardEntry): EstimateFields {
  const own = fields.source;
  if (!own || !('preset' in fields.scenario)) return fields;
  if (isLeadScenario(scenarioRefOf(fields.scenario))) return fields;
  if (entry.source.kind !== 'tracker' || own.kind !== 'tracker' || own.key !== entry.source.key)
    return fields;
  const { source: _own, ...rest } = fields;
  return rest;
}

export async function startEntry(entry: BoardEntry, deps: StartDeps): Promise<StartOutcome> {
  const cmdId = entry.cmdId;
  if (!cmdId) return { refused: 'start without a replay key' };
  const env = deps.split();
  if (!env) return { refused: 'the conductor is not running in this core' };
  const boardEntry = boardEntryOf(entry);
  if ('refused' in boardEntry) return boardEntry;
  if (entry.launch.kind === 'link') {
    if (!entry.launch.repo) return { refused: 'no local repository for the MR link' };
    if (!deps.openLink) return { refused: 'review by link is not wired in this core' };
    const opened = await deps.openLink(
      { cmdId, fields: { url: entry.launch.mrUrl, repo: entry.launch.repo }, proof: {} },
      env,
      { boardEntry },
    );
    if (opened.reply && (opened.status === 200 || opened.status === 202))
      return { taskId: opened.reply.taskId };
    return { refused: (opened.problems ?? ['review link refused']).join('; ') };
  }
  const parsed = parseEstimateBody({ cmdId, proof: {}, fields: fieldsOf(entry) });
  if (!parsed.ok)
    return {
      refused: `launch fields: ${parsed.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
    };
  const fields = roadFields(parsed.body.fields, entry);
  const body = { ...parsed.body, fields };
  // Приём ведущего — как у ручки оценки: источники под маской, профиль, критерии.
  const leadOf = (f: EstimateFields): LeadEstimate =>
    leadEstimate(
      f,
      scenarioRefOf(f.scenario),
      (text) => deps.registry.mask(text).text,
      leadConfigOf(deps.layout),
    );
  // Каждая задача записи (одна или N задач группы) несёт запись доски и её остановку.
  const withEntry = (base: CreateSeed): CreateSeed => ({
    ...base,
    created: (pinned) => ({
      ...base.created?.(pinned),
      boardEntry,
      ...(entry.paidOnRefusal ? { paidOnRefusal: true } : {}),
      ...(entry.stop === 'plan' ? { launchPolicy: 'confirm' as const } : {}),
    }),
  });
  const mixed = groupMixProblem(fields);
  if (mixed) return { refused: mixed };
  if (groupItemsOf(fields)) {
    // Группа — одна запись, N задач тем же путём оценки группы, что у ручки оценки: пункт — задача
    // с общим `groupId`, ключ повтора пункта выводится из ключа записи (`itemCmdId`).
    const grouped = await estimateGroup(body, deps.registry, env, leadOf, withEntry);
    if (grouped.status === 422) return { refused: grouped.problems.join('; ') };
    return { taskId: grouped.reply.taskId };
  }
  const lead = leadOf(fields);
  if (lead.kind === 'refused') return { refused: lead.problem };
  const seed = withEntry(lead.kind === 'lead' ? lead.seed : {});
  const outcome = await estimateTask(body, deps.registry, env, seed);
  if (outcome.status === 422) return { refused: outcome.problems.join('; ') };
  return { taskId: outcome.reply.taskId };
}
