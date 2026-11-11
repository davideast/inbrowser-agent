import type { ObservationSnapshot, RefId, SnapshotDiff, SnapshotNode } from '../types.js';
import { HostMap, HostSet, UrlCtor, reflectGet } from './intrinsics.js';

export function originAndPathname(rawUrl: string): string {
  if (UrlCtor) {
    try {
      const p = new UrlCtor(rawUrl);
      return `${p.origin !== 'null' ? p.origin : p.protocol}${p.pathname}`;
    } catch {
      // Relative or non-standard URL.
    }
  }
  return rawUrl.split(/[?#]/)[0]!;
}

const sameFlat = (a?: object, b?: object): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  return (
    ka.length === Object.keys(b).length && ka.every((k) => reflectGet(a, k) === reflectGet(b, k))
  );
};

const NODE_SCALAR_KEYS =
  'role name ref driverId intent value checked disabled expanded min max'.split(' ');

function sameNodeShallow(a: SnapshotNode, b: SnapshotNode): boolean {
  return (
    NODE_SCALAR_KEYS.every((k) => reflectGet(a, k) === reflectGet(b, k)) &&
    sameFlat(a.media, b.media) &&
    sameFlat(a.canvas, b.canvas)
  );
}

function shallowCopy(node: SnapshotNode): SnapshotNode {
  if (!node.children) return node;
  const { children: _omitted, ...shallow } = node;
  void _omitted;
  return shallow;
}

export function diffSnapshots(
  prev: ObservationSnapshot | null,
  next: ObservationSnapshot,
): SnapshotDiff {
  const fullReset = prev === null || originAndPathname(prev.url) !== originAndPathname(next.url);
  const prevRefs = new HostMap<RefId, SnapshotNode>();
  const prevOrder: RefId[] = [];
  const prevUnreffed = new HostMap<string, SnapshotNode>();
  const nextRefs = new HostSet<RefId>();
  const added: SnapshotNode[] = [];
  const changed: SnapshotNode[] = [];

  function walkTree(
    nodes: readonly SnapshotNode[],
    parentKey: string,
    inAdded: boolean,
    indexOnly: boolean,
  ): void {
    const counts = new HostMap<string, number>();
    for (const n of nodes) {
      let key: string | undefined = n.ref;
      if (n.ref !== undefined) {
        if (indexOnly) {
          prevRefs.set(n.ref, n);
          prevOrder.push(n.ref);
        } else {
          nextRefs.add(n.ref);
        }
      } else {
        const ord = counts.get(n.role) ?? 0;
        counts.set(n.role, ord + 1);
        key = `${parentKey}/${n.role}[${ord}]`;
        if (indexOnly) prevUnreffed.set(key, n);
      }
      if (indexOnly) {
        if (n.children) walkTree(n.children, key!, false, true);
      } else {
        const old = n.ref !== undefined ? prevRefs.get(n.ref) : prevUnreffed.get(key!);
        if (!old) {
          if (!inAdded) added.push(n);
          if (n.children) walkTree(n.children, key!, true, false);
        } else {
          if (!sameNodeShallow(old, n)) changed.push(shallowCopy(n));
          if (n.children) walkTree(n.children, key!, inAdded, false);
        }
      }
    }
  }

  if (!fullReset) {
    walkTree(prev.elements, 'root', false, true);
    walkTree(next.elements, 'root', false, false);
  }

  return {
    fromRev: prev?.rev ?? 0,
    toRev: next.rev,
    fullReset,
    added,
    removed: prevOrder.filter((ref) => !nextRefs.has(ref)),
    changed,
    ...(fullReset ? { elements: next.elements } : {}),
  };
}
