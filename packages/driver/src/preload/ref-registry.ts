import {
  DriverError,
  type DriverErrorCode,
  type RefId,
  type SemanticFingerprint,
  type SnapshotRevision,
  type TargetSpec,
} from '../types.js';
import { HostMap, HostWeakMap, HostWeakRef, doc, normSpace } from './intrinsics.js';
import { isComposedDescendant, isElementObservableInScope, scanLiveDom } from './observe.js';

export interface SemanticCandidateItem<T = Element> {
  readonly target: T;
  readonly fingerprint: SemanticFingerprint;
}

export type FingerprintMatchOutcome<C> =
  | { readonly status: 'matched'; readonly candidate: C }
  | { readonly status: 'ambiguous'; readonly candidates: readonly SemanticFingerprint[] }
  | { readonly status: 'not_found'; readonly candidates: readonly SemanticFingerprint[] };

export function failDriver(
  code: DriverErrorCode,
  msg: string,
  candidates?: readonly SemanticFingerprint[],
): never {
  throw new DriverError(code, msg, candidates !== undefined ? { candidates } : undefined);
}

export function failNotFound(msg: string, c?: readonly SemanticFingerprint[]): never {
  return failDriver('DRIVER_TARGET_NOT_FOUND', msg, c);
}

export function failAmbiguous(msg: string, c: readonly SemanticFingerprint[]): never {
  return failDriver('DRIVER_TARGET_AMBIGUOUS', msg, c);
}

export function rankNearestCandidates<T>(
  candidates: readonly SemanticCandidateItem<T>[],
  q: {
    readonly role: string;
    readonly name: string;
    readonly landmark?: string;
    readonly driverId?: string;
    readonly nth?: number;
  },
  limit = 8,
): readonly SemanticFingerprint[] {
  const sameRole = q.role ? candidates.filter((c) => c.fingerprint.role === q.role) : [];
  const sub = (a: string | undefined, b: string | undefined, eq: number): number => {
    if (!a || !b) return 0;
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    return lb === la ? eq : lb.includes(la) || la.includes(lb) ? eq / 2 : 0;
  };
  return (sameRole.length ? sameRole : candidates)
    .map(
      ({ fingerprint: fp }, idx) =>
        [
          fp,
          idx,
          (q.role && fp.role === q.role ? 100 : 0) +
            (q.landmark !== undefined && fp.landmark === q.landmark ? 30 : 0) +
            sub(q.driverId, fp.driverId, 80) +
            sub(q.name, fp.name, 50),
        ] as const,
    )
    .sort((a, b) => b[2] - a[2] || a[1] - b[1])
    .slice(0, limit)
    .map((x) => x[0]);
}

const sameCohort = (a: SemanticFingerprint, b: SemanticFingerprint): boolean =>
  a.role === b.role && a.name === b.name && a.landmark === b.landmark && a.driverId === b.driverId;

export function matchStoredFingerprint<C extends SemanticCandidateItem<unknown>>(
  stored: { readonly fingerprint: SemanticFingerprint; readonly cohortSize: number },
  candidates: readonly C[],
): FingerprintMatchOutcome<C> {
  const cohort = candidates.filter((c) => sameCohort(c.fingerprint, stored.fingerprint));
  if (cohort.length === 0) {
    return {
      status: 'not_found',
      candidates: rankNearestCandidates(candidates, stored.fingerprint),
    };
  }
  if (cohort.length === stored.cohortSize) {
    const picked = cohort[cohort.length === 1 ? 0 : stored.fingerprint.nth];
    if (picked !== undefined) return { status: 'matched', candidate: picked };
  }
  return { status: 'ambiguous', candidates: cohort.map((c) => c.fingerprint) };
}

export function isRefId(value: string): value is RefId {
  return /^e\d+$/.test(value);
}

type StoredRefTuple = [
  weakEl: WeakRef<Element>,
  fingerprint: SemanticFingerprint,
  cohortSize: number,
  lastSeenRev: SnapshotRevision,
];

const MAX_STORED_REFS = 2_000;
let curRev = 0;
let nextSeq = 1;
const elToRef = /* @__PURE__ */ new HostWeakMap<Element, RefId>();
const entries = /* @__PURE__ */ new HostMap<RefId, StoredRefTuple>();

export const currentRevision = (): SnapshotRevision => curRev;
export const syncMinRevision = (minRev: SnapshotRevision): void => {
  if (minRev > curRev) curRev = minRev;
};
export const nextRevision = (): SnapshotRevision => ++curRev;
export const getRefEntry = (ref: RefId): StoredRefTuple | undefined => entries.get(ref);

