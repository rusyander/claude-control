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
};
