/**
 * Сборка английской справки. Текст раздела — в `./en/topics/<раздел>.ts`,
 * рядом с русским близнецом и типизированный по нему: раздел переводят
 * по одному файлу, а не правкой общего словаря.
 */

import type { HelpSchema } from './ru';
import { chatEn } from './en/topics/chat';
import { overviewEn } from './en/topics/overview';
import { analyticsEn } from './en/topics/analytics';
import { settingsEn } from './en/topics/settings';
import { groupsEn } from './en/topics/groups';
import { pluginsEn } from './en/topics/plugins';
import { envEn } from './en/topics/env';
import { mcpEn } from './en/topics/mcp';
import { permissionsEn } from './en/topics/permissions';
import { scriptsEn } from './en/topics/scripts';
import { hooksEn } from './en/topics/hooks';
import { skillsEn } from './en/topics/skills';
import { commandsEn } from './en/topics/commands';
import { rulesEn } from './en/topics/rules';
import { claudeMdEn } from './en/topics/claudeMd';
import { searchEn } from './en/topics/search';
import { compareEn } from './en/topics/compare';
import { historyEn } from './en/topics/history';
import { testsEn } from './en/topics/tests';
import { projectsEn } from './en/topics/projects';
import { dlpEn } from './en/topics/dlp';
import { panelAgentEn } from './en/topics/panelAgent';
import { platformEn } from './en/topics/platform';
import { endpointsEn } from './en/topics/endpoints';
import { providersEn } from './en/topics/providers';
import { integrationsEn } from './en/topics/integrations';
import { promptsEn } from './en/topics/prompts';
import { portabilityEn } from './en/topics/portability';

