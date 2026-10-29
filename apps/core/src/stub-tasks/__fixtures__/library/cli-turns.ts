import type { StubTask } from '../stub-tasks.types.ts';
import { BASE_REPO } from './happy-path.ts';

/**
 * Ход, начатый самим CLI (F06, P48): модель запускает фоновую команду и заканчивает ход; команда
 * завершается, CLI будит модель уведомлением БЕЗ нашей отправки. Ядро обязано записать
 * `turn.cli-initiated` (причина `background-wake` / `notification`) и не приписать этот ход ни
 * одной своей отправке. Фоновая команда — тем инструментом, чей конец будит CLI (`script.ts`
 * `TOOL_VOCABULARY.wake`: Qwen — монитор, Claude — фоновая `Bash`).
 * Судит переходник (нормализатор потока), проверяет сквозной прогон части 2;
 * отдельной пробы фазы 2 нет — кадры сочинять руками значит проверять свои кадры.
 */
export const CLI_INITIATED_TURN: StubTask = {
  id: 'cli-initiated-turn',
  summary: 'background command wakes the CLI after the turn → turn.cli-initiated, no core send',
  adversarial: true,
  input: {
    title: 'Run the slow probe',
    request: 'Start the slow probe in the background and report when it finishes.',
    repo: BASE_REPO,
    stepKind: 'work',
    requirements: [{ id: 'r1', text: 'the probe finished and was reported' }],
  },
  moves: [
    { op: 'shell', argv: ['sleep', '2'], background: true },
    { op: 'text', text: 'The probe is running in the background.' },
    // Сюда приходит запрос пробуждения CLI: в истории уже два ответа модели.
    { op: 'text', text: 'The probe finished.' },
  ],
  dialects: ['anthropic-messages', 'openai-chat', 'openai-responses'],
  verdicts: [
    {
      property: 'P48',
      phase: 2,
      judge: { kind: 'adapter-event', event: 'turn.cli-initiated' },
      expect:
        'the wake turn journals turn.cli-initiated; no session.message sent by the core for it',
      journal: { present: ['turn.cli-initiated'] },
    },
    {
      property: 'P16',
      phase: 4,
      judge: { kind: 'decision', class: 'next' },
      expect: 'a CLI-initiated turn end is not a step end: no reminder fires on it',
    },
  ],
  observer: { signals: [] },
  phase2: [],
};
