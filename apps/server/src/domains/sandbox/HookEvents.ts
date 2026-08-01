import { isWindows } from './HookProbe.constants.ts';
import type { EventFixture } from './HookProbe.types.ts';

/**
 * Путь в примере события — в стиле той системы, где панель запущена.
 *
 * Раньше во всех заготовках стоял `C:/work/...`: на Linux и macOS такой путь
 * выглядит чужеродно, а хук-страж, который смотрит на пути, может на него и
 * не сработать — тогда прогон покажет не то, что покажет в бою.
 */
function demoPath(name: string): string {
  return isWindows ? `C:/work/demo/${name}` : `/home/user/demo/${name}`;
}

/**
 * Приманка для стража секретов, собранная из кусков.
 *
 * Записанная целиком, она валидна с виду и поднимает тревогу у secret scanning
 * на GitHub. Токен выдуман и никуда не ведёт, но объясняться с каждой такой
 * тревогой — лишняя работа.
 */
const FAKE_TOKEN = ['glpat', 'x7Kd93mQpL2vRnT4wZbA'].join('-');

export const EVENT_FIXTURES: EventFixture[] = [
  {
    id: 'bash-safe',
    event: 'PreToolUse',
    title: 'Безобидная команда',
    description: 'Обычный вызов Bash — страж не должен вмешиваться.',
    expectsBlock: false,
    payload: {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status', description: 'Показать статус' },
    },
  },
  {
    id: 'bash-destructive',
    event: 'PreToolUse',
    title: 'Рекурсивное удаление',
    description: 'Опасная команда — страж разрушительных операций должен остановить.',
    expectsBlock: true,
    payload: {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /c/work/project', description: 'Удалить папку' },
    },
  },
  {
    id: 'bash-git-push',
    event: 'PreToolUse',
    title: 'Мутирующая операция git',
    description: 'Пуш в удалённый репозиторий — по правилам агент этого делать не должен.',
    expectsBlock: true,
    payload: {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main', description: 'Отправить изменения' },
    },
  },
  {
    id: 'write-secret',
    event: 'PreToolUse',
    title: 'Запись секрета в файл',
    description: 'В содержимом похожий на токен ключ — страж секретов должен вмешаться.',
    expectsBlock: true,
    payload: {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: {
        // Строка намеренно не содержит слов вроде «example» и «test»: стражи
        // секретов считают их заготовками и пропускают — а нам нужно, чтобы
        // проверка выглядела как настоящий ключ.
        //
        // И ровно поэтому она собирается из кусков: целиком записанный
        // `glpat-…` — валидная с виду приманка, на которую реагирует secret
        // scanning на GitHub. Утечки здесь нет (токен выдуман), но разбираться
        // с ложной тревогой в каждом форке никому не нужно.
        file_path: demoPath('config.ts'),
        content: `export const gitlabToken = "${FAKE_TOKEN}";`,
      },
    },
  },
  {
    id: 'write-placeholder',
    event: 'PreToolUse',
    title: 'Ключ-заготовка в примере',
    description: 'Значение-плейсхолдер в .env.example — страж не должен мешать.',
    expectsBlock: false,
    payload: {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: {
        file_path: demoPath('.env.example'),
        content: 'GITLAB_TOKEN=your-token-here',
      },
    },
  },
  {
    id: 'write-plain',
    event: 'PostToolUse',
    title: 'Обычная правка файла',
    description: 'Правка исходника — сюда обычно вешают автоформатирование.',
    expectsBlock: false,
    payload: {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: demoPath('index.ts') },
      tool_response: { success: true },
    },
  },
  {
    id: 'prompt-figma',
    event: 'UserPromptSubmit',
    title: 'Запрос со ссылкой на Figma',
    description: 'Подсказки на ввод пользователя срабатывают здесь.',
    expectsBlock: false,
    payload: {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Свёрстай по макету https://www.figma.com/design/abc/Example',
    },
  },
  {
    id: 'session-start',
    event: 'SessionStart',
    title: 'Начало сессии',
    description: 'Брифинги и напоминания при старте.',
    expectsBlock: false,
    payload: { hook_event_name: 'SessionStart', source: 'startup' },
  },
  {
    id: 'stop',
    event: 'Stop',
    title: 'Конец ответа',
    description: 'Проверки, которые запускаются после ответа модели.',
    expectsBlock: false,
    payload: { hook_event_name: 'Stop', stop_hook_active: false },
  },
];

/**
 * Пользовательское событие — это должен быть JSON-объект, а не массив, строка
 * или число: хук Claude Code всегда получает на вход объект вида
 * `{"hook_event_name": "…", …}`. Экспортируется ради тестов.
 */
export function isEventObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Разбор и проверка произвольного события, введённого руками. Кривой JSON и
 * не-объект получают внятную причину отказа, а не молчаливый провал прогона.
 * Экспортируется ради тестов.
 */
export function parseCustomEvent(
  raw: string,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Не удалось разобрать JSON: проверьте синтаксис события.' };
  }

  if (!isEventObject(parsed)) {
    return {
      ok: false,
      error: 'Событие должно быть JSON-объектом вида {"hook_event_name": "…"}.',
    };
  }

  return { ok: true, payload: parsed };
}
