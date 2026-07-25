import type { ProjectRunnerTarget, ProjectRunnerView } from '@claude-control/contracts';

export interface ProjectRunnerControlsProps {
  /** Абсолютный путь корня проекта — вкладки, чьи dev-серверы мы ведём. */
  path: string;
}

/** Строка одной цели в поповере настроек запуска. */
export interface RunnerTargetRowProps {
  /** Корень проекта: цель адресуется парой «корень + подпапка». */
  path: string;
  target: ProjectRunnerTarget;
  /** Состояние запуска этой цели, если она запущена. */
  run?: ProjectRunnerView;
  /** Разворачивать ли поля команды и порта сразу (у единственной цели — да). */
  defaultOpen: boolean;
}

/** Сообщение «порт занят» с предложением освободить его и запустить заново. */
export interface BusyPortNoticeProps {
  /** Корень проекта и подпапка цели — её и перезапустим после освобождения. */
  path: string;
  dir: string;
  /** Порт, на который пожаловался сервер. */
  port: number;
}

/** Ссылка на запущенную цель в ряду вкладки. */
export interface RunnerChipProps {
  path: string;
  run: ProjectRunnerView;
  /** Показывать ли имя цели: у монорепы важно, у одиночного проекта — шум. */
  withName: boolean;
}
