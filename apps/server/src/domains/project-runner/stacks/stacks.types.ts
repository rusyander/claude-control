import type { RunnerStack } from '@agentdeck/contracts';

/**
 * Что дописать к запуску, когда человек закрепил порт. У каждого стека свой
 * способ: Node-серверы читают `PORT`, uvicorn — `--port`, Django —
 * `runserver 127.0.0.1:N`, Spring — `SERVER_PORT`. Одна `PORT` для всех
 * работала бы только у части проектов, а панель ждала бы порт, который никто
 * не слушает.
 */
export type PinPort = (port: number) => { args?: string[]; env?: Record<string, string> };

/** Один способ запустить каталог, найденный детектором стека. */
export interface StackCandidate {
  stack: RunnerStack;
  framework?: string;
  /** Абсолютные пути файлов, по которым команда угадана. */
  evidence: string[];
  /** Исполняемый файл для spawn (абсолютный путь — для обёрток и venv). */
  file: string;
  args: string[];
  /** Каталог запуска, если он не каталог цели (Go: корень модуля). */
  cwd?: string;
  /** Команда для показа: `go run ./cmd/api`. */
  display: string;
  /** Программа из PATH, без которой команда не запустится. */
  tool?: string;
  /** Файл-обёртка в проекте (gradlew, .venv/python): доступна, если существует. */
  toolPath?: string;
  pinPort?: PinPort;
}

/** Каталог, который смотрит детектор, и корень проекта (граница поиска вверх). */
export interface StackProbe {
  dir: string;
  root: string;
}
