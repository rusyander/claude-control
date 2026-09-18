import { isWindows } from './HookProbe.constants.ts';
import type { EventFixture } from './HookProbe.types.ts';
import { serverText } from '../../lib/server-texts.ts';

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
    title: serverText('sandbox-event-bash-safe-title'),
    description: serverText('sandbox-event-bash-safe-description'),
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
    title: serverText('sandbox-event-bash-destructive-title'),
    description: serverText('sandbox-event-bash-destructive-description'),
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
    title: serverText('sandbox-event-git-push-title'),
    description: serverText('sandbox-event-git-push-description'),
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
    title: serverText('sandbox-event-write-secret-title'),
    description: serverText('sandbox-event-write-secret-description'),
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
    title: serverText('sandbox-event-write-placeholder-title'),
    description: serverText('sandbox-event-write-placeholder-description'),
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
    title: serverText('sandbox-event-write-plain-title'),
    description: serverText('sandbox-event-write-plain-description'),
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
    title: serverText('sandbox-event-prompt-figma-title'),
    description: serverText('sandbox-event-prompt-figma-description'),
    expectsBlock: false,
    payload: {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Свёрстай по макету https://www.figma.com/design/abc/Example',
    },
  },
  {
    id: 'session-start',
    event: 'SessionStart',
    title: serverText('sandbox-event-session-start-title'),
    description: serverText('sandbox-event-session-start-description'),
    expectsBlock: false,
    payload: { hook_event_name: 'SessionStart', source: 'startup' },
  },
  {
    id: 'stop',
    event: 'Stop',
    title: serverText('sandbox-event-stop-title'),
    description: serverText('sandbox-event-stop-description'),
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
    return { ok: false, error: serverText('sandbox-event-bad-json') };
  }

  if (!isEventObject(parsed)) {
    return {
      ok: false,
      error: serverText('sandbox-event-not-object'),
    };
  }

  return { ok: true, payload: parsed };
}
