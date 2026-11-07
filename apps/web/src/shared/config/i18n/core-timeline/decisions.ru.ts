import type { DecisionClassId } from '@agentdeck/contracts/core/decisions';
import type { DecisionOutcome } from '@agentdeck/contracts/core/decision-view';

/**
 * Шаблоны решений ленты (этап 9, развилка F1): подпись класса и заголовок на каждый исход из
 * закрытого списка контрактов `DECISION_OUTCOMES`. Тип исчерпывающий: новый класс или исход ядра
 * без текста здесь — ошибка сборки, а не «решение без шаблона» у человека. Причины решения
 * (английская проза ядра) показываются дословно под «детали» — сюда они не переводятся (P32).
 */
export type DecisionTexts = {
  [C in DecisionClassId]: { label: string; outcomes: { [O in DecisionOutcome<C>]: string } };
};

const SIGNAL_OUTCOMES_RU = {
  quiet: 'Не сработал',
  show: 'Показан человеку',
  hint: 'Подсказка сессии',
  'stop-step': 'Шаг остановлен',
  'pause-at-safe-point': 'Пауза в безопасной точке',
};

export const decisionsRu: DecisionTexts = {
  check: {
    label: 'Проверка',
    outcomes: {
      replay: 'Повтор записанного результата',
      run: 'Полный прогон',
      narrow: 'Суженный прогон',
      wait: 'Ждёт очереди',
      defer: 'Отложена',
      refuse: 'Отказано',
      absent: 'Проверки нет в реестре',
    },
  },
  compose: {
    label: 'Сборка стенда',
    outcomes: { ready: 'Стенд готов', run: 'Стенд поднимается', refuse: 'Стенд не собран' },
  },
  window: {
    label: 'Окно лимитов',
    outcomes: {
      open: 'Окно открыто',
      warn: 'Окно на исходе',
      refused: 'Окно отказало',
      held: 'Запрос придержан',
      exhausted: 'Лимит исчерпан',
      offline: 'Маршрут недоступен',
    },
  },
  schedule: {
    label: 'Очередь',
    outcomes: { granted: 'Место выдано', waiting: 'Ждёт места' },
  },
  requirements: {
    label: 'Требования',
    outcomes: { covered: 'Все требования покрыты', uncovered: 'Есть непокрытые требования' },
  },
  gates: {
    label: 'Ворота',
    outcomes: { passed: 'Ворота пройдены', closed: 'Ворота закрыты' },
  },
  'publish-ready': {
    label: 'Готовность к публикации',
    outcomes: { allow: 'Можно публиковать', refuse: 'Публикация не разрешена' },
  },
  'publish-text': {
    label: 'Текст публикации',
    outcomes: { pass: 'Текст принят', stripped: 'Лишнее вырезано', refused: 'Текст отклонён' },
  },
  continuation: {
    label: 'Продолжение',
    outcomes: { 'same-session': 'В той же сессии', fresh: 'В новой сессии' },
  },
  tier: {
    label: 'Модель',
    outcomes: { picked: 'Модель выбрана', refused: 'Модель не выбрана' },
  },
  'split-check': {
    label: 'Разбиение',
    outcomes: { accepted: 'Разбиение принято', refused: 'Разбиение отклонено' },
  },
  next: {
    label: 'Следующее действие',
    outcomes: {
      'create-unit': 'Создать единицу',
      'start-unit': 'Начать единицу',
      'start-step': 'Начать шаг',
      'reenter-step': 'Повторно войти в шаг',
      'run-step': 'Исполнить шаг',
      'run-core-step': 'Шаг исполняет ядро',
      'post-step': 'Разобрать итог шага',
      remind: 'Напомнить сессии',
      'derive-outcome': 'Вывести исход шага',
      'stop-step': 'Остановить шаг',
      'park-session': 'Поставить сессию на паузу',
      'extend-budget': 'Продлить время',
      'extend-tokens': 'Добавить токенов',
      answered: 'Ответ получен',
      'close-human-step': 'Закрыть шаг человека',
      'close-chat': 'Закрыть чат',
      'close-ask': 'Закрыть вопрос: ответ пришёл',
      raise: 'Спросить человека',
      'skip-step': 'Пропустить шаг',
      'end-unit': 'Завершить единицу',
      'launch-children': 'Запустить следующие дочерние задачи',
      'finish-task': 'Завершить задачу',
      'fail-task': 'Задача не удалась',
      'cancel-task': 'Отменить задачу',
      wait: 'Ждать',
    },
  },
  'human-point': {
    label: 'Вопрос человеку',
    outcomes: {
      blocking: 'Нужен ответ, шаг ждёт',
      'non-blocking': 'Вопрос без остановки',
      fork: 'Развилка решена по умолчанию',
      refused: 'Вопрос не поднят',
    },
  },
  authority: {
    label: 'Полномочия',
    outcomes: { allow: 'Команда принята', refuse: 'Команда отклонена' },
  },
  permit: {
    label: 'Право',
    outcomes: { allow: 'Действие разрешено', deny: 'Действие запрещено' },
  },
  ownership: {
    label: 'Владение путём',
    outcomes: { inside: 'В своих путях', outside: 'Вне своих путей' },
  },
  safepoint: {
    label: 'Безопасная точка',
    outcomes: { safe: 'Точка безопасна', unsafe: 'Точка небезопасна' },
  },
  reconcile: {
    label: 'Сверка действия',
    outcomes: {
      happened: 'Действие состоялось',
      'not-happened': 'Действие не состоялось',
      retry: 'Повторить действие',
      ask: 'Спросить человека',
    },
  },
  observer: { label: 'Наблюдатель', outcomes: SIGNAL_OUTCOMES_RU },
  'forged-publish': { label: 'Подделка публикации', outcomes: SIGNAL_OUTCOMES_RU },
  'hook-block': { label: 'Блок хука', outcomes: SIGNAL_OUTCOMES_RU },
  'hook-loop': { label: 'Петля хука', outcomes: SIGNAL_OUTCOMES_RU },
  'copy-setup': {
    label: 'Рабочая копия',
    outcomes: {
      ready: 'Копия готова',
      'ready-with-gaps': 'Копия готова с пробелами',
      failed: 'Копия не подготовлена',
    },
  },
  'red-before': {
    label: 'Красный до правки',
    outcomes: { proven: 'Доказан', unproven: 'Не доказан', unknown: 'Не удалось проверить' },
  },
  cleanup: {
    label: 'Уборка',
    outcomes: { release: 'Ресурсы освобождены', keep: 'Ресурсы оставлены' },
  },
  compat: {
    label: 'Совместимость маршрута',
    outcomes: { direct: 'Напрямую', 'via-gateway': 'Через шлюз', refused: 'Несовместимо' },
  },
  fit: {
    label: 'Помещается ли модель',
    outcomes: { fits: 'Помещается', short: 'Не хватает памяти' },
  },
  'slot-wait': {
    label: 'Ожидание слота',
    outcomes: {
      hold: 'Держать слот',
      retry: 'Повторить',
      release: 'Отпустить слот',
      foreign: 'Слот занят чужим',
      adopt: 'Забрать слот',
      'human-point': 'Спросить человека',
    },
  },
  endpoint: {
    label: 'Точка доступа',
    outcomes: { serve: 'Отдаётся', refuse: 'Отказано' },
  },
  budget: {
    label: 'Бюджет',
    outcomes: { within: 'В пределах', over: 'Превышен' },
  },
  'keep-warm': {
    label: 'Прогрев кэша',
    outcomes: { ping: 'Прогрет', skip: 'Пропущен' },
  },
  'set-route': {
    label: 'Смена маршрутов',
    outcomes: { applied: 'Применена', refused: 'Отклонена' },
  },
  precedence: {
    label: 'Уровни настроек',
    outcomes: {
      'within-levels': 'Всё в пределах уровней',
      'widening-rejected': 'Расширение отклонено',
    },
  },
  'layer-run': {
    label: 'Слой пользователя',
    outcomes: { 'as-asked': 'Как запрошено', lowered: 'Понижен' },
  },
  intake: {
    label: 'Приём задачи',
    outcomes: { auto: 'Карточка принята без вопроса', ask: 'Карточка ждёт подтверждения' },
  },
  classify: {
    label: 'Класс задачи',
    outcomes: {
      S: 'Класс S — одна правка',
      M: 'Класс M — одна единица и ревью',
      L: 'Класс L — несколько единиц и сборка',
      XL: 'Класс XL — дочерние задачи',
    },
  },
};
