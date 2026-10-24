import type { Group } from '@agentdeck/contracts';
import {
  ESCALATE_LINE,
  REVIEW_DURABLE_LINE,
  type CascadeStage,
} from '@agentdeck/contracts/model-cascade';
import type { AppStore } from '../../../lib/app-store/app-store.ts';
import type { PathStep } from '@agentdeck/contracts/group-path';
import { groupKeyOf } from '@agentdeck/contracts/group-sources';
import { parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { leverWorks } from '@agentdeck/contracts/group-economy-support';
import { getProvider } from '../../../providers/registry.ts';
import { knobsLineForChoice } from '../../groups/knobs/knobs.ts';
import { readChat } from '../../provider-chat/store/store.ts';
import { chatPathSteps, scenarioLine, skillInsertsLine } from '../path-steps/path-steps.ts';
import { childAppendPrompt, stageOf } from '../ChatCascadeStages/ChatCascadeStages.ts';
import { chatGroupSettingsView, storeTreeReader } from '../chat-autonomy/chat-autonomy.ts';
import { pinnedChoiceAt } from '../group-auto-pick/group-auto-pick.ts';
import {
  FOREIGN_CHILD_NO_TOOL_LOOP_PROMPT,
  FOREIGN_CHILD_PROMPT,
  FOREIGN_GROUP_ECONOMY_PROMPT,
  NO_TOOL_LOOP_ECONOMY_PROMPT,
} from '../initiative/initiative.ts';
import { WORK_HABITS_SHARED_NOTE } from '../group-profile/group-profile.ts';

/**
 * Строки группы в системной дописке прогона: «числа» группы, выбранной в чате
 * (с учётом дерева — ребёнок разделения наследует выбор родителя), и для звена
 * работы — как поднять критическое в главный чат.
 *
 * Дописку звена собирают три места — старт ребёнка (`split-launch.ts`), ответ
 * человека в него (`childAppendPrompt`) и переход стадии (`handoff-routes.ts`),
 * — и все берут дополнение ОТСЮДА: разойдись они хоть словом, ход не совпал бы
 * подписью с живым процессом и пошёл бы холодным `--resume`.
 */

type GroupStore = Pick<
  AppStore,
  'getGroups' | 'getChatGroupSettings' | 'getChatLink' | 'canonicalChatKey' | 'getSettings'
>;

/**
 * Выбор группы разговора (ключи — временный и настоящий) с учётом дерева.
 * `pendingParent` — родитель ребёнка, чья связь запишется только перед
 * запуском (веер из чата): без него первый ход не видел бы группу родителя, а
 * именно на первом ходу скилл спрашивает, сколько агентов заводить, и путь
 * группы нужен с первой строки.
 */
export function chatGroupChoice(
  store: Omit<GroupStore, 'getGroups'>,
  keys: readonly string[],
  pendingParent?: string,
): string {
  const base = storeTreeReader(store);
  const reader = pendingParent
    ? {
        ...base,
        parentOf: (key: string) =>
          base.parentOf(key) ?? (keys.includes(key) ? pendingParent : undefined),
      }
    : base;
  return chatGroupSettingsView(reader, keys).groupChoice;
}

/**
 * Выбор группы разговора, по которому идёт ПРОГОН в `cwd`: `chatGroupChoice`,
 * сверенный с парами проекта (`pinnedChoiceAt`, F-107). Сырой выбор здесь
 * вёл бы прогон по шагам и строкам неактивной половины пары — той, что
 * включение на старте уже не включает.
 */
export function runGroupChoice(
  store: GroupStore,
  appData: string,
  keys: readonly string[],
  cwd: string | undefined,
  pendingParent?: string,
): string {
  const choice = chatGroupChoice(store, keys, pendingParent);
  return pinnedChoiceAt(store.getGroups(), appData, choice, cwd);
}

/** Свои шаги «Пути» группы прогона после стадии (`chatPathSteps`) — по `runGroupChoice`. */
export function runPathSteps(
  store: GroupStore,
  appData: string,
  aliases: readonly string[],
  stage: CascadeStage,
  cwd: string | undefined,
): PathStep[] {
  return chatPathSteps(store.getGroups(), runGroupChoice(store, appData, aliases, cwd), stage);
}

/**
 * Строка скиллов группы, выбранной у разговора (`chatGroupChoice`): её «числа»
 * и свои шаги внутри порядка скиллов — и то и другое о том, КАК идут скиллы
 * группы, и едет одним куском во все дописки, что уже несут числа.
 */
export function chatKnobsLine(
  store: GroupStore,
  appData: string,
  keys: readonly string[],
  cwd: string | undefined,
  pendingParent?: string,
): string | undefined {
  const groups: readonly Group[] = store.getGroups();
  const hasKnobs = groups.some((group) => group.knobs && Object.keys(group.knobs).length > 0);
  const hasInserts = groups.some(
    (group) => group.flow === 'scenario' || group.path?.steps.some((step) => step.within),
  );
  if (!hasKnobs && !hasInserts) return undefined;
  const choice = runGroupChoice(store, appData, keys, cwd, pendingParent);
  const knobs = hasKnobs ? knobsLineForChoice(appData, groups, choice) : undefined;
  const group =
    hasInserts && choice !== 'auto'
      ? groups.find((item) => groupKeyOf(item) === choice)
      : undefined;
  const inserts = group ? (scenarioLine(group) ?? skillInsertsLine(group)) : undefined;
  return [knobs, inserts].filter(Boolean).join(' ') || undefined;
}

/**
 * Дополнение дописки звена по стадии. Ревью, правки и доставка получают
 * строку эскалации в самом задании (`model-cascade.ts`), а работа — только
 * здесь: у неё задание — слова человека, и дописать туда нечего. Ревью, кроме
 * того, несёт здесь правила, что переживают сжатие контекста.
 */
export function childStageExtra(stage: CascadeStage, knobs: string | undefined): string {
  // Ревью несёт то, что обязано пережить сжатие контекста (T17, T4): системная
  // дописка в пересказ не уходит, а первое сообщение уходит.
  const stageLine =
    stage === 'work' ? ESCALATE_LINE : stage === 'review' ? REVIEW_DURABLE_LINE : '';
  return [stageLine, knobs ?? ''].filter(Boolean).join(' ');
}

/**
 * Системная дописка хода в разговор звена Claude — по его связи, одна на все
 * входы: ответ человека (`run-routes.ts`) и продолжение той же сессии панелью
 * — после лимита, паузы, обрыва, слово родителя, публикация ревью
 * (`review-starter.ts`). Дописка входит в системный промпт, а он у сессии
 * обязан совпадать байт в байт от хода к ходу: иначе кэш разговора пишется
 * заново целиком (E6, замер 12.10.2026 по 36 сессиям копий: в 8 продолжение
 * панелью теряло строку эскалации, которую старт работы дописал). Связи под
 * ключами разговора нет — разговор не звено, `undefined`.
 */
export function linkedChildAppend(
  store: GroupStore,
  appData: string,
  settings: Parameters<typeof childAppendPrompt>[1],
  keys: readonly string[],
  cwd: string | undefined,
  pendingParent?: string,
): string | undefined {
  const link = keys.map((key) => store.getChatLink(key)).find(Boolean);
  if (!link) return undefined;
  const knobs = chatKnobsLine(store, appData, keys, cwd, pendingParent);
  return childAppendPrompt(link, settings, childStageExtra(stageOf(link), knobs)) || undefined;
}

/**
 * Строка привычек группы чужого CLI (рычаг `workHabits`) — общая часть строки
 * Claude, без фразы про `cd`. Рычаг — закреплённый на первом старте разговора
 * (`linkEconomy` в runtime): строка едет в начале переписки, и смена посреди тёплой сессии
 * переписала бы её кэш, как у Claude. Рычагов в настройках нет — строки нет.
 */
function foreignHabits(store: GroupStore, chatKey: string): string | undefined {
  const current = store.getSettings().groupEconomy;
  if (!current) return undefined;
  // Каталог CLI говорит, что строке у него нечего менять (aider: инструментов нет) —
  // строки нет: отметка «не нужен» и токены каждого хода не должны расходиться.
  const providerId = parseForeignChatKey(chatKey)?.providerId;
  const declared = providerId
    ? getProvider(providerId).groupEconomy?.support.workHabits
    : undefined;
  if (declared && !leverWorks(declared)) return undefined;
  // Только смотрит: закрепляет рычаги старт прогона (`setChildRun` в runtime), как
  // у Claude. Дополнение строится и при заведении звена, задолго до его хода
  // (отложенный старт) — закрепление здесь брало бы рычаги того момента.
  const economy = store.getChatLink(chatKey)?.economy ?? current;
  return economy.workHabits ? WORK_HABITS_SHARED_NOTE : undefined;
}

/**
 * Дополнение звена ЧУЖОГО CLI — по его связи (`codex:…`), тем же
 * `childStageExtra`, что у ребёнка Claude. Собирается из одних связи и групп,
 * поэтому совпадает у всех, кто его строит: старт ребёнка, переход стадии,
 * продолжение после паузы и ответ человека в чат группы. Связи нет — разговор
 * не звено, и дописывать нечего.
 *
 * Системной дописки у чужого CLI нет: дополнение едет в `systemPrefix` —
 * первой репликой переписки перед заданием (`ProviderChatRun`).
 *
 * Каталог прогона — рабочая папка самого разговора: по ней закрепление
 * сверяется с парой проекта (`runGroupChoice`), и все, кто строит дополнение,
 * получают одно и то же, не передавая каталог сами.
 */
export function foreignChildExtra(
  store: GroupStore,
  appData: string,
  chatKey: string,
): string | undefined {
  const link = store.getChatLink(chatKey);
  if (!link) return undefined;
  const parsed = parseForeignChatKey(chatKey);
  const cwd = parsed ? readChat(appData, parsed.providerId, parsed.chatId)?.workdir : undefined;
  const stage = stageOf(link);
  // Правила ребёнка — всем звеньям группы, кроме разбора: он не группа, а
  // общий прогон до них (TQ-06).
  const group = Boolean(link.parentChatId) && stage !== 'triage';
  // CLI без цикла инструментов (каталог, `noToolLoop`) получает из строки экономии
  // только то, что исполнит правкой файла: фразы о вызовах и оболочке ему не по силам.
  const noToolLoop = Boolean(parsed && getProvider(parsed.providerId).groupEconomy?.noToolLoop);
  const economy = noToolLoop ? NO_TOOL_LOOP_ECONOMY_PROMPT : FOREIGN_GROUP_ECONOMY_PROMPT;
  const rules = noToolLoop ? FOREIGN_CHILD_NO_TOOL_LOOP_PROMPT : FOREIGN_CHILD_PROMPT;
  const child = group
    ? [rules, economy, foreignHabits(store, chatKey)].filter(Boolean).join(' ')
    : '';
  return (
    [child, childStageExtra(stage, chatKnobsLine(store, appData, [chatKey], cwd))]
      .filter(Boolean)
      .join(' ') || undefined
  );
}
