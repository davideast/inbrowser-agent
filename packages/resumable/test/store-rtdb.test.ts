/**
 * RTDB store integration test — runs the shared conformance suite
 * against a real RTDB instance. Skipped when credentials aren't
 * present in the environment.
 *
 * To run:
 *   PYRIC_RESUMABLE_TEST_RTDB_URL='https://your-db.firebaseio.com' \
 *   PYRIC_RESUMABLE_TEST_SA_FILE='/abs/path/to/sa.json' \
 *   bun test
 *
 * Optional: declare `.indexOn: ["expiresAt"]` on the rootPath so the
 * sweep cases hit the indexed query rather than the scan fallback.
 */
import { describe, it } from 'bun:test';
import { runJobStoreConformance } from './conformance';
import {
  createRtdbJobStore,
  serviceAccountTokenProvider,
} from '../src/store/rtdb';

const url = process.env.PYRIC_RESUMABLE_TEST_RTDB_URL;
const keyFile = process.env.PYRIC_RESUMABLE_TEST_SA_FILE;

if (url && keyFile) {
  // Isolate each test run under a unique root so concurrent / repeated
  // runs don't collide. Manual cleanup not needed — sweep cases delete
  // their own jobs; leftover roots are cheap.
  const rootPath = `test_resumable_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  runJobStoreConformance(
    `createRtdbJobStore @ ${rootPath}`,
    () =>
      createRtdbJobStore<string>({
        url,
        auth: serviceAccountTokenProvider({ keyFile }),
        rootPath,
        defaultTtlMs: 1000,
      }),
  );
} else {
  describe('createRtdbJobStore — skipped', () => {
    it.skip('set PYRIC_RESUMABLE_TEST_RTDB_URL + PYRIC_RESUMABLE_TEST_SA_FILE to run', () => {});
  });
}
