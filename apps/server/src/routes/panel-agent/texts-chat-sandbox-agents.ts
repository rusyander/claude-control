import type { PanelTextCode } from '@agentdeck/contracts/panel-agent';

/**
 * Русские тексты карточек и следа действий P3 (U5c): продолжение чата в чистой
 * сессии, файлы чата, «Открыть в редакторе», песочница, агенты и эмбеддинги
 * контура. Коды объявлены в контракте
 * (`panel-agent-texts-chat-sandbox-agents.ts`), общий словарь сервера забирает
 * их одним разворотом — правка этого набора не переписывает чужие строки.
 */
export type ChatSandboxAgentsTextCode =
  | 'journal-continue-chat-handoff'
  | 'journal-restart-chat-session'
  | 'journal-list-chat-artifacts'
  | 'journal-read-chat-artifact'
  | 'journal-delete-chat-artifact'
  | 'journal-open-in-editor'
  | 'summary-continue-chat-handoff'
  | 'summary-restart-chat-session'
  | 'summary-delete-chat-artifact'
  | 'summary-open-in-editor'
  | 'label-handoff-done'
  | 'label-handoff-next'
  | 'label-handoff-checkpoint'
  | 'label-artifact-size'
  | 'label-editor'
  | 'value-restart-how'
  | 'journal-list-sandbox-fixtures'
  | 'journal-sandbox-probe-hook'
  | 'journal-sandbox-ask'
  | 'summary-sandbox-probe-hook'
  | 'summary-sandbox-ask'
  | 'label-sandbox-events'
  | 'label-sandbox-question'
  | 'label-sandbox-rules'
  | 'label-sandbox-skills'
  | 'label-sandbox-hooks'
  | 'label-sandbox-mcp'
  | 'label-sandbox-scripts'
  | 'label-sandbox-draft-rule'
  | 'value-sandbox-events-all'
  | 'value-sandbox-cleanup'
  | 'value-sandbox-empty'
  | 'value-sandbox-ask-how'
  | 'journal-ask-contour-agent'
  | 'journal-read-contour-agent-session'
  | 'journal-reset-contour-agent-session'
  | 'journal-contour-embeddings'
  | 'summary-ask-contour-agent'
  | 'summary-reset-contour-agent-session'
  | 'summary-contour-embeddings'
  | 'label-contour-agent'
  | 'label-contour-question'
  | 'label-contour-session'
  | 'label-contour-model'
  | 'label-contour-texts'
  | 'value-contour-session-none'
  | 'value-contour-agent-spends'
  | 'value-contour-session-forget'
  | 'value-contour-embeddings-spend';

export const CHAT_SANDBOX_AGENTS_TEXTS_RU: {
  [C in ChatSandboxAgentsTextCode & PanelTextCode]: string;
} = {
  'journal-continue-chat-handoff': 'Продолжение чата в новой сессии',
  'journal-restart-chat-session': 'Перезапуск сессии чата',
  'journal-list-chat-artifacts': 'Список файлов чата',
  'journal-read-chat-artifact': 'Чтение файла чата',
  'journal-delete-chat-artifact': 'Удаление файла чата',
  'journal-open-in-editor': 'Открытие проекта в редакторе',
  'summary-continue-chat-handoff':
    'Продолжить чат «{{title}}» в новой сессии по предложению агента',
  'summary-restart-chat-session': 'Перезапустить сессию чата «{{title}}»',
  'summary-delete-chat-artifact': 'Удалить файл «{{name}}» из чата «{{title}}»',
  'summary-open-in-editor': 'Открыть проект «{{name}}» в редакторе',
  'label-handoff-done': 'Сделано',
  'label-handoff-next': 'Дальше',
  'label-handoff-checkpoint': 'Файл опоры',
  'label-artifact-size': 'Размер и дата',
  'label-editor': 'Редактор',
  'value-restart-how':
    'Если {{checkpoint}} свежее вашего последнего сообщения — новая сессия стартует сразу; иначе чат сначала обновит его, и продолжение начнётся само, когда этот ход закончится',
  'journal-list-sandbox-fixtures': 'Заготовки событий песочницы',
  'journal-sandbox-probe-hook': 'Прогон хука в песочнице',
  'journal-sandbox-ask': 'Вопрос Claude в песочнице',
  'summary-sandbox-probe-hook': 'Прогнать «{{name}}» в песочнице',
  'summary-sandbox-ask': 'Спросить Claude в песочнице с выбранными настройками',
  'label-sandbox-events': 'События',
  'label-sandbox-question': 'Вопрос',
  'label-sandbox-rules': 'Правила',
  'label-sandbox-skills': 'Скиллы',
  'label-sandbox-hooks': 'Хуки',
  'label-sandbox-mcp': 'MCP-серверы',
  'label-sandbox-scripts': 'Скрипты',
  'label-sandbox-draft-rule': 'Черновик правила',
  'value-sandbox-events-all': 'Все заготовки',
  'value-sandbox-cleanup':
    'Команда запустится на этом компьютере над копией во временной папке; настоящие настройки не меняются, папка удаляется сразу после прогона',
  'value-sandbox-empty': 'Ничего — Claude без ваших настроек, для сравнения',
  'value-sandbox-ask-how':
    'Claude Code запустится с временной конфигурацией только из выбранного и потратит лимит подписки; копия доступа к аккаунту удаляется сразу после ответа',
  'journal-ask-contour-agent': 'Вопрос агенту контура',
  'journal-read-contour-agent-session': 'Чтение сессии агента контура',
  'journal-reset-contour-agent-session': 'Сброс сессии агента контура',
  'journal-contour-embeddings': 'Эмбеддинги контура',
  'summary-ask-contour-agent': 'Спросить агента {{name}} контура «{{title}}»',
  'summary-reset-contour-agent-session': 'Сбросить сессию «{{name}}» у контура «{{title}}»',
  'summary-contour-embeddings': 'Посчитать эмбеддинги моделью {{name}} у контура «{{title}}»',
  'label-contour-agent': 'Агент',
  'label-contour-question': 'Вопрос',
  'label-contour-session': 'Сессия',
  'label-contour-model': 'Модель',
  'label-contour-texts': 'Тексты',
  'value-contour-session-none': 'Без сессии — агент не вспомнит этот разговор',
  'value-contour-agent-spends':
    'Агент отвечает на стороне контура и тратит его бюджет; может пользоваться инструментами, которые ему дала компания',
  'value-contour-session-forget':
    'Контур забудет всю переписку этой сессии, у всех агентов; отменить нельзя',
  'value-contour-embeddings-spend':
    'Запрос уйдёт в контур и потратит его бюджет; агенту вернутся только число векторов и их размер',
};
