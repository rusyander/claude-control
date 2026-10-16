import type { PowerAction, PowerUnavailableReason } from '@agentdeck/contracts';
import type { computersRu } from './ru';

const OS: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

const ACTION: Record<PowerAction, string> = { hibernate: 'hibernate', sleep: 'sleep' };

export const computersEn: typeof computersRu = {
  title: 'Computers',
  about:
    'The phone pairs with each computer through the code in its panel. The selected one is ' +
    'whose projects, chats and questions you see and where work goes.',
  current: 'selected',
  add: 'Add a computer',
  rename: 'Rename',
  renamePlaceholder: 'Name on this phone',
  save: 'Save',
  cancel: 'Cancel',
  forget: 'Forget this computer',
  machineNamed: (name: string) => `The computer calls itself “${name}”`,
  os: (platform: string) => OS[platform] ?? '',
  switcher: 'Computer',

  powerTitle: 'Power',
  hibernate: 'Hibernate',
  sleep: 'Sleep',
  hibernateAbout:
    'Everything open — windows, files, tabs — is saved to disk and the computer powers off ' +
    'completely. The power button brings it back with everything in place.',
  sleepAbout:
    'Sleep: memory stays powered, the computer wakes from the keyboard, mouse or power button ' +
    'in a couple of seconds.',
  macMode: (mode: number) => {
    if (mode === 25) return 'macOS mode 25: true hibernation — memory to disk, power off.';
    if (mode === 3)
      return 'macOS mode 3: sleep with a copy of memory on disk — survives a flat battery.';
    if (mode === 0) return 'macOS mode 0: plain sleep — without power, open work is lost.';
    return `macOS mode ${mode}.`;
  },
  macModeHint:
    'True hibernation on a Mac is mode 25: `sudo pmset -a hibernatemode 25` in Terminal; ' +
    'the same with 3 restores the default.',
  noWake:
    'The phone cannot switch the computer back on: while it sleeps, the panel, chats and ' +
    'notifications are unreachable. Powering off completely is not offered for the same reason.',
  awakeHeld: 'An agent is working right now — sleep will stop its work.',
  confirmTitle: (action: PowerAction, name: string) => `Put “${name}” to ${ACTION[action]}?`,
  confirm: 'Yes, do it',
  accepted: 'Command accepted — the computer goes in a couple of seconds.',
  failed: (message: string) => `The system refused: ${message}`,
  unavailable: (reason: PowerUnavailableReason | undefined, platform: string) => {
    if (reason === 'disabled')
      return platform === 'win32'
        ? 'Hibernation is off in Windows. Turn it on: `powercfg /hibernate on` in an administrator terminal.'
        : 'This mode is off in the system.';
    if (reason === 'not-allowed')
      return 'The system does not allow this without an administrator password, or does not support it (logind/polkit).';
    if (reason === 'no-tool') return 'The system tool for this is missing (busctl or pmset).';
    return 'The panel does not manage power on this system.';
  },
};
