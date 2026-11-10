import type { EstimateReply } from '@agentdeck/contracts/core/estimate';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';

/**
 * Просьба открыть задачу ответов ревьюерам (05:77): поздние заметки в MR законченной задачи,
 * найденные опросом форжа. Всё о MR — из журнала задачи-источника; здесь только где его искать.
 */
export interface AnswerTaskInput {
  /** Законченная задача, чей MR получил заметки. */
  fromTaskId: string;
  /** Единица этой задачи, которой принадлежит MR (`publish.mr`). */
  unitId: string;
  /** Исходный репозиторий (копий задачи-источника уже нет). */
  repo: string;
  /** Удалённый репозитория, чей адрес пуша — `url`. */
  remote: string;
  url: string;
  mrIid: number;
  /** Строки `forge.event` (источник `poller`) — причина новой задачи. */
  events: JournalDataV1['forge.event'][];
  /**
   * Этап 12 (P162): ключ оценки носителя — `cmdId` доработки: тот же ключ дважды — та же задача
   * (`replayEstimate`). Нет — свой новый ключ (опрос форжа: повтор держат его отметки).
   */
  cmdId?: string;
  /** Этап 12 (P162): слово человека к доработке — в запрос задачи, его читает первый бриф. */
  note?: string;
}

export type AnswerTaskOutcome =
  | { opened: string; reply: EstimateReply }
  /** Задачи нет: причины названы, опрос спросит снова на следующем круге. */
  | { refused: string[] };
