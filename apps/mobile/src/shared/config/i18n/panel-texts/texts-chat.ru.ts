import type { PanelTextCode } from '@agentdeck/contracts/panel-agent';

/**
 * Форма словаря без импорта из `texts.ru.ts`: тот вливает этот модуль, и обратный
 * импорт типа замыкал бы круг. Полноту держит тип словаря у места вливания.
 */
type ChatTexts = { [C in PanelTextCode]?: string };

/**
 * Тексты действий агента над чатами: прочитать, написать, попросить разделение,
 * «работать здесь», группа чата, стоп, пульт разделения и дерева, ожидания,
 * поиск. Вливаются в `panelTextsRu` одним разворотом: общий словарь правят
 * параллельно. Русский совпадает с запасным текстом сервера (`texts-chat.ts`).
 */
export const panelTextsChatRu = {
  'journal-read-chat': 'Чтение чата',
  'journal-search-chats': 'Поиск по чатам',
  'journal-list-waiting': 'Что в чатах ждёт человека',
  'journal-list-chat-projects': 'Папки, в которых есть чаты',
  'journal-send-chat-message': 'Сообщение в чат',
  'journal-request-split': 'Просьба разделить задачи по чатам',
  'journal-split-decline': 'Отказ от разделения задач',
  'journal-set-chat-group': 'Группа и автономность чата',
  'journal-stop-chat-run': 'Остановка агента в чате',
  'journal-split-control': 'Управление разделением задач',
  'summary-send-chat-message': 'Отправить сообщение в чат «{{chat}}»',
  'summary-request-split': 'Попросить чат «{{chat}}» предложить разделение задач по чатам',
  'summary-split-decline': 'Чат «{{chat}}»: работать здесь, разделение больше не предлагать',
  'summary-set-chat-group': 'Сменить группу или автономность чата «{{chat}}»',
  'summary-stop-chat-run': 'Остановить агента в чате «{{chat}}»',
  'summary-split-pause': 'Поставить на паузу группу «{{group}}» (чат «{{chat}}»)',
  'summary-split-resume': 'Продолжить группу «{{group}}» после паузы (чат «{{chat}}»)',
  'summary-split-release':
    'Отпустить группу «{{group}}», не дожидаясь предшественников (чат «{{chat}}»)',
  'summary-split-answer': 'Ответить на вопрос разбора группы «{{group}}» (чат «{{chat}}»)',
  'summary-tree-pause': 'Остановить всё дерево чата «{{chat}}»',
  'summary-tree-resume': 'Продолжить всё дерево чата «{{chat}}»',
  'label-chat': 'Чат',
  'label-message': 'Сообщение',
  'label-effort': 'Глубина продумывания',
  'label-chat-state': 'Агент чата',
  'label-autonomous': 'Автономность',
  'label-answer': 'Ответ',
  'label-question': 'Вопрос',
  'value-split-request-standard':
    'Стандартная просьба о разделении — та же, что у кнопки «Разделить задачи по чатам»',
  'value-split-next-human':
    'Агент чата предложит группы; под его ответом появится кнопка «Разделить на … чата» — нажимаете её вы',
  'value-chat-busy-queued': 'Сейчас работает — сообщение уйдёт, когда он закончит ход',
  'value-chat-idle': 'Свободен — сообщение уйдёт сразу',
  'value-group-auto': 'Авто',
  'value-group-inherit': 'Как у родительского чата',
  'value-autonomous-on': 'Включена',
  'value-autonomous-off': 'Выключена',
  'value-autonomous-inherit': 'Как у родительского чата',
  'value-stop-run': 'Ход прервётся; начатое агент не доделает',
  'value-stop-pauses-group': 'Это чат группы разделения — группа встанет на паузу',
  'value-split-decline-effect':
    'Сам агент чата больше не предложит разделение; кнопка «Разделить задачи по чатам» работает по-прежнему',
  'value-split-pause-effect': 'Прогоны группы остановятся, группа ждёт «Продолжить»',
  'value-split-resume-effect': 'Группа продолжит работу своей сессией',
  'value-split-release-effect': 'Группа стартует сейчас, ничего не сливая от предшественников',
  'value-split-answer-effect': 'Ответ уйдёт группе, и она стартует',
  'value-tree-pause-effect': 'Остановятся все прогоны этой просьбы, автостарты замрут',
  'value-tree-resume-effect': 'Остановленные разговоры продолжатся, отложенное уйдёт',
} satisfies ChatTexts;
