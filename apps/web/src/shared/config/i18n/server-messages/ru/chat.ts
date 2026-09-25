import type { ChatMessageCode } from '@agentdeck/contracts/server-messages';

export const chatRu: Record<ChatMessageCode, string> = {
  'run-busy':
    'Предыдущий ответ в этом разговоре ещё генерируется. Дождитесь его окончания или нажмите «Остановить» — сообщение не отправлено.',
  'run-empty-prompt': 'Сообщение пустое — отправлять нечего.',
  'run-unsupported-upload':
    'Не поддерживаются вложения: {{names}}. Сообщение не отправлено. Допустимые расширения: {{supported}}.',
  'run-workspace-missing':
    'Рабочая папка этого чата не найдена: {{cwd}}. Разговор начинался в ней, и продолжить его можно только оттуда.',
  'run-session-unknown':
    'Разговор {{sessionId}} не найден: транскрипта с таким sessionId нет. Сообщение не отправлено — новый разговор без sessionId начинается отдельно.',
  'branch-name-required': 'Имя ветки не задано — копию заводить не под что.',
  'branch-run-gone':
    'Прогон, который ждал решения о ветке, уже закончился: копию заводить не для кого.',
  'editor-not-found':
    'Редактор кода не найден. Укажите его в настройках или установите code/cursor.',
  'handoff-proposal-invalid': 'Предложение не разобрано: нужны «что закрыто» и «чем продолжить»',
  'restart-run-in-progress':
    'Прогон ещё идёт: дождитесь конца хода или остановите его, потом перезапускайте',
  'cli-not-found': 'CLI Claude не найден в PATH',
  'cli-outdated':
    'Панель запускает Claude Code {{current}}, а модели нужна версия {{required}} или новее. Обновите CLI.',
  'prompt-too-long':
    'Контекст разговора переполнен: следующее сообщение он не примет. Сожмите контекст или продолжите в новой сессии.',
  'conversation-unspecified': 'Не указан разговор',
  'split-proposal-invalid': 'Разделение не разобрано: нужны минимум две группы с задачами',
  'split-conveyor-off': 'Конвейер уровней выключен',
  'split-group-number-required': 'Нужен номер группы',
  'split-group-not-found': 'Группа не найдена',
  'split-answer-empty': 'Ответ пустой',
  'split-overlap-off': 'Сверка веток выключена',
  'split-levels-missing': 'Разделения с уровнями тут нет',
  'split-review-off': 'Ревью по ссылкам выключено',
  'split-review-decision-unknown': 'Неизвестное решение',
  'split-review-decided': 'Решение по этому ревью уже принято',
  'split-review-nothing-to-send': 'Отправлять нечего: правок по ревью здесь не было',
  'split-review-branch-unknown': 'Ветка MR неизвестна — push ушёл бы в новую ветку, а не в MR',
  'split-review-no-session': 'Разговор ещё не начался — продолжать нечего',
  'split-review-busy': 'Чат ещё работает — дождитесь конца хода',
  'split-review-start-failed': 'Запуск не удался',
  'split-review-not-missing': 'Итог ревью уже получен — повторять нечего',
  'conversation-not-found': 'Разговор не найден',
  'panel-help-query-empty': 'Пустой запрос к справке.',
  'panel-card-click-only': 'Решение по карточке принимается только кликом в окне панели.',
  'panel-card-truncated':
    'Карточка показывает не всё, что будет выполнено, — одобрить её нельзя. Отклоните и попросите агента разбить действие на части.',
  'panel-card-not-found': 'Такой карточки нет — возможно, она уже снята.',
  'panel-card-decided': 'По этой карточке уже принято решение.',
  'panel-conversation-not-found': 'Такого разговора нет.',
  'foreign-chat-not-for-claude': 'У Claude собственный чат — эти маршруты не для него.',
  'conversation-create-failed': 'Не удалось создать разговор',
  'request-empty': 'Пустой запрос',
  'foreign-answer-running': 'Ответ на предыдущий вопрос ещё идёт',
  'foreign-restart-running':
    'Ответ ещё идёт: дождитесь конца хода или остановите его, потом перезапускайте',
  'foreign-restart-no-cwd': 'У разговора нет рабочего каталога — новый разговор заводить негде',
  'foreign-continuation-store-failed': 'Продолжение не заведено: хранилище отказало',
  'panel-help-topic-missing': 'Темы справки «{{id}}» нет. Есть: {{known}}.',
  'panel-agent-busy': 'В этом разговоре агент ещё отвечает — дождитесь конца хода.',
  'split-hold-not-waiting': 'Группа не ждёт ответа: вопроса нет или на него уже ответили',
  'split-release-not-waiting': 'Группа не ждёт предшественников: отпускать нечего',
  'split-relaunch-nothing': 'Разделения нет: перезапускать нечего',
  'split-ticket-missing': 'Такого предложения тикета в разделении нет',
  'split-ticket-tracker-missing': 'Трекер у проекта не привязан: завести тикет некуда',
  'split-relaunch-running': 'Перезапуск этого разделения уже идёт',
  'split-plan-running':
    'Разделение этого разговора ещё идёт — дождитесь конца групп или отмените план',
  'split-cleanup-nothing': 'Убирать нечего: группа не закрыта, копии нет или она уже убрана',
  'split-cleanup-shared':
    'В этой копии ещё работает другая группа — уберите копию, когда закроется и она',
  'panel-agent-last-not-user': 'последняя реплика должна быть человека',
  'split-pause-not-running': 'Группа сейчас не работает — ставить на паузу нечего',
  'split-resume-not-paused': 'Группа не на паузе — продолжать нечего',
  'split-resume-refused': 'Продолжить группу нечем: у неё нет разговора или копии',
  'split-start-not-queued': 'Группа не в очереди — запускать нечего',
  'split-accept-not-done': 'Принять нечего: группы нет или она ещё не доставлена',
  'split-group-no-slot': 'Все места заняты: работает {{running}} из {{limit}}',
  'split-limit-active': 'Лимит подписки исчерпан до {{until}}',
  'split-plan-cancel-nothing': 'Отменять нечего: разделение этого разговора уже закончилось',
  'split-plan-cancel-unknown': 'Разделения с этим разговором нет',
  'split-plan-cancelled': 'План отменён: его группы закрыты — начните новое разделение',
  'split-group-cleanup-failed': 'Копию убрать не удалось: {{detail}}',
};
