/** English twin of the environment passport article. Typed from the Russian one. */
export const portabilityEn = {
  topic: {
    title: 'Environment passport',
    summary:
      'What a CLI actually has configured, what of it reaches another one — and how to keep them in agreement',
    lead:
      'The section answers four questions in a row. What the chosen CLI actually ' +
      'has configured — as entries and named omissions, never as silence. What of ' +
      'it reaches another CLI and in what shape — the fidelity report. What ' +
      'exactly will change in the target files — the transfer plan, shown before ' +
      'the first write. And finally: should the target be kept in agreement from ' +
      'now on — a subscription to the panel canon. The passport and the report ' +
      'write nothing; only the transfer and the rebuild write, and every write ' +
      'starts with a backup.',

    guideTitle: 'How to read this page',
    guideText:
      'First, why the section exists at all and how a transfer differs from a ' +
      'subscription. Then two paths in screenshots: the one-off transfer ' +
      '(passport → fidelity → plan → applied) and the subscription (layers → ' +
      'rebuild plan → hand edit → outcome). After the screenshots: what the ' +
      'section is not, what it reads and writes, the five fidelity levels, limits ' +
      'and refusals, and the fine print.',

    whyPassport: 'You see what is actually configured',
    whyPassportText:
      'The panel reads the chosen CLI files and shows entries by kind: ' +
      'instructions, skills, commands, subagents, hooks, permissions, MCP ' +
      'servers, variables, secrets, plugins. A section that could not be read is ' +
      'shown with its reason, not as blank space: blank space reads as "I have ' +
      'none of that", and that would be a lie about your environment.',
    whyFidelity: 'You see what reaches the target and how',
    whyFidelityText:
      'Pick a target and every entry gets a level: natively, emulated, wired, as ' +
      'text, impossible. "Impossible" is named by a reason from a closed ' +
      'vocabulary, not in general terms. The report is computed before the ' +
      'transfer, so the decision rests on a forecast rather than on consequences.',
    whyTransfer: 'The transfer is visible before the first write',
    whyTransferText:
      'There is no "transfer" button without a shown plan — not "it is disabled", ' +
      'it is absent. First the list of files and the line-by-line diff, then the ' +
      'decision. A transfer is reverted whole: a backup is taken before every ' +
      'write.',
    whySubscription: 'The target can be kept in agreement',
    whySubscriptionText:
      'A one-off transfer answers "move what is there now". A subscription ' +
      'answers "keep this in agreement": the panel rebuilds the subscribed layers ' +
      'at the target from its own canon whenever you ask.',

    guide: {
      transferTitle: 'Path one. The one-off transfer',
      transferCaption:
        'Passport → fidelity report → plan → applied. The order is not decoration: ' +
        'each step answers the question the previous one raises.',
      transferPassport: 'Passport: what the source has',
      transferPassportText:
        'At the top: the source provider, the transfer target and the level (home ' +
        'or project). Below: entries by kind and the "entries" and "omissions" ' +
        'counters. An omission is a named reason: no such section, unreadable, ' +
        'format not parsed, empty, disabled. Only the unreadable ones are ' +
        'coloured: an empty section is a lawful part of an ordinary home.',
      transferFidelity: 'Fidelity report: what reaches the target',
      transferFidelityText:
        'The summary "N natively · M emulated · K wired · L as text · P ' +
        'impossible" is computed from the entries themselves. A number expands ' +
        'into a list, a row into the exact entry and its reason. The main warning ' +
        'stands on its own line above the table: how many entries work ONLY when ' +
        'started through the panel — a CLI you launch yourself will not see them.',
      transferPlan: 'Plan: what exactly changes in the files',
      transferPlanText:
        'Target files by name: how many are created, how many lines are added and ' +
        'removed, and a line-by-line diff for each. Next to the counters are the ' +
        'entry outcomes: written, already available, runtime only, not ' +
        'transferable, disabled at source, refused by target, needs your choice. ' +
        'A zero is shown just like a number. A file too large for a diff says so — ' +
        '"no diff was built" — and an edit to it between the plan and applying it ' +
        'is still noticed: the panel asks you to review the plan again.',
      transferApplied: 'Applied — and reverted whole',
      transferAppliedText:
        'After applying, a trace replaces the plan: when it was transferred, how ' +
        'many files, and the revert button. It survives a page reload. Files you ' +
        'edited AFTER the transfer are named one by one and are left alone by ' +
        'default: restoring a backup over your own edit would erase it silently.',

      subscribeTitle: 'Path two. Subscription and a hand edit',
      subscribeCaption:
        'Layers → rebuild plan → file touched by hand → outcome. The last step is ' +
        'the point: the panel cannot overwrite your edit silently.',
      subscribeLayers: 'Layers: what the target is subscribed to',
      subscribeLayersText:
        'A switch per layer. While none is subscribed there is nothing to ' +
        'rebuild — and that is said in words, not by blank space. The ' +
        'subscription canon is the panel own environment, not the source chosen ' +
        'above: the truth has exactly one owner and it is not a choice.',
      subscribePlan: 'Rebuild plan: what changes at the target',
      subscribePlanText:
        'Entries by state: new, changed, unchanged, gone from the canon. The ' +
        'unchanged ones are hidden but counted — there can be two hundred of ' +
        'them, and a list with them is unreadable while a list without them reads ' +
        'as "the canon holds only this". Again there is no "rebuild" button ' +
        'before a shown plan.',
      subscribeDrift: 'A file touched by hand is left alone',
      subscribeDriftText:
        'The panel remembers the fingerprint of every file it wrote. A file that ' +
        'changed since is held back: not one byte. On screen it is named by its ' +
        'state — "edited by hand" or "file is gone" — and three outcomes are ' +
        'offered. For a file that is gone, "take into the canon" is not offered: ' +
        'there is nothing to read.',
      subscribeResolved: 'Outcome done — the drift is gone',
      subscribeResolvedText:
        'After the outcome the stale plan leaves the screen: it listed a drift ' +
        'that no longer exists, and a fresh plan must not be substituted for the ' +
        'one you read. Press "show the plan" again — there will be no line about ' +
        'touched files in it.',
      carryTitle: 'Path three. Unfinished work',
      carryCaption:
        'The environment has moved — and the conversations stayed at the previous ' +
        'CLI. This section offers to continue them at the new one, and what travels ' +
        'is not the transcript but the checkpoint file and the original task.',
      carryList: 'What the panel offers to carry',
      carryListText:
        'A candidate is a conversation of ANOTHER CLI (Claude included) that has a ' +
        'working directory and was touched within the last day. The destination is ' +
        'named on the card and is not a choice: it is the active CLI, not the ' +
        'environment transfer target picked above. The source conversation is ' +
        'neither closed nor changed — carrying opens a new one instead of spoiling ' +
        'the old one. A note about the carry lands in the source conversation: with ' +
        'another CLI it stays there for good, while with Claude the feed is its own ' +
        'transcript, which the panel never writes into — it can only speak into a ' +
        'RUNNING run, and a conversation without one says so in the outcome instead ' +
        'of passing it over in silence.',
      carryRefusal: 'Why a row cannot be picked',
      carryRefusalText:
        'The safeguards are the same as for a clean-session continuation, and they ' +
        'are named right on the row: the chain reached its cap, there is no ' +
        'checkpoint file in the directory, the checkpoint has not changed since the ' +
        'last carry. The last one is the loop guard: the new conversation would read ' +
        'exactly what the previous one read. An unusable row stays in the list — ' +
        'were it to vanish, the list would read as "I have no such work". Apart from ' +
        'the safeguards there is the target itself: the run at the new CLI may never ' +
        'start, the storage may not create the conversation, and a created ' +
        'conversation may not receive the task. Those three are different troubles, ' +
        'fixed differently, and each is named in its own words after the count.',
    },

    notTitle: 'What this section is NOT',
    notCaption: 'The neighbours the passport is confused with most often.',
    notColumn: 'What is not here',
    notMeaningColumn: 'Where it actually lives',
    notInstall: 'Installing other CLIs',
    notInstallText:
      'The panel transfers settings, it does not install tools. Files are written ' +
      'even for a target that is not on the machine — but the fidelity of such a ' +
      'target is marked "not verified", never "works".',
    notCompare: 'A line-by-line comparison of two CLIs',
    notCompareText:
      'The table of "what one has and the other does not" is the Compare section. ' +
      'The answer here is different: what reaches the target and in what shape.',
    notHistory: 'Transferring conversation history',
    notHistoryText:
      'Transcripts do not travel into a foreign format — there is no such format. ' +
      'What travels is the environment: rules, skills, hooks, permissions, ' +
      'servers, variables. Unfinished WORK does travel, though — by path three: a ' +
      'conversation opens at the new CLI that reads the same checkpoint and knows ' +
      'the same task.',
    notMerge: 'Merging the configurations of two people',
    notMergeText:
      'A transfer is about one person, their environment and their machine. They ' +
      'never have two sources.',
    notLineMerge: 'A line-by-line merge of your edit with the canon',
    notLineMergeText:
      'A drift has three whole outcomes — take into the canon, restore the ' +
      'projection, stop writing into the file. There is deliberately no ' +
      'line-level merge: it would require guessing what you meant.',

    storageReads: 'What it reads',
    storageReadsValue:
      'the chosen CLI files in its own directory: instructions, skills, commands, ' +
      'subagents, hooks, permissions, MCP servers, variables, plugins',
    storageCanon: 'The subscription canon',
    storageCanonValue:
      'the panel own files (Claude). It is not a choice and is re-read every ' +
      'time — a stored canon would be a second truth',
    storageWrites: 'What it writes',
    storageWritesValue:
      'nothing until a transfer or a rebuild is pressed. Then — the TARGET files, ' +
      'with a backup before every write',
    storageState: 'What the panel remembers',
    storageStateValue:
      'subscriptions, the fingerprints of written files and the trace of the last ' +
      'transfer — so it can recognise your edit and offer a revert',
    storageSecrets: 'Secrets',
    storageSecretsValue:
      'a secret value is never transferred: the variable name travels, not its ' + 'contents',
    storageTarget: 'When the target sees this',
    storageTargetValue: 'at its next start: a CLI reads its configuration when the session begins',

    canPassport: 'Look at the passport of any installed CLI, not only the active one',
    canFidelity: 'Get the fidelity report before a transfer — five levels with reasons',
    canPlan: 'See the transfer plan by file and by line before the first write',
    canRevert: 'Revert a transfer whole, even after a page reload',
    canSubscribe: 'Subscribe the target to canon layers and rebuild it on request',
    canDrift: 'Resolve a hand edit through one of three outcomes',
    canProbe: 'Run the acceptance probe: start a real CLI in a temporary home',

    cantInstall: 'Install the target CLI — the panel transfers settings, not tools',
    cantSecretValue: 'Transfer a secret value: the variable name travels, not its contents',
    cantMerge: 'Merge your edit with the canon line by line — whole outcomes, no merge',
    cantTranscripts: 'Transfer conversation history: foreign CLIs have no format for it',
    cantSilent: 'Overwrite a hand-touched file silently — that path does not exist at all',

    levelsTitle: 'The five fidelity levels',
    levelsCaption:
      'A level answers one question: is this the same entry at the target — or a ' +
      'similar one, or none at all.',
    levelsColumn: 'Level',
    levelsMeaningColumn: 'What it means',
    levelNative: 'Natively',
    levelNativeText:
      'The target has the same mechanism and the entry becomes its entry. This is ' +
      'the only level at which nothing is lost.',
    levelEmulated: 'Emulated',
    levelEmulatedText:
      'The target has no such mechanism, but the panel achieves the same ' +
      'behaviour by its own means — usually through the supervisor that lives in ' +
      'a panel-started run. A CLI you launch directly will not see it.',
    levelWired: 'Wired',
    levelWiredText:
      'The behaviour is achieved through the contour in the request path: the ' +
      'panel sees the tool call and decides whether to let it through. Today the ' +
      'panel opens those gates in no run at all, so the level is granted to ' +
      'nobody: the entry stands at its fallback level with its own reason ' +
      'instead of promising enforcement that is not there. Once the wiring lands ' +
      'the level returns — and turning the contour off will drop it again.',
    levelText: 'As text',
    levelTextText:
      'The entry arrives as content, not as a mechanism: a skill becomes a piece ' +
      'of instructions. The model will read it, but such text cannot stop an ' +
      'action.',
    levelImpossible: 'Impossible',
    levelImpossibleText:
      'The reason is named exactly: the target has no such event, the entity ' +
      'lives inside a foreign process, the body of the entry is synced with an ' +
      'account and is not on disk. There is no "text is probably enough" here.',

    limitsTitle: 'Limits and refusals',
    limitsCaption:
      'What the panel answers instead of a transfer or a rebuild — and what to do about it.',
    limitsColumn: 'What you see',
    limitsMeaningColumn: 'Why, and what to do',
    limitRuntime: '"Works only when started through the panel"',
    limitRuntimeText:
      'The "emulated" level: the target has no such mechanism, and the behaviour ' +
      'is held by the supervisor that lives in a panel-started run. Launch the ' +
      'CLI from the panel section — or count these entries as not arrived. Today ' +
      "the supervisor replays the panel's own entries only — the prompt gate and " +
      'group scenario triggers; transferred hooks, skills, commands, subagents ' +
      'and keys at this level are not wired into a foreign run yet and arrive ' +
      'neither as a file nor through a panel-started run.',
    limitCollision: '"Needs your choice"',
    limitCollisionText:
      'The target already holds an entry with the same name and different ' +
      'content. By default the panel keeps yours and waits for a decision: keep, ' +
      'replace, rename. Neither wins silently.',
    limitChanged: '"The files have changed" instead of a transfer',
    limitChangedText:
      'The target files diverged from the plan you were reading. This is not an ' +
      'error: a fresh plan takes the place of the old one and the difference is ' +
      'visible. Read it and press again.',
    limitHeld: '"Will not travel: you edited this file by hand"',
    limitHeldText:
      'The file fingerprint does not match what the panel left behind. The ' +
      'rebuild goes around it entirely until you pick an outcome. This is the ' +
      'only way not to lose an edit silently.',
    limitCanonVersion: 'A whole rebuild: a different canon version',
    limitCanonVersionText:
      'The projection was built by an earlier version of the transfer vocabulary: ' +
      'the old fingerprints cannot be compared with the new ones, so not a single ' +
      'entry counts as agreed — the subscription is rebuilt whole, with the reason ' +
      'named above the plan. Files you edited by hand are still left alone: they ' +
      'are guarded by the file hash, and that is computed from the content, not ' +
      'from the vocabulary.',
    limitNewForever: '"New: N" next to "nothing to write"',
    limitNewForeverText:
      'Entries for which the target has no mechanism at all. They never become ' +
      'agreed — there would be nowhere for them to land — so they stay new. The ' +
      '"nothing to write" line next to them explains why the rebuild changes ' +
      'nothing.',
    limitNoCli: '"The target is not on this machine"',
    limitNoCliText:
      'The acceptance probe starts a REAL CLI, and without one there is nothing ' +
      'to measure. Files are still written: the transfer is allowed in advance, ' +
      'and the fidelity is honestly marked "not verified".',
    limitProjectLevel: 'The project-level passport is empty',
    limitProjectLevelText:
      'The "Project" level is picked but the project is not: there is nothing to ' +
      'ask the server, and a line says so. Pick a project from the panel registry.',

    noteCanonTitle: 'The subscription canon is the panel, not the chosen source',
    noteCanonText:
      'The provider at the top is the source of the ONE-OFF transfer and can be ' +
      'changed. The subscription canon is single and is not a choice: the panel ' +
      'own files. Otherwise the truth would have two owners, and the first ' +
      'rebuild would erase the work of the second.',
    noteBlockTitle: 'In a foreign file the panel keeps ITS OWN section',
    noteBlockText:
      'Where the file belongs to the target entirely, the file is rebuilt. Where ' +
      'the panel appends its own block to a foreign file, only the block is ' +
      'rebuilt — the text around it stays yours. The "restore the projection" ' +
      'outcome works exactly the same way: it restores the panel section, not the ' +
      'whole file.',
    noteUnsubscribeTitle: '"Stop writing into the file" drops ALL layers of that file',
    noteUnsubscribeText:
      'Leaving one layer subscribed would re-open the same drift on the next ' +
      'rebuild. The layers that will be dropped are listed before you press.',
    noteBackupTitle: 'A backup before every write',
    noteBackupText:
      'The transfer and the rebuild write through one mechanism, so their revert ' +
      'is shared and complete: applying does not start at all if a backup could ' +
      'not be taken. Half a transferred environment never stays behind.',
    noteRestartTitle: 'The target sees this at its next start',
    noteRestartText:
      'Files on disk change immediately, but a CLI reads its configuration when ' +
      'the session begins. A conversation already under way keeps the old rules.',
  },

  shots: {
    transfer: {
      '01-passport':
        'The Claude environment passport: entries by kind, the "Entries" and "Omissions" counters, the directory root and the chosen transfer target — Codex',
      '02-fidelity':
        'The fidelity report for a transfer into Codex: the summary over five levels, the "works only when started through the panel" line above the table and a reason on every entry',
      '03-plan':
        'The transfer plan: target files by name, "+N −M" for each, entry outcomes as separate badges and the line-by-line diff of what will end up in the file',
      '04-applied':
        'The transfer is applied: the date, the number of files and the "Revert the transfer" button in place of the plan',
    },
    subscribe: {
      '01-layers':
        'The Codex subscription to the panel canon: layer switches, the "No layer is subscribed" line and the note that the canon is the panel own environment',
      '02-plan':
        'The rebuild plan: new, changed, unchanged and gone from the canon; the unchanged ones are hidden behind the "Show unchanged" button',
      '03-drift':
        'A file touched by hand: the drift card marked "edited by hand" with three outcomes — take the edit into the canon, restore the projection, stop writing into the file',
      '04-resolved':
        'The outcome is done: the drift card is gone, the stale plan has left the screen and the button is back to "Show the rebuild plan"',
    },
    carry: {
      '01-list':
        'The "Unfinished work at other CLIs" card: the "Continue at: Claude Code" line names the active CLI, not the environment transfer target picked above; the Codex conversation shows its working directory and the checkpoint file the new conversation will read',
      '02-refusal':
        'An unusable conversation stays in the list: its switch is off and the reason is named on the row itself — there is no checkpoint file in the directory; the usable conversation next to it is still selectable',
    },
  },
};
