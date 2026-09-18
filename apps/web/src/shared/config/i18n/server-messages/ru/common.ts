import type { CommonMessageCode } from '@agentdeck/contracts/server-messages';

export const commonRu: Record<CommonMessageCode, string> = {
  'file-not-found': 'Файл не найден',
  'path-absolute-required': 'Нужен абсолютный путь',
  'directory-unavailable': 'Каталог недоступен',
  'directory-not-found': 'Каталог не найден',
  'project-path-required': 'Нужен путь проекта',
  'project-not-in-registry': 'Проект не найден в реестре',
  'project-id-not-in-registry': 'Проекта с таким id нет в реестре.',
  'project-dir-already-added': 'Этот каталог уже добавлен как «{{name}}».',
};
