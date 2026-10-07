# Angular & Vue canon — audit playbook

## Angular (v17+ canon)

- **Components**: standalone components over NgModules in new code; `OnPush` (or signals) everywhere
  — default change detection on a large tree = P2.
- **Signals** for local reactive state; RxJS where streams genuinely compose. Mixed signal/subject
  soup for one concern = P2.
- **Subscriptions**: `async` pipe or `takeUntilDestroyed` — manual `subscribe` without teardown = P1
  leak. Nested subscribes = P2 (switchMap/combineLatest instead).
- **DI**: `inject()` fine; services `providedIn: 'root'` unless scoped deliberately; logic lives in
  services, components present.
- **Templates**: `trackBy` on `*ngFor`/`@for` lists; typed reactive forms (untyped `FormGroup` = P2);
  new control flow (`@if/@for`) in fresh code.
- **Routing**: lazy-loaded feature routes; guards/resolvers typed; no business logic in guards.

## Vue (3.x canon)

- **Composition API + `<script setup>`** in new code; Options API additions to a Comp-API codebase
  (or vice versa without a stated rule) = P3 consistency finding.
- **Reactivity integrity**: destructuring a `reactive()` loses reactivity = P1 when it ships;
  `toRefs`/`computed` instead. `ref` unwrapping honest in templates.
- **Derived state**: `computed`, not a `watch` that copies into another ref (= P2). `watchEffect`
  only for genuine side-effects with cleanup.
- **Props/emits**: typed (`defineProps<T>()`/`defineEmits`); mutation of props = P1; `defineModel`
  for v-model pairs.
- **State**: Pinia over Vuex in v3 code; stores hold shared state only — per-component state stays
  local.
- **Lists**: stable `:key`; `v-if` with `v-for` on one node = P2 (precedence trap).
- **Async**: `<Suspense>`/loading states deliberate; unhandled rejections in `setup` = P2.

## Both

- Route-level code splitting; bundle artifact backs any size finding.
- i18n: hardcoded user-facing strings where an i18n layer exists → route to `agentdeck-kit:i18n-audit`.
- Component libraries used idiomatically (no wrapper-of-wrapper shells around every widget = P3).
