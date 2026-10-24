import type { phoneSigningRu } from './ru.ts';

/** English texts of the phone signing card; typed against the Russian module. */
export const phoneSigningEn: typeof phoneSigningRu = {
  title: 'Decisions signed by the phone',
  on: 'On',
  off: 'Off',
  enabledAt: 'on since {{time}}',
  explain:
    'With this mode on, “Allow” — for permissions, D-n asks, branch gates, panel-agent cards, auto-approve and full access — is accepted only with the signature of a paired phone’s key. The key is created and kept on the phone: neither a model process nor modified panel code in this window can sign for you. “Deny” and “Stop” are accepted from anywhere.',
  phoneOnly:
    'Pairing a phone and switching the mode on or off happen on the phone only: Settings → Link → Decision signing. Here you see the state and can revoke a key: an “enable” button in this window could be pressed by modified code of the window itself.',
  whileOn:
    'While the mode is on, “Allow” from the panel window and from Telegram does not go through — answer from the phone. Changes that loosen the rights of every future decision (auto mode in every chat, auto-approve rules, group permissions, settings import) are refused: switch signing off on the phone, make the change, then switch it back on.',
  noDeviceOn:
    'The mode is on but no paired phone is left: nobody can “Allow” right now. To switch the mode off without a phone, delete this file on this computer',
  devices: 'Paired phones',
  noDevices: 'No phone is paired. Pair one in the app: Settings → Decision signing.',
  unnamed: 'Unnamed phone',
  fingerprint: 'Fingerprint {{value}}',
  fingerprintHint:
    'The fingerprint must match the one the phone shows. An unfamiliar fingerprint is a key you did not pair: revoke it.',
  boundAt: 'paired {{time}}',
  lastUsedAt: 'last signature {{time}}',
  revokedAt: 'revoked {{time}}',
  revoke: 'Revoke',
  revokeTitle: 'Revoke the phone’s key?',
  revokeText:
    'Signatures of the phone “{{label}}” will no longer be accepted. It can be paired again only while the mode is off.',
  revokeLastText:
    'This is the last paired phone and the mode is on: after revoking, nobody can “Allow”. Without a phone the mode can be switched off only by deleting the file {{path}} on this computer.',
  revoked: 'The phone’s key is revoked.',
  loadError: 'Could not read the signing mode — the server did not answer.',
};
