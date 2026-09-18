import type { rulesRu } from '../../ru/topics/rules';

/** Типизирован по русскому разделу: забыть ключ при переводе не получится. */
export const rulesEn: typeof rulesRu = {
  topic: {
    title: 'Rules',
    summary: 'Standing instructions in CLAUDE.md that Claude always takes into account',
    lead:
      'A rule is a standing instruction that Claude Code reads at the start of ' +
      'every session. Everything written here applies by default: the language ' +
      'to answer in, what is off limits, how to work, what counts as verified. ' +
      'It is not a prompt for one conversation but behaviour you never have to ' +
      'repeat.',

    guideTitle: 'What this page contains',
    guideText:
      'First, why the section exists and what it is not. Then two diagrams of ' +
      'the mechanism and two paths in screenshots: the first rule from scratch ' +
      'and working with a set you already have. At the end — what goes to disk, ' +
      'the fields, the limits and how to undo every action.',

    whyRepeat: 'Stop repeating yourself',
    whyRepeatText:
      'What you explain to Claude in every conversation — the language to answer ' +
      'in, what is off limits, how to verify — is written once and then holds on ' +
      'its own.',
    whyEverywhere: 'The same in every project',
    whyEverywhereText:
      'Personal rules are read in any folder where Claude Code runs. Moving to ' +
      'another project does not start with explaining everything again.',
    whyVisible: 'Visible and reversible',
    whyVisibleText:
      'It is an ordinary markdown file: a rule can be read with your own eyes, ' +
      'switched off with a toggle and restored from a backup.',

    diffTitle: 'What this is NOT',
    diffCaption:
      'Half of the questions about rules are really questions about which ' +
      'section owns the thing. Four neighbours rules get confused with most often.',
    diffPermissions: 'Not “Permissions”',
    diffPermissionsText:
      'A rule is an instruction, not a technical block: it changes behaviour but ' +
      'stops nothing. Only “Permissions” can forbid a tool call, and that is also ' +
      'what makes the agent ask for approval.',
    diffProject: 'Not project rules',
    diffProjectText:
      'This is the personal ~/.claude/CLAUDE.md, which applies in any folder. A ' +
      'project has its own CLAUDE.md and its own .claude directory; both live in ' +
      '“Projects” and have no toggles.',
    diffSkills: 'Not skills',
    diffSkillsText:
      'A skill is an instruction for one kind of task: it is pulled in when the ' +
      'task matches its description. A rule applies to every answer, whatever the ' +
      'conversation is about.',
    diffHooks: 'Not hooks',
    diffHooksText:
      'A hook is a command Claude Code runs on an event, and it always runs. A ' +
      'rule is read and taken into account; there is no guarantee of execution.',

    guide: {
      mapTitle: 'How it works',
      mapCaption:
        'Two diagrams answer what no screen state shows: what the panel counts as ' +
        'a rule, and what happens to the text when a rule is switched off.',
      pathTextTitle: 'The same path in words',
      pathTextText:
        'The form saves a rule → the server parses CLAUDE.md, replaces one section ' +
        'and reassembles the file → before writing it puts a copy into ' +
        'agentdeck/backups/ → Claude Code reads the file at the start of the ' +
        'next session. Only the “## ПРАВИЛО: …” heading makes a section a rule; the ' +
        'rest of the file is left untouched.',

      firstTitle: 'The first rule: from an empty section to a real check',
      firstCaption:
        'A path you walk once and then forget. Every step was shot on a live panel ' +
        'with a throwaway config directory — the file in the frames is real, and ' +
        'the edits land in it.',
      fEmpty: 'The empty section explains the format',
      fEmptyText:
        'The “No rules yet” placeholder names what counts as a rule right away: a ' +
        'section headed “## ПРАВИЛО: …”. The sidebar shows 0 next to “Rules”.',
      fForm: 'Simple mode: title and text',
      fFormText:
        'The “Add rule” button opens the form. Title and rule text on the left, the ' +
        'assistant on the right; the dialog subtitle says plainly that changes apply ' +
        'after Claude Code restarts.',
      fBuilder: 'The builder — same result, different input',
      fBuilderText:
        'Blocks for “allowed”, “not allowed”, “with care” and a custom section. The ' +
        'panel assembles markdown out of the items and drops the empty ones.',
      fAssistant: 'The assistant fills the fields',
      fAssistantText:
        'Describe the task in plain words — for example “always answer in Russian, ' +
        'including choice options”. The reply shows which fields it changed: the ' +
        'title and body badges. The file is still untouched: saving is a separate ' +
        'button.',
      fCard: 'The rule in the list, and a copy of the file',
      fCardText:
        'After saving, the section counter becomes 1 and the toast names the backup ' +
        'made before the write: CLAUDE.md plus a timestamp and the .bak extension.',
      fBulk: 'Several rules at once',
      fBulkText:
        'The “Several at once” mode takes lines shaped “Title :: text”. The panel ' +
        'shows what it recognised (“2 recognised”) and creates the whole batch with ' +
        'one “Create all (2)” button.',
      fSandbox: 'Checking with a real conversation',
      fSandboxText:
        'The flask icon on the card opens the sandbox: on the right you see what is ' +
        'wired into it and where account access comes from, and next to the button ' +
        'the cost estimate for the request ($0.004 in this frame). Your real ' +
        '~/.claude stays read-only.',

      livingTitle: 'A set you already have: search, switching off, “zero rules”',
      livingCaption:
        'The second entrance is not “how to start” but “why this way”. Frames 3 and ' +
        '4 are one action from two sides: the toggle in the list and the consequence ' +
        'in the file.',
      lList: 'The list of rules',
      lListText:
        'Every card is a section of the file. Four icons on the right: sandbox, edit, ' +
        'delete and the toggle — and only the last two change the file.',
      lSearch: 'Search also looks inside the text',
      lSearchText:
        'The query “миграции” matched neither a title nor a body — and the page says ' +
        'exactly that. A search miss does not pretend the section is empty: the ' +
        'sidebar counter still reads 4.',
      lOff: 'Switching off is not deleting',
      lOffText:
        'The toggle is off and the rule is marked “Switched off”. It did not vanish ' +
        'from the list or the counter: the text is intact, Claude just no longer ' +
        'reads it.',
      lFile: 'What happened to the file',
      lFileText:
        'The same moment on the CLAUDE.md page: the rule text moved under “### ' +
        'Коммиты только по просьбе” into the service section “## Отключённые правила ' +
        '(AgentDeck)” at the end of the file. The panel rebuilds that section on ' +
        'every write.',
      lZero: '“Zero rules” in a file that is not empty',
      lZeroText:
        'If the file is marked up with ordinary “## ” sections there will be no ' +
        'cards — and the page explains why: “3 sections «## …»”, a sample of the ' +
        'expected heading and two links, to open the file or to read about the format.',

      shotsTitle: 'The screenshots are real',
      shotsText:
        'The frames were shot on a separate panel with a throwaway config directory ' +
        'and made-up rules: not a single line of your ~/.claude is in them. They are ' +
        'reshot with node tools/help-shots/rules-panel.mjs.',
    },

    canWrite: 'Write rules as text, with the builder, or a batch at once',
    canToggle: 'Switch a rule off without losing its text',
    canSearch: 'Search across rule titles and bodies',
    canSandbox: 'Check a rule with a real conversation in the sandbox',
    canGroup: 'Collect rules into groups and switch them on in sets',
    canEditByHand: 'Edit CLAUDE.md by hand — the panel picks the changes up',
    canAssistant: 'Let the assistant word the rule and refine it in the same window',
    canBackup: 'Roll the whole file back to one of the recent copies — in “Settings”',

    cantProject:
      'Project-level rules: this section owns the personal ~/.claude/CLAUDE.md, while ' +
      'a specific project’s CLAUDE.md is edited in “Projects”',
    cantPriority:
      'Priorities between rules: Claude reads the whole file, and a contradiction ' +
      'between two rules is not resolved for you',
    cantHistory:
      'A per-rule edit history: what accumulates is copies of the whole CLAUDE.md — a ' +
      'rollback returns the file of that moment, not one fixed rule',
    cantForce: 'A guarantee of compliance: a rule is an instruction, not a technical limit',
    cantLive:
      'Reaching a conversation already running: the file is read at session start, and ' +
      'an open conversation will not see the new revision',

    storageFile: 'File',
    storageUnit: 'One rule',
    storageUnitValue: 'a markdown section headed “## ПРАВИЛО: …”',
    storageReader: 'Who reads it',
    storageReaderValue: 'Claude Code at session start, in full',
    storageDisabled: 'Switched off',
    storageDisabledValue:
      'a “### Title” inside the “## Отключённые правила (AgentDeck)” section at the end of the ' +
      'file; a file switched off before the rename carries the heading with the former name — it ' +
      'is still read, and there is no need to rewrite it by hand',
    storageMarks: 'The panel’s own marks',
    storageMarksValue:
      'what is switched off and which groups contain what — in the panel’s state.json; Claude Code never reads that file',
    storageBackup: 'Backups',

    modesTitle: 'Three ways to create a rule',
    modesCaption:
      'The mode choice exists only while creating. An existing rule keeps a plain ' + 'text field.',
    modeSimple: 'Plain text',
    modeSimpleText: 'One field, markdown allowed. Good when the wording is already in your head.',
    modeBuilder: 'Builder',
    modeBuilderText:
      'Four blocks: “Allowed”, “Forbidden”, “With care” and “Custom section” — the last ' +
      'one with a heading you write yourself. The panel assembles ' +
      'markdown with headings out of them and drops empty items. Good when the rule ' +
      'is a list of limits.',
    modeBulk: 'As a list',
    modeBulkText:
      'One line per rule, shaped “Title :: text”. Creates a batch at once — handy ' +
      'for moving in a set you already wrote.',
    modesNote:
      'All three modes produce the same thing — “## ПРАВИЛО: …” sections in CLAUDE.md. ' +
      'The mode only changes how convenient the typing is.',

    fieldsTitle: 'Rule fields',
    fieldsCaption: 'Field names match ruleDraftSchema: that is how you find them in the code.',
    fieldTitle:
      'The rule title. Becomes the ## heading in the file, and the identifier for links like /rules?id=… is derived from it',
    fieldBody: 'The rule text in markdown: what to do, what not to do, how to verify the result.',
    fieldEnabled:
      'Whether the rule is on. A switched-off rule is not deleted but moved to the end of the file.',
    fieldGroups:
      'Groups the rule belongs to. Through a group it can be switched on and off ' +
      'together with other settings.',

    limitsTitle: 'Limits of the section',
    limitsCaption:
      'The numbers and conditions people trip over most often. Everything listed here ' +
      'is visible in the frames above.',
    limitLevel: 'Level',
    limitLevelValue:
      'only ~/.claude/CLAUDE.md. Toggles, groups and the sandbox exist for it alone; project files live in “Projects” and are edited as text',
    limitReach: 'When it reaches Claude',
    limitReachValue:
      'at the start of the next session. An open conversation will not see the new revision — neither in the terminal nor in the panel’s chat',
    limitHeading: 'What counts as a rule',
    limitHeadingValue:
      '“## ПРАВИЛО: …” — the word in any case, the colon required. “## Title” and “### ПРАВИЛО: …” are ordinary text',
    limitDuplicate: 'Identical titles',
    limitDuplicateValue:
      'a second rule with the same title gets the suffix “-2”, a third “-3”: the identifier is derived from the title',
    limitBackups: 'Copies of the file',
    limitBackupsValue:
      'while “Back up before writing” is on in Settings (it is on by default) — a copy before every write; ten are kept, and the depth is changed there too (1 to 100). With the toggle off nothing is copied at all',
    limitSandbox: 'Sandbox',
    limitSandboxValue:
      'a separate config directory and its own working folder; the real settings are read-only, and everything created is removed no later than two hours of idling',

    undoTitle: 'How to undo',
    undoCaption: 'Action by action: what exactly comes back, and where to go for it.',
    undoToggle: 'Switched off the wrong rule',
    undoToggleText:
      'Put the toggle back — the text sat in the service section of the file all along and returns to its place.',
    undoEdit: 'The form is not saved yet',
    undoEditText:
      'Close the window with “Cancel”: until the save button is pressed CLAUDE.md does not change.',
    undoFile: 'You edited the file by hand',
    undoFileText:
      'On the CLAUDE.md page the “Discard changes” button returns the field to what is on disk.',
    undoDelete: 'You deleted a rule',
    undoDeleteText:
      'The toggle will not bring it back: the section was cut out of the file. What is left is a backup rollback in “Settings” — the whole file of that moment returns.',
    undoGroup: 'Switched off by a group',
    undoGroupText:
      'Switch the group back on. A rule switched off by hand will not come alive: the group mark and the manual one are independent.',

    notesTitle: 'Details people trip over',
    noteRestartTitle: 'Changes apply after a restart',
    noteRestartText:
      'Claude Code reads CLAUDE.md at session start. An open conversation keeps ' +
      'working by the old rules — that is not a fault.',
    noteRenameTitle: 'Renaming changes the identifier',
    noteRenameText:
      'The identifier is derived from the title. After a rename a link like ' +
      '/rules?id=old-name stops opening the rule; the marks for switching off and ' +
      'group membership are carried over by the panel itself.',
    noteSectionTitle: 'The service section at the end of the file is not junk',
    noteSectionText:
      'It holds the text of switched-off rules. Erase it by hand on the CLAUDE.md ' +
      'page and the text is gone — the toggle can no longer bring it back.',
    noteDeleteTitle: 'Deleting cuts the section out of the file',
    noteDeleteText:
      'A copy of the file stays in agentdeck/backups, but the rule is gone from ' +
      'CLAUDE.md itself. To switch a rule off temporarily use the toggle.',
    noteWordingTitle: 'Word it so it can be checked',
    noteWordingText:
      'A rule applies to every conversation. “Answer in Russian” is checkable, ' +
      '“write well” is not, and Claude cannot comply with the second.',

    formatTitle: 'The heading format is the only thing that makes a section a rule',
    formatCaption:
      'CLAUDE.md may be marked up any way you like: the panel turns only sections ' +
      'headed “## ПРАВИЛО: …” into cards. The preamble and ordinary sections stay in ' +
      'the file untouched and never reach the list.',
    formatRule: 'A rule',
    formatRuleText:
      '“## ПРАВИЛО: Отвечать по-русски” — a second-level heading, the word ПРАВИЛО in ' +
      'any case, the colon required; extra spaces around it do no harm.',
    formatPlain: 'An ordinary section',
    formatPlainText:
      '“## Язык общения”, “### ПРАВИЛО: …” (third level) or “## ПРАВИЛО without a colon” ' +
      'are not rules: the panel leaves such text alone and makes no cards out of it.',
    formatZero: 'Why the page says “0 rules”',
    formatZeroText:
      'A file marked up with ordinary “## ” sections gives an empty list — that is not ' +
      'a fault. The page then names how many such sections there are and shows the ' +
      'expected heading; rename the section you need on the CLAUDE.md page and it ' +
      'appears as a card.',
  },

  shots: {
    first: {
      '01-empty': 'The empty section names the heading format; the sidebar shows 0 for Rules',
      '02-form':
        'Simple mode: title, rule text and the assistant on the right — the file is untouched',
      '03-builder':
        'The builder: “allowed” and “not allowed” blocks, markdown assembled by the panel',
      '04-assistant':
        'The assistant returned the wording and marked the fields it changed: title and body',
      '05-card':
        'The rule in the list, the counter is 1, and the toast names the backup made before the write',
      '06-bulk': 'A list, one line per rule: “2 recognised” and the “Create all (2)” button',
      '07-sandbox':
        'The rule sandbox: what is wired in, where access comes from, the cost estimate and the answer to a test question',
    },
    living: {
      '01-list': 'Four rules: sandbox, edit, delete and a toggle on each',
      '02-search': 'The search for “миграции” found nothing — and the page says exactly that',
      '03-off': 'The toggle is off: marked “Switched off”, still in the list and in the counter',
      '04-file-disabled':
        'The same moment in the file: the text moved under “## Отключённые правила (AgentDeck)”',
      '05-zero':
        '“0 rules” in a non-empty file: 3 ordinary sections and a sample of the right heading',
    },
  },

  diagrams: {
    'rule-round-trip':
      'The path of one edit: form → server → backup → CLAUDE.md → session start. Only the “## ПРАВИЛО: …” heading makes a section a rule, and the panel has no database of its own.',
    'rule-states':
      'On, off, deleted: what the toggle and the bin do to the text in the file, where a group fits in, and why all of it exists for the personal level only.',
  },
};
