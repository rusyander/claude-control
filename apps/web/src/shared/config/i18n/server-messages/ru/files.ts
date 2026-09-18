import type { FilesMessageCode } from '@agentdeck/contracts/server-messages';

export const filesRu: Record<FilesMessageCode, string> = {
  'file-not-found-dot': 'Файл не найден.',
  'directory-unavailable-dot': 'Каталог недоступен.',
  'file-unavailable': 'Файл недоступен.',
  'code-window-snapshot-incomplete': 'Неполный снимок окна кода.',
  'file-list-width-missing': 'Ширина списка файлов не задана.',
  'write-request-incomplete': 'Неполный запрос на запись.',
  'write-failed': 'Записать не удалось.',
  'runner-project-path-required': 'Нужен абсолютный путь к каталогу проекта',
  'runner-enabled-boolean': 'Поле enabled должно быть булевым',
  'runner-port-required': 'Нужен номер порта',
  'file-not-a-file': 'Это не файл.',
  'file-format-not-shown': 'Такой формат панель не показывает.',
  'file-too-large-view': 'Файл слишком велик для просмотра.',
  'file-content-missing': 'Содержимое не передано.',
  'file-too-large-write': 'Файл больше допустимого размера.',
  'file-changed-on-disk': 'Файл на диске изменился после открытия.',
  'runner-command-empty': 'Команда запуска пуста.',
  'runner-subdir-outside': 'Подпапка должна лежать внутри проекта: {{dir}}',
  'resource-path-escapes': 'Путь выходит за пределы ресурса',
  'resource-path-invalid': 'Неверный путь',
  'resource-file-exists': 'Файл с таким именем уже существует',
  'resource-read-only': 'Этот вид ресурса доступен только для чтения',
  'project-dev-script-missing':
    'В package.json нет скрипта dev или start. Задайте команду запуска вручную.',
};
