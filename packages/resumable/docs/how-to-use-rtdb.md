# How To Use RTDB For Durable Jobs

Use the RTDB store when a job log must survive server restarts or a subscriber
reconnecting to a different process.

## Configure The Store

```ts
import { createJobEngine } from '@inbrowser/resumable';
import {
  createRtdbJobStore,
  serviceAccountTokenProvider,
} from '@inbrowser/resumable/rtdb';

type Event = { kind: 'chunk'; text: string };

const store = createRtdbJobStore<Event>({
  url: process.env.RTDB_URL!,
  auth: serviceAccountTokenProvider({
    keyFile: './service-account.json',
  }),
  rootPath: 'resumable_jobs',
  defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
});

const engine = createJobEngine<Event>({
  store,
  sweep: {
    intervalMs: 60 * 60 * 1000,
  },
});
```

`defaultTtlMs` is post-terminal retention. A running job never expires because
`expiresAt` is not assigned until `finish()`.

The store preserves job state and events. It does not restart a producer that
was killed with its process.

## Add The RTDB Sweep Index

Declare an index on the same root path you pass to `createRtdbJobStore`:

```json
{
  "rules": {
    "resumable_jobs": {
      ".indexOn": ["expiresAt"]
    }
  }
}
```

Without the index, `sweepExpired` falls back to a full scan and calls `onWarn`
if you provided one.

## Use A Service Account Token Provider

The built-in `serviceAccountTokenProvider` mints OAuth access tokens from a
service account JSON file or object:

```ts
const auth = serviceAccountTokenProvider({
  keyJson: JSON.parse(process.env.SERVICE_ACCOUNT_JSON!),
});
```

The default scopes are the RTDB REST minimum:

- `https://www.googleapis.com/auth/firebase.database`
- `https://www.googleapis.com/auth/userinfo.email`

Use `staticTokenProvider(token)` only when another part of your system refreshes
the token.

## Sweep Expired Jobs

Stores without native backend TTL expose `sweepExpired`. The engine can run it
on an interval:

```ts
const engine = createJobEngine<Event>({
  store,
  sweep: {
    intervalMs: 60 * 60 * 1000,
    statusFilter: ['done', 'error', 'cancelled'],
    onResult: (result) => {
      console.log('sweep', result);
    },
  },
});
```

If your host already has a scheduler, you can also call the store directly:

```ts
await store.sweepExpired?.({
  olderThan: Date.now(),
  batchSize: 200,
});
```

## Verify Durability And TTL

Run the probes from `@inbrowser/resumable/testing` against the same RTDB namespace:

```ts
import { probeStoreDurability, probeSweepTtl } from '@inbrowser/resumable/testing';

const makeStore = () =>
  createRtdbJobStore<Event>({
    url: process.env.RTDB_URL!,
    auth,
    rootPath: 'resumable_probe_jobs',
    defaultTtlMs: 1000,
  });

const durability = await probeStoreDurability({
  makeStore,
  makeEvent: (i) => ({ kind: 'chunk', text: `event-${i}` }),
});

if (!durability.ok) {
  throw new Error(durability.reason);
}

const ttlStore = makeStore();
const ttl = await probeSweepTtl({
  store: ttlStore as typeof ttlStore & {
    sweepExpired: NonNullable<typeof ttlStore.sweepExpired>;
  },
  makeEvent: (i) => ({ kind: 'chunk', text: `event-${i}` }),
});

if (!ttl.ok) {
  throw new Error(ttl.reason);
}
```

For package integration tests, set:

```sh
PYRIC_RESUMABLE_TEST_RTDB_URL='https://your-db.firebaseio.com' \
PYRIC_RESUMABLE_TEST_SA_FILE='/abs/path/to/service-account.json' \
bun test packages/resumable/test/store-rtdb.test.ts
```

## Operational Notes

- Keep each deployment under a stable `rootPath`. Changing it creates a new job
  namespace.
- Set `defaultTtlMs` to match how long clients may reasonably reconnect.
- Call `engine.stop()` during graceful shutdown so scheduled sweeps stop cleanly.
- Store event payloads that are safe to persist. The RTDB store preserves event
  values as JSON strings, but it does not encrypt or redact them.
