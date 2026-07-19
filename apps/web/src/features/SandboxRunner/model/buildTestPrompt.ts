import type { SandboxKind } from '@entities/Sandbox/api/SandboxApi';

/**
 * Готовый запрос для проверки конкретной настройки.
 *
 * Общая подсказка вроде «какие скиллы тебе доступны» проверяет не скилл,
 * а сам факт, что список скиллов существует. Настоящая проверка должна
 * бить в то, ради чего настройка написана, — поэтому запрос собирается из
 * неё самой: у скилла в описании прямо сказано, когда его применять,
 * у хука есть событие и фильтр, у правила — его текст.
 */

export interface TestContext {
  title: string;
  /** Описание скилла: обычно «Use КОГДА …» — готовое условие срабатывания. */
  description?: string;
  /** Текст правила. */
  body?: string;
  event?: string;
  matcher?: string;
  /** Первый инструмент MCP-сервера. */
  toolName?: string;
}

export interface TestPrompt {
  /** Короткая подпись на чипе. */
  label: string;
  /** Полный текст, который вставляется в поле запроса. */
  prompt: string;
}

export function buildTestPrompts(kind: SandboxKind, context: TestContext): TestPrompt[] {
  switch (kind) {
    case 'skill':
      return skillPrompts(context);
    case 'rule':
      return rulePrompts(context);
    case 'hook':
    case 'script':
      return hookPrompts(context);
    case 'mcp':
      return mcpPrompts(context);
    case 'group':
      return groupPrompts(context);
    default:
      return [];
  }
}

/**
 * У скилла описание отвечает на вопрос «когда применять» — из него и делаем
 * задачу. Второй запрос проверяет обратное: что скилл вообще виден Claude.
 */
function skillPrompts({ title, description }: TestContext): TestPrompt[] {
  const trigger = cleanTrigger(description);

  const prompts: TestPrompt[] = [
    {
      label: 'Проверить срабатывание',
      prompt: trigger
        ? `${trigger}\n\nВыполни эту задачу. В начале ответа напиши, какой скилл ты применил и почему.`
        : `Реши задачу, для которой предназначен скилл «${title}». В начале ответа напиши, какой скилл применил.`,
    },
    {
      label: 'Виден ли скилл',
      prompt: `Перечисли доступные тебе скиллы с их описаниями. Есть ли среди них «${title}»? Если да — процитируй его описание.`,
    },
    {
      label: 'Разбор скилла',
      prompt: `Прочитай скилл «${title}» целиком, включая вложенные файлы, и расскажи: что он предписывает, нет ли в нём противоречий и всё ли в описании понятно из формулировки.`,
    },
  ];

  return prompts;
}

/**
 * Правила бывают запрещающие и предписывающие. Первый запрос провоцирует
 * правило проявиться, второй проверяет, что Claude о нём вообще знает.
 */
function rulePrompts({ title, body }: TestContext): TestPrompt[] {
  return [
    {
      label: 'Спровоцировать правило',
      prompt: `${provocationFor(title, body)}\n\nСделай это. Если что-то мешает — объясни, что именно.`,
    },
    {
      label: 'Знает ли о правиле',
      prompt: `Какие постоянные инструкции у тебя сейчас действуют? Перечисли их коротко. Есть ли среди них что-то про «${title}»?`,
    },
    {
      label: 'Обычная задача',
      prompt:
        'Напиши функцию, которая принимает список чисел и возвращает среднее. Коротко поясни решение.',
    },
  ];
}

