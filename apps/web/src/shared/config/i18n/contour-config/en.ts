import type { contourConfigRu } from './ru.ts';

/** English texts of the contour card sections, the rules choice and conflict winners; typed against the Russian module. */
export const contourConfigEn: typeof contourConfigRu = {
  sections: {
    title: 'Sections through this contour',
    text: 'An open section reaches the model through the contour, a closed one goes around it. A closed section is closed in the gateway on every request: for a run started earlier and for CLI files too.',
    inactive:
      'The contour is not active: no section goes through it right now. The switches decide who goes once you activate it.',
    open: 'open',
    closed: 'closed',
    foreignChat: '{{name}} chat',
    toggleLabel: '{{section}} through the contour',
    assistantOpens:
      'Opens by writing the address into the assistant setting — on the “Section access” tab.',
    terminalOpens: 'Opens by writing the address into CLI files — on the “Section access” tab.',
    terminalClosedFiles:
      'CLI files still point at the contour, but the gateway does not let their requests through. To restore the files, use “Undo the apply”.',
    openAccess: 'Open on the “Section access” tab',
    unavailable:
      'Not available on this contour: {{names}}. The reasons are on the “Section access” tab.',
    media: 'Images and presentations',
    mediaText:
      'Always through the active contour: they have no switch of their own, and the gateway does not close them.',
    untagged:
      'The gateway lets an address without a section mark through: panel checks, images and CLI files written before this version go that way. Apply such files again — the old address will show as a conflict.',
    saved: 'Section access saved',
  },
  rules: {
    title: 'Whose rules apply',
    choiceLabel: 'Whose rules apply to a run through the contour',
    applies: {
      both: 'Both sets',
      contour: 'Contour rules only',
      ours: 'Ours only',
    },
    appliesText: {
      both: 'The contour rules go into the request, our layers into the run. Where they overlap, the rows below say who wins.',
      contour:
        'Our layers (personal rules, hooks, permissions, skills, MCP, the prompt addition) are removed from runs through the contour. The contour rules go as set.',
      ours: 'The contour rules do not go into the request: the contour only receives “no contour tools”. Our layers follow their own switches.',
    },
    keeps:
      'The data mask and the tool shim are not rules: the choice leaves them alone. What the contour owner turns on at their side (checks, data substitution, knowledge base, history compaction) the panel cannot turn off at all.',
    sideOff: 'Removed by the “{{choice}}” choice: it does not reach the run. The values are kept.',
    overlaps: 'Overlaps with our rules: {{count}}',
    overlapsActive: 'in conflict now: {{count}}',
    noOverlaps: 'No overlaps: the contour declared no rules that touch ours.',
    openRules: 'Open the rules',
    saved: 'Rules choice saved',
  },
  overlap: {
    badge: 'overlap',
    with: 'overlaps: {{what}}',
    ours: {
      toolShim: 'the tool shim',
      dlp: 'the data mask',
      checkpoints: 'panel checkpoints',
      promptGate: 'the prompt gate',
    },
    elsewhere: 'Our rules outside this column that overlap the contour',
    oursTitle: {
      checkpoints: 'Panel checkpoints',
      promptGate: 'Prompt gate',
    },
  },
  winner: {
    tools:
      'The contour wins: with its tool set the shim does not switch on at all — both cannot be on.',
    anonymization:
      'Both apply, ours first: the mask hides values before sending, the contour substitutes on its side.',
    compaction:
      'The contour wins: it compacts the history at its side, and panel checkpoints do not undo that.',
    guardrails:
      'Both apply, ours first: the prompt gate refuses before sending, the contour guardrails at its side.',
    contour: 'The contour wins.',
    ours: 'The panel wins.',
    both: 'Both sides apply in turn.',
  },
  offBy: {
    contour:
      'The contour side is removed by the “Ours only” choice — there is no conflict in the run.',
    ours: 'Our side is removed by the “Contour rules only” choice — there is no conflict in the run.',
  },
  access: {
    consumersHint:
      'A run gets the gateway address in the variables of ITS OWN process: “chat through the contour, tests with my own key” is a choice, not a wish. An unticked switch closes the section in the gateway at once — for runs already going, too.',
    filesStay:
      'CLI files stay applied, but the gateway no longer lets terminal requests through. To restore the files themselves, press “Undo the apply” on the contour card.',
  },
};
