import type { BrowseGap, BrowseStep } from '@agentdeck/contracts/core/browse';
import type { ProjectTestStep } from '@agentdeck/contracts';

/** Вход генератора спека: только строки прохода и имя теста — ни часов, ни задачи, ни значений секретов. */
export interface RecordedSpecInput {
  /** Полное имя теста (`recorded > <название>`) — строка-метка спека. */
  testName: string;
  steps: readonly BrowseStep[];
  gaps: readonly BrowseGap[];
}

/** Шаг спека, который гоняется без модели: номер в спеке и подпись по-русски. */
export interface RecordedPlayable {
  n: number;
  title: string;
  step: BrowseStep;
}

/** Строка прохода в порядке журнала: сыгранный шаг, неудавшийся при записи шаг или пробел. */
export type RecordedItem =
  | { kind: 'play'; playable: RecordedPlayable }
  | { kind: 'failed'; step: BrowseStep; title: string }
  | { kind: 'gap'; gap: BrowseGap; title: string };

/** Итог генерации: текст спека и шаги кейса — из одних и тех же строк. */
export interface RecordedBuild {
  spec: string;
  /** Адрес стенда, на котором записано, — запасной, когда `E2E_BASE_URL` не задан. */
  origin: string;
  playable: RecordedPlayable[];
  /** Шаги кейса: сыгранные с номером спека, остальные — «не проверено». */
  caseSteps: ProjectTestStep[];
  /** Сколько строк легло «не проверено». */
  unchecked: number;
}

/** Порт к ядру: открыть одну задачу прохода по стенду и вернуть её id. */
export interface RecordedWalkPort {
  open(request: RecordedWalkRequest): Promise<{ taskId: string }>;
}

export interface RecordedWalkRequest {
  root: string;
  title: string;
  /** Текст задачи модели — по-английски: модель читает его, человек видит подпись. */
  text: string;
}
