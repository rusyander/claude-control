import type { GroupEconomy } from '@agentdeck/contracts/group-economy';
import type { ProviderChatMessage } from '@agentdeck/contracts/provider-chat';

/**
 * Рычаги экономии группы на ОДИН прогон чужого CLI (`setEconomyRun`): то, что
 * решатель канала (`economy-run/economy-run.ts`) превращает в переменные запуска.
 */
export interface EconomyRunRequest {
  /** Рычаги, закреплённые на первом старте разговора (`linkEconomy`). */
  economy?: GroupEconomy;
  /** Окно сжатия группы — читается на ходу, как у Claude (`groupWindow`). */
  compactWindow?: number;
  /** Модель хода (шапка разговора или модель контура). Пусто — своя модель CLI. */
  model?: string;
  /** Окно локальной модели, если ход идёт через неё (`route.localLimits`). */
  localContextWindow?: number;
  /** Окно модели хода по каталогу контура (`route.modelContext`), если контур его объявил. */
  modelContext?: number;
  /** Рабочий каталог разговора: настройки проекта CLI лежат там. */
  workdir?: string;
}

/** Что решатель «холодного продолжения» знает о ходе (`setColdPlan`). */
export interface ColdPlanRequest {
  providerId: string;
  chatId: string;
  appDataDir: string;
  workdir?: string;
  /** Сессия CLI прошлых ходов (отметка `live-session`); нет — продолжать нечего. */
  session?: { kind: string; id: string };
  /**
   * Ход идёт на локальной модели (`localLimits` маршрута или свой локальный сервер
   * CLI, `setOwnLocal`): кэша провайдера нет.
   */
  local?: boolean;
  /** Сохранённая переписка ДО новой реплики. */
  messages: readonly ProviderChatMessage[];
}

/**
 * Решение о продолжении после паузы:
 * - `resume` — сессия CLI продолжается, как без решателя;
 * - `fresh` — кэш остыл: сессия бросается, а ход открывается вводной панели
 *   (`brief`) и хвостом переписки из `tail` последних реплик — перечитывать всю
 *   историю по холодной цене дороже, чем начать заново. `notice` — строка в ленту.
 */
export type ColdPlan =
  { kind: 'resume' } | { kind: 'fresh'; brief: string; tail: number; notice?: string };

/**
 * Старт и конец хода чужого CLI — сторожу групп (`setWatchListener`). Потока
 * событий у чужого CLI сторожу нет: события он берёт из переписки CLI сам.
 * `sessionId` — сессия CLI, если она известна: на старте — продолжаемая, на
 * конце — та, в которой ход прошёл.
 */
export type ForeignWatchFeed =
  | {
      kind: 'start';
      providerId: string;
      chatId: string;
      sessionId?: string;
      group: boolean;
      cwd: string;
      /**
       * Ход на локальной модели (локальный контур или свой локальный сервер CLI):
       * кэша провайдера нет — R2 сторожа молчит.
       */
      local?: boolean;
    }
  | { kind: 'finish'; providerId: string; chatId: string; sessionId?: string; group: boolean };
