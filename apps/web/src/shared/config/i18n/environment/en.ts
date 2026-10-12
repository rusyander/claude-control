import { environmentLogsEn } from './logs/en.ts';
import { environmentApiEn } from './api/en.ts';
import type { environmentRu } from './ru.ts';

/** English texts of the project “Environment” window; typed against the Russian module. */
export const environmentEn: typeof environmentRu = {
  open: 'Environment',
  openHint: 'Project services: Docker Compose containers, their state and ports',
  title: 'Project environment',
  description: 'What the project cannot run without: the database, queues, neighbouring services.',
  tabsLabel: 'Environment sections',
  tabs: {
    logs: 'Logs',
    logsHint:
      'Output of “Dev server” targets and Docker Compose services in one place: search, levels, a line analysed by the agent.',
    services: 'Services',
    servicesHint:
      'Containers from the project’s Docker Compose. The panel stores nothing: the stack comes from the file, the state from docker.',
    database: 'Database',
    databaseHint:
      'Read only: schema, queries, plans and migrations. Nothing can be written to the database from here — neither by you nor by the agent.',
    api: 'API',
    apiHint:
      'Endpoints from an OpenAPI contract or a Postman collection: requests through the panel server and response check against the schema.',
    guard: 'Guard',
    guardHint:
      'Before a command that cannot be undone, the agent stops and asks you: dropping tables, rolling back migrations, infrastructure, volumes with data, production.',
  },
  docker: {
    missingTitle: 'Docker is not installed',
    missingText:
      'There is no docker program in the panel server’s PATH. Install Docker Desktop (Windows, macOS) or Docker Engine with the compose plugin (Linux) and restart the panel.',
    stoppedTitle: 'Docker is not running',
    stoppedText:
      'The docker program is there, but its service does not answer. Start Docker Desktop or the docker service — the window refreshes on its own.',
    detail: 'What docker said',
  },
  file: {
    missingTitle: 'The project has no Docker Compose',
    missingText:
      'The panel looks for compose.yaml, compose.yml, docker-compose.yaml and docker-compose.yml in the project root and in the docker/, deploy/, .docker/ folders.',
    configErrorTitle: 'Docker rejected {{file}}',
    configErrorText:
      'Until the file is fixed, services can be neither started nor shown. Below is docker’s answer verbatim: it names the line and key it tripped on.',
    label: 'File',
    withOverride: 'together with {{file}}',
    project: 'Compose project',
    projectHint:
      'Docker recognises the stack’s containers by this name — the same ones docker compose ps shows in a terminal.',
  },
  stack: {
    label: 'Whole stack',
    up: 'Start all',
    stop: 'Stop all',
    restart: 'Restart all',
    empty: 'The file has no services.',
  },
  table: {
    caption: 'Stack services in start order: dependencies above their dependants',
    service: 'Service',
    image: 'Image',
    state: 'State',
    ports: 'Ports',
    actions: 'Actions',
    build: 'built from source',
    dependsOn: 'after {{names}}',
    noPorts: 'not exposed',
    portTitle: 'Port {{published}} on this machine leads to container port {{target}}',
  },
  state: {
    running: 'Running',
    healthy: 'Running, healthy',
    starting: 'Starting',
    unhealthy: 'Running, health check failing',
    stopped: 'Stopped',
    crashed: 'Crashed, code {{code}}',
    created: 'Created, not started',
    restarting: 'Restarting',
    paused: 'Paused',
    dead: 'Dead',
    absent: 'Not created',
  },
  row: {
    up: 'Start {{name}}',
    stop: 'Stop {{name}}',
    restart: 'Restart {{name}}',
  },
  job: {
    running: 'In progress: {{action}}',
    done: 'Done: {{action}}',
    failed: 'Failed: {{action}}',
    failedHint: 'The reason is in the last lines of docker’s output below.',
    output: 'docker compose output',
    empty: 'docker has printed nothing yet',
    actions: {
      up: 'start all',
      stop: 'stop all',
      restart: 'restart all',
      down: 'remove containers',
      'down-volumes': 'remove containers with their data',
    },
    serviceActions: {
      up: 'start {{name}}',
      stop: 'stop {{name}}',
      restart: 'restart {{name}}',
      down: 'remove containers',
      'down-volumes': 'remove containers with their data',
    },
  },
  danger: {
    title: 'Removal',
    text: 'Containers are created again by the next “Start all”. Data in named volumes survives a plain removal and is lost only together with the volumes.',
    down: 'Remove containers',
    downVolumes: 'Remove with data',
    noVolumes: 'The file has no named volumes — there is no data to remove.',
    confirmTitle: 'Remove containers and volumes?',
    confirmText:
      'docker compose down -v removes the stack’s containers and volumes: {{volumes}}. Everything in them — databases, uploads, caches — is lost for good.',
    confirmLabel: 'Remove with data',
  },
  errors: {
    busy: 'An action is already running on this stack — wait for it to finish.',
    unregistered:
      'The panel starts containers only for projects from “Projects”, folders inside them and copies of their branches.',
    fileMissing: 'The Compose file is gone — the window refreshes and shows what was found.',
    serviceUnknown: 'The file no longer has this service — the list refreshes.',
    generic: 'Action not accepted: {{message}}',
  },
  database: {
    connection: 'Connection',
    sources: {
      compose: 'Compose',
      env: '.env',
      spring: 'Spring',
      manual: 'Own',
    },
    origin: 'From: {{origin}}',
    originManual: 'Added in the panel',
    remote: 'Not a local database',
    remoteHint:
      'The address is not on this machine — it may be a shared stand or production. Queries only read, but a heavy one loads it too. For production, create a separate read-only role.',
    noPassword: 'No password found',
    noPasswordHint:
      'The project files hold no password. If the database needs one, add your own connection with it.',
    composeDown: 'Service {{service}} is now: {{state}} — there is nothing to connect to.',
    toServices: 'Start it on the “Services” tab',
    add: 'Own connection',
    edit: 'Edit',
    remove: 'Remove',
    removeTitle: 'Remove connection “{{label}}”?',
    removeText:
      'The panel forgets the address and password. The database itself does not change. Connections found in project files are not removed this way — edit the file itself.',
    form: {
      titleNew: 'Own Postgres connection',
      titleEdit: 'Edit “{{label}}”',
      label: 'Name',
      labelHint: 'How the connection is named in the list: “Stage”, “Reports”.',
      host: 'Host',
      port: 'Port',
      database: 'Database',
      user: 'User',
      password: 'Password',
      passwordHint:
        'Stored encrypted in the panel and never given out — neither to the window nor to the agent.',
      passwordKeep: 'Empty — keep the current password.',
      save: 'Save',
      cancel: 'Cancel',
      required: 'Fill in the field',
      portInvalid: 'Port is a whole number from 1 to 65535',
    },
    unsupportedTitle: 'Found but not readable',
    unsupportedEngine: '{{origin}} — {{engine}}: the panel reads only Postgres so far.',
    unsupportedNoPort:
      '{{origin}} — Postgres without a published port. Add ports: ["5432:5432"] to the service so this machine can reach the database.',
    empty: {
      title: 'No database found',
      text: 'The panel looked for Postgres in Docker Compose, in .env files (DATABASE_URL, PG*, DB_*) and in Spring settings. If the database lives elsewhere, add your own connection.',
    },
    agent: {
      title: 'Agent access',
      text: 'The panel writes its MCP bridge into the CLI configuration: the agent gets the schema, read queries, plans and migrations — with the same limits as here. The database address and password are not passed to the agent.',
      toggle: 'Let the agent read the project database',
      on: 'The agent sees the database',
      off: 'The agent does not see the database',
      restart: 'Picked up on the next CLI start.',
    },
    schema: {
      title: 'Schema',
      filter: 'Find a table or column',
      version: 'Postgres {{version}}',
      tables_one: '{{count}} table',
      tables_few: '{{count}} tables',
      tables_many: '{{count}} tables',
      truncated: 'The first 500 tables are shown — search for the one you need.',
      empty: 'The database has no tables.',
      noMatch: 'Nothing found',
      rows: '≈ {{count}} rows',
      insert: 'Insert a query for {{name}}',
      refresh: 'Refresh schema',
      pk: 'primary key',
      kinds: {
        table: 'table',
        view: 'view',
        'materialized-view': 'materialized view',
        'partitioned-table': 'partitioned table',
        'foreign-table': 'foreign table',
      },
    },
    editor: {
      label: 'SQL query',
      placeholder: 'SELECT * FROM users LIMIT 100',
      run: 'Run',
      runShortcut: 'Ctrl+Enter',
      explain: 'Plan',
      explainAnalyze: 'Plan with execution',
      explainAnalyzeHint:
        'EXPLAIN ANALYZE really runs the query and measures it — inside a read-only transaction.',
      limits: 'Read only · one statement · up to 500 rows · 15 seconds',
      running: 'Running…',
    },
    result: {
      caption: 'Query result',
      summary_one: '{{count}} row in {{ms}} ms',
      summary_few: '{{count}} rows in {{ms}} ms',
      summary_many: '{{count}} rows in {{ms}} ms',
      truncated: 'The first {{count}} rows are shown — narrow the condition or add LIMIT.',
      empty: 'The query returned no rows.',
      plan: 'Execution plan',
      planTime: 'Plan received in {{ms}} ms',
    },
    refused: {
      title: 'Query not sent',
      empty: 'The query is empty.',
      multiple: 'One statement at a time — remove the extra “;” or split the query.',
      'not-read':
        'The query starts with “{{word}}”. Only reading is allowed here: SELECT, WITH, EXPLAIN, SHOW, TABLE, VALUES.',
      'denied-word':
        'The query contains “{{word}}” — that changes data. Only reading is allowed; if it is a column name, put it in double quotes.',
      'denied-function':
        'Function {{name}} acts outside the query (sessions, files, server settings) and is not allowed.',
      'unicode-escape': 'Names written as U&"…" are not allowed — write the name as plain text.',
      unterminated: 'Unclosed string or comment.',
    },
    errors: {
      connect: 'The database does not answer: {{message}}',
      connectHint: 'Check that it is running and the address is right.',
      auth: 'The database rejected the user or password.',
      authHint: 'Add your own connection with the right password.',
      'database-missing': 'No such database on the server: {{message}}',
      timeout: 'The query did not finish in 15 seconds and was stopped.',
      timeoutHint: 'Narrow the selection or add LIMIT; the plan shows what is slow.',
      'read-only': 'Postgres refused: the query tried to write — {{message}}',
      permission: 'No permission: {{message}}',
      query: 'Error in the query: {{message}}',
      position: 'Position {{position}}, line {{line}}',
      unregistered:
        'The panel works with the database only for projects from “Projects”, folders inside them and copies of their branches.',
      unknown: 'This connection is gone — the list is refreshed.',
      notManual: 'A connection found in project files is edited in the file itself.',
      mcp: 'Did not work: {{message}}',
      generic: 'Did not work: {{message}}',
    },
    migrations: {
      title: 'Migrations',
      none: 'No migrations found in the project.',
      where: '{{tool}} · {{dir}} · tracked in {{table}}',
      pending_one: '{{count}} not applied',
      pending_few: '{{count}} not applied',
      pending_many: '{{count}} not applied',
      allApplied: 'All applied',
      neverRun: 'The database has no {{table}} table — no migrations have been applied to it yet.',
      dirty:
        'The last migration failed halfway (dirty). Until that is fixed, the migration tool will not go further.',
      orphaned:
        'Recorded in the database but missing from the project: {{ids}}. The branch was switched or the file deleted.',
      readError: 'The database state was not read: {{message}}',
      filesOnly: 'No connection — only the project files are visible.',
      applied: 'applied',
      notApplied: 'not applied',
      readOnly:
        'The panel neither applies nor rolls back migrations — the project’s tool does that.',
    },
  },
  guard: {
    title: 'Backend guard',
    state: {
      none: 'Not installed',
      installed: 'On',
      partial: 'Partial',
    },
    noneText:
      'A Claude Code hook in the project’s .claude/: when it recognises a command from the list below, the agent stops and asks you — in the terminal and in the panel chat. Everything else runs as before.',
    installedText:
      'The agent asks you before every command covered by the enabled rules. In the panel chat, auto-approval does not let such commands through.',
    partialText:
      'Some files are missing or were edited by hand — the guard may stay silent. “Restore” puts the files back; the settings are kept.',
    group: 'Panel group: {{name}}',
    filesTitle: 'Files in the project',
    parts: {
      script: 'Hook script',
      hook: 'Entry in settings.json',
      rule: 'Rule for the agent',
      config: 'Guard settings',
    },
    partState: {
      ok: 'in place',
      missing: 'missing',
      changed: 'edited',
    },
    claudeOnly:
      'Only Claude Code reads the hook and the rule. Codex, Gemini and the other CLIs do not see them — the guard will not ask in their chats.',
    shareHint:
      'The files live in the project: commit them and everyone working with the repository gets the guard.',
    rulesTitle: 'What it asks about',
    rulesHint: 'A disabled rule stays silent; the others ask.',
    ruleToggle: 'Ask: {{rule}}',
    rules: {
      'prod-target': {
        title: 'Touching production',
        text: 'Any command carrying a production marker from the list on the right — even a read.',
      },
      'sql-drop': {
        title: 'Dropping a table, database or schema',
        text: 'DROP TABLE, DROP DATABASE, ALTER … DROP COLUMN, dropdb, FLUSHALL.',
      },
      'sql-truncate': {
        title: 'Emptying a table',
        text: 'TRUNCATE.',
      },
      'sql-unbounded': {
        title: 'DELETE and UPDATE without WHERE',
        text: 'Changing every row of a table at once.',
      },
      'migration-down': {
        title: 'Rolling back or resetting migrations',
        text: 'migrate down, alembic downgrade, rails db:rollback, prisma migrate reset, flyway clean, artisan migrate:fresh.',
      },
      'infra-change': {
        title: 'Changing infrastructure',
        text: 'terraform apply and destroy, kubectl delete, apply and exec, helm upgrade and uninstall, deleting resources in aws and gcloud.',
      },
      'volume-delete': {
        title: 'Deleting Docker volumes',
        text: 'docker volume rm and prune, compose down -v, system prune --volumes.',
      },
    },
    prod: {
      title: 'Production',
      label: 'Production markers',
      hint: 'A host, an IP or a kubectl context name — one per line. Any command containing one of them asks.',
      placeholder: 'db.prod.internal\n10.0.5.12\nprod-cluster',
      tooShort:
        'Shorter than three characters: {{markers}}. Such a marker would match almost every command.',
    },
    check: {
      title: 'Check a command',
      label: 'Command',
      hint: 'Uses the settings on screen, even unsaved ones.',
      placeholder: 'psql -h db.prod.internal -c "drop table orders"',
      button: 'Check',
      asks: 'Asks — {{reason}}: {{match}}',
      passes: 'Runs without a guard question.',
    },
    actions: {
      install: 'Install the guard',
      restore: 'Restore',
      save: 'Save settings',
      revert: 'Discard changes',
      saved: 'Settings saved.',
      installed: 'The guard is on. New Claude chats in this project already see it.',
      dirty: 'There are unsaved changes.',
      removed: 'The guard is removed. The files are in the panel’s backups.',
    },
    remove: {
      title: 'Remove the guard',
      text: 'The hook and the rule leave the project’s .claude/ (copies go to backups) and the panel group is deleted. The agent stops asking before such commands.',
      button: 'Remove the guard',
      confirmTitle: 'Remove the backend guard?',
      confirmText:
        'The hook script, the rule and the settings leave the project’s .claude/, the entry is taken out of settings.json and the group “{{group}}” is deleted. Copies of the files stay in backups.',
      confirmLabel: 'Remove',
    },
    errors: {
      unregistered:
        'The panel installs the guard only in projects from the Projects section, folders inside them and copies of their branches.',
      notInstalled: 'The guard is no longer in the project — the window has been refreshed.',
      generic: 'Failed: {{message}}',
    },
  },
  api: environmentApiEn,
  logs: environmentLogsEn,
};
