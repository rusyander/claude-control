import type { EstimateBody } from '@agentdeck/contracts/core/estimate';
import type { ForgePort, ForgeThread } from '@agentdeck/contracts/core/forge';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import { parseMrLink } from '@agentdeck/contracts/core/review-link';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { CopyGitOptions } from '../../platform/copy-git.ts';
import type { TaskRegistry } from '../tasks.ts';
import { createAnswer, mrHeadCheck } from './answer-task.ts';
import type { AnswerTaskOutcome } from './answer-task.types.ts';
import { ANSWER_REVIEWERS_PRESET, replayEstimate } from './estimate.ts';
import type { SplitEnv } from './estimate.types.ts';

/**
 * Задача ответов ревьюерам по ССЫЛКЕ на свой MR, которого ядро не открывало (этап 12, P182, D17):
 * журнала-источника нет, поэтому личность MR и его нити — только от форжа (`ForgePort.mr` /
 * `threads`), никогда не из журналов задач. Дальше — та же дорога, что у опроса (`createAnswer`):
 * база — голова MR на сервере, ветка единицы 0 — ветка MR, `publish.mr` сразу за единицей, строки
 * `forge.event` — нерешённые нити (без источника `poller`: их не нашёл опрос, и отметки опроса
 * они не трогают). Ключ оценки — `cmdId` звонящего: тот же ключ — та же задача.
 */

export type AnswerMrPort = Pick<ForgePort, 'kind' | 'mr' | 'threads'>;

/**
 * Сервер репозитория и форж его адреса пуша; читает проводка (дирижёр форж и git-remote не знает).
 * `null` в `port` — у адреса нет API форжа (только пуш и ссылка).
 */
export type MrReader = (
  repo: string,
) => Promise<
  { value: { remote: string; url: string; port: AnswerMrPort | null } } | { unknown: string }
>;

export interface AnswerFromMrInput {
  cmdId: string;
  mrUrl: string;
  /** Локальный репозиторий, чей удалённый — проект MR. */
  repo: string;
  note?: string;
  /** Старт с доски (Z1): доказательство хода человека. */
  boardEntry?: JournalDataV1['task.created']['boardEntry'];
  lang?: 'ru' | 'en';
}

/** Хост и путь проекта без регистра и `.git`: так их пишут и ссылка, и адрес MR у форжа. */
const same = (a: string, b: string): boolean =>
  a.toLowerCase().replace(/\.git$/, '') === b.toLowerCase().replace(/\.git$/, '');

/** Нерешённые нити → строки `forge.event`: id — последняя заметка нити, автор — её автор. */
export function threadEvents(
  threads: readonly ForgeThread[],
  target: string,
  iid: number,
): JournalDataV1['forge.event'][] {
  const out: JournalDataV1['forge.event'][] = [];
  for (const t of threads) {
    if (!t.resolvable || t.resolved) continue;
    const last = t.notes.at(-1);
    if (!last) continue;
    out.push({
      forgeEventId: last.id,
      type: 'thread',
      target,
      mrIid: iid,
      ...(last.author ? { author: last.author } : {}),
    });
  }
  return out;
}

function requestOf(
  mr: { url: string; iid: number; sourceBranch: string },
  events: readonly JournalDataV1['forge.event'][],
  note: string | undefined,
): string {
  const authors = [...new Set(events.map((e) => e.author).filter(Boolean))];
  return [
    `Ответить ревьюерам в MR ${mr.url} (!${mr.iid}, ветка ${mr.sourceBranch}).`,
    `Открытые нити: ${events.length}${authors.length > 0 ? ` (${authors.join(', ')})` : ''}.`,
    ...events.map((e) => `- ${e.type} ${e.forgeEventId}${e.author ? ` от ${e.author}` : ''}`),
    ...(note?.trim() ? ['Слово человека:', note.trim()] : []),
    'Прочитать открытые нити MR и ответить на каждую; правка кода — новыми коммитами в ту же ветку.',
  ].join('\n');
}

