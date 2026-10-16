import type { PowerAction, PowerUnavailableReason } from '@agentdeck/contracts';

/**
 * Несколько компьютеров и их питание. Отдельным модулем, как главная и проекты:
 * словарь общий, а правят его одновременно несколько разделов.
 */

const OS: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

const ACTION: Record<PowerAction, string> = { hibernate: 'гибернацию', sleep: 'сон' };

export const computersRu = {
  title: 'Компьютеры',
  about:
    'Телефон спаривается с каждым компьютером по коду из его панели. Выбранный — тот, чьи ' +
    'проекты, чаты и вопросы вы видите и куда уходит работа.',
  current: 'выбран',
  add: 'Добавить компьютер',
  rename: 'Переименовать',
  renamePlaceholder: 'Имя на этом телефоне',
  save: 'Сохранить',
  cancel: 'Отмена',
  forget: 'Забыть этот компьютер',
  machineNamed: (name: string) => `Сам компьютер называет себя «${name}»`,
  os: (platform: string) => OS[platform] ?? '',
  switcher: 'Компьютер',

  powerTitle: 'Питание',
  hibernate: 'Гибернация',
  sleep: 'Сон',
  hibernateAbout:
    'Открытое — окна, файлы, вкладки — сохраняется на диск, и компьютер выключается полностью. ' +
    'Включается кнопкой питания, всё открытое на месте.',
  sleepAbout:
    'Сон: память остаётся под питанием, компьютер просыпается от клавиатуры, мыши или кнопки ' +
    'питания за пару секунд.',
  macMode: (mode: number) => {
    if (mode === 25)
      return 'Режим macOS 25: настоящая гибернация — память на диск, питание выключено.';
    if (mode === 3)
      return 'Режим macOS 3: сон с копией памяти на диске — переживёт и полный разряд батареи.';
    if (mode === 0) return 'Режим macOS 0: обычный сон — без питания открытое пропадёт.';
    return `Режим macOS ${mode}.`;
  },
  macModeHint:
    'Настоящая гибернация на Mac — режим 25: `sudo pmset -a hibernatemode 25` в Терминале; ' +
    'вернуть обычный — тем же с 3.',
  noWake:
    'С телефона компьютер обратно не включить: пока он спит, панель, чаты и уведомления ' +
    'недоступны. Выключить совсем отсюда нельзя — по той же причине.',
  awakeHeld: 'Сейчас работает агент — во сне его работа остановится.',
  confirmTitle: (action: PowerAction, name: string) => `Отправить «${name}» в ${ACTION[action]}?`,
  confirm: 'Да, отправить',
  accepted: 'Команда принята — компьютер уйдёт через пару секунд.',
  failed: (message: string) => `Система отказала: ${message}`,
  unavailable: (reason: PowerUnavailableReason | undefined, platform: string): string => {
    if (reason === 'disabled')
      return platform === 'win32'
        ? 'Гибернация выключена в Windows. Включить: `powercfg /hibernate on` в терминале администратора.'
        : 'Режим выключен в системе.';
    if (reason === 'not-allowed')
      return 'Система не даёт этого без пароля администратора или не поддерживает (logind/polkit).';
    if (reason === 'no-tool') return 'Нет системной утилиты для этого (busctl или pmset).';
    return 'На этой системе панель питанием не управляет.';
  },
};
