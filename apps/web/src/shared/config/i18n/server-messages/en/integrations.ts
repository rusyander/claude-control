import type { IntegrationsMessageCode } from '@agentdeck/contracts/server-messages';

export const integrationsEn: Record<IntegrationsMessageCode, string> = {
  'integration-not-found': 'Integration “{{id}}” does not exist.',
  'request-atlassian-url-missing':
    'Request rejected: the Atlassian address is not set ({{field}}).',
  'request-atlassian-token-missing':
    'Request rejected: the Atlassian token is not saved ({{field}}).',
  'request-search-text-required': 'Request rejected: search text is required ({{field}}).',
  'request-space-missing': 'Request rejected: no space specified ({{field}}).',
  'request-page-title-missing': 'Request rejected: no page title specified ({{field}}).',
  'request-search-or-jql-required': 'Request rejected: search text or JQL is required ({{field}}).',
  'request-jira-project-missing': 'Request rejected: no Jira project specified ({{field}}).',
  'request-issue-title-missing': 'Request rejected: no issue title specified ({{field}}).',
  'request-comment-empty': 'Request rejected: empty comment ({{field}}).',
  'request-transition-missing': 'Request rejected: no transition specified ({{field}}).',
  'request-ci-kind-missing':
    'Request rejected: no CI system selected (github or gitlab) ({{field}}).',
  'request-repo-missing':
    'Request rejected: no repository specified and it could not be derived from origin ({{field}}).',
  'request-forge-kind-missing':
    'Request rejected: no forge kind selected (github or gitlab) ({{field}}).',
  'request-title-missing': 'Request rejected: no title specified ({{field}}).',
  'request-url-not-merge-request':
    'Request rejected: the link does not look like a merge request ({{field}}).',
  'request-project-dir-missing': 'Request rejected: no project folder specified ({{field}}).',
  'request-run-missing': 'Request rejected: no run specified ({{field}}).',
  'request-publish-target': 'Request rejected: you can publish to confluence or jira ({{field}}).',
  'request-token-too-long': 'Request rejected: the token is longer than allowed ({{field}}).',
  'request-testit-url-missing':
    'Request rejected: the Test IT address is not set — every self-hosted installation has its own ({{field}}).',
  'request-testit-url-scheme':
    'Request rejected: the Test IT address must start with http:// or https:// ({{field}}).',
  'request-testit-project-missing': 'Request rejected: no Test IT project specified ({{field}}).',
  'request-testit-no-run-id': 'Request rejected: {{SYSTEM}} returned no run id ({{field}}).',
  'request-xray-token-pair':
    'Request rejected: the Xray token is a “clientId:clientSecret” pair separated by a colon ({{field}}).',
  'request-xray-no-key': 'Request rejected: Xray issued no key for this pair ({{field}}).',
  'request-jira-project-key-missing':
    'Request rejected: no Jira project key specified ({{field}}).',
  'request-xray-refused': 'Request rejected: Xray refused: {{failure}} ({{field}}).',
  'request-webhook-url-missing': 'Request rejected: no webhook address specified ({{field}}).',
  'request-webhook-url-unparsed':
    'Request rejected: the webhook address could not be parsed ({{field}}).',
  'request-webhook-url-scheme':
    'Request rejected: the webhook address must be http or https ({{field}}).',
  'request-groupid-missing': 'Request rejected: no test group specified ({{field}}).',
  'request-chat-id-missing': 'Request rejected: no chat for notifications specified ({{field}}).',
  'request-page-body-empty':
    'Request rejected: the page body is empty — a page is not overwritten like that ({{field}}).',
  'integration-token-not-saved': 'The token is not saved.',
  'ci-run-no-artifacts': 'Run {{id}} has no artifacts.',
  'ci-no-pipelines': 'The project has no pipelines.',
  'publish-run-not-found': 'Run “{{runId}}” not found.',
  'confluence-space-missing': 'Confluence: space “{{key}}” does not exist or is not accessible.',
  'integration-timeout': '{{system}} did not answer within {{seconds}} s.',
  'integration-network': 'No connection to {{system}}: {{reason}}.',
  'integration-token-rejected':
    '{{system}}: token rejected ({{status}}). Check the credentials in settings.',
  'integration-address-404':
    '{{system}}: address not found (404) — check the site address and identifiers.',
  'integration-rate-limited': '{{system}}: too many requests (429), try again later.',
  'integration-server-error': '{{system}}: the server answered with error {{status}}.',
  'integration-request-rejected': '{{system}}: request rejected ({{status}}){{tail}}.',
  'integration-not-json':
    '{{system}} did not answer with JSON — the address seems to lead elsewhere.',
  'ci-artifact-file-missing': 'The artifact holds no file «{{name}}».',
  'ci-artifact-no-xml': 'The artifact holds no XML report — name the file in the CI settings.',
  'ci-workflow-runs-missing': 'No finished runs of the workflow «{{workflow}}» were found.',
  'ci-no-finished-runs': 'The repository holds no finished Actions run.',
  'ci-pipeline-job-missing': 'The pipeline {{pipeline}} has no job «{{workflow}}» with artifacts.',
  'ci-pipeline-no-artifacts': 'In the pipeline {{pipeline}} no job left artifacts.',
  'integration-not-connected':
    "{{title}} is not connected: switch it on and save the token in the panel's settings.",
  'tms-not-connected':
    "Test management is not connected: switch it on and save the token in the panel's settings.",
  'tms-system-not-chosen':
    'Test management is not connected: no system is chosen (Zephyr Scale, Xray or Test IT).',
  'tms-run-already-sending':
    'The run «{{runId}}» is already being sent to test management — wait for the sending to finish.',
  'integrations-bridge-script-missing':
    'The bridge script tools/mcp/atlassian.mjs was not found — the panel was started outside its own repository.',
  'tms-run-cases-not-found':
    "{{system}}: none of the run's cases was found in this project — {{because}}",
};
