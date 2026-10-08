import type { Group } from '@agentdeck/contracts';
import type {
  GroupLayerDelivered,
  GroupLayerKind,
  GroupLayerRefusal,
} from '@agentdeck/contracts/group-delivery';
import type { MemberDeps } from '../members/members.ts';

/** Вход одного прогона: группы уже отобраны (`effectiveGroupsForRun`). */
export interface GroupLayerInput {
  providerId: string;
  /** Имя CLI для текстов (`{{cli}}`). */
  cliName: string;
  /** Без повторов, из пары — действующая сторона, только файлы Claude; порядок = приоритет. */
  groups: readonly Group[];
}

export interface GroupLayerPlan<Payload = unknown> {
  kind: GroupLayerKind;
  providerId: string;
  groups: { id: string; name: string }[];
  delivered: GroupLayerDelivered[];
  refused: GroupLayerRefusal[];
  /** Переменные групп: при совпадении имени выигрывает первая группа. */
  env: Record<string, string>;
  /** Отпечаток всего, что увидит прогон: имя каталога и «та же ли заметка». */
  digest: string;
  payload: Payload;
}

/**
 * Хук группы, который отыгрывает надзиратель панели на прогоне (Codex: хук в его
 * собственных файлах срабатывает только после одобрения в `/hooks`, а слой на
 * один прогон в файлы CLI не пишется).
 */
export interface GroupLayerHook {
  event: 'SessionStart' | 'UserPromptSubmit' | 'Stop';
  command: string;
  timeoutMs?: number;
}

export interface GroupLayerWritten {
  env: Record<string, string>;
  args?: string[];
  dir: string;
  /** Хуки для надзирателя прогона; у слоя, который несёт хуки файлом CLI, — нет. */
  hooks?: GroupLayerHook[];
}

/**
 * Слой одного механизма. `plan` — чистая половина: читает файлы Claude и
 * ничего не пишет (её же показывает страница группы). `write` — ввод-вывод под
 * `<appData>/<cli>-group-layers/<отпечаток>/`; доставлять нечего — `undefined`.
 * Отказать прогону целиком — бросить `GroupLayerBlocked`.
 */
export interface GroupLayerWriter<Payload = unknown> {
  kind: GroupLayerKind;
  plan(
    deps: MemberDeps,
    input: GroupLayerInput,
    options?: { env?: NodeJS.ProcessEnv },
  ): GroupLayerPlan<Payload>;
  write(
    deps: MemberDeps,
    plan: GroupLayerPlan<Payload>,
    options?: { now?: number; env?: NodeJS.ProcessEnv },
  ): GroupLayerWritten | undefined;
}