/** Типизирован по русской версии: забыть ключ при переводе не получится. */
export const helpEn: HelpSchema = {
  index: {
    subtitle: 'How every section of the panel works',
    lead:
      'The panel has no database of its own: everything you change here is a ' +
      'Claude Code configuration file on your disk. That is why each help ' +
      'article starts by naming the exact file it edits and when the change ' +
      'reaches Claude.',

    howTitle: 'How the app is put together',
    howCaption:
      'There is no database behind the panel, and two things follow from that. ' +
      'The same files can be edited by hand outside the panel, and almost every ' +
      'change reaches Claude only after a restart.',
    howPanel: 'The panel',
    howPanelCaption: 'forms, lists, assistant',
    howFiles: 'Files in ~/.claude',
    howFilesCaption: 'CLAUDE.md, settings.json, skills/…',
    howClaude: 'Claude Code',
    howClaudeCaption: 'reads them when a session starts',
    howEdgeWrite: 'write with a backup',
    howEdgeRestart: 'restart',

    helpTitle: 'How to use the help itself',
    helpButton: 'The “?” button on a page',
    helpButtonText:
      'Next to the heading of every section sits a question mark that opens the ' +
      'walkthrough for that section. The question usually comes up on the page itself, ' +
      'not in the contents.',
    helpLink: 'Links can be shared',
    helpLinkText:
      'The address of an article contains the section name, so a link to the right ' +
      'explanation can be sent to a colleague or saved. Links to a specific rule, skill ' +
      'or server inside the sections work the same way.',
    helpNav: 'Moving to the next section',
    helpNavText:
      'At the bottom of each article are links to the previous and next one. The help ' +
      'can be read straight through without going back to the contents.',
    helpAssistant: 'An assistant in almost every form',
    helpAssistantText:
      'Rules, skills, hooks, scripts, servers, permissions, variables, groups and ' +
      'scenarios can all be filled in by the assistant: describe the task in words and ' +
      'it returns ready fields. It runs on your subscription; no separate key is needed.',

    sectionsTitle: 'Sections',
    sectionsCaption: 'Each card is a detailed walkthrough of its section of the panel.',

    notFoundTitle: 'No such help article',
    notFoundText: 'The link may be out of date. Open the list of sections and pick one.',
  },

  common: {
    back: 'All sections',
    openSection: 'Go to the section',
    storageTitle: 'Where this lives',
    fieldName: 'Field',
    fieldPurpose: 'What it controls',
    required: 'required',
    prevTopic: 'Previous section',
    nextTopic: 'Next section',
    canTitle: 'What you can do here',
    cantTitle: 'What is not here',
    whyTitle: 'Why this exists',
    howTitle: 'How it works',
    recipesTitle: 'How to do it',
    assistantTitle: 'The assistant',
    notesTitle: 'Things people trip over',
    onlyOnCreate: 'when creating only',
    readOnly: 'read only',
  },

  shots: {
    sidePlatform: 'Contour admin',
    sidePanel: 'Panel',
    chat: chatEn.shots,
    platform: platformEn.shots,
    tests: testsEn.shots,
    rules: rulesEn.shots,
    claudeMd: claudeMdEn.shots,
    projects: projectsEn.shots,
    groups: groupsEn.shots,
    permissions: permissionsEn.shots,
    mcp: mcpEn.shots,
    env: envEn.shots,
    skills: skillsEn.shots,
    commands: commandsEn.shots,
    hooks: hooksEn.shots,
    scripts: scriptsEn.shots,
    plugins: pluginsEn.shots,
    overview: overviewEn.shots,
    search: searchEn.shots,
    analytics: analyticsEn.shots,
    history: historyEn.shots,
    portability: portabilityEn.shots,
    compare: compareEn.shots,
    settings: settingsEn.shots,
    providers: providersEn.shots,
    endpoints: endpointsEn.shots,
    integrations: integrationsEn.shots,
    prompts: promptsEn.shots,
    dlp: dlpEn.shots,
    panelAgent: panelAgentEn.shots,
  },

  diagrams: {
    label: 'Diagram',
    open: 'open at full size',
    chat: chatEn.diagrams,
    platform: platformEn.diagrams,
    tests: testsEn.diagrams,
    rules: rulesEn.diagrams,
    claudeMd: claudeMdEn.diagrams,
    projects: projectsEn.diagrams,
    groups: groupsEn.diagrams,
    permissions: permissionsEn.diagrams,
    mcp: mcpEn.diagrams,
    env: envEn.diagrams,
    skills: skillsEn.diagrams,
    commands: commandsEn.diagrams,
    hooks: hooksEn.diagrams,
    scripts: scriptsEn.diagrams,
    plugins: pluginsEn.diagrams,
    overview: overviewEn.diagrams,
    search: searchEn.diagrams,
    analytics: analyticsEn.diagrams,
    history: historyEn.diagrams,
    compare: compareEn.diagrams,
    settings: settingsEn.diagrams,
    providers: providersEn.diagrams,
    endpoints: endpointsEn.diagrams,
    integrations: integrationsEn.diagrams,
    dlp: dlpEn.diagrams,
    panelAgent: panelAgentEn.diagrams,
  },

  topics: {
    chat: chatEn.topic,
    overview: overviewEn.topic,
    analytics: analyticsEn.topic,
    settings: settingsEn.topic,
    groups: groupsEn.topic,
    plugins: pluginsEn.topic,
    env: envEn.topic,
    mcp: mcpEn.topic,
    permissions: permissionsEn.topic,
    scripts: scriptsEn.topic,
    hooks: hooksEn.topic,
    skills: skillsEn.topic,
    commands: commandsEn.topic,
    rules: rulesEn.topic,
    claudeMd: claudeMdEn.topic,
    search: searchEn.topic,
    compare: compareEn.topic,
    history: historyEn.topic,
    portability: portabilityEn.topic,
    tests: testsEn.topic,
    projects: projectsEn.topic,
    dlp: dlpEn.topic,
    panelAgent: panelAgentEn.topic,
    platform: platformEn.topic,
    endpoints: endpointsEn.topic,
    providers: providersEn.topic,
    integrations: integrationsEn.topic,
    prompts: promptsEn.topic,
  },
};
