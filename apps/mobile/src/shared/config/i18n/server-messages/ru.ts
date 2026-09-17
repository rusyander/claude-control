import type { ServerMessageCode } from '@agentdeck/contracts/server-messages';

/**
 * Тексты сервера по коду (`contracts/server-messages.ts`) — те же, что у панели
 * (`apps/web/src/shared/config/i18n/server-messages`). Отдельный модуль, а
 * не ветка в `ru.ts`: список кодов растёт вместе с сервером, и `Record` по типу
 * кода ломает сборку, если код заведён, а перевода нет.
 *
 * Русский текст повторяет серверный по смыслу — сервер свою строку оставляет
 * запасной для записей без кода.
 */
export const serverMessagesRu: Record<ServerMessageCode, string> = {
  'capability-models-key-scoped': 'список сужен правами ключа',
  'capability-models-gateway-listed': 'список отдан шлюзом',
  'capability-kind-undeclared': 'вид моделей не объявлен',
  'capability-chat-listed': 'модели чата в списке ключа',
  'capability-chat-none': 'моделей чата ключу не выдано',
  'capability-embeddings-listed': 'модели эмбеддингов в списке ключа',
  'capability-embeddings-none': 'моделей эмбеддингов ключу не выдано',
  'capability-agents-call-only': 'проверяется только вызовом агента — панель его не делает',
  'capability-guardrails-in-band': 'работают в полосе запроса: отказ приходит статусом 451',
  'capability-knowledge-via-owner': 'через владельца ключа, отдельного маршрута нет',
  'capability-client-tools-rejected': 'публичный API не принимает описания инструментов',
  'capability-undeclared-by-gateway': 'совместимый шлюз этого о себе не сообщает',
  'capability-image-flag-undeclared': 'флаг рисования не объявлен ни одной моделью',
  'capability-image-no-models': 'моделей ключу не выдано',
  'capability-image-listed': 'модели с флагом рисования в списке ключа',
  'capability-image-none': 'рисующих моделей ключу не выдано',
  'platform-not-found': 'Контура «{{id}}» не существует.',
  'platform-not-connected': 'Контур «{{title}}» не подключён: включите его и сохраните ключ.',
  'platform-agents-not-declared':
    'У контура «{{title}}» нет опубликованных агентов: его тип их не объявляет.',
  'run-busy':
    'Предыдущий ответ в этом разговоре ещё генерируется. Дождитесь его окончания или нажмите «Остановить» — сообщение не отправлено.',
  'run-empty-prompt': 'Сообщение пустое — отправлять нечего.',
  'run-unsupported-upload':
    'Не поддерживаются вложения: {{names}}. Сообщение не отправлено. Допустимые расширения: {{supported}}.',
  'run-workspace-missing':
    'Рабочая папка этого чата не найдена: {{cwd}}. Разговор начинался в ней, и продолжить его можно только оттуда.',
  'media-block-too-large': 'Блок слишком велик — панель такой не принимает.',
  'media-image-not-found': 'Такой картинки у панели нет.',
  'media-deck-not-found': 'Такой презентации у панели нет.',
  'media-deck-file-missing': 'Файл презентации панель не нашла.',
  'media-deck-format-unknown': 'Такого вида файла у презентации нет.',
  'media-deck-revise-unspecified': 'Не сказано, какую презентацию править.',
  'media-deck-revise-gone': 'Той презентации, которую просят поправить, у панели уже нет.',
  'media-deck-block-invalid': 'В блоке не колода: нет заголовка или ни одного слайда.',
  'media-topic-empty': 'Опишите, что нужно.',
  'media-prompt-kind-unknown': 'Неизвестный вид просьбы.',
};
