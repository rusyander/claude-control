import type { DlpMessageCode } from '@agentdeck/contracts/server-messages';

export const dlpEn: Record<DlpMessageCode, string> = {
  'dlp-rules-list-expected': 'A list of rules is expected.',
  'dlp-text-field-expected': 'The text field is expected.',
  'dlp-rules-unparsed': 'the rules file does not parse ({{reason}})',
  'dlp-rules-schema-file': 'the rules file does not match the schema',
  'dlp-rule-schema': '{{rule}}: does not match the schema',
  'dlp-rules-schema': 'the rules do not match the schema',
  'dlp-upstream-missing': 'no address set to forward requests to',
  'dlp-upstream-unparsed': 'address “{{value}}” does not parse',
  'dlp-upstream-scheme': 'the address must start with http:// or https://',
  'dlp-no-rules': 'there is no enabled rule',
  'dlp-core-missing': 'the core was not found ({{reason}})',
  'dlp-core-unverified': 'the core entry did not verify ({{reason}})',
  'dlp-core-unverified-bare': 'the core entry did not verify',
  'dlp-core-http': 'the core answered {{status}} to {{path}}',
  'dlp-core-down': 'Data protection is held by the core, and it does not answer: {{reason}}',
  'dlp-core-port-waiting': 'the port is busy',
  'dlp-core-port-busy': 'port {{port}} is busy ({{reason}})',
  'dlp-core-listener-silent': 'no answer from the listener',
};
