import type { environmentApiRu } from './ru.ts';

/** English texts of the “API” tab of the Environment window; typed against the Russian module. */
export const environmentApiEn: typeof environmentApiRu = {
  source: 'Contract',
  sourceKinds: {
    file: 'project file',
    url: 'address',
    postman: 'Postman',
  },
  sourceFound: 'found at a running service',
  refresh: 'Refresh',
  refreshHint: 'Search files and running services for a contract again, re-read the selected one',
  addUrl: 'Add address',
  importPostman: 'Import Postman',
  removeSource: 'Remove',
  removeTitle: 'Remove “{{label}}” from sources?',
  removeText:
    'Only the source leaves the panel. A collection file moves to the panel data archive; request history stays.',
  askContract: 'Check contract against code',
  askContractHint:
    'The window closes and a request to the agent appears in the chat field — you send it yourself',
  urlForm: {
    title: 'Contract by address',
    label: 'OpenAPI / Swagger address',
    hint: 'JSON or YAML: e.g. …/v3/api-docs in Spring, …/openapi.json in FastAPI, a stand’s contract.',
    save: 'Check and add',
    cancel: 'Cancel',
  },
  importing: 'Reading the collection…',
  notFoundTitle: 'No contract found',
  notFoundText:
    'The panel looked for openapi/swagger files and Postman collections in the project (4 levels deep, skipping node_modules and builds), and at services started from “Dev server” — /openapi.json, /v3/api-docs, /swagger.json and similar. You can send a request without a contract too — by address below.',
  notFoundServices: 'Running services: {{list}} — no contract at the known addresses.',
  warnings: {
    truncated: 'Only the first {{count}} endpoints are shown.',
    cookie: 'Cookie parameters are not shown: {{count}}.',
    'form-data': 'formData fields are not shown: {{count}}.',
    'external-ref':
      'A reference to another file was not resolved: {{detail}} — the schema is not checked there.',
    'postman-auth':
      'Auth type “{{detail}}” from the collection was not carried over — set the header yourself.',
    'postman-body': 'form-data or file bodies were not carried over: {{count}} request(s).',
  },
  specLoading: 'Reading the contract…',
  specMeta: '{{title}} · {{format}} · endpoints: {{count}}',
  target: {
    baseUrl: 'Base address',
    baseUrlHint: 'Where requests go. Saved per project.',
    baseUrlSaved: 'Saved',
    connection: 'Where requests go',
    suggestions: 'Suggestions',
    fromMain: 'main checkout',
    suggestionsMore: '{{count}} more',
    suggestionsLess: 'Collapse',
    useSuggestion: 'Use address {{url}}',
    origin: {
      service: 'running',
      env: '.env',
      contract: 'contract',
    },
    auth: 'Authorization',
    authNone: 'not set',
    authAdd: 'Set header',
    authEdit: 'Change',
    authRemove: 'Remove',
    authHeader: 'Header',
    authValue: 'Value',
    authValueHint:
      'E.g. Bearer eyJ… Stored encrypted in the panel data; never reaches the browser or history — only a mask.',
    authSave: 'Save',
    authCancel: 'Cancel',
  },
  list: {
    label: 'Endpoints',
    search: 'Find endpoint',
    searchPlaceholder: 'Method, path or description',
    untagged: 'No tag',
    empty: 'Nothing found.',
    deprecated: 'deprecated',
    free: 'Own request',
    freeHint: 'Address and method by hand — no endpoint from the contract',
  },
  request: {
    label: 'Request',
    method: 'Method',
    url: 'Address',
    urlPlaceholder: '/health or https://…',
    finalUrl: 'Goes to',
    pathParams: 'Path parameters',
    required: 'required',
    query: 'Query parameters',
    headers: 'Headers',
    add: 'Add',
    rowName: 'Name',
    rowValue: 'Value',
    rowEnabled: 'Send {{name}}',
    rowRemove: 'Remove {{name}}',
    useAuth: 'Use the saved authorization ({{header}})',
    body: 'Body',
    bodyType: 'Type: {{type}}',
    formatJson: 'Format',
    resetBody: 'Example from contract',
    autofill: 'Fill with sample',
    autofillHint:
      'Random values from the contract schema: path and query parameters, body. Every click gives new ones.',
    autofilled: 'Filled with sample: {{count}}',
    jsonProblem:
      'Not JSON: {{message}}. You can send it, but the server will most likely answer 400.',
    send: 'Send',
    sendShortcut: 'Ctrl+Enter',
    sending: 'Waiting for the response…',
    missingParams: 'Fill in path parameters: {{list}}',
    noBase: 'Set a base address or type a full address with http(s)://',
    viaServer:
      'The request leaves from the panel server, not the browser: CORS does not get in the way.',
  },
  response: {
    label: 'Response',
    duration: '{{ms}} ms',
    truncated: 'The body is over 2 MB — the beginning is shown, not checked against the schema.',
    binary: 'The body is not text ({{type}}) — only the size is shown.',
    empty: 'The body is empty.',
    headers: 'Response headers ({{count}})',
    copy: 'Copy body',
    copied: 'Copied',
    verdict: {
      ok: 'The response matches the contract schema ({{against}})',
      mismatch: 'The response differs from the contract schema ({{against}}): {{count}}',
      'no-schema':
        'The contract has no body schema for response {{against}} — nothing to check against.',
      'undocumented-status':
        'Status {{status}} is not described for this endpoint in the contract.',
      'not-json': 'The contract promised JSON but something else came — cannot check.',
    },
    truncatedIssues: 'Only the first differences are shown — there are more.',
    issue: {
      type: '{{path}}: expected {{expected}}, got {{actual}}',
      required: '{{path}}: required field is missing',
      enum: '{{path}}: {{actual}} is not in the list ({{expected}})',
      additional: '{{path}}: field is not in the contract, got {{actual}}',
      'one-of': '{{path}}: none of the variants matched ({{expected}}), got {{actual}}',
      format: '{{path}}: {{actual}} is not in {{expected}} format',
    },
    askMismatch: 'Ask the agent about the difference',
  },
  history: {
    label: 'History',
    empty: 'Sent requests show up here — the last 50, secrets masked.',
    replay: 'Repeat {{method}} {{url}}',
    clear: 'Clear',
    clearTitle: 'Clear the project request history?',
    clearText: 'All 50 last requests of this project go away. Contracts and settings stay.',
    failed: 'not sent',
    mismatch: 'differs from schema',
    maskedNote: 'Masked headers are not repeated — the saved authorization is used instead.',
  },
  askAgent: {
    contract:
      'Check the API contract “{{source}}” against the project code: find endpoints that exist in code but are not described in the contract and vice versa, plus differences in parameters and response schemas. Change nothing — first list the differences and for each say what to fix: the contract or the code.',
    mismatch:
      'The response of {{endpoint}} (HTTP {{status}}) did not match the schema of contract “{{source}}”:\n{{issues}}\n\nFind where this response is built in the code and say where the error is — in the contract or the code. Propose a fix, but do not apply it without my confirmation.',
  },
  errors: {
    unregistered:
      'The panel sends API requests only for projects from the “Projects” section. Add the folder there.',
    badPort:
      'This port is forbidden for requests by the fetch standard (1, 6000, 6665–6669, 10080 and others). Move the service to another port.',
    send: {
      'bad-url': 'Address not accepted: {{message}}',
      connect: 'The service did not answer ({{detail}}).',
      dns: 'Host {{host}} not found (DNS): no such name, or no network/VPN route to it. Pick an address from the suggestions under “Base address”.',
      refused:
        'Connection refused ({{host}}): the service is not running or listens on another port.',
      tls: 'Certificate of {{host}} rejected ({{detail}}): self-signed or issued for another name.',
      reset:
        'Connection to {{host}} dropped ({{detail}}) — the service closed it or a proxy is in the way.',
      timeout: 'No response in {{detail}} s — the service is busy or hung.',
    },
    spec: {
      unreadable: 'Not readable as JSON or YAML: {{message}}',
      'not-a-spec': 'This is not OpenAPI 3, Swagger 2.0 or a Postman collection.',
      fetch: 'No contract received from the address: {{message}}',
      'too-big': 'The contract is over 10 MB — the panel does not read it.',
      missing: 'The source is gone: {{message}}',
    },
    notPostman:
      'This is an OpenAPI contract, not a Postman collection — add it by address or put the file into the project.',
    notRemovable: 'A contract file from the project is removed in the project itself.',
    fileRead: 'File not read: {{message}}',
    generic: 'Did not work: {{message}}',
  },
};
