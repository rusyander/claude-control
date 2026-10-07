// Frontend-doctrine scaffolder (plop). Goes to the project root on request.
// Install: npm i -D plop ; run: npx plop  (or "scaffold": "plop" in package.json).
// Generators emit the doctrine shape: named exports, one folder per component with its satellites,
// PascalCase files everywhere, kebab-case slice folders in shared, index.ts only at a SLICE boundary
// (colocation.md) — never inside a component folder.

const COMPONENT_TSX = `import type { {{pascalCase name}}Props } from './{{fileBase}}.types';
// import styles from './{{fileBase}}.module.scss';

export const {{pascalCase name}} = (props: {{pascalCase name}}Props) => {
  return <div>{{pascalCase name}}</div>;
};
`;

const COMPONENT_TYPES = `export interface {{pascalCase name}}Props {
  // TODO: props (>3 → one object; types live here only, never inline)
}
`;

const COMPONENT_INDEX = `export { {{pascalCase name}} } from './{{fileBase}}';
export type { {{pascalCase name}}Props } from './{{fileBase}}.types';
`;

const COMPONENT_SCSS = `.root {
}
`;

const COMPONENT_TEST = `import { render } from '@testing-library/react';

import { {{pascalCase name}} } from './{{fileBase}}';

describe('{{pascalCase name}}', () => {
  it('renders', () => {
    render(<{{pascalCase name}} />);
  });
});
`;

const COMPONENT_STORIES = `import type { Meta, StoryObj } from '@storybook/react';

import { {{pascalCase name}} } from './{{fileBase}}';

const meta: Meta<typeof {{pascalCase name}}> = { component: {{pascalCase name}} };
export default meta;

export const Default: StoryObj<typeof {{pascalCase name}}> = {};
`;

const ENTITY_API = `import axios from 'axios';

// API types live beside the transport (ADR-005)
export interface {{pascalCase name}} {
  id: string;
}

export const get{{pascalCase name}} = async (id: string): Promise<{{pascalCase name}}> => {
  const response = await axios.get<{{pascalCase name}}>(\`/api/{{camelCase name}}s/\${id}\`);
  return response.data;
};
`;

const ENTITY_HOOK = `import { useQuery } from '@tanstack/react-query';

import { get{{pascalCase name}} } from './{{camelCase name}}.api';
import { {{camelCase name}}Keys } from './queryKeys';

export const use{{pascalCase name}} = (id: string) =>
  useQuery({
    queryKey: {{camelCase name}}Keys.detail(id),
    queryFn: () => get{{pascalCase name}}(id),
  });
`;

const ENTITY_KEYS = `export const {{camelCase name}}Keys = {
  all: ['{{camelCase name}}'] as const,
  detail: (id: string) => [...{{camelCase name}}Keys.all, 'detail', id] as const,
};
`;

const ENTITY_INDEX = `export { get{{pascalCase name}} } from './api/{{camelCase name}}.api';
export type { {{pascalCase name}} } from './api/{{camelCase name}}.api';
export { use{{pascalCase name}} } from './api/use{{pascalCase name}}';
export { {{camelCase name}}Keys } from './api/queryKeys';
`;

export default function (plop) {
  // Component. Outside shared: <layer>/<segment>/<Name>/<Name>.tsx, no barrel inside (the slice's
  // index.ts re-exports it). In shared: shared/<segment>/<kebab-slice>/<Name>.tsx + index.ts — the
  // one-component slice folder is the component folder, and its index.ts is the slice API.
  plop.setGenerator('component', {
    description:
      'Component in doctrine shape (folder + types [+ scss/test/stories]; index.ts only for a shared slice)',
    prompts: [
      { type: 'input', name: 'name', message: 'Component name (PascalCase):' },
      {
        type: 'list',
        name: 'layer',
        message: 'Layer:',
        choices: ['features', 'entities', 'pages', 'shared'],
      },
      {
        type: 'input',
        name: 'segment',
        message: 'Path inside the layer (e.g. OrderDetails/ui, or ui for shared):',
        default: 'ui',
      },
      {
        type: 'checkbox',
        name: 'extras',
        message: 'Extra files:',
        choices: ['module.scss', 'test', 'stories'],
      },
    ],
    actions: (data) => {
      const isShared = data.layer === 'shared';
      data.fileBase = plop.getHelper('pascalCase')(data.name);
      const folder = isShared ? plop.getHelper('kebabCase')(data.name) : data.fileBase;
      const dir = `src/${data.layer}/${data.segment}/${folder}`;
      const acts = [
        { type: 'add', path: `${dir}/${data.fileBase}.tsx`, template: COMPONENT_TSX },
        { type: 'add', path: `${dir}/${data.fileBase}.types.ts`, template: COMPONENT_TYPES },
      ];
      if (isShared) acts.push({ type: 'add', path: `${dir}/index.ts`, template: COMPONENT_INDEX });
      if (data.extras.includes('module.scss'))
        acts.push({
          type: 'add',
          path: `${dir}/${data.fileBase}.module.scss`,
          template: COMPONENT_SCSS,
        });
      if (data.extras.includes('test'))
        acts.push({
          type: 'add',
          path: `${dir}/${data.fileBase}.test.tsx`,
          template: COMPONENT_TEST,
        });
      if (data.extras.includes('stories'))
        acts.push({
          type: 'add',
          path: `${dir}/${data.fileBase}.stories.tsx`,
          template: COMPONENT_STORIES,
        });
      return acts;
    },
  });

  // Entity: axios function + Query hook + query keys (ADR-005, api.md)
  plop.setGenerator('entity', {
    description: 'Entity with an API layer: axios function + Query hook + query keys',
    prompts: [{ type: 'input', name: 'name', message: 'Entity name (singular, e.g. user):' }],
    actions: [
      {
        type: 'add',
        path: 'src/entities/{{pascalCase name}}/api/{{camelCase name}}.api.ts',
        template: ENTITY_API,
      },
      {
        type: 'add',
        path: 'src/entities/{{pascalCase name}}/api/use{{pascalCase name}}.ts',
        template: ENTITY_HOOK,
      },
      {
        type: 'add',
        path: 'src/entities/{{pascalCase name}}/api/queryKeys.ts',
        template: ENTITY_KEYS,
      },
      { type: 'add', path: 'src/entities/{{pascalCase name}}/index.ts', template: ENTITY_INDEX },
    ],
  });

  // Feature: ui/model/api skeleton + slice barrel
  plop.setGenerator('feature', {
    description: 'Feature skeleton: ui/model/api + index',
    prompts: [{ type: 'input', name: 'name', message: 'Feature name (PascalCase):' }],
    actions: [
      { type: 'add', path: 'src/features/{{pascalCase name}}/index.ts', template: 'export {};\n' },
      { type: 'add', path: 'src/features/{{pascalCase name}}/ui/.gitkeep', template: '' },
      { type: 'add', path: 'src/features/{{pascalCase name}}/model/.gitkeep', template: '' },
      { type: 'add', path: 'src/features/{{pascalCase name}}/api/.gitkeep', template: '' },
    ],
  });
}
