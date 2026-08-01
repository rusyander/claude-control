import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Рекурсивные обход своими руками, а не `fs.cpSync` и `fs.rmSync`.
 *
 * Замерено на Node 24 под Windows: рекурсивные операции ломаются, если в пути
 * есть нелатинские символы. `cpSync` убивает процесс молча — без исключения,
 * без сообщения, с нулевым кодом выхода. `rmSync` с `force: true` рапортует
 * об успехе, а папка остаётся на диске: панель сказала бы «удалено», ничего
 * не удалив. Поймано на скилле с русским именем папки.
 *
 * Поштучные операции — `copyFileSync`, `unlinkSync`, `rmdirSync`, `readdirSync` —
 * те же пути обрабатывают правильно, поэтому обход пишем сами. Названия у
 * скиллов и их файлов приходят от пользователя, так что кириллица здесь
 * ожидаема, а не экзотика.
 */
export function copyRecursive(source: string, target: string): void {
  if (!statSync(source).isDirectory()) {
    copyFileSync(source, target);
    return;
  }

  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    copyRecursive(join(source, entry.name), join(target, entry.name));
  }
}

/** Удаление файла или папки целиком. Отсутствующий путь — не ошибка. */
export function removeEntry(target: string): void {
  if (!existsSync(target)) return;

  if (!statSync(target).isDirectory()) {
    unlinkSync(target);
    return;
  }

  for (const entry of readdirSync(target)) removeEntry(join(target, entry));
  rmdirSync(target);
}
