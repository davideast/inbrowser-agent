import { describe, expect, it } from 'vitest';
import { createRingBuffer } from '../../src/preload/diagnostics.js';
import { diffSnapshots } from '../../src/preload/diff.js';
import {
  type SemanticCandidateItem,
  matchStoredFingerprint,
  rankNearestCandidates,
} from '../../src/preload/ref-registry.js';
import type { ObservationSnapshot, RefId, SnapshotNode } from '../../src/types.js';

describe('diagnostics bounded ring buffer', () => {
  it('drains only new items per turn and evicts oldest items beyond capacity', () => {
    const ring = createRingBuffer<string>(3);

    ring.push('err-1');
    ring.push('err-2');
    expect(ring.drain()).toEqual(['err-1', 'err-2']);
    expect(ring.drain()).toEqual([]);

    ring.push('err-3');
    ring.push('err-4');
    ring.push('err-5');
    ring.push('err-6');
    expect(ring.drain()).toEqual(['err-4', 'err-5', 'err-6']);
    expect(ring.drain()).toEqual([]);
  });

  it('enforces default max capacity of 50 entries', () => {
    const ring = createRingBuffer<number>();
    for (let i = 1; i <= 65; i += 1) {
      ring.push(i);
    }
    const drained = ring.drain();
    expect(drained).toHaveLength(50);
    expect(drained[0]).toBe(16);
    expect(drained[49]).toBe(65);
  });
});

describe('semantic fingerprint healing and ambiguity detection', () => {
  const candidatePool: readonly SemanticCandidateItem<{ id: string }>[] = [
    {
      target: { id: 'save-btn-v2' },
      fingerprint: { role: 'button', name: 'Save', landmark: 'main:Workspace', nth: 0 },
    },
    {
      target: { id: 'cancel-btn' },
      fingerprint: { role: 'button', name: 'Cancel', landmark: 'main:Workspace', nth: 0 },
    },
    {
      target: { id: 'sidebar-save' },
      fingerprint: { role: 'button', name: 'Save', landmark: 'complementary:Inspector', nth: 0 },
    },
  ];

  it('heals an unambiguous single-cohort remount within the same landmark', () => {
    const outcome = matchStoredFingerprint(
      {
        fingerprint: { role: 'button', name: 'Save', landmark: 'main:Workspace', nth: 0 },
        cohortSize: 1,
      },
      candidatePool,
    );

    expect(outcome).toEqual({
      status: 'matched',
      candidate: candidatePool[0],
    });
  });

  it('heals an exact nth match when a multi-item cohort remounts with unchanged count', () => {
    const rowButtons: readonly SemanticCandidateItem<{ row: number }>[] = [
      {
        target: { row: 0 },
        fingerprint: { role: 'button', name: 'Remove', landmark: 'region:Tracks', nth: 0 },
      },
      {
        target: { row: 1 },
        fingerprint: { role: 'button', name: 'Remove', landmark: 'region:Tracks', nth: 1 },
      },
    ];

    const outcome = matchStoredFingerprint(
      {
        fingerprint: { role: 'button', name: 'Remove', landmark: 'region:Tracks', nth: 1 },
        cohortSize: 2,
      },
      rowButtons,
    );

    expect(outcome).toEqual({
      status: 'matched',
      candidate: rowButtons[1],
    });
  });

  it('fails safe with ambiguous status when guest renders an extra identical control in the same landmark', () => {
    const duplicatedPool: readonly SemanticCandidateItem<{ idx: number }>[] = [
      {
        target: { idx: 0 },
        fingerprint: { role: 'button', name: 'Delete', landmark: 'main:Workspace', nth: 0 },
      },
      {
        target: { idx: 1 },
        fingerprint: { role: 'button', name: 'Delete', landmark: 'main:Workspace', nth: 1 },
      },
    ];

    const outcome = matchStoredFingerprint(
      {
        fingerprint: { role: 'button', name: 'Delete', landmark: 'main:Workspace', nth: 0 },
        cohortSize: 1,
      },
      duplicatedPool,
    );

    expect(outcome).toEqual({
      status: 'ambiguous',
      candidates: [duplicatedPool[0]!.fingerprint, duplicatedPool[1]!.fingerprint],
    });
  });

  it('fails safe with ambiguous status when a multi-item cohort shrinks on remount (preventing shifted-row clicks)', () => {
    const shrunkPool: readonly SemanticCandidateItem<{ idx: number }>[] = [
      {
        target: { idx: 0 },
        fingerprint: { role: 'button', name: 'Delete', landmark: 'main:Workspace', nth: 0 },
      },
    ];

    const outcome = matchStoredFingerprint(
      {
        fingerprint: { role: 'button', name: 'Delete', landmark: 'main:Workspace', nth: 0 },
        cohortSize: 2,
      },
      shrunkPool,
    );

    expect(outcome).toEqual({
      status: 'ambiguous',
      candidates: [shrunkPool[0]!.fingerprint],
    });
  });

  it('returns not_found with role-prioritized nearest candidates when 0 cohort matches exist', () => {
    const nearest = rankNearestCandidates(candidatePool, {
      role: 'button',
      name: 'Save Draft',
      landmark: 'main:Workspace',
      nth: 0,
    });

    expect(nearest[0]).toEqual({
      role: 'button',
      name: 'Save',
      landmark: 'main:Workspace',
      nth: 0,
    });

    const outcome = matchStoredFingerprint(
      {
        fingerprint: { role: 'button', name: 'Publish', landmark: 'main:Workspace', nth: 0 },
        cohortSize: 1,
      },
      candidatePool,
    );

    expect(outcome.status).toBe('not_found');
    if (outcome.status === 'not_found') {
      expect(outcome.candidates.length).toBeGreaterThan(0);
      expect(outcome.candidates.every((c) => c.role === 'button')).toBe(true);
    }
  });
});

