import type { ProjectTestStatus } from '@agentdeck/contracts';
import type { HotkeyBinding } from '@shared/lib/hotkeys';

/**
 * Вердикты прохода в том порядке, в каком они стоят на экране.
 *
 * Список ОДИН на кнопки и на клавиши: клавиша — это номер кнопки в ряду, и
 * разойдись они, подпись «1 — пройден» врала бы ровно там, где по ней и
 * жмут не глядя.
 */
export const RUNNER_VERDICTS: readonly ProjectTestStatus[] = [
  'passed',
  'failed',
  'skipped',
  'blocked',
];

/** Что умеет клавиатура ручного прохода. */
export interface RunnerHotkeyActions {
  submit: (status: ProjectTestStatus) => void;
  prev: () => void;
  next: () => void;
  /** Перевести курсор в заметку «что получилось». */
  focusNote: () => void;
  /** Открыть выбор файла для доказательства. */
  attach: () => void;
}

/** Клавиша заметки и клавиша снимка — сразу за вердиктами. */
export const RUNNER_NOTE_KEY = String(RUNNER_VERDICTS.length + 1);
export const RUNNER_ATTACH_KEY = String(RUNNER_VERDICTS.length + 2);

/**
 * Клавиши ручного прохода.
 *
 * Цифры, а не буквы, намеренно: `event.key` приходит из РАСКЛАДКИ, и на
 * русской «p» превращается в «з» — буквенные подписи на экране перестали бы
 * соответствовать тому, что срабатывает. Цифровой ряд одинаков в любой
 * раскладке, а порядок цифр совпадает с порядком кнопок под ними.
 *
 * Ни одна привязка не помечена `allowInInput`: в заметке и в полях шагов
 * клавиши обязаны молчать — иначе набранное «1» закрыло бы проход.
 *
 * Пустой список, когда прохода нет: подписка на окно живёт одна на всё
 * приложение, и висящие привязки закрытого окна отбирали бы цифры у страницы
 * за ним.
 */
export function runnerBindings(actions: RunnerHotkeyActions, isEnabled: boolean): HotkeyBinding[] {
  if (!isEnabled) return [];

  return [
    ...RUNNER_VERDICTS.map((verdict, index) => ({
      chord: String(index + 1),
      handler: () => actions.submit(verdict),
    })),
    { chord: RUNNER_NOTE_KEY, handler: actions.focusNote },
    { chord: RUNNER_ATTACH_KEY, handler: actions.attach },
    { chord: 'arrowleft', handler: actions.prev },
    { chord: 'arrowright', handler: actions.next },
  ];
}
