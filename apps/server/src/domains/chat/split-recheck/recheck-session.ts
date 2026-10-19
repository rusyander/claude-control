import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { OWNER_PRECEDENCE_LINE } from '@agentdeck/contracts/quality-floor';
import type {
  ChatLink,
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../lib/app-store/app-store.types.ts';
import { carriedLink, conversationKeys } from '../../../lib/app-store/chat-links.ts';
import { git } from '../../project-git/exec/exec.ts';
import { parseDirtyPaths, readMergeTarget } from '../../project-git/read.ts';
import type { RecheckScope } from './split-recheck.ts';

/**
 * «Перепроверить MR» — новым разговором группы (живое наблюдение 19.10.2026, R2
 * и R5).
 *
 * Перепроверку жмут через часы после работы группы. Продолжение прежней сессии
 * (`--resume`) после часа простоя — промах кэша почти целиком: четыре группы
 * разом писали в кэш по ~150 тыс. токенов. И модель продолжала давние нити
 * своего контекста: группа фронтового MR без правок в Go заново гоняла 14
 * Go-наборов утренней работы. Перепроверке нужен не разговор, а факты: ветка,
 * копия, MR, задание группы и охват — их вводная и несёт.
 *
 * Прежний разговор не теряется: его связь остаётся на месте, и хаб показывает
 * его прежним звеном пути группы. Новая связь — копия прежней (`carriedLink`):
 * та же стадия, дописка, окружение и профиль группы. Чужой CLI, занятая группа,
 * связь без настоящей сессии и отказ старта — прежнее продолжение сессии.
 */

/** Вводная нового разговора перепроверки: откуда он и что о группе знать. */
export function recheckFreshBrief(input: {
  /** Прежний разговор группы — его id, чтобы найти в истории. */
  previous: string;
  group: Pick<SplitPlanGroupRecord, 'title' | 'branch' | 'path' | 'mr'>;
  /** Задание группы из связи (`ChatLink.groupTask`) — как его получила работа. */
  task?: string;
  /** Задачи группы из предложения — когда задания в связи нет (старые связи). */
  tasks: readonly string[];
  /** Есть ли `.agent/PROGRESS.md` в копии. */
  progress: boolean;
}): string {
  const { group } = input;
  const lines = [
    `This is a NEW conversation of the split group «${group.title}»: the panel starts every MR ` +
      'recheck fresh instead of resuming the old session. Your previous conversation ' +
      `(${input.previous}) stays in the chat history — do not try to resume or continue it.`,
    `Branch ${group.branch}, working copy ${group.path ?? '—'}, MR ${group.mr ?? '—'}.`,
    input.progress
      ? 'Working notes: .agent/PROGRESS.md in the copy — context of the earlier work, not tasks ' +
        'for this recheck. Restore the rest from the facts: git log of the branch and the MR.'
      : 'Restore the context from the facts: git log of the branch and the MR.',
  ];
  const task = input.task?.trim();
  if (task) lines.push('', "The group's task, as it was given:", task);
  else if (input.tasks.length > 0) {
    lines.push('', "The group's tasks:", ...input.tasks.map((item) => `- ${item}`));
  }
  // Задание группы в связи — без строки старшинства (`withoutPrecedence`): она здесь одна.
  lines.push('', OWNER_PRECEDENCE_LINE);
  return lines.join('\n');
}

/**
 * Охват перепроверки по копии группы: что ветка меняет против цели MR и что
 * лежит в дереве копии мимо него. Цель — основание группы (отведена от ветки
 * предшественника) или ветка основной копии в том виде, в каком её знают ссылки.
 * Сеть не трогается; не прочитано — `undefined`.
 */
export async function readRecheckScope(
  input: { mainDir: string; copy: string; base?: string },
  run: (cwd: string, args: string[]) => Promise<string> = git,
): Promise<RecheckScope | undefined> {
  const base = input.base ?? (await readMergeTarget(input.mainDir));
  if (!base) return undefined;
  const [diff, status] = await Promise.all([
    run(input.copy, ['diff', '--name-only', '-z', `${base}...HEAD`]),
    run(input.copy, ['status', '--porcelain=v1', '-z', '-uall']),
  ]);
  const files = diff
    .split('\0')
    .map((path) => path.trim())
    .filter(Boolean);
  const own = new Set(files);
  const outside = [...new Set(parseDirtyPaths(status))].filter((path) => !own.has(path));
  return { base, files, outside };
}

/** Старт нового разговора группы — тот же, что у звеньев ревью (`createReviewStarter`). */
export type RecheckStart = (input: {
  chatId: string;
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  stage: 'tell';
  fromAliases: string[];
  title?: string;
}) => { started: boolean; busy?: boolean };

const hasProgress = (cwd: string): boolean => existsSync(join(cwd, '.agent', 'PROGRESS.md'));

type Delivery = 'sent' | 'queued' | 'refused';

export interface RecheckSessionDeps {
  links: () => Record<string, ChatLink>;
  setLink: (chatId: string, link: ChatLink) => void;
  removeLink: (chatId: string) => void;
  /** Идёт ли прогон под ключом: занятой группе слово — после её хода, прежним путём. */
  running: (chatId: string) => boolean;
  start: RecheckStart;
  /** Прежний путь — продолжение сессии группы (`tellGroup`). */
  resume: (group: SplitPlanGroupRecord, prompt: string) => Delivery;
  /** Есть ли `.agent/PROGRESS.md` в копии; не задан — смотрим на диске. */
  progress?: (cwd: string) => boolean;
  now?: () => number;
  log: (message: string, error?: unknown) => void;
}

/**
 * Слово перепроверки группе — новым разговором в её копии. Ключ нового —
 * временный `new-…`: настоящий он получит первым ходом, и связь переедет на
 * него сама (`linkChatSession`); старт хода переводит группу на новый ключ
 * (`onChainResumed`), поэтому следующее слово панели идёт уже в него.
 */
export function createRecheckSession(
  deps: RecheckSessionDeps,
): (record: SplitPlanRecord, group: SplitPlanGroupRecord, prompt: string) => Delivery {
  return (record, group, prompt) => {
    const chatId = group.chatId;
    const link = chatId ? deps.links()[chatId] : undefined;
    if (!chatId || !group.path || !link) return deps.resume(group, prompt);
    const aliases = [...new Set([chatId, ...conversationKeys(deps.links(), chatId)])];
    const previous = aliases.find((key) => !key.startsWith('new-'));
    // Чужой CLI ведёт свои разговоры сам — новый там пока не проверен живьём.
    // Занятой группе (идёт её ход) второй разговор в той же копии — это два агента.
    if (
      !previous ||
      aliases.some((key) => parseForeignChatKey(key)) ||
      aliases.some((key) => deps.running(key))
    ) {
      return deps.resume(group, prompt);
    }
    const key = `new-${(deps.now ?? Date.now)()}-recheck${group.index}`;
    deps.setLink(key, {
      ...carriedLink(link),
      conversation: key,
      createdAt: new Date((deps.now ?? Date.now)()).toISOString(),
    });
    const brief = recheckFreshBrief({
      previous,
      group,
      ...(link.groupTask ? { task: link.groupTask } : {}),
      tasks: record.proposal.groups[group.index]?.tasks ?? [],
      progress: (deps.progress ?? hasProgress)(group.path),
    });
    let outcome: { started: boolean } = { started: false };
    try {
      outcome = deps.start({
        chatId: key,
        prompt: `${brief}\n\n${prompt}`,
        cwd: group.path,
        ...(link.model ? { model: link.model } : {}),
        ...(link.effort ? { effort: link.effort } : {}),
        stage: 'tell',
        fromAliases: aliases,
        ...(link.title ? { title: link.title } : {}),
      });
    } catch (error) {
      deps.log('mr recheck: fresh session start failed', error);
    }
    if (outcome.started) return 'sent';
    // Новый не завёлся — связь без разговора не висит в дереве, слово идёт прежним путём.
    deps.removeLink(key);
    deps.log(`mr recheck: fresh session refused, resuming (${record.parentChatId}#${group.index})`);
    return deps.resume(group, prompt);
  };
}