function emptyDiagnostics() {
  return {
    compileOverlay: null,
    consoleErrors: [],
    pageErrors: [],
    networkFailures: [],
  };
}

function buildMultiSectionElements(overrides?: {
  readonly playLabel?: string;
  readonly volumeValue?: string;
  readonly videoPaused?: boolean;
  readonly videoTime?: number;
  readonly canvasNonBlank?: boolean;
  readonly statusText?: string;
  readonly inspectorTitle?: string;
  readonly omitArchiveButton?: boolean;
  readonly includeAlert?: boolean;
  readonly includeConfirmDialog?: boolean;
}): readonly SnapshotNode[] {
  const trackItems: SnapshotNode[] = [];
  for (let i = 1; i <= 18; i += 1) {
    const muteRef: RefId = `e${20 + i * 2 - 1}`;
    const soloRef: RefId = `e${20 + i * 2}`;
    trackItems.push({
      role: 'region',
      name: `Channel ${i}`,
      ref: `e${100 + i}`,
      children: [
        { role: 'heading', name: `Channel ${i} Audio` },
        {
          role: 'button',
          name: `Mute Channel ${i}`,
          ref: muteRef,
          checked: false,
          disabled: false,
        },
        {
          role: 'button',
          name: `Solo Channel ${i}`,
          ref: soloRef,
          checked: false,
          disabled: false,
        },
      ],
    });
  }

  const transportChildren: SnapshotNode[] = [
    { role: 'button', name: overrides?.playLabel ?? 'Play', ref: 'e2', disabled: false },
    { role: 'button', name: 'Stop', ref: 'e3', disabled: false },
    {
      role: 'slider',
      name: 'Master Volume',
      ref: 'e6',
      value: overrides?.volumeValue ?? '25',
      min: 0,
      max: 100,
      disabled: false,
    },
    { role: 'status', name: overrides?.statusText ?? '00:00 / 00:30' },
  ];
  if (!overrides?.omitArchiveButton) {
    transportChildren.push({
      role: 'button',
      name: 'Archive Session',
      ref: 'e14',
      disabled: false,
    });
  }
  if (overrides?.includeAlert) {
    transportChildren.push({ role: 'alert', name: 'Peak level warning (-0.1 dB)' });
  }

  const rootElements: SnapshotNode[] = [
    {
      role: 'banner',
      name: 'Top Bar',
      ref: 'e1',
      children: [
        { role: 'heading', name: 'Studio Editor' },
        { role: 'link', name: 'Projects', ref: 'e4' },
        { role: 'link', name: 'Settings', ref: 'e5' },
      ],
    },
    {
      role: 'toolbar',
      name: 'Transport',
      ref: 'e7',
      children: transportChildren,
    },
    {
      role: 'main',
      name: 'Stage',
      ref: 'e8',
      children: [
        {
          role: 'video',
          name: 'Program Monitor',
          ref: 'e9',
          media: {
            kind: 'video',
            paused: overrides?.videoPaused ?? true,
            currentTime: overrides?.videoTime ?? 0,
            duration: 30,
            width: 1280,
            height: 720,
            ready: true,
            error: null,
          },
        },
        {
          role: 'canvas',
          name: 'Waveform Scope',
          ref: 'e10',
          canvas: {
            width: 640,
            height: 120,
            nonBlank: overrides?.canvasNonBlank ?? false,
          },
        },
        ...trackItems,
      ],
    },
    {
      role: 'complementary',
      name: overrides?.inspectorTitle ?? 'Inspector',
      ref: 'e11',
      children: [
        { role: 'textbox', name: 'Clip Title', ref: 'e12', value: 'Intro', disabled: false },
        {
          role: 'combobox',
          name: 'Resolution',
          ref: 'e13',
          value: '1080p',
          expanded: false,
          disabled: false,
          children: [
            {
              role: 'option',
              name: '720p',
              ref: 'e15',
              value: '720p',
              checked: false,
              disabled: false,
            },
            {
              role: 'option',
              name: '1080p',
              ref: 'e16',
              value: '1080p',
              checked: true,
              disabled: false,
            },
          ],
        },
      ],
    },
  ];

  if (overrides?.includeConfirmDialog) {
    rootElements.push({
      role: 'dialog',
      name: 'Confirm Export',
      ref: 'e90',
      children: [
        { role: 'heading', name: 'Export Master?' },
        { role: 'button', name: 'Confirm', ref: 'e91', disabled: false },
        { role: 'button', name: 'Cancel', ref: 'e92', disabled: false },
      ],
    });
  }

  return rootElements;
}

