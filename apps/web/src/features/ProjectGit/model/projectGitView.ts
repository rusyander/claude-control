import type { ProjectGitFileStatus } from '@entities/ProjectGit';

/**
 * Чистая часть пульта git: как показать изменённый файл и что отправить
 * кнопкой pull. Вынесено из компонента, потому что здесь есть что проверить —
 * разрез пути и правило «пустой выбор значит текущая ветка».
 */

/** Буква git у состояния файла — короче и понятнее любого перевода. */
export const STATUS_LETTER: Record<ProjectGitFileStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  typechange: 'T',
  untracked: '?',
  conflict: 'U',
};

/**
 * Путь разрезан на каталог и имя: в списке сжимается только каталог, имя файла
 * видно всегда. Обрезать путь с конца — значит прятать ровно то, что ищут
 * глазами. Разделитель только `/`: git отдаёт пути так на любой ОС.
 */
export function splitPath(value: string): { dir: string; name: string } {
  const cut = value.lastIndexOf('/');
  return cut < 0
    ? { dir: '', name: value }
    : { dir: value.slice(0, cut + 1), name: value.slice(cut + 1) };
}

/**
 * Тело запроса pull. Пустой выбор в селекте — это «текущая ветка», то есть
 * обычный `git pull` по её upstream: поле `branch` в запрос не идёт вовсе.
 * Отправить пустую строку значило бы попросить ветку с пустым именем.
 */
export function pullBody(path: string, selection: string): { path: string; branch?: string } {
  const branch = selection.trim();
  return branch ? { path, branch } : { path };
}