const inflight = new Map<string, Promise<AnswerTaskOutcome>>();

export async function openAnswerTaskFromMr(
  input: AnswerFromMrInput,
  reader: MrReader,
  registry: TaskRegistry,
  env: SplitEnv,
  git: CopyGitOptions = {},
): Promise<AnswerTaskOutcome> {
  const running = inflight.get(input.cmdId);
  if (running) await running.catch(() => undefined);
  const replayed = replayEstimate(registry, input.cmdId);
  if (replayed) return { opened: replayed.taskId, reply: replayed };
  const work = createFromMr(input, reader, registry, env, git);
  inflight.set(input.cmdId, work);
  try {
    return await work;
  } finally {
    inflight.delete(input.cmdId);
  }
}

async function createFromMr(
  input: AnswerFromMrInput,
  reader: MrReader,
  registry: TaskRegistry,
  env: SplitEnv,
  git: CopyGitOptions,
): Promise<AnswerTaskOutcome> {
  const link = parseMrLink(input.mrUrl);
  if (!link) return { refused: [`not a GitLab MR or GitHub PR link: ${input.mrUrl}`] };
  const server = await reader(input.repo);
  if (!('value' in server)) return { refused: [`${input.repo}: ${server.unknown}`] };
  const { port, remote, url } = server.value;
  if (!port || port.kind !== link.forge)
    return { refused: [`${url}: no ${link.forge} API for this remote`] };
  const mr = await port.mr(link.iid);
  if (!('value' in mr))
    return {
      refused: [`MR !${link.iid}: ${'unknown' in mr ? mr.unknown : `not in ${url}`}`],
    };
  const got = parseMrLink(mr.value.url);
  // Чужой MR (другой проект с тем же номером) — отказ: пуш ушёл бы в чужую ветку.
  if (!got || !same(got.host, link.host) || !same(got.project, link.project))
    return { refused: [`MR !${link.iid} of ${url} is ${mr.value.url}, not ${input.mrUrl}`] };
  if (mr.value.state !== 'open') return { refused: [`MR !${link.iid} is ${mr.value.state}`] };
  const threads = await port.threads(link.iid);
  if (!('value' in threads))
    return {
      refused: [`MR !${link.iid} threads: ${'unknown' in threads ? threads.unknown : 'absent'}`],
    };
  const events = threadEvents(threads.value, `${url} !${link.iid}`, link.iid);
  const branch = mr.value.sourceBranch;
  const body: EstimateBody = {
    cmdId: input.cmdId,
    proof: {},
    fields: {
      title: `Ответы ревьюерам !${link.iid}: ${branch}`.slice(0, 300),
      request: requestOf(mr.value, events, input.note),
      repos: [{ path: input.repo, baseRef: `${remote}/${branch}` }],
      scenario: { preset: ANSWER_REVIEWERS_PRESET },
      // С доски — ход человека и есть запуск; без доски — человек запускает сам.
      launchPolicy: input.boardEntry ? 'auto' : 'confirm',
      ciWait: false,
      ...(input.lang ? { lang: input.lang } : {}),
    },
  };
  const entry = input.boardEntry;
  return createAnswer(body, registry, env, {
    checkPinned: mrHeadCheck(branch, git),
    branch,
    refuseBeforeCreate: true,
    ...(entry ? { created: () => ({ boardEntry: entry }) } : {}),
    opened(task, cmdId) {
      for (const e of events) task.append({ kind: 'forge.event', actor: 'core', cmdId, data: e });
    },
    afterUnitZero(task, zero, cmdId) {
      // Личность MR от форжа (P31): публикатор пушит в этот MR и второго не открывает.
      task.append({
        kind: 'publish.mr',
        actor: 'core',
        unitId: zero.unitId,
        cmdId,
        data: {
          unitId: zero.unitId,
          forge: link.forge,
          mrId: mr.value.id,
          mrIid: mr.value.iid,
          url: mr.value.url,
          sourceBranch: branch,
          actionId: newId(),
        },
      });
    },
  });
}
