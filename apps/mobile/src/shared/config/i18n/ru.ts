import { serverMessagesRu } from './server-messages/ru.ts';

/**
 * Русский словарь — источник истины. Английский типизирован по нему, поэтому
 * забытый ключ ломает сборку, а не всплывает пустой строкой на экране.
 *
 * Строка с подстановкой — функция: собирать её конкатенацией на месте значит
 * разложить фразу по кускам, а порядок слов в языках разный.
 */
export const ru = {
  // Тексты сервера по коду: шаблоны `{{имя}}`, а не функции — список кодов и
  // подстановок общий с панелью (`contracts/server-messages.ts`).
  serverMessages: serverMessagesRu,
  tabs: {
    chat: 'Чат',
    projects: 'Проекты',
    analytics: 'Аналитика',
    settings: 'Настройки',
    agent: 'Агент',
  },

  common: {
    loading: 'Загрузка…',
    empty: 'Пусто',
    notConnected: 'Панель не подключена. Откройте «Настройки».',
    notConnectedChat: 'Панель не подключена. Откройте «Настройки» и спарьте приложение по QR-коду.',
    panelSilent: 'Панель не ответила',
    notFound: 'Не найдено',
    up: 'Вверх',
    open: 'открыть',
    close: 'закрыть',
    kb: 'КБ',
    duration: { h: 'ч', m: 'м', s: 'с' },
  },

  chat: {
    title: 'Чат',
    conversations: 'Разговоры',
    code: 'Код',
    tests: 'Тесты',
    homeChat: 'Домашний чат',
    blank: 'Пусто. Напишите задачу — она уйдёт агенту на компьютере.',
    queued: (prompt: string) => `В очереди: ${prompt} ✕`,
    image: '[изображение]',
    // Та же подпись, что у ответа в веб-чате (`context-managed`).
    contextSummarized:
      'Контур сжал историю перед этим ответом: модель видела пересказ начала разговора, а не весь ' +
      'текст. Что ушло в пересказ, панель не знает — сжимает платформа.',
    // Предложения панели: карточек на телефоне нет, решают в панели, — но и
    // сырой JSON вместо них показывать незачем.
    offerSplit: 'Агент предложил разделить задачи по чатам — решение в панели.',
    offerHandoff: 'Агент предложил продолжить в чистой сессии — решение в панели.',
    // Рисунок агента блоком `agentdeck:svg` — карточкой, как в панели; колоду
    // телефон не собирает, но и JSON вместо неё не показывает.
    picture: {
      title: 'Рисунок агента',
      broken: 'Рисунок не отрисовался на телефоне — откройте его в панели.',
    },
    offerDeck: 'Агент продиктовал презентацию — карточка в панели.',
    blocksRejected: (count: number) =>
      `Панель не приняла блоков: ${count} — они показаны как есть.`,
    plan: (done: number, total: number) => `План ${done}/${total}`,
    subagents: (count: number) => `Субагентов: ${count}`,
    permission: 'Нужно разрешение',
    allow: 'Разрешить',
    deny: 'Запретить',
    permissionFailed: 'Не удалось ответить',
    permissionLost: 'Решение не дошло до агента: запрос уже закрыт или прогон завершён',
    usage: {
      title: 'Расход шага',
      input: 'Свежий вход',
      cacheCreation: 'Записано в кэш',
      cacheRead: 'Прочитано из кэша',
      output: 'Сгенерировано',
      total: 'Всего',
      cost: 'Стоимость',
      answer: 'Ответ',
      run: 'Расход хода',
      shared: (count: number) => `Общий расход на ${count} вызова этого шага`,
      step: 'Время шага',
      span: (from: string, to: string) => `с ${from} до ${to}`,
      runTime: 'Весь прогон',
      live: (time: string) => `идёт ${time}`,
    },
  },

  composer: {
    ask: 'Что сделать?',
    queue: 'Дописать в очередь…',
    send: 'Отправить',
    stop: 'Стоп',
    settings: 'Настройки отправки',
    attach: 'Приложить снимок',
    voice: 'Голосом',
    voiceListening: 'Слушаю…',
    voiceDenied: 'Нет разрешения на микрофон',
    voiceUnavailable: 'Распознавание речи на этом устройстве недоступно',
    allowEdits: 'Правки разрешены',
    autoApprove: 'Автоподтверждение',
    model: 'Модель',
    modelDefault: 'по умолчанию',
    effort: 'Глубина продумывания',
    unsupported: (names: string) => `Не поддерживается: ${names}`,
    shot: (index: number) => `снимок-${index}.jpg`,
    /**
     * Прогон через контур (Т6/Т8) — те же слова, что в шапке чата панели.
     * Подписи появляются только в этом случае и называют контур по имени:
     * иначе «модель заменена» читается как поломка приложения.
     */
    platformModel: (title: string, model: string) => `Через контур «${title}»: ${model}.`,
    platformModelReplaced: (title: string, asked: string, model: string) =>
      `Через контур «${title}»: имени «${asked}» там нет, запрос уйдёт с ${model}.`,
    platformModelUnset: (title: string) =>
      `Контур «${title}» модель не назначил (каталог пуст или проба не проходила) — запрос уйдёт как есть.`,
    platformNoEffort: (title: string) =>
      `Контур «${title}» не принимает глубину продумывания — она не отправляется.`,
    platformLocked: (title: string) =>
      `Чат идёт через контур «${title}»: модель и глубину задаёт он. Сменить — в разделе «Контур» панели или вернуть провайдер по умолчанию.`,
    platformModelNone: 'модель контура',
    platformEffortOff: 'не отправляется',
    platformRefused: (title: string, reason: string, fix: string) =>
      `Контур «${title}» обязателен, а ${reason}: сообщение будет отклонено — ни в контур, ни в облако вендора оно не уйдёт. ${fix}`,
    platformBypassed: (title: string, reason: string, fix: string) =>
      `Мимо контура: «${title}» включён «по возможности», а ${reason} — сообщение уйдёт напрямую в облако вендора, без защиты контура. ${fix}`,
    platformRefusedReason: {
      gateway_down: 'шлюз панели не поднят',
      no_token: 'ключ контура не сохранён',
    },
    /** Телефон контур не правит (Т12) — чинится в панели, и сказано, где именно. */
    platformRefusedFix: {
      gateway_down: 'Нажмите «Поднять шлюз» на карточке контура в панели (раздел «Контур»).',
      no_token: 'Сохраните ключ в панели: «Настроить» на карточке контура → шаг «Ключ».',
    },
    platformLayers: (title: string, list: string) =>
      `Через контур «${title}» прогон пойдёт без нашего: ${list}.`,
    platformLayersAll: (title: string) =>
      `Через контур «${title}» прогон пойдёт без единого нашего слоя: ни правил, ни хуков, ни прав, ни скиллов, ни MCP-серверов, ни дописки панели.`,
    /** Названия слоёв — как на карточке контура в панели. */
    layerTitle: {
      settings: 'Личные правила, хуки и права',
      skills: 'Скиллы',
      mcp: 'MCP-серверы',
      systemPrompt: 'Дописка панели к системному промпту',
    },
    /**
     * Режим отправки (Т9): сообщение агенту или картинка. Доступность решает
     * сервер (`/media/images/plan`), здесь только слова.
     */
    mode: {
      text: 'Сообщение',
      image: 'Картинка',
      imageBlocked: 'Рисовать нечем',
      imagePlaceholder: 'Опишите картинку — панель нарисует её сама, без агента',
      imagePlaceholderAgent: 'Опишите картинку — агент нарисует её кодом, вектором',
      drawing: 'Рисуем — это минуты',
      source: (title: string, model: string) => (model ? `${title} · ${model}` : title),
      sourceAgent: 'Нарисует агент разговора: вектор кодом, а не снимок',
      promptSkipped: 'Промпт режима здесь не уезжает: у ручки картинок системного сообщения нет',
      blocked: {
        'no-route': 'Ни активного контура, ни профиля эндпоинта — рисовать некому',
        'driver-none': 'Этот контур картинок не рисует: возможность в его драйвере не объявлена',
        'no-model': 'В каталоге ключа нет модели с генерацией картинок',
        'endpoint-no-url': 'В профиле эндпоинта не задан адрес генерации картинок',
        'gateway-off': 'Шлюз панели выключен, а запрос в контур идёт через него',
        'gateway-failed': 'Шлюз панели включён, но не поднялся',
        'endpoint-api-kind': 'У этого вида API отдельной ручки картинок нет',
        'no-agent': 'Нет ни растровой дороги, ни разговора, в котором можно попросить агента',
      },
      noRaster: {
        'no-route': 'растра нет: ни активного контура, ни профиля эндпоинта',
        'driver-none': 'растра нет: этот контур картинок не рисует',
        'no-model': 'растра нет: в каталоге ключа нет модели с генерацией картинок',
        'endpoint-no-url': 'растра нет: в профиле эндпоинта не задан адрес генерации',
        'gateway-off': 'растра нет: шлюз панели выключен',
        'gateway-failed': 'растра нет: шлюз панели не поднялся',
        'endpoint-api-kind': 'растра нет: у этого вида API ручки картинок нет',
        'no-agent': 'растра нет: рисовать некому',
      },
      card: {
        by: (model: string, source: string) => `Нарисовано: ${model} · ${source}`,
        byNoModel: (source: string) => `Нарисовано: ${source}`,
        source: {
          'contour-chat': 'контур, частью ответа',
          'contour-images': 'контур, ручка картинок',
          endpoint: 'профиль эндпоинта',
          agent: 'агент разговора',
        },
        size: (width: number, height: number, size: string) => `${width}×${height}, ${size}`,
        /** Файл живёт в панели, а не в переписке: расшифровка — файл Claude Code. */
        note: 'Файлом в панели, в переписку не попадает',
        failed: (message: string) => `Не получилось: ${message}`,
      },
    },
  },

  chats: {
    title: 'Разговоры',
    newChat: 'Новый разговор',
    search: 'Поиск по названию',
    nothing: 'Ничего не нашлось',
    sandbox: 'песочница',
    messages: (count: number) => `${count} сообщ.`,
  },

  projects: {
    toChat: 'В разговор',
    code: 'Код',
    recent: 'Недавние',
    browse: 'Обзор',
    toDisks: 'к дискам',
    openFolder: 'Открыть эту папку',
    chats: (count: number) => `${count} разгов.`,
    gone: 'папки больше нет',
  },

  git: {
    title: 'Git',
    noCommits: 'ещё нет коммитов',
    detached: 'HEAD отцеплен',
    noUpstream: 'без upstream',
    dirty: (count: number) => `изменено: ${count}`,
    clean: 'дерево чистое',
    noRemote: 'без удалённого',
    showFiles: 'Показать файлы',
    hideFiles: 'Скрыть файлы',
    truncated: '…список обрезан',
    staged: 'в индексе',
    commitMessage: 'Сообщение коммита',
    commit: 'Коммит',
    pull: 'Притянуть',
    push: 'Отправить',
    newBranch: 'Новая ветка',
    create: 'Завести',
  },

  /**
   * Копии проекта на телефоне — только чтение: почему агенту отказали, видно
   * здесь, а не в одном лишь тексте отказа.
   */
  worktrees: {
    title: 'Копии проекта',
    count: (count: number) => `${count}`,
    detached: 'HEAD отцеплен',
    ready: 'полная',
    notReady: 'неполная',
    locked: 'заперта',
    prunable: 'каталога нет',
    access: {
      ok: 'доступ есть',
      missing: 'нет записи доступа',
      unknown: 'доступ не сверялся',
    },
    gap: {
      file: (path: string) => `нет файла ${path}`,
      link: (path: string) => `не связан общий каталог ${path}`,
      access: (path: string) => `нет записи ${path} в .claude.json`,
    },
    bootstrapRunning: (command: string) => `установка идёт: ${command}`,
    bootstrapFailed: (command: string) => `установка не удалась: ${command}`,
    hint: 'Заводят и удаляют копии с компьютера. Неполную панель пробует добрать сама перед каждым запуском.',
  },

  code: {
    title: 'Код',
    projectTitle: 'Код проекта',
    noProject: 'Проект не выбран. Откройте его на вкладке «Проекты».',
    root: 'Корень проекта',
    changedHere: 'Изменено в этом разговоре',
    missing: 'нет на диске',
    unbound: (count: number) => `Не удалось привязать правок: ${count}`,
    dirFailed: 'Каталог недоступен',
    partial: 'Показан не весь каталог',
    fileFailed: 'Файл не открылся',
    readOnly: 'только чтение',
    tooBig: 'велик для сравнения',
    unmatched: (count: number) => `правок не найдено: ${count}`,
    wholeFile: 'файл перезаписан целиком',
    showFile: 'показать файл',
    showDiff: 'показать правки',
    binary: 'Двоичный файл — показывать нечего.',
  },

  tests: {
    title: 'Тесты',
    screenTitle: 'Тест-кейсы проекта',
    noProject: 'Проект не выбран. Откройте его на вкладке «Проекты».',
    where: (dir: string) => `Кейсы лежат в ${dir} самого проекта.`,
    empty: 'Тестов в этом проекте ещё нет.',
    emptyHint: 'Пусть агент осмотрит приложение и напишет первый набор.',
    emptyGroup: 'В этой группе кейсов нет.',
    broken: (error: string) => `Файл группы не разобрался: ${error}`,
    brokenHint: 'Панель его не трогает — почините файл на компьютере.',
    generate: 'Сгенерировать',
    run: 'Прогнать',
    runFull: 'Полный перетест',
    stop: 'Остановить',
    scope: 'Пожелание агенту: например, только чат',
    // Пусто — сервер возьмёт ближайший тег git: команда, которая уже ставит
    // теги, ради отчёта не делает ничего дополнительно.
    release: 'Веха: v1.4 · пусто — из тега git',
    onComputer: 'Прогон идёт на компьютере: агент поднимает приложение там же, где лежит код.',
    // Привязки к внешнему миру: на телефоне только смотрят и открывают в
    // браузере — заводят и правят их в панели, там же, где токены.
    links: {
      title: 'Связано с',
      issue: 'Задача',
      page: 'Требования',
    },
    running: 'Прогон идёт',
    generating: 'Агент пишет кейсы',
    done: 'Прогон закончен',
    stopped: 'Прогон остановлен',
    failed: (error: string) => `Прогон сорвался: ${error}`,
    log: 'Лог прогона',
    counts: (passed: number, failed: number, rest: number) =>
      `${passed} пройдено · ${failed} провалено · ${rest} осталось`,
    conventionOff: 'Из чата кейсы не ведутся',
    conventionInstall: 'Вписать соглашение в CLAUDE.md',
    conventionOn: 'Кейсы ведутся и из чата',
    addCase: 'Добавить тест',
    editCase: 'Правка теста',
    caseTitle: 'Что проверяем',
    casePurpose: 'Зачем',
    caseArea: 'Зона',
    caseSection: 'Секция',
    caseSectionHint: 'Путь внутри группы: Чат/Вложения',
    casePrecondition: 'С чего начинать',
    caseSteps: 'Шаги',
    caseExpected: 'Ожидаемый результат',
    caseOracle: 'Чем доказывается',
    caseTags: 'Метки через запятую',
    caseType: 'Тип',
    casePriority: 'Важность',
    caseAutomation: 'Автоматизация',
    stepAction: (index: number) => `Шаг ${index}`,
    stepExpected: 'Ожидание шага',
    stepAdd: 'Добавить шаг',
    stepRemove: 'Убрать',
    save: 'Сохранить',
    remove: 'Удалить',
    source: { agent: 'написан агентом', human: 'написан вами' },
    status: {
      unknown: 'не проверялся',
      running: 'проверяется',
      passed: 'пройден',
      failed: 'провален',
      skipped: 'пропущен',
      blocked: 'заблокирован',
    },
    kind: { case: 'кейс', checklist: 'чек-лист' },
    priority: { blocker: 'блокер', high: 'высокая', medium: 'средняя', low: 'низкая' },
    automation: { manual: 'руками', toAutomate: 'в автоматизацию', automated: 'автотест' },
    filter: {
      title: 'Отбор',
      any: 'любой',
      anyTag: 'любая метка',
      reset: 'Сбросить отбор',
      shown: (shown: number, total: number) => `Показано ${shown} из ${total}`,
      nothing: 'Под отбор ничего не подошло.',
    },
    lastRun: (when: string) => `Последний прогон: ${when}`,
    lastRunNever: 'Ещё не гоняли',
    // Красный кейс в карантине и просто красный — разные факты: первый уже
    // известен и никого не держит, и на телефоне это должно быть видно сразу.
    muted: 'карантин',
    muteReason: (reason: string) => `Карантин: ${reason}`,
    selected: (count: number) => `Отмечено: ${count}`,
    clearSelection: 'Снять отметки',
    runs: {
      open: 'История прогонов',
      title: 'История прогонов',
      empty: 'Прогонов ещё не было.',
      summary: (passed: number, failed: number, skipped: number, blocked: number) =>
        `${passed} пройдено · ${failed} провалено · ${skipped} пропущено · ${blocked} заблокировано`,
      mode: {
        generate: 'генерация',
        run: 'прогон агентом',
        explore: 'исследование',
        automate: 'автоматизация',
        manual: 'ручной прогон',
        import: 'импорт из CI',
      },
      actor: { agent: 'агент', human: 'человек', ci: 'CI' },
      state: {
        running: 'идёт',
        done: 'закончен',
        error: 'сорвался',
        stopped: 'остановлен',
      },
      spent: (tokens: number) => `${tokens} токенов`,
    },
    manual: {
      open: 'Пройти руками',
      openSelected: (count: number) => `Пройти руками (${count})`,
      title: 'Ручной прогон',
      none: 'Ручной прогон не начат.',
      noneHint: 'Отметьте кейсы в списке и нажмите «Пройти руками».',
      position: (index: number, total: number) => `${index} из ${total}`,
      steps: 'Шаги',
      note: 'Что увидели на самом деле',
      passed: 'Прошёл',
      failed: 'Провален',
      skipped: 'Пропустить',
      blocked: 'Заблокирован',
      prev: 'Назад',
      next: 'Дальше',
      finish: 'Закончить прогон',
      cancel: 'Бросить прогон',
      finished: 'Прогон записан в историю.',
      progress: (done: number, total: number) => `Отмечено ${done} из ${total}`,
      onDevice:
        'Проверяете вы сами, панель только записывает. Результат ложится в тот же файл, ' +
        'что и прогон агента.',
    },
  },

  analytics: {
    today: 'Сегодня',
    days: (count: number) => `${count} дней`,
    all: 'Всё время',
    from: 'с даты',
    to: 'по дату',
    reset: 'Сбросить',
    mb: 'МБ',
    estimate: 'оценка по тарифам API',
    tokens: 'Токенов',
    requests: 'Запросов',
    cached: 'Из кэша',
    activeSessions: 'Сессий сейчас',
    byDay: 'По дням',
    models: 'Модели',
    projects: 'Проекты',
    tools: 'Инструменты',
    skills: 'Навыки',
    runningNow: 'Запущено сейчас',
    recentSessions: 'Последние сессии',
    scanned: (files: number, ms: number) => `Просканировано файлов: ${files} за ${ms} мс`,
    running: ' · идёт',
    tokensShort: 'ток.',
    allProjects: 'Все проекты',
    allModels: 'Все модели',
    filters: 'Фильтры',
    nothingForFilter: 'За этот период с такими фильтрами ничего не нашлось.',
  },

  settings: {
    panel: 'Панель',
    online: 'на связи',
    offline: 'не отвечает',
    notPaired: 'Не подключено',
    pair: 'Спарить',
    repair: 'Спарить заново',
    disconnect: 'Отключить',
    language: 'Язык',
    languageRu: 'Русский',
    languageEn: 'English',
    notifications: 'Уведомления',
    notificationsAbout:
      'Приходят, когда работа закончена, упала, ждёт разрешения или агент задал вопрос. ' +
      'Уходит только вид события и имя папки проекта — ни текста, ни кода.',
    enableHere: 'Включить на этом телефоне',
    panelNotifies: 'Панель шлёт уведомления',
    testNotification: 'Проверочное уведомление',
    sentTo: (devices: number) => `Отправлено устройствам: ${devices}`,
    devices: 'Устройства',
    forget: 'отвязать',
    outside: 'Доступ снаружи',
    outsideOn: 'Включён: панель требует токен на каждом запросе.',
    outsideOff: 'Выключен: до панели дотягивается только её собственная машина.',
    serveOn: ' (serve работает)',
    serveOff: ' (serve не запущен)',
    noTailscale: 'Tailscale на машине не найден — снаружи адреса нет.',
    pushOn: 'Уведомления подключены',
    thisPhone: 'Телефон',
  },

  platform: {
    title: 'Контур',
    readOnly: 'Только чтение: ключ вводят в панели, на своей машине.',
    empty: 'Контуров нет.',
    state_ok: 'работает',
    state_off: 'не активен: работа идёт не через него',
    state_noKey: 'ключ не сохранён',
    state_failed: 'проба не прошла',
    state_unchecked: 'ещё не проверялся',
    state_exhausted: 'контур отказал по бюджету',
    budget: (spent: string, budget: string, percent: number) =>
      `Оценка расхода: $${spent} из $${budget} (${percent}%)`,
    budgetOff: (spent: string) => `Оценка расхода: $${spent}, бюджет не задан`,
    active: (title: string) => `${title} — активен`,
    smokeOk: (answer: string, model: string) =>
      `Пробный запрос прошёл: «${answer}», модель ${model}`,
    smokeFailed: (detail: string) =>
      detail ? `Пробный запрос не прошёл: ${detail}` : 'Пробный запрос не прошёл',
    estimate: 'Это оценка панели по её прайсу, а не счёт контура.',
    exhaustedAt: (at: string, keyBudget: boolean, level: string) => {
      if (keyBudget) return `Отказ ${at}: исчерпан бюджет ключа`;
      return level ? `Отказ ${at}, предел: ${level}` : `Отказ ${at}`;
    },
  },

  pair: {
    title: 'Подключение',
    screenTitle: 'Спаривание',
    fromPanel: 'Код из панели',
    where: 'Настройки → Удалённый доступ. Наведите камеру на код.',
    allowCamera: 'Разрешить камеру',
    checkingCamera: 'Проверяю доступ…',
    orManually: 'Или руками',
    address: 'https://машина.tailnet.ts.net',
    token: 'Токен доступа',
    connect: 'Подключиться',
    needAddress: 'Нужен адрес панели',
    notPanelCode: 'Это не код панели',
    saveFailed: 'Не удалось сохранить',
    secretNote:
      'Токен открывает всё API панели: он лежит в защищённом хранилище телефона и никуда больше ' +
      'не уходит. Потеряли телефон — смените токен в панели, и это устройство перестанет ходить.',
  },

  push: {
    channel: 'Прогоны агента',
    denied: 'Уведомления запрещены в системных настройках',
    noProjectId: 'Не задан projectId EAS — выполните `eas init` в apps/mobile',
    noToken: 'Сервис Expo не выдал токен',
  },

  api: {
    notConfigured: 'Панель не настроена: укажите адрес и токен',
    silent: 'Сервер панели не ответил',
    unreachable: 'Сервер панели недоступен',
    tokenRejected: 'Токен не принят — спарьте приложение заново',
  },

  // Агент панели (А8): тот же агент, что в окне панели на компьютере.
  agent: {
    title: 'Агент панели',
    subtitle:
      'Пишите или диктуйте — агент делает это в панели. Любое изменение ждёт вашего решения.',
    views: { conversation: 'Разговор', history: 'История', journal: 'След' },
    empty: 'Например: «Создай проект C:/work/demo». Страницы панели агент открывает на компьютере.',
    placeholder: 'Что сделать в панели?',
    send: 'Отправить',
    stop: 'Стоп',
    newConversation: 'Новый разговор',
    thinking: 'Агент думает…',
    context: (project: string) => `Проект: ${project}`,
    toolCalled: (name: string) => `Действие: ${name}`,
    toolFailed: (name: string) => `Действие не удалось: ${name}`,
    stopped: 'Ход остановлен.',
    runFailed: (message: string) => `Агент не ответил: ${message}`,
    cut: 'Связь оборвалась до конца хода — агент остановлен. Сказанное сохранено в истории.',
    refusal: {
      invalid_body: 'Сообщение не принято: сервер не понял запрос.',
      busy: 'В этом разговоре агент ещё отвечает — дождитесь конца хода.',
      provider_unsupported: 'Агент панели пока работает только с Claude Code: активный CLI другой.',
      cli_not_found: 'Claude Code не найден в PATH компьютера: агенту нечем работать.',
      endpoint_unsupported:
        'Ассистенту выбран свой эндпоинт: его ключ пришлось бы отдать процессу агента.',
      contour_unreachable:
        'Ассистент идёт через контур, а шлюз не поднят или нет ключа — в облако вендора молча не уходим.',
      data_mask_broken:
        'Правила маскирования данных сломаны: без маски сообщение агенту не уходит.',
    } as Record<string, string>,
    card: {
      heading: 'Агент просит подтвердить',
      dangerHeading: 'Опасное действие — проверьте внимательно',
      approve: 'Выполнить',
      reject: 'Отклонить',
      expires: (time: string) => `Ждёт до ${time}`,
      sent: 'Решение отправлено, ждём итог…',
      truncated:
        'Предпросмотр показан не целиком — одобрить нельзя. Отклоните и попросите разбить действие.',
      diff: 'Что изменится',
      truncatedRefused: 'Сервер не принял одобрение: предпросмотр неполный. Отклоните карточку.',
      alreadyDecided: 'По этой карточке уже принято решение.',
      gone: 'Карточки уже нет — её сняли или истекло время.',
      failed: (message: string) => `Решение не принято: ${message}`,
    },
    outcome: {
      done: 'выполнено',
      rejected: 'отклонено',
      timeout: 'время ожидания вышло',
      invalid: 'неверный вход',
      unknown: 'нет такого действия',
      failed: 'ошибка',
      'needs-secret': 'нужен ключ — введите его в панели на компьютере',
      cancelled: 'агент остановлен до решения',
    },
    decidedBy: {
      auto: 'без вопроса',
      human: 'решил человек',
      timeout: 'по таймауту',
      client: 'агент ушёл',
    },
    history: {
      empty: 'Разговоров пока нет',
      messages: (count: number) => `Сообщений: ${count}`,
      failed: 'Не удалось загрузить разговоры',
    },
    journal: {
      empty: 'Действий агента пока не было',
      failed: 'Не удалось загрузить след действий',
    },
    pendingBadge: (count: number) => `Ждут решения: ${count}`,
  },

  run: {
    serverUnreachable: 'Сервер недоступен',
    connectionLost: 'Связь с панелью потеряна',
    reconnecting: 'Связь прервалась, переподключаемся…',
    answered: (status: number) => `Сервер ответил ${status}`,
    finished: 'Работа закончена',
    failed: 'Прогон упал',
    homeChat: 'домашний чат',
    needToken: 'Панель требует токен: спарьте приложение заново.',
    // Отказ сервера на отправку — текст по структурному коду, а не по его сообщению.
    notSent: {
      busy:
        'Предыдущий ответ ещё генерируется — сообщение не отправлено. ' +
        'Показываю идущий ответ: прервать его можно кнопкой «Стоп».',
      files: (names: string, supported: string) =>
        `Панель не умеет передавать такие вложения: ${names}. Сообщение не отправлено. ` +
        `Допустимые расширения: ${supported}.`,
      workspaceMissing: (cwd: string) =>
        `Рабочая папка этого разговора не найдена: ${cwd}. Продолжить его можно только оттуда.`,
      copyNotReady: (cwd: string, gaps: string) =>
        `Копия ${cwd} неполная${gaps ? `: не хватает ${gaps}` : ''}. Панель попробовала добрать ` +
        'недостающее сама и не смогла: агент в такой копии работал бы не с тем окружением. ' +
        'Добрать можно в панели на компьютере — пульт git проекта, кнопка «Добрать» под копией.',
      other: (message: string) => `Сообщение не отправлено: ${message}`,
    },
  },
};

/** Форма словаря: английский обязан повторить её ключ в ключ. */
export type Dictionary = typeof ru;
