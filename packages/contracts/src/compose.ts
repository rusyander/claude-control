/**
 * Docker Compose проекта — то, что окно «Окружение» показывает на вкладке
 * «Сервисы». Источник правды — сам docker: панель читает `compose config` и
 * `compose ps` и ничего у себя не хранит.
 */

/** Состояние Docker на машине: нет программы, программа есть, но демон не отвечает, всё работает. */
export type DockerState = 'ok' | 'missing' | 'stopped';

/** Что сделать со стеком или сервисом. `down-volumes` удаляет и данные томов. */
export type ComposeAction = 'up' | 'stop' | 'restart' | 'down' | 'down-volumes';

/** Состояние контейнера сервиса; `absent` — сервис описан, но контейнера ещё нет. */
export type ComposeServiceState =
  'running' | 'exited' | 'created' | 'restarting' | 'paused' | 'dead' | 'absent';

/** Опубликованный порт: `127.0.0.1:5433 → 5432/tcp`. */
export interface ComposePort {
  /** Адрес на машине; пустой — все интерфейсы. */
  host: string;
  published: number;
  target: number;
  protocol: string;
}

export interface ComposeService {
  name: string;
  /** Образ из файла; у сервиса со сборкой — то, что задано рядом с `build`, если задано. */
  image?: string;
  /** Сервис собирается из исходников (`build:`), а не берётся готовым образом. */
  build: boolean;
  state: ComposeServiceState;
  /** Проверка здоровья, если она в файле есть и контейнер работает. */
  health?: 'healthy' | 'unhealthy' | 'starting';
  /** Строка состояния docker: «Up 8 seconds (healthy)», «Exited (1) 2 minutes ago». */
  status?: string;
  exitCode?: number;
  /** Порты: у работающего — опубликованные на деле, у остальных — объявленные в файле. */
  ports: ComposePort[];
  dependsOn: string[];
}

/** Действие, которое идёт или только что закончилось: одно на проект. */
export interface ComposeJob {
  id: string;
  action: ComposeAction;
  /** Пусто — над всем стеком. */
  service?: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  /** Хвост вывода docker compose — в нём причина отказа («port is already allocated»). */
  output: string;
}

export interface ComposeInfo {
  projectPath: string;
  docker: DockerState;
  /** Что ответил docker, когда он не готов, — для подробностей под объяснением. */
  dockerDetail?: string;
  /** Найденный файл относительно корня проекта; нет — в проекте нет Compose. */
  file?: string;
  /** Файлы, которые compose применит вместе: основной и override рядом с ним. */
  files: string[];
  /** Имя проекта compose — по нему docker узнаёт «свои» контейнеры. */
  projectName?: string;
  services: ComposeService[];
  /** Именованные тома из файла — именно они пропадут при «удалить вместе с данными». */
  volumes: string[];
  /** Файл есть, но docker его не принял: синтаксис, неизвестный ключ, нет переменной. */
  configError?: string;
  job?: ComposeJob;
}
