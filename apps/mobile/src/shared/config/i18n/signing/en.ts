import type { signingRu } from './ru';

export const signingEn: typeof signingRu = {
  title: 'Decision signing',
  about:
    'The "decisions only with the phone signature" mode: the panel accepts chat permissions, ' +
    'answers to agent questions, approved cards and full-access runs only when the key of a ' +
    'bound phone signed them. Deny and "Stop" need no signature. While the mode is on, the ' +
    'panel window and Telegram cannot allow anything.',
  unsupported:
    'The web build has no signing key: the mode is turned on and signed from a phone only.',
  modeOn: 'The mode is on: permissions are accepted only with a signature.',
  modeOff: 'The mode is off: decisions are accepted as usual.',
  devices: 'Bound keys',
  noDevices: 'No phone is bound yet.',
  unnamed: 'Phone',
  thisPhone: 'this phone',
  revoked: 'revoked',
  mine: (fingerprint: string) =>
    `Fingerprint of this phone's key: ${fingerprint}. Compare it with the list in the panel window.`,
  bind: 'Bind this phone',
  revokedMine: "This phone's key was revoked in the panel. Binding creates a new key.",
  bindBlocked:
    'The mode is on: a new key will not be bound. Turn the mode off on a phone that is already ' +
    'bound, bind this one and turn it on again.',
  enable: 'Turn the mode on',
  enableTitle: 'Turn decision signing on?',
  enableList:
    'Permissions will be accepted only with a signature of these keys. Compare the fingerprints ' +
    "with the panel window — an extra key means someone else's phone is bound:",
  enableLoss:
    'If you lose the phone, the mode is turned off by deleting a file on the computer (from a ' +
    'terminal, not from the panel):',
  confirmEnable: 'Turn on',
  cancel: 'Cancel',
  disable: 'Turn the mode off',
  unbind: 'Unbind this phone',
  unbindTitle: 'Unbind this phone?',
  unbindAbout:
    'The key is revoked in the panel and erased from the phone. The phone can be bound again ' +
    'while the mode is off.',
  confirmUnbind: 'Unbind',
  unbindBlocked: 'The phone can be unbound while the mode is off.',
};