describe('diffSnapshots structural snapshot diffing', () => {
  it('returns fullReset=true with full elements when prev snapshot is null', () => {
    const next: ObservationSnapshot = {
      rev: 1,
      url: 'http://127.0.0.1:4706/workspace',
      title: 'Workspace',
      viewport: { width: 1280, height: 720 },
      diagnostics: emptyDiagnostics(),
      elements: buildMultiSectionElements(),
    };

    const diff = diffSnapshots(null, next);
    expect(diff).toEqual({
      fromRev: 0,
      toRev: 1,
      fullReset: true,
      added: [],
      removed: [],
      changed: [],
      elements: next.elements,
    });
  });

  it('triggers fullReset=true on origin or pathname navigation, but keeps incremental diff on query/hash updates', () => {
    const baseElements = buildMultiSectionElements();
    const prev: ObservationSnapshot = {
      rev: 2,
      url: 'http://127.0.0.1:4706/workspace?tab=timeline#t=0',
      title: 'Workspace',
      viewport: { width: 1280, height: 720 },
      diagnostics: emptyDiagnostics(),
      elements: baseElements,
    };

    const sameRouteQueryHash: ObservationSnapshot = {
      ...prev,
      rev: 3,
      url: 'http://127.0.0.1:4706/workspace?tab=mixer#t=4',
    };
    const queryDiff = diffSnapshots(prev, sameRouteQueryHash);
    expect(queryDiff).toEqual({
      fromRev: 2,
      toRev: 3,
      fullReset: false,
      added: [],
      removed: [],
      changed: [],
    });
    expect('elements' in queryDiff).toBe(false);

    const navigatedPathname: ObservationSnapshot = {
      ...prev,
      rev: 4,
      url: 'http://127.0.0.1:4706/export',
    };
    const navDiff = diffSnapshots(sameRouteQueryHash, navigatedPathname);
    expect(navDiff).toEqual({
      fromRev: 3,
      toRev: 4,
      fullReset: true,
      added: [],
      removed: [],
      changed: [],
      elements: baseElements,
    });
  });

  it('computes compact added, removed, and shallow changed nodes (>= 75% smaller than full elements) on localized UI updates', () => {
    const prev: ObservationSnapshot = {
      rev: 5,
      url: 'http://127.0.0.1:4706/workspace',
      title: 'Workspace',
      viewport: { width: 1280, height: 720 },
      diagnostics: emptyDiagnostics(),
      elements: buildMultiSectionElements(),
    };

    const next: ObservationSnapshot = {
      rev: 6,
      url: 'http://127.0.0.1:4706/workspace',
      title: 'Workspace',
      viewport: { width: 1280, height: 720 },
      diagnostics: emptyDiagnostics(),
      elements: buildMultiSectionElements({
        playLabel: 'Pause',
        volumeValue: '60',
        videoPaused: false,
        videoTime: 4.25,
        canvasNonBlank: true,
        statusText: '00:04 / 00:30',
        inspectorTitle: 'Inspector (Modified)',
        omitArchiveButton: true,
        includeAlert: true,
        includeConfirmDialog: true,
      }),
    };

    const diff = diffSnapshots(prev, next);

    expect(diff.fromRev).toBe(5);
    expect(diff.toRev).toBe(6);
    expect(diff.fullReset).toBe(false);
    expect('elements' in diff).toBe(false);

    expect(diff.removed).toEqual(['e14']);

    expect(diff.added).toEqual([
      { role: 'alert', name: 'Peak level warning (-0.1 dB)' },
      {
        role: 'dialog',
        name: 'Confirm Export',
        ref: 'e90',
        children: [
          { role: 'heading', name: 'Export Master?' },
          { role: 'button', name: 'Confirm', ref: 'e91', disabled: false },
          { role: 'button', name: 'Cancel', ref: 'e92', disabled: false },
        ],
      },
    ]);

    expect(diff.changed).toEqual([
      { role: 'button', name: 'Pause', ref: 'e2', disabled: false },
      {
        role: 'slider',
        name: 'Master Volume',
        ref: 'e6',
        value: '60',
        min: 0,
        max: 100,
        disabled: false,
      },
      { role: 'status', name: '00:04 / 00:30' },
      {
        role: 'video',
        name: 'Program Monitor',
        ref: 'e9',
        media: {
          kind: 'video',
          paused: false,
          currentTime: 4.25,
          duration: 30,
          width: 1280,
          height: 720,
          ready: true,
          error: null,
        },
      },
      {
        role: 'canvas',
        name: 'Waveform Scope',
        ref: 'e10',
        canvas: { width: 640, height: 120, nonBlank: true },
      },
      { role: 'complementary', name: 'Inspector (Modified)', ref: 'e11' },
    ]);

    const diffBytes = JSON.stringify(diff).length;
    const fullBytes = JSON.stringify(next.elements).length;
    expect(diffBytes).toBeLessThanOrEqual(Math.floor(fullBytes * 0.25));
  });

  it('preserves reparented existing RefIds inside newly added subtrees without falsely marking them removed', () => {
    const prev: ObservationSnapshot = {
      rev: 1,
      url: 'about:blank#step-1',
      title: 'Draft',
      viewport: { width: 800, height: 600 },
      diagnostics: emptyDiagnostics(),
      elements: [
        {
          role: 'main',
          name: 'Editor',
          ref: 'e1',
          children: [{ role: 'button', name: 'Apply', ref: 'e2', disabled: true }],
        },
      ],
    };

    const next: ObservationSnapshot = {
      rev: 2,
      url: 'about:blank#step-2',
      title: 'Draft',
      viewport: { width: 800, height: 600 },
      diagnostics: emptyDiagnostics(),
      elements: [
        { role: 'main', name: 'Editor', ref: 'e1' },
        {
          role: 'dialog',
          name: 'Review',
          ref: 'e3',
          children: [{ role: 'button', name: 'Apply', ref: 'e2', disabled: false }],
        },
      ],
    };

    const diff = diffSnapshots(prev, next);
    expect(diff.fullReset).toBe(false);
    expect(diff.removed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.ref).toBe('e3');
    expect(diff.changed).toEqual([{ role: 'button', name: 'Apply', ref: 'e2', disabled: false }]);
  });

  it('disambiguates stored fingerprints by driverId and detects driverId/intent updates in diffSnapshots', () => {
    const candidates: readonly SemanticCandidateItem<{ id: string }>[] = [
      {
        target: { id: 'btn-primary' },
        fingerprint: {
          role: 'button',
          name: 'Reset',
          landmark: 'main:Workspace',
          driverId: 'toolbar.reset-view',
          nth: 0,
        },
      },
      {
        target: { id: 'btn-fixture' },
        fingerprint: {
          role: 'button',
          name: 'Reset',
          landmark: 'main:Workspace',
          driverId: 'toolbar.reset-fixture',
          nth: 0,
        },
      },
    ];

    const matched = matchStoredFingerprint(
      {
        fingerprint: {
          role: 'button',
          name: 'Reset',
          landmark: 'main:Workspace',
          driverId: 'toolbar.reset-fixture',
          nth: 0,
        },
        cohortSize: 1,
      },
      candidates,
    );
    expect(matched).toEqual({ status: 'matched', candidate: candidates[1] });

    const prev: ObservationSnapshot = {
      rev: 1,
      url: 'about:blank',
      title: 'App',
      viewport: { width: 800, height: 600 },
      diagnostics: emptyDiagnostics(),
      elements: [
        {
          role: 'button',
          name: 'Reset',
          ref: 'e1',
          driverId: 'toolbar.reset',
          intent: 'Resets active filters',
        },
      ],
    };
    const next: ObservationSnapshot = {
      ...prev,
      rev: 2,
      elements: [
        {
          role: 'button',
          name: 'Reset',
          ref: 'e1',
          driverId: 'toolbar.reset',
          intent: 'Resets entire workspace fixture',
        },
      ],
    };
    const diff = diffSnapshots(prev, next);
    expect(diff.changed).toEqual([
      {
        role: 'button',
        name: 'Reset',
        ref: 'e1',
        driverId: 'toolbar.reset',
        intent: 'Resets entire workspace fixture',
      },
    ]);
  });
});
