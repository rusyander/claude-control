import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { removeEntry } from './safe-io.ts';

/**
 * Временная копия файла конфигурации — «песочница» для записи.
 *
 * Нужна там, где панель должна ВЫПОЛНИТЬ настоящую запись, но не имеет права
 * коснуться файла пользователя: проверка провайдера (круг чтения-записи) и
 * предпросмотр диффа. Подменить каталог, как у Claude, нельзя — у чужих CLI
 * конфигурация глобальная, поэтому копируем файл, работаем с копией и удаляем
 * её. Второго способа получить ЧЕСТНЫЙ результат (а не предсказание) нет.
 *
 * Отдельный модуль, а не приватная функция домена: приём общий, и второй его
 * реализации в коде быть не должно.
 */
export interface ConfigSandbox {
  /** Путь копии внутри временного каталога — адаптер пишет только сюда. */
  path: string;
  /** Файл-оригинал существовал (иначе копии нет и запись создаст файл с нуля). */
  existed: boolean;
  dispose: () => void;
}

/**
 * Скопировать файл во временный каталог. Имя файла сохраняется: адаптеры
 * различают форматы по расширению и кладут копии рядом по basename.
 */
export function createConfigSandbox(filePath: string): ConfigSandbox {
  const dir = mkdtempSync(join(tmpdir(), 'claude-control-sandbox-'));
  const copy = join(dir, basename(filePath));
  const existed = existsSync(filePath);
  // Файла может не быть вовсе (CLI ещё не запускали) — это нормальный случай:
  // адаптер создаст его в копии, и мы увидим ветку «создание с нуля».
  if (existed) copyFileSync(filePath, copy);
  // Каталог удаляем целиком: адаптер мог оставить рядом временные файлы записи.
  return { path: copy, existed, dispose: () => removeEntry(dir) };
}
