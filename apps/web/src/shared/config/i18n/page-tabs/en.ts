import type { pageTabsRu } from './ru.ts';

/** English texts of the section-page tabs; typed against the Russian module. */
export const pageTabsEn: typeof pageTabsRu = {
  dlp: {
    tabsLabel: 'Data protection sections',
    tab: {
      proxy: 'Proxy',
      rules: 'Rules',
      check: 'Check',
      journal: 'Journal',
      gate: 'Prompt gate',
    },
    hint: {
      proxy:
        'Start, port and model address. The proxy sits between the CLI and the model and edits every request by the rules on the “Rules” tab.',
      rules:
        'What to look for and what to replace it with. Edits collect in a draft and take effect only on “Save” — the draft survives switching to another tab.',
      check:
        'Sample text run through the current rules, draft included: see what the model will get before the proxy is even started.',
      journal:
        'Which rule fired, when and how many times. The journal never stores the matched values themselves.',
      gate: 'A second, independent mechanism on the same rules: a hook checks only the prompt you typed, before it is sent. It does not see files or command output — that is the proxy’s job.',
    },
    unsaved: 'unsaved',
  },
  portability: {
    tabsLabel: 'Environment passport sections',
    tab: {
      passport: 'Passport',
      transfer: 'Transfer',
      subscription: 'Subscription',
      probe: 'Target probe',
      carry: 'Unfinished work',
    },
    hint: {
      passport:
        'What the chosen CLI really has configured: entries by kind, and the sections the panel could not read — with the reason.',
      transfer:
        'What will reach the target and in what form, then the transfer plan with a file diff. Nothing is written until you confirm the plan.',
      subscription:
        'Keep the target in line with the panel from now on: whenever you ask, the panel rewrites the chosen layers there.',
      probe:
        'A check on the target’s real CLI in a temporary home: do the entries actually arrive. The probe does not touch your files.',
      carry: 'Conversations of other CLIs left halfway — they can be continued at the active CLI.',
    },
    needsTarget: 'Choose a transfer target',
    needsTargetText:
      'This tab answers about a specific target. Pick it in the “Transfer target” field above — source and level are already chosen.',
  },
  compare: {
    tabsLabel: 'Comparison sections',
    countHint: 'this many entries differ between the sides',
    hint: {
      mcp: 'MCP servers of both sides side by side. Ticked entries can be moved either way — the panel shows the file diff first.',
      env: 'Environment variables of both sides. Secret values are hidden and compared by presence only; variables are never transferred.',
      permissions:
        'Permissions of both sides, side by side, view only: permissions are not transferred.',
      instructions:
        'The global instructions text of both sides. It can be transferred as a whole — after a diff preview.',
    },
  },
  plugins: {
    tabsLabel: 'Plugin sections',
    tab: {
      installed: 'Installed',
      catalog: 'Catalogue',
      marketplaces: 'Marketplaces',
      scaffold: 'Own plugin',
    },
    hint: {
      installed:
        'Plugins already in place: enable, disable, update or remove. Changes apply after Claude Code restarts.',
      catalog:
        'Plugins from the connected marketplaces: find and install. The catalogue opens with «Show catalogue»; if you already know the name, install by identifier below.',
      marketplaces:
        'Where the catalogue’s plugins come from. Removing a marketplace also removes every plugin installed from it.',
      scaffold: 'A skeleton of your own plugin in the Claude Code format, in a folder you choose.',
    },
  },
  scripts: {
    tabsLabel: 'Script filter',
    tab: {
      all: 'All',
      used: 'In use',
      unused: 'Not bound',
      test: 'Tests',
    },
    hint: {
      all: 'Every file in the hooks/ folder. Search looks at names and descriptions within the open tab.',
      used: 'Scripts a hook runs — directly or through an import from another such script. Deleting one breaks the hook.',
      unused:
        'Scripts no hook runs and no bound script imports. Candidates for clean-up — or for binding to a hook.',
      test: 'Tests and fixtures: files under tests/ and named *.test.* or *.spec.*. They are not bound to hooks by design.',
    },
    empty: {
      used: 'No script in the folder is run by a hook.',
      unused: 'No forgotten scripts: every file is run by a hook or imported by such a script.',
      test: 'There are no tests or fixtures in the folder.',
    },
  },
  analytics: {
    tabsLabel: 'Analytics sections',
    tab: {
      overview: 'Summary',
      breakdown: 'Models and projects',
      activity: 'Tools and hours',
      sessions: 'Sessions',
      live: 'Agents and contour',
    },
    hint: {
      overview:
        'The chosen period in total: tokens, requests, cache share, cost estimate and spend by day.',
      breakdown:
        'Where the period’s tokens went — by model and by project. Click a row to open the details.',
      activity: 'When you work and with what: activity by hour, frequent tools and skills.',
      sessions: 'The latest sessions of the period: project, branch, models and volume.',
      live: 'What is running right now and what is counted apart from transcripts: live agents, parallel-agent runs on a cheaper model than ordered, and spend through the contour. The period does not affect this tab, so the period picker and export are off here.',
    },
  },
  rules: {
    tabsLabel: 'Rule filter',
    tab: {
      all: 'All',
      enabled: 'On',
      disabled: 'Off',
    },
    hint: {
      all: 'Every rule in the panel format from CLAUDE.md. Search looks at titles and text within the open tab.',
      enabled: 'Rules the agent reads in every session, in every project.',
      disabled:
        'Rules that stay in CLAUDE.md but the agent does not see. Turn one on with its switch — the text is not lost.',
    },
    empty: {
      enabled: 'No rule is on: the agent sees none of them right now.',
      disabled: 'No rule is off — all of them apply.',
    },
  },
};