export function assignRef(
  el: Element,
  fp: SemanticFingerprint,
  cohortSize: number,
  rev: SnapshotRevision,
): RefId {
  const store = (ref: RefId): RefId => {
    elToRef.set(el, ref);
    entries.set(ref, [new HostWeakRef(el), fp, cohortSize, rev]);
    return ref;
  };
  const existing = elToRef.get(el);
  if (existing !== undefined) return store(existing);

  let healRef: RefId | undefined;
  let healRev = -1;
  for (const [ref, [weakEl, efp, eSize, eRev]] of entries) {
    if (
      eSize === cohortSize &&
      sameCohort(efp, fp) &&
      efp.nth === fp.nth &&
      !weakEl.deref()?.isConnected &&
      eRev > healRev
    ) {
      healRef = ref;
      healRev = eRev;
    }
  }
  if (healRef) return store(healRef);

  const ref = store(`e${nextSeq++}`);
  if (entries.size > MAX_STORED_REFS) {
    for (const [k, [w]] of entries) {
      if (!w.deref()?.isConnected) {
        entries.delete(k);
        if (entries.size <= MAX_STORED_REFS) break;
      }
    }
  }
  return ref;
}

export function failMiss(
  msg: string,
  root: ParentNode,
  role = '',
  name = '',
  pool?: readonly SemanticCandidateItem<unknown>[],
  driverId?: string,
): never {
  return failNotFound(
    msg,
    rankNearestCandidates(pool ?? scanLiveDom(root, false), {
      role,
      name,
      ...(driverId ? { driverId } : {}),
    }),
  );
}

export function resolveTarget(spec: TargetSpec, scopeRoot?: ParentNode): Element {
  const root: ParentNode = scopeRoot ?? doc ?? failNotFound('No root.');
  function miss(
    msg: string,
    role = '',
    name = '',
    pool?: readonly SemanticCandidateItem<unknown>[],
    driverId?: string,
  ): never {
    return failMiss(msg, root, role, name, pool, driverId);
  }

  if (typeof spec === 'string') {
    if (!isRefId(spec)) miss(spec, '', spec);
    const entry = entries.get(spec);
    if (!entry) miss(spec);
    const liveEl = entry[0].deref();
    if (liveEl && isElementObservableInScope(liveEl, root)) return liveEl;

    const outcome = matchStoredFingerprint(
      { fingerprint: entry[1], cohortSize: entry[2] },
      scanLiveDom(root, false),
    );
    if (outcome.status === 'matched') {
      entry[0] = new HostWeakRef(outcome.candidate.target);
      elToRef.set(outcome.candidate.target, spec);
      return outcome.candidate.target;
    }
    return outcome.status === 'ambiguous'
      ? failAmbiguous(spec, outcome.candidates)
      : failNotFound(spec, outcome.candidates);
  }

  const pickSingle = (
    matches: readonly SemanticCandidateItem<Element>[],
    nth: number | undefined,
    label: string,
  ): Element => {
    const fps = (): readonly SemanticFingerprint[] => matches.map((m) => m.fingerprint);
    if (nth !== undefined) return matches[nth]?.target ?? failNotFound(`nth=${String(nth)}`, fps());
    return matches.length > 1 ? failAmbiguous(label, fps()) : matches[0]!.target;
  };

  if ('role' in spec || 'driver' in spec) {
    const live = scanLiveDom(root, false);
    if ('role' in spec) {
      const role = spec.role.trim().toLowerCase();
      const name = spec.name !== undefined ? normSpace(spec.name) : undefined;
      const matches = live.filter(
        ({ fingerprint: f }) => f.role === role && (name === undefined || f.name === name),
      );
      if (!matches.length) miss(spec.role, role, name ?? '', live);
      return pickSingle(matches, spec.nth, spec.role);
    }
    const drv = normSpace(spec.driver);
    const matches = drv ? live.filter(({ fingerprint: f }) => f.driverId === drv) : [];
    if (!matches.length) miss(spec.driver, '', drv, live, drv);
    return pickSingle(matches, spec.nth, drv);
  }

  const query = normSpace(spec.text);
  const exact = spec.exact === true;
  const lq = query.toLowerCase();
  const matched = query
    ? scanLiveDom(root, true).filter((c) =>
        [c.text, c.fingerprint.name].some((s) =>
          exact ? s === query : s.toLowerCase().includes(lq),
        ),
      )
    : [];
  if (!matched.length) miss(spec.text, '', query);
  const deepest = matched.filter(
    (o) => !matched.some((i) => i.target !== o.target && isComposedDescendant(o.target, i.target)),
  );
  return pickSingle(deepest, undefined, spec.text);
}
