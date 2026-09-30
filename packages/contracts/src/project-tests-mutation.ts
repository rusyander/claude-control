import type { ProjectTestStatus } from './project-tests';

/**
 * Проверка набора кейсов поломкой (`/api/project-tests/mutation`): в отдельной
 * копии репозитория файл заведомо ломается, привязанные к нему автоматические
 * кейсы прогоняются, и отчёт называет пойманное и пропущенное. Только по кнопке
 * человека: это прогон автотестов в копии, минуты и больше.
 */

/** `break` — модуль падает при загрузке (данные пустеют); `subtle` — переворот первого сравнения. */
export type ProjectTestMutationMode = 'break' | 'subtle';

export interface ProjectTestMutationCase {
  groupId: string;
  caseId: string;
  title: string;
  /** Автотест кейса — его файл уходит в команду прогона. */
  automationFile: string;
  /** Итог в прогоне поломки; `no-result` — отчёт о кейсе не сказал ничего. */
  status: ProjectTestStatus | 'no-result';
}

export interface ProjectTestMutationCheck {
  status: 'running' | 'done' | 'error' | 'stopped';
  /** Где идёт проверка: копия, поломка, прогон, разбор отчёта, уборка копии. */
  stage: 'copy' | 'break' | 'run' | 'report' | 'cleanup';
  /** Сломанный файл — от корня проекта. */
  file: string;
  mode: ProjectTestMutationMode;
  /** Что именно сломано: строка до и после или «модуль падает при загрузке». */
  mutation?: string;
  command?: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  /** Хвост вывода команды прогона. */
  log: string;
  cases: ProjectTestMutationCase[];
  /** Кейсов, покрасневших на поломке, — поймали. */
  caught: number;
  /** Кейсов, оставшихся зелёными, — поломку не заметили. */
  missed: number;
  error?: string;
  errorCode?: string;
}

/** Файл, который есть что ломать: на него указывают `codePaths` автоматических кейсов. */
export interface ProjectTestMutationCandidate {
  file: string;
  cases: number;
}

/** Ответ `GET /api/project-tests/mutation`. */
export interface ProjectTestMutationView {
  check?: ProjectTestMutationCheck;
  candidates: ProjectTestMutationCandidate[];
}
