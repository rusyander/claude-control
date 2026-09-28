import type { Group } from '@agentdeck/contracts';
import { ESCALATE_LINE, type CascadeStage } from '@agentdeck/contracts/model-cascade';
import type { AppStore } from '../../lib/app-store.ts';
import type { PathStep } from '@agentdeck/contracts/group-path';
import { groupKeyOf } from '@agentdeck/contracts/group-sources';
import { parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { knobsLineForChoice } from '../groups/knobs.ts';
import { readChat } from '../provider-chat/store.ts';
import { chatPathSteps, scenarioLine, skillInsertsLine } from './path-steps.ts';
import { stageOf } from './ChatCascadeStages.ts';
import { chatGroupSettingsView, storeTreeReader } from './chat-autonomy.ts';
import { pinnedChoiceAt } from './group-auto-pick.ts';

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
  'getGroups' | 'getChatGroupSettings' | 'getChatLink' | 'canonicalChatKey'
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
 * здесь: у неё задание — слова человека, и дописать туда нечего.
 */
export function childStageExtra(stage: CascadeStage, knobs: string | undefined): string {
  return [stage === 'work' ? ESCALATE_LINE : '', knobs ?? ''].filter(Boolean).join(' ');
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
  return childStageExtra(stageOf(link), chatKnobsLine(store, appData, [chatKey], cwd)) || undefined;
}
