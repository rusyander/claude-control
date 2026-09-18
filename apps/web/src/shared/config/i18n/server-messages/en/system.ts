import type { SystemMessageCode } from '@agentdeck/contracts/server-messages';

export const systemEn: Record<SystemMessageCode, string> = {
  'analytics-pricing-refresh-failed': 'Could not refresh the price list: {{failure}}',
  'endpoint-profile-not-found': 'Custom endpoint profile not found.',
  'value-too-long': 'The value exceeds the allowed length.',
  'remote-settings-invalid': 'The settings are invalid',
  'remote-device-invalid': 'The device is described incorrectly',
  'remote-device-token-unspecified': 'No device token specified',
  'location-not-found':
    'The .claude folder was not found automatically. Specify its path manually in the app settings.',
  'location-dir-missing': 'The folder does not exist: {{dir}}',
  'location-is-file': 'This is a file, not a folder: {{dir}}',
  'location-dir-unavailable': 'The folder is unavailable: {{dir}}',
  'location-dir-unreadable': 'No permission to read the folder: {{dir}}',
  'location-app-data-failed': 'The panel data folder in {{root}} cannot be created: {{detail}}',
};