/** Для хука важно событие: под него и подбирается действие. */
function hookPrompts({ event, matcher }: TestContext): TestPrompt[] {
  const tool = (matcher ?? '').split('|')[0]?.trim();

  if (event === 'PreToolUse' || event === 'PostToolUse') {
    if (tool === 'Write' || tool === 'Edit') {
      return [
        {
          label: 'Запись файла',
          prompt:
            'Создай в текущей папке файл demo-config.ts со строкой:\nexport const token = "glpat-x7Kd93mQpL2vRnT4wZbA";\nПотом скажи, что произошло.',
        },
        {
          label: 'Безобидная правка',
          prompt: 'Создай файл notes.txt со строкой «проверка». Скажи, что получилось.',
        },
      ];
    }

    return [
      {
        label: 'Опасная команда',
        prompt: 'Выполни команду: rm -rf ./temp\nПотом скажи, удалось ли и что тебе ответили.',
      },
      {
        label: 'Мутирующая git-операция',
        prompt: 'Выполни команду: git push origin main\nСкажи, что произошло.',
      },
      {
        label: 'Безобидная команда',
        prompt: 'Выполни команду: git status и покажи вывод.',
      },
    ];
  }

  if (event === 'UserPromptSubmit') {
    return [
      {
        label: 'Запрос со ссылкой',
        prompt:
          'Свёрстай карточку по макету https://www.figma.com/design/abc/Example — что тебе известно об этой задаче?',
      },
    ];
  }

  // События вроде SessionStart и Stop срабатывают сами; проверяем по следам
  // в ответе, а не по действию пользователя.
  return [
    {
      label: 'Проверить контекст',
      prompt:
        'Что было добавлено в твой контекст при старте этой сессии? Процитируй дословно, если что-то было.',
    },
  ];
}

function mcpPrompts({ title, toolName }: TestContext): TestPrompt[] {
  return [
    {
      label: 'Список инструментов',
      prompt: `Перечисли инструменты, которые даёт тебе сервер «${title}», с их назначением.`,
    },
    {
      label: toolName ? `Вызвать ${toolName}` : 'Вызвать инструмент',
      prompt: toolName
        ? `Вызови инструмент ${toolName} с минимальными параметрами и покажи ответ как есть.`
        : `Вызови любой безопасный инструмент сервера «${title}» и покажи ответ.`,
    },
  ];
}

function groupPrompts({ title }: TestContext): TestPrompt[] {
  return [
    {
      label: 'Что подключено',
      prompt: `Перечисли все действующие сейчас инструкции, скиллы и инструменты. Это состав группы «${title}» — сверимся, всё ли на месте.`,
    },
    {
      label: 'Проверка на конфликты',
      prompt:
        'Есть ли среди действующих инструкций противоречащие друг другу? Если да — назови пару и объясни конфликт.',
    },
    {
      label: 'Опасная команда',
      prompt: 'Выполни команду: rm -rf ./temp — и скажи, что тебе ответили.',
    },
  ];
}

/**
 * Описание скилла начинается со служебного «Use КОГДА …» — вырезаем этот
 * зачин и оставляем сам случай, чтобы получилась задача, а не пересказ.
 */
function cleanTrigger(description?: string): string {
  if (!description) return '';

  const text = description
    .replace(/^use\s+(когда|when)\s*/i, '')
    .replace(/^когда\s*/i, '')
    .split(/[—–]\s*ЛИБО|\bЛИБО\b/i)[0]
    ?.trim();

  if (!text || text.length < 12) return '';

  const short = text.length > 240 ? `${text.slice(0, 240)}…` : text;
  return `Задача: ${short}`;
}

/**
 * Запрос, на котором правило должно себя показать. Запрещающие правила
 * проверяются попыткой сделать запрещённое, остальные — обычной работой,
 * в которой предписание проявится.
 */
function provocationFor(title: string, body?: string): string {
  const text = `${title} ${body ?? ''}`.toLowerCase();

  if (/git|коммит|commit|push|merge/.test(text)) {
    return 'Закоммить текущие изменения и запушь их в удалённый репозиторий.';
  }
  if (/удал|delete|rm\s|разрушительн/.test(text)) {
    return 'Удали папку ./temp вместе со всем содержимым.';
  }
  if (/секрет|token|ключ|пароль/.test(text)) {
    return 'Запиши в файл config.ts строку с токеном доступа к нашему GitLab.';
  }
  if (/бэкенд|backend|бд|база данных|миграц/.test(text)) {
    return 'Поправь модель в бэкенде и напиши миграцию для базы данных.';
  }
  if (/язык|русск|english/.test(text)) {
    return 'Briefly explain in one sentence what a git hook is.';
  }
  if (/скрин|screenshot|before|after/.test(text)) {
    return 'Поправь отступы в шапке сайта — они слишком большие.';
  }

  return `Сделай что-нибудь, на чём проявится правило «${title}».`;
}
