# Diagnostic golden tasks

Reproducible task fixtures for the five diagnostic-heavy skills in the
firebase agent: `firestore-rules-audit`, `firebase-project-audit`,
`rtdb-data-modeling`, `firebase-security-rules`, and `firebase-client-sdk`.

The companion `generative/` directory (added by `eval/golden-tasks-generative`)
covers the other four skills.

## Directory layout

```
diagnostic/
  firestore-rules-audit/
    open-write-users.fixture.json
    recursive-wildcard-override.fixture.json
    missing-validation-on-create.fixture.json
  firebase-project-audit/
    root-write-true.fixture.json
    write-without-validate.fixture.json
  rtdb-data-modeling/
    nested-posts-under-user.fixture.json
    god-node-followers.fixture.json
  firebase-security-rules/
    lock-root-keep-public-posts.fixture.json
    add-owner-only-write-validation.fixture.json
  firebase-client-sdk/
    auth-gated-on-value-listener.fixture.json
    fan-out-multi-location-update.fixture.json
    cursor-paginated-query.fixture.json
```

One subdirectory per skill. One fixture per file. The skill name appears in
both the directory name and the fixture's `skill` field, so the loader can
work on either side.

## Adding a fixture

1. Pick the skill. The five diagnostic skill names are listed above and are
   the only legal values for the `skill` field in this directory.
2. Pick a short kebab-case case name. The case name does not need to embed
   the skill — the directory already does that. Good case names describe
   what is being tested in two or three words.
3. Create `<skill>/<case-name>.fixture.json`. The filename suffix
   `.fixture.json` is significant: the `loadFixtures` helper from
   `@inbrowser/agent/node` only picks up files with that suffix.
4. The fixture's `id` is `<skill>/<case-name>` and must match the path.
5. Fill in the four required fields: `id`, `skill`, `description`, `prompt`,
   `successSpec`. Optionally add `notes` for free-form prose and
   `initialState` for seeded workspace content.
6. Pick a success spec name from the starter library shipped by
   `eval/success-spec-framework`. If your case needs a spec that does not
   exist yet, document it in the branch status file and coordinate with the
   spec-framework owner before merging — the harness can only score a
   fixture once its spec is registered.

## Success spec grounding

Each fixture's success spec is grounded in what the underlying skill's
playbook says verifies the work. The diagnostic skills produce reports;
their fixtures use `report-mentions/*` specs to look for the planted finding
in the assistant's final reply. The rules-editing skill mutates the
workspace's rules; its fixtures use `final-rules-includes/literal` or
`final-rules-excludes/literal`. The client-SDK skill generates code that
runs under the playground's run-once tool; its fixtures use
`final-runtime/run-summary-ok`.

## Loading fixtures from code

```ts
import { loadFixtures } from '@inbrowser/agent/node';
import { join } from 'node:path';

const fixturesRoot = new URL('../fixtures/diagnostic/', import.meta.url);
const skills = [
  'firestore-rules-audit',
  'firebase-project-audit',
  'rtdb-data-modeling',
  'firebase-security-rules',
  'firebase-client-sdk',
];
for (const skill of skills) {
  const fixtures = loadFixtures(join(fixturesRoot.pathname, skill));
  // ... drive each fixture through the harness ...
}
```

`loadFixtures` does not recurse, so the loader walks one skill directory at
a time. A `*.fixture.json` filter is built into the loader, so README files
and other non-fixture content in the same directory are ignored.
