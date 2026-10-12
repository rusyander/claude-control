import { environmentLogsRu } from './logs/ru.ts';
import { environmentApiRu } from './api/ru.ts';

/** Окно «Окружение» из чата проекта — `features/ProjectEnvironment`. */
export const environmentRu = {
  open: 'Окружение',
  openHint: 'Сервисы проекта: контейнеры Docker Compose, их состояние и порты',
  title: 'Окружение проекта',
  description: 'То, без чего проект не работает: база, очереди, соседние сервисы.',
  tabsLabel: 'Разделы окружения',
  tabs: {
    logs: 'Логи',
    logsHint:
      'Вывод целей «Dev-сервера» и сервисов Docker Compose в одном месте: поиск, уровни, разбор строки агентом.',
    services: 'Сервисы',
    servicesHint:
      'Контейнеры из Docker Compose проекта. Панель ничего не хранит: состав берёт из файла, состояние — у docker.',
    database: 'База данных',
    databaseHint:
      'Только чтение: схема, запросы, планы и миграции. Записать в базу отсюда нельзя — ни человеку, ни агенту.',
    api: 'API',
    apiHint:
      'Эндпоинты из контракта OpenAPI или коллекции Postman: запрос через сервер панели и сверка ответа со схемой.',
    guard: 'Защита',
    guardHint:
      'Перед командой, которую не отменить, агент остановится и спросит вас: снос таблиц, откат миграций, инфраструктура, тома с данными, прод.',
  },
  docker: {
    missingTitle: 'Docker не установлен',
    missingText:
      'Программы docker нет в PATH сервера панели. Установите Docker Desktop (Windows, macOS) или Docker Engine с плагином compose (Linux) и перезапустите панель.',
    stoppedTitle: 'Docker не запущен',
    stoppedText:
      'Программа docker есть, но её служба не отвечает. Запустите Docker Desktop или службу docker — окно обновится само.',
    detail: 'Что ответил docker',
  },
  file: {
    missingTitle: 'В проекте нет Docker Compose',
    missingText:
      'Панель ищет compose.yaml, compose.yml, docker-compose.yaml и docker-compose.yml в корне проекта и в папках docker/, deploy/, .docker/.',
    configErrorTitle: 'Docker не принял {{file}}',
    configErrorText:
      'Пока файл не исправлен, ни поднять, ни показать сервисы нельзя. Ниже — ответ docker дословно: в нём строка и ключ, на которых он споткнулся.',
    label: 'Файл',
    withOverride: 'вместе с {{file}}',
    project: 'Проект compose',
    projectHint:
      'По этому имени docker узнаёт контейнеры стека — то же, что видит docker compose ps в терминале.',
  },
  stack: {
    label: 'Весь стек',
    up: 'Поднять всё',
    stop: 'Остановить всё',
    restart: 'Перезапустить всё',
    empty: 'В файле нет ни одного сервиса.',
  },
  table: {
    caption: 'Сервисы стека в порядке подъёма: зависимости выше зависящих',
    service: 'Сервис',
    image: 'Образ',
    state: 'Состояние',
    ports: 'Порты',
    actions: 'Действия',
    build: 'собирается из исходников',
    dependsOn: 'после {{names}}',
    noPorts: 'наружу не открыт',
    portTitle: 'Порт {{published}} на этой машине ведёт в порт {{target}} контейнера',
  },
  state: {
    running: 'Работает',
    healthy: 'Работает, здоров',
    starting: 'Запускается',
    unhealthy: 'Работает, проверка здоровья не проходит',
    stopped: 'Остановлен',
    crashed: 'Упал, код {{code}}',
    created: 'Создан, не запущен',
    restarting: 'Перезапускается',
    paused: 'На паузе',
    dead: 'Сломан',
    absent: 'Не создан',
  },
  row: {
    up: 'Поднять {{name}}',
    stop: 'Остановить {{name}}',
    restart: 'Перезапустить {{name}}',
  },
  job: {
    running: 'Идёт: {{action}}',
    done: 'Готово: {{action}}',
    failed: 'Не получилось: {{action}}',
    failedHint: 'Причина — в последних строках вывода docker ниже.',
    output: 'Вывод docker compose',
    empty: 'docker пока ничего не напечатал',
    actions: {
      up: 'поднять всё',
      stop: 'остановить всё',
      restart: 'перезапустить всё',
      down: 'удалить контейнеры',
      'down-volumes': 'удалить контейнеры вместе с данными',
    },
    serviceActions: {
      up: 'поднять {{name}}',
      stop: 'остановить {{name}}',
      restart: 'перезапустить {{name}}',
      down: 'удалить контейнеры',
      'down-volumes': 'удалить контейнеры вместе с данными',
    },
  },
  danger: {
    title: 'Удаление',
    text: 'Контейнеры создаются заново следующим «Поднять всё». Данные в именованных томах переживают обычное удаление и пропадают только вместе с томами.',
    down: 'Удалить контейнеры',
    downVolumes: 'Удалить вместе с данными',
    noVolumes: 'Именованных томов в файле нет — удалять с данными нечего.',
    confirmTitle: 'Удалить контейнеры и тома?',
    confirmText:
      'docker compose down -v удалит контейнеры стека и тома: {{volumes}}. Всё, что лежит в них — базы, загрузки, кэши, — пропадёт без возврата.',
    confirmLabel: 'Удалить с данными',
  },
  errors: {
    busy: 'Над стеком уже идёт действие — дождитесь его конца.',
    unregistered:
      'Контейнеры панель поднимает только у проектов из раздела «Проекты», каталогов внутри них и копий их веток.',
    fileMissing: 'Файл Compose пропал — окно обновится и покажет, что нашлось.',
    serviceUnknown: 'Такого сервиса в файле больше нет — список обновится.',
    generic: 'Действие не принято: {{message}}',
  },
  database: {
    connection: 'Подключение',
    sources: {
      compose: 'Compose',
      env: '.env',
      spring: 'Spring',
      manual: 'Своё',
    },
    origin: 'Откуда: {{origin}}',
    originManual: 'Заведено в панели',
    remote: 'Не локальная база',
    remoteHint:
      'Адрес не на этой машине — это может быть общий стенд или боевая база. Запросы только читают, но тяжёлый запрос нагружает и её. Для боевой базы заведите отдельную роль только на чтение.',
    noPassword: 'Пароль не найден',
    noPasswordHint:
      'В файлах проекта пароля нет. Если база его требует, заведите своё подключение с паролем.',
    composeDown: 'Сервис {{service}} сейчас: {{state}} — подключаться не к чему.',
    toServices: 'Поднять на вкладке «Сервисы»',
    add: 'Своё подключение',
    edit: 'Изменить',
    remove: 'Убрать',
    removeTitle: 'Убрать подключение «{{label}}»?',
    removeText:
      'Панель забудет адрес и пароль. Сама база не меняется. Найденные в файлах проекта подключения так не убираются — их правят в самом файле.',
    form: {
      titleNew: 'Своё подключение к Postgres',
      titleEdit: 'Изменить «{{label}}»',
      label: 'Название',
      labelHint: 'Как подключение будет называться в списке: «Стенд», «Отчёты».',
      host: 'Адрес',
      port: 'Порт',
      database: 'База',
      user: 'Пользователь',
      password: 'Пароль',
      passwordHint: 'Хранится в панели зашифрованным и наружу не отдаётся — ни окну, ни агенту.',
      passwordKeep: 'Пусто — оставить прежний пароль.',
      save: 'Сохранить',
      cancel: 'Отмена',
      required: 'Заполните поле',
      portInvalid: 'Порт — целое число от 1 до 65535',
    },
    unsupportedTitle: 'Найдены, но не читаются',
    unsupportedEngine: '{{origin}} — {{engine}}: панель пока читает только Postgres.',
    unsupportedNoPort:
      '{{origin}} — Postgres без опубликованного порта. Добавьте сервису ports: ["5432:5432"], чтобы до базы можно было достучаться с этой машины.',
    empty: {
      title: 'Базы не найдено',
      text: 'Панель искала Postgres в Docker Compose, в файлах .env (DATABASE_URL, PG*, DB_*) и в настройках Spring. Если база живёт в другом месте — заведите своё подключение.',
    },
    agent: {
      title: 'Доступ агента',
      text: 'Панель запишет свой переходник MCP в конфигурацию CLI: агент получит схему, запросы чтения, планы и миграции — с теми же ограничениями, что здесь. Адрес и пароль базы агенту не передаются.',
      toggle: 'Дать агенту читать базу проекта',
      on: 'Агент видит базу',
      off: 'Агент базу не видит',
      restart: 'Подхватится в следующем запуске CLI.',
    },
    schema: {
      title: 'Схема',
      filter: 'Найти таблицу или колонку',
      version: 'Postgres {{version}}',
      tables_one: '{{count}} таблица',
      tables_few: '{{count}} таблицы',
      tables_many: '{{count}} таблиц',
      truncated: 'Показаны первые 500 таблиц — найдите нужную поиском.',
      empty: 'В базе нет ни одной таблицы.',
      noMatch: 'Ничего не нашлось',
      rows: '≈ {{count}} строк',
      insert: 'Подставить запрос к {{name}}',
      refresh: 'Обновить схему',
      pk: 'первичный ключ',
      kinds: {
        table: 'таблица',
        view: 'представление',
        'materialized-view': 'материализованное представление',
        'partitioned-table': 'секционированная таблица',
        'foreign-table': 'внешняя таблица',
      },
    },
    editor: {
      label: 'Запрос SQL',
      placeholder: 'SELECT * FROM users LIMIT 100',
      run: 'Выполнить',
      runShortcut: 'Ctrl+Enter',
      explain: 'План',
      explainAnalyze: 'План с выполнением',
      explainAnalyzeHint:
        'EXPLAIN ANALYZE выполняет запрос по-настоящему и меряет время — в транзакции только для чтения.',
      limits: 'Только чтение · один оператор · до 500 строк · 15 секунд',
      running: 'Выполняется…',
    },
    result: {
      caption: 'Результат запроса',
      summary_one: '{{count}} строка за {{ms}} мс',
      summary_few: '{{count}} строки за {{ms}} мс',
      summary_many: '{{count}} строк за {{ms}} мс',
      truncated: 'Показаны первые {{count}} строк — уточните условие или добавьте LIMIT.',
      empty: 'Запрос не вернул строк.',
      plan: 'План выполнения',
      planTime: 'План получен за {{ms}} мс',
    },
    refused: {
      title: 'Запрос не отправлен',
      empty: 'Запрос пуст.',
      multiple: 'Только один оператор за раз — уберите лишнюю «;» или разбейте запрос.',
      'not-read':
        'Запрос начинается с «{{word}}». Здесь можно только читать: SELECT, WITH, EXPLAIN, SHOW, TABLE, VALUES.',
      'denied-word':
        'В запросе есть «{{word}}» — это изменение данных. Здесь только чтение; если это имя колонки, возьмите его в кавычки.',
      'denied-function':
        'Функция {{name}} действует за пределами запроса (сеансы, файлы, настройки сервера) и запрещена.',
      'unicode-escape': 'Имена в виде U&"…" не пропускаются — напишите имя обычным текстом.',
      unterminated: 'Незакрытая строка или комментарий.',
    },
    errors: {
      connect: 'База не отвечает: {{message}}',
      connectHint: 'Проверьте, что она запущена и адрес верный.',
      auth: 'База не приняла логин или пароль.',
      authHint: 'Заведите своё подключение с верным паролем.',
      'database-missing': 'Такой базы на сервере нет: {{message}}',
      timeout: 'Запрос не уложился в 15 секунд и остановлен.',
      timeoutHint: 'Сузьте выборку или добавьте LIMIT; план покажет, что медленно.',
      'read-only': 'Postgres отказал: запрос пытался писать — {{message}}',
      permission: 'Нет прав: {{message}}',
      query: 'Ошибка в запросе: {{message}}',
      position: 'Позиция {{position}}, строка {{line}}',
      unregistered:
        'С базой панель работает только у проектов из раздела «Проекты», каталогов внутри них и копий их веток.',
      unknown: 'Этого подключения больше нет — список обновлён.',
      notManual: 'Найденное в файлах проекта подключение правят в самом файле.',
      mcp: 'Не получилось: {{message}}',
      generic: 'Не получилось: {{message}}',
    },
    migrations: {
      title: 'Миграции',
      none: 'Миграций в проекте не найдено.',
      where: '{{tool}} · {{dir}} · учёт в {{table}}',
      pending_one: '{{count}} не применена',
      pending_few: '{{count}} не применены',
      pending_many: '{{count}} не применено',
      allApplied: 'Все применены',
      neverRun: 'Таблицы {{table}} в базе нет — миграции к ней ещё не применялись.',
      dirty:
        'Прошлая миграция упала посередине (dirty). Пока это не исправлено, инструмент миграций дальше не пойдёт.',
      orphaned:
        'Записаны в базе, но файла в проекте нет: {{ids}}. Ветку переключили или файл удалили.',
      readError: 'Состояние в базе не прочитано: {{message}}',
      filesOnly: 'Подключения нет — видны только файлы проекта.',
      applied: 'применена',
      notApplied: 'не применена',
      readOnly: 'Панель миграций не применяет и не откатывает — это делает инструмент проекта.',
    },
  },
  guard: {
    title: 'Защита бэкенда',
    state: {
      none: 'Не стоит',
      installed: 'Включена',
      partial: 'Частично',
    },
    noneText:
      'Хук Claude Code в .claude/ проекта: узнал команду из списка ниже — агент останавливается и спрашивает вас, в терминале и в чате панели. Остальная работа идёт как шла.',
    installedText:
      'Агент спросит вас перед каждой командой из включённых правил. В чате панели автоподтверждение такие команды не пропускает.',
    partialText:
      'Части файлов нет или их правили руками — защита может молчать. «Восстановить» положит файлы заново, настройки останутся.',
    group: 'Группа панели: {{name}}',
    filesTitle: 'Файлы в проекте',
    parts: {
      script: 'Скрипт хука',
      hook: 'Запись в settings.json',
      rule: 'Правило для агента',
      config: 'Настройки защиты',
    },
    partState: {
      ok: 'на месте',
      missing: 'нет',
      changed: 'изменён',
    },
    claudeOnly:
      'Хук и правило читает только Claude Code. Codex, Gemini и другие CLI их не видят — в их чатах защита не спросит.',
    shareHint:
      'Файлы лежат в проекте: закоммитьте их — и защита будет у всех, кто работает с репозиторием.',
    rulesTitle: 'Что спрашивает',
    rulesHint: 'Выключенное правило молчит, остальные спрашивают.',
    ruleToggle: 'Спрашивать: {{rule}}',
    rules: {
      'prod-target': {
        title: 'Обращение к проду',
        text: 'Любая команда с меткой прода из списка справа — даже если только читает.',
      },
      'sql-drop': {
        title: 'Снос таблицы, базы или схемы',
        text: 'DROP TABLE, DROP DATABASE, ALTER … DROP COLUMN, dropdb, FLUSHALL.',
      },
      'sql-truncate': {
        title: 'Очистка таблицы',
        text: 'TRUNCATE.',
      },
      'sql-unbounded': {
        title: 'DELETE и UPDATE без WHERE',
        text: 'Изменение всех строк таблицы разом.',
      },
      'migration-down': {
        title: 'Откат и сброс миграций',
        text: 'migrate down, alembic downgrade, rails db:rollback, prisma migrate reset, flyway clean, artisan migrate:fresh.',
      },
      'infra-change': {
        title: 'Изменение инфраструктуры',
        text: 'terraform apply и destroy, kubectl delete, apply и exec, helm upgrade и uninstall, удаление ресурсов в aws и gcloud.',
      },
      'volume-delete': {
        title: 'Удаление томов Docker',
        text: 'docker volume rm и prune, compose down -v, system prune --volumes.',
      },
    },
    prod: {
      title: 'Прод',
      label: 'Метки прода',
      hint: 'Адрес, IP или имя контекста kubectl — по одному в строке. Команда с любым из них спросит.',
      placeholder: 'db.prod.internal\n10.0.5.12\nprod-cluster',
      tooShort:
        'Короче трёх знаков: {{markers}}. Такая метка совпадала бы почти с каждой командой.',
    },
    check: {
      title: 'Проверить команду',
      label: 'Команда',
      hint: 'По настройкам на экране, даже несохранённым.',
      placeholder: 'psql -h db.prod.internal -c "drop table orders"',
      button: 'Проверить',
      asks: 'Спросит — {{reason}}: {{match}}',
      passes: 'Пройдёт без вопроса защиты.',
    },
    actions: {
      install: 'Поставить защиту',
      restore: 'Восстановить',
      save: 'Сохранить настройки',
      revert: 'Отменить правки',
      saved: 'Настройки сохранены.',
      installed: 'Защита стоит. Новые чаты Claude в этом проекте её уже видят.',
      dirty: 'Есть несохранённые правки.',
      removed: 'Защита снята. Файлы — в резервных копиях панели.',
    },
    remove: {
      title: 'Снять защиту',
      text: 'Хук и правило уйдут из .claude/ проекта (копии — в резервных), группа панели удалится. Агент перестанет спрашивать перед такими командами.',
      button: 'Снять защиту',
      confirmTitle: 'Снять защиту бэкенда?',
      confirmText:
        'Из .claude/ проекта уйдут скрипт хука, правило и настройки, запись в settings.json будет убрана, группа «{{group}}» удалится. Копии файлов останутся в резервных.',
      confirmLabel: 'Снять',
    },
    errors: {
      unregistered:
        'Защиту панель ставит только в проекты из раздела «Проекты», каталоги внутри них и копии их веток.',
      notInstalled: 'Защиты в проекте уже нет — окно обновлено.',
      generic: 'Не получилось: {{message}}',
    },
  },
  api: environmentApiRu,
  logs: environmentLogsRu,
};
