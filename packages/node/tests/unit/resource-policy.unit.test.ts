import { describe, expect, it, vi } from 'vitest';
import { HTTP_LIMIT, HTTP_RESPONSE_LIMIT } from '../../src/http-limits';
import { MODULE_SOURCE_LIMIT, MODULE_TOTAL_LIMIT } from '../../src/module-limits';
import { CALL_TIMEOUT, CAPACITY, HEADER_BYTES } from '../../src/protocol';
import {
  DEFAULT_RESOURCE_POLICY,
  FIXED_LIMITS,
  REMOVED_LIMITS,
  RESOURCE_POLICY_MAXIMA,
  UNBOUNDED,
  UNBOUNDED_LIMITS,
  aliasResourceOverrides,
  attachHttpEgressPolicy,
  httpEgressPolicy,
  installResourcePolicy,
  intersectHttpEgressPolicies,
  isResourcePolicy,
  matchesHttpEgressTarget,
  resolveResourcePolicy,
  validateHttpEgressPolicy,
} from '../../src/resource-policy';
import { SNAPSHOT_BYTES, SNAPSHOT_ENTRIES } from '../../src/snapshot';

const MiB = 1024 * 1024;

describe('default resource policy', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_RESOURCE_POLICY).toEqual({
      syscall: {
        callTimeoutMs: 5000,
        kernelRequestTimeoutMs: 7000,
      },
      filesystem: {
        descriptorReadBytes: 32 * MiB,
        descriptorWriteBytes: 32 * MiB,
        fileReadBytes: 32 * MiB,
        readStreamHighWaterMarkBytes: 1 * MiB,
        maxTotalBytes: 1024 * MiB,
        maxInodes: 200000,
        maxOpenDescriptors: 4096,
        processWatchers: 4096,
        hostWatchers: 4096,
        watchQueueEvents: 256,
        watchQueueBytes: 1 * MiB,
      },
      modules: {
        sourceBytes: 32 * MiB,
        graphBytes: 128 * MiB,
        countPerProcess: 2048,
        contextSourceMapBytes: 32 * MiB,
        contextSourceBytes: 32 * MiB,
        contextOutputBytes: 128 * MiB,
      },
      http: {
        responseBytes: 8 * MiB,
        headerBytes: 65536,
        clientBodyBytes: 8 * MiB,
        agentRequests: 1024,
      },
      preview: {
        requestBodyBytes: 1 * MiB,
        responseBytes: 64 * MiB,
        requestWindowBytes: 1 * MiB,
        responseWindowBytes: 1 * MiB,
        moduleSourceBytes: 32 * MiB,
        relaysPerContainer: 64,
      },
      child: {
        maxProcesses: 64,
        outputBytes: 32 * MiB,
        inputQueueBytes: 32 * MiB,
        inputQueueDeliveries: 1024,
        stdinChunkBytes: 32 * MiB,
        pipeBytes: 32 * MiB,
        pendingStdinReads: 1024,
        terminalInputBytes: 32 * MiB,
        terminalLineBytes: 65536,
        readlineLineBytes: 65536,
        captureBytes: 16 * MiB,
        outputObserverBytes: 1 * MiB,
        shellWords: 2048,
        shellScriptBytes: 65536,
        execArgvCount: 256,
        execArgvBytes: 65536,
        randomAllocationBytes: 32 * MiB,
        comparisonBytes: 32 * MiB,
        ipcMessageBytes: 1 * MiB,
        ipcQueuedMessages: 64,
        ipcQueuedBytes: 8 * MiB,
        ipcGraphNodes: 4096,
        ipcGraphEdges: 65536,
        ipcGraphDepth: 128,
        ipcArraySlots: 1 * MiB,
        threadMessageBytes: 1 * MiB,
        threadQueuedMessages: 64,
        threadQueuedBytes: 8 * MiB,
        threadTransferBytes: 32 * MiB,
        threadCollectionEntries: 65536,
        threadGraphNodes: 4096,
        threadGraphEdges: 65536,
        threadGraphDepth: 128,
      },
      snapshot: {
        bytes: 128 * MiB,
        entries: 100000,
        packageCacheBytes: 128 * MiB,
        packageCacheFiles: 100000,
        startupConfigBytes: 65536,
      },
      install: {
        packageBytes: 256 * MiB,
        archiveBytes: 64 * MiB,
        gzipBytes: 32 * MiB,
        unzipBytes: 32 * MiB,
        lockedPackages: 2048,
      },
      timers: {
        interruptGraceMs: 250,
        gzipMs: 7000,
        storeMs: 7000,
        downloadMs: 20000,
        contextCompilerMs: 20000,
        httpRequestMs: 20000,
        cryptoInitMs: 5000,
        previewLookupMs: 30000,
        previewHostRequestMs: 120000,
        previewGuestRequestMs: 125000,
        previewModuleRequestMs: 5000,
        previewDiscoverMs: 500,
        serviceTaskMs: 5000,
        previewSocketIdleMs: 15000,
        previewStreamIdleMs: 15000,
      },
    });
  });

  it('reuses the shared constants that both peers already agree on', () => {
    expect(DEFAULT_RESOURCE_POLICY.syscall.callTimeoutMs).toBe(CALL_TIMEOUT);
    expect(DEFAULT_RESOURCE_POLICY.preview.requestBodyBytes).toBe(HTTP_LIMIT);
    expect(DEFAULT_RESOURCE_POLICY.preview.responseBytes).toBe(HTTP_RESPONSE_LIMIT);
    expect(DEFAULT_RESOURCE_POLICY.modules.sourceBytes).toBe(MODULE_SOURCE_LIMIT);
    expect(DEFAULT_RESOURCE_POLICY.modules.graphBytes).toBe(MODULE_TOTAL_LIMIT);
    expect(DEFAULT_RESOURCE_POLICY.snapshot.bytes).toBe(SNAPSHOT_BYTES);
    expect(DEFAULT_RESOURCE_POLICY.snapshot.entries).toBe(SNAPSHOT_ENTRIES);
  });

  it('names the structural limits that stay fixed', () => {
    expect(FIXED_LIMITS.syscallPayloadBytes).toBe(CAPACITY);
    expect(FIXED_LIMITS.syscallHeaderBytes).toBe(HEADER_BYTES);
    expect(FIXED_LIMITS.transportChunkBytes).toBe(65536);
    expect(FIXED_LIMITS.previewSocketBytes).toBe(1 * MiB);
    expect(FIXED_LIMITS.previewSocketQueuedPackets).toBe(1024);
    expect(FIXED_LIMITS.previewSocketFragments).toBe(1024);
    expect(FIXED_LIMITS).not.toHaveProperty('contextCompilerSourceBytes');
    expect(FIXED_LIMITS).not.toHaveProperty('contextCompilerOutputBytes');
  });

  it('is frozen so a resolved policy cannot mutate the defaults', () => {
    expect(Object.isFrozen(DEFAULT_RESOURCE_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_RESOURCE_POLICY.http)).toBe(true);
  });
});

describe('preview wait defaults', () => {
  it('lets the service worker wait longer than the host so the host reports first', () => {
    const { timers } = DEFAULT_RESOURCE_POLICY;
    expect(timers.previewGuestRequestMs).toBeGreaterThan(timers.previewHostRequestMs);
  });
});

describe('context compiler limits', () => {
  it('keeps the reply capacity at four times the source capacity, as it was at 8 and 32 MiB', () => {
    const { modules } = DEFAULT_RESOURCE_POLICY;
    expect(modules.contextOutputBytes).toBe(4 * modules.contextSourceBytes);
  });

  it('keeps one maximum-size module plus typical framework code inside the process graph', () => {
    const { modules } = DEFAULT_RESOURCE_POLICY;
    expect(modules.graphBytes).toBeGreaterThanOrEqual(4 * modules.sourceBytes);
  });

  it('validates them like other byte limits, with hard maxima', () => {
    expect(RESOURCE_POLICY_MAXIMA.modules.contextSourceBytes).toBe(256 * MiB);
    expect(RESOURCE_POLICY_MAXIMA.modules.contextOutputBytes).toBe(1024 * MiB);
    const policy = resolveResourcePolicy({
      modules: { contextSourceBytes: 64 * 1024, contextOutputBytes: 256 * 1024 },
    });
    expect(policy.modules.contextSourceBytes).toBe(64 * 1024);
    expect(policy.modules.contextOutputBytes).toBe(256 * 1024);
    for (const key of ['contextSourceBytes', 'contextOutputBytes'] as const) {
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
        expect(() => resolveResourcePolicy({ modules: { [key]: value } })).toThrow(
          new RegExp(`resources\\.modules\\.${key}`),
        );
    }
    expect(() => resolveResourcePolicy({ modules: { contextSourceBytes: 256 * MiB + 1 } })).toThrow(
      RangeError,
    );
    expect(() =>
      resolveResourcePolicy({ modules: { contextOutputBytes: 1024 * MiB + 1 } }),
    ).toThrow(RangeError);
  });
});

describe('resolveResourcePolicy', () => {
  it('returns the defaults for undefined and empty overrides', () => {
    expect(resolveResourcePolicy()).toEqual(DEFAULT_RESOURCE_POLICY);
    expect(resolveResourcePolicy({})).toEqual(DEFAULT_RESOURCE_POLICY);
    expect(resolveResourcePolicy({ http: {} })).toEqual(DEFAULT_RESOURCE_POLICY);
  });

  it('merges deeply, leaving sibling groups and sibling keys untouched', () => {
    const policy = resolveResourcePolicy({
      snapshot: { entries: 10 },
      http: { clientBodyBytes: 4096 },
    });
    expect(policy.snapshot.entries).toBe(10);
    expect(policy.snapshot.bytes).toBe(DEFAULT_RESOURCE_POLICY.snapshot.bytes);
    expect(policy.http.clientBodyBytes).toBe(4096);
    expect(policy.http.responseBytes).toBe(DEFAULT_RESOURCE_POLICY.http.responseBytes);
    expect(policy.child).toEqual(DEFAULT_RESOURCE_POLICY.child);
  });

  it('does not alias the defaults into the resolved policy', () => {
    const policy = resolveResourcePolicy({ snapshot: { entries: 10 } });
    expect(policy).not.toBe(DEFAULT_RESOURCE_POLICY);
    expect(policy.child).not.toBe(DEFAULT_RESOURCE_POLICY.child);
    expect(DEFAULT_RESOURCE_POLICY.snapshot.entries).toBe(100000);
  });

  it('rejects non-integer, zero and negative values with ERR_OUT_OF_RANGE', () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      let thrown: unknown;
      try {
        resolveResourcePolicy({ snapshot: { entries: value } });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RangeError);
      expect((thrown as { code?: string }).code).toBe('ERR_OUT_OF_RANGE');
    }
  });

  it('rejects values above a hard maximum the runtime already enforces', () => {
    expect(RESOURCE_POLICY_MAXIMA.http.responseBytes).toBe(64 * MiB);
    expect(RESOURCE_POLICY_MAXIMA.filesystem.descriptorReadBytes).toBe(64 * MiB);
    expect(RESOURCE_POLICY_MAXIMA.install.unzipBytes).toBe(256 * MiB);
    expect(() => resolveResourcePolicy({ http: { responseBytes: 64 * MiB } })).not.toThrow();
    expect(() => resolveResourcePolicy({ http: { responseBytes: 64 * MiB + 1 } })).toThrow(
      RangeError,
    );
    expect(() =>
      resolveResourcePolicy({ filesystem: { descriptorReadBytes: 64 * MiB + 1 } }),
    ).toThrow(RangeError);
    expect(() => resolveResourcePolicy({ install: { unzipBytes: 256 * MiB + 1 } })).toThrow(
      RangeError,
    );
  });

  it('rejects non-number values and non-object groups with ERR_INVALID_ARG_TYPE', () => {
    for (const overrides of [
      { snapshot: { entries: '10' } },
      { snapshot: { entries: null } },
      { snapshot: 10 },
      { snapshot: null },
      42,
      'resources',
    ]) {
      let thrown: unknown;
      try {
        resolveResourcePolicy(overrides as never);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      expect((thrown as { code?: string }).code).toBe('ERR_INVALID_ARG_TYPE');
    }
  });

  it('rejects unknown groups and unknown keys, including structural limits', () => {
    for (const overrides of [
      { nope: { entries: 10 } },
      { snapshot: { nope: 10 } },
      { syscall: { payloadBytes: 4096 } },
      { preview: { socketBytes: 4096 } },
    ]) {
      let thrown: unknown;
      try {
        resolveResourcePolicy(overrides as never);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      expect((thrown as { code?: string }).code).toBe('ERR_INVALID_ARG_TYPE');
    }
  });

  it('accepts a removed key, validated as before, and ignores it', () => {
    expect(REMOVED_LIMITS).toEqual({ timers: ['channelAckMs'] });
    const policy = resolveResourcePolicy({ timers: { channelAckMs: 30000 } });
    expect(policy).toEqual(DEFAULT_RESOURCE_POLICY);
    expect(Object.keys(policy.timers)).not.toContain('channelAckMs');
    expect(resolveResourcePolicy({ timers: { channelAckMs: undefined } })).toEqual(
      DEFAULT_RESOURCE_POLICY,
    );
    expect(() => resolveResourcePolicy({ timers: { channelAckMs: 0 } })).toThrow(RangeError);
    expect(() => resolveResourcePolicy({ timers: { channelAckMs: 0 } })).toThrow(
      /resources\.timers\.channelAckMs/,
    );
    expect(() => resolveResourcePolicy({ timers: { channelAckMs: '5000' } } as never)).toThrow(
      TypeError,
    );
    // Removed from one group only: the name is unknown elsewhere.
    expect(() => resolveResourcePolicy({ child: { channelAckMs: 5000 } } as never)).toThrow(
      TypeError,
    );
  });

  it('names the rejected path in the message, Node argument-validation style', () => {
    expect(() => resolveResourcePolicy({ snapshot: { entries: 0 } })).toThrow(
      /resources\.snapshot\.entries/,
    );
    expect(() => resolveResourcePolicy({ snapshot: { nope: 1 } } as never)).toThrow(
      /resources\.snapshot\.nope/,
    );
  });
});

describe('unbounded stream budgets', () => {
  it('is Infinity and names exactly the two preview totals', () => {
    expect(UNBOUNDED).toBe(Number.POSITIVE_INFINITY);
    expect(UNBOUNDED_LIMITS).toEqual({ preview: ['requestBodyBytes', 'responseBytes'] });
  });

  it('accepts the marker for the preview totals and leaves their siblings at the defaults', () => {
    const policy = resolveResourcePolicy({
      preview: { requestBodyBytes: UNBOUNDED, responseBytes: Number.POSITIVE_INFINITY },
    });
    expect(policy.preview.requestBodyBytes).toBe(Number.POSITIVE_INFINITY);
    expect(policy.preview.responseBytes).toBe(Number.POSITIVE_INFINITY);
    expect(policy.preview.responseWindowBytes).toBe(1 * MiB);
    expect(policy.preview.requestWindowBytes).toBe(1 * MiB);
    expect(isResourcePolicy(policy)).toBe(true);
  });

  it('lets the preview totals be raised far beyond their defaults', () => {
    const policy = resolveResourcePolicy({
      preview: { requestBodyBytes: 4096 * MiB, responseBytes: 65536 * MiB },
    });
    expect(policy.preview.requestBodyBytes).toBe(4096 * MiB);
    expect(policy.preview.responseBytes).toBe(65536 * MiB);
  });

  it('rejects the marker for every limit that sizes a buffer, a queue or a deadline', () => {
    for (const overrides of [
      { preview: { responseWindowBytes: Number.POSITIVE_INFINITY } },
      { preview: { requestWindowBytes: Number.POSITIVE_INFINITY } },
      { preview: { moduleSourceBytes: Number.POSITIVE_INFINITY } },
      { http: { responseBytes: Number.POSITIVE_INFINITY } },
      { timers: { previewStreamIdleMs: Number.POSITIVE_INFINITY } },
    ]) {
      let thrown: unknown;
      try {
        resolveResourcePolicy(overrides);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RangeError);
      expect((thrown as { code?: string }).code).toBe('ERR_OUT_OF_RANGE');
    }
  });

  it('still rejects other non-integers for the preview totals, naming Infinity as valid', () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, 2 ** 60])
      expect(() => resolveResourcePolicy({ preview: { responseBytes: value } })).toThrow(
        /resources\.preview\.responseBytes.*a positive safe integer or Infinity/,
      );
  });

  it('validates a policy received over a boot message the same way', () => {
    const policy = resolveResourcePolicy({ preview: { responseBytes: UNBOUNDED } });
    expect(isResourcePolicy(policy)).toBe(true);
    expect(
      isResourcePolicy({
        ...policy,
        preview: { ...policy.preview, responseWindowBytes: Number.POSITIVE_INFINITY },
      }),
    ).toBe(false);
    expect(
      isResourcePolicy({
        ...policy,
        timers: { ...policy.timers, gzipMs: Number.POSITIVE_INFINITY },
      }),
    ).toBe(false);
    const timers: Record<string, number> = { ...policy.timers };
    delete timers.previewStreamIdleMs;
    expect(isResourcePolicy({ ...policy, timers })).toBe(false);
  });
});

describe('aliasResourceOverrides', () => {
  it('maps the three deprecated boot aliases onto policy paths', () => {
    expect(
      aliasResourceOverrides(undefined, {
        httpResponseLimit: 4096,
        unzipLimit: 8192,
        descriptorReadLimit: 16384,
      }),
    ).toEqual({
      http: { responseBytes: 4096 },
      install: { unzipBytes: 8192 },
      filesystem: { descriptorReadBytes: 16384 },
    });
  });

  it('is a no-op when no alias is present', () => {
    expect(aliasResourceOverrides(undefined, {})).toBeUndefined();
    expect(aliasResourceOverrides({ http: { responseBytes: 4096 } }, {})).toEqual({
      http: { responseBytes: 4096 },
    });
  });

  it('lets an explicit resources override win over an alias', () => {
    const merged = aliasResourceOverrides(
      { http: { responseBytes: 2048, clientBodyBytes: 1024 } },
      { httpResponseLimit: 4096 },
    );
    expect(merged).toEqual({ http: { responseBytes: 2048, clientBodyBytes: 1024 } });
  });

  it('resolves an aliased override to the same policy as the modern spelling', () => {
    expect(resolveResourcePolicy(aliasResourceOverrides(undefined, { unzipLimit: 8192 }))).toEqual(
      resolveResourcePolicy({ install: { unzipBytes: 8192 } }),
    );
  });
});

describe('kernel and process resource quotas', () => {
  it('validates maxProcesses, maxTotalBytes, maxInodes and maxOpenDescriptors as positive safe integers', () => {
    const policy = resolveResourcePolicy({
      child: { maxProcesses: 12 },
      filesystem: {
        maxTotalBytes: 64 * MiB,
        maxInodes: 5000,
        maxOpenDescriptors: 20000,
      },
    });
    expect(policy.child.maxProcesses).toBe(12);
    expect(policy.filesystem.maxTotalBytes).toBe(64 * MiB);
    expect(policy.filesystem.maxInodes).toBe(5000);
    expect(policy.filesystem.maxOpenDescriptors).toBe(20000);
    expect(isResourcePolicy(policy)).toBe(true);

    for (const value of [0, -1, 1.5, Number.NaN, UNBOUNDED, 2 ** 60]) {
      expect(() => resolveResourcePolicy({ child: { maxProcesses: value } })).toThrow(
        /resources\.child\.maxProcesses/,
      );
      for (const key of ['maxTotalBytes', 'maxInodes', 'maxOpenDescriptors'] as const) {
        expect(() => resolveResourcePolicy({ filesystem: { [key]: value } })).toThrow(
          new RegExp(`resources\\.filesystem\\.${key}`),
        );
      }
    }

    expect(
      isResourcePolicy({
        ...policy,
        child: { ...policy.child, maxProcesses: UNBOUNDED },
      }),
    ).toBe(false);
    expect(
      isResourcePolicy({
        ...policy,
        filesystem: { ...policy.filesystem, maxTotalBytes: UNBOUNDED },
      }),
    ).toBe(false);
    expect(
      isResourcePolicy({
        ...policy,
        filesystem: { ...policy.filesystem, maxInodes: 0 },
      }),
    ).toBe(false);
    expect(
      isResourcePolicy({
        ...policy,
        filesystem: { ...policy.filesystem, maxOpenDescriptors: -1 },
      }),
    ).toBe(false);
  });
});

describe('outbound HTTP egress policy', () => {
  it('matches exact hosts, wildcard subdomains, explicit ports, and IPv6 while letting blockedHosts win', () => {
    expect(validateHttpEgressPolicy()).toBeUndefined();
    expect(matchesHttpEgressTarget(undefined, new URL('https://anything.example.com/'))).toBe(true);

    const policy = validateHttpEgressPolicy({
      allowedHosts: [
        'Registry.NPMJS.org',
        '*.example.com',
        '*.api.internal:8443',
        'plain.example.org:80',
        '127.0.0.1:4450',
        '[::1]:8080',
      ],
      blockedHosts: ['evil.example.com', 'sub.evil.example.com:443'],
    });
    expect(policy).toBeDefined();

    expect(matchesHttpEgressTarget(policy, new URL('https://registry.npmjs.org/pkg'))).toBe(true);
    expect(matchesHttpEgressTarget(policy, new URL('http://registry.npmjs.org:8080/pkg'))).toBe(
      true,
    );
    expect(matchesHttpEgressTarget(policy, new URL('https://cdn.example.com/a'))).toBe(true);
    expect(matchesHttpEgressTarget(policy, new URL('https://deep.cdn.example.com/a'))).toBe(true);
    // Wildcard subdomain does not match bare domain or suffix-sharing domain.
    expect(matchesHttpEgressTarget(policy, new URL('https://example.com/a'))).toBe(false);
    expect(matchesHttpEgressTarget(policy, new URL('https://badexample.com/a'))).toBe(false);
    // Explicit port 80 allows http default port 80, denies https default port 443.
    expect(matchesHttpEgressTarget(policy, new URL('http://plain.example.org/path'))).toBe(true);
    expect(matchesHttpEgressTarget(policy, new URL('https://plain.example.org/path'))).toBe(false);
    // Wildcard + port.
    expect(matchesHttpEgressTarget(policy, new URL('https://v1.api.internal:8443/x'))).toBe(true);
    expect(matchesHttpEgressTarget(policy, new URL('https://v1.api.internal/x'))).toBe(false);
    // IPv4 and IPv6 + port.
    expect(matchesHttpEgressTarget(policy, new URL('http://127.0.0.1:4450/ok'))).toBe(true);
    expect(matchesHttpEgressTarget(policy, new URL('http://127.0.0.1:4451/no'))).toBe(false);
    expect(matchesHttpEgressTarget(policy, new URL('http://[::1]:8080/ok'))).toBe(true);
    expect(matchesHttpEgressTarget(policy, new URL('http://[::1]:8081/no'))).toBe(false);
    // blockedHosts overrides allowedHosts (*.example.com).
    expect(matchesHttpEgressTarget(policy, new URL('https://evil.example.com/'))).toBe(false);
    expect(matchesHttpEgressTarget(policy, new URL('https://sub.evil.example.com/'))).toBe(false);
    expect(matchesHttpEgressTarget(policy, new URL('http://sub.evil.example.com/'))).toBe(true);

    // Empty allowedHosts denies all outbound HTTP/HTTPS.
    const denyAll = validateHttpEgressPolicy({ allowedHosts: [] });
    expect(matchesHttpEgressTarget(denyAll, new URL('http://127.0.0.1:4450/'))).toBe(false);
  });

  it('rejects malformed egress patterns and options with EINVAL', () => {
    for (const bad of [
      '',
      '   ',
      'https://example.com',
      'example.com/path',
      'example.com?q=1',
      'user@example.com',
      '*.*.example.com',
      '*.',
      '*.127.0.0.1',
      'example.com:0',
      'example.com:65536',
      'example.com:abc',
      '[::1]:99999',
    ]) {
      let thrown: unknown;
      try {
        validateHttpEgressPolicy({ allowedHosts: [bad] });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `pattern "${bad}" should fail`).toBeInstanceOf(Error);
      expect(
        typeof thrown === 'object' && thrown !== null ? Reflect.get(thrown, 'code') : null,
      ).toBe('EINVAL');
    }
  });

  it('canonicalizes trailing-dot FQDNs and IPv4-mapped IPv6 literals across allowlists and blocklists', () => {
    const policy = validateHttpEgressPolicy({
      allowedHosts: ['api.example.com', '*.corp.example'],
      blockedHosts: ['evil.corp.example', '127.0.0.1', '169.254.169.254', '[::ffff:10.0.0.5]:8080'],
    });

    // Trailing-dot FQDN matches exact and wildcard rules identically to bare FQDN.
    expect(matchesHttpEgressTarget(policy, new URL('https://api.example.com./v1'))).toBe(true);
    expect(matchesHttpEgressTarget(policy, new URL('https://ok.corp.example./v1'))).toBe(true);
    // Blocklist cannot be bypassed with a trailing dot!
    expect(matchesHttpEgressTarget(policy, new URL('https://evil.corp.example./v1'))).toBe(false);
    // Double trailing dot or bare dot is never matched.
    expect(matchesHttpEgressTarget(policy, new URL('https://api.example.com../v1'))).toBe(false);

    // Blocklist-only policy: trailing dot and IPv4-mapped IPv6 cannot bypass loopback/metadata blocklist.
    const blockOnly = validateHttpEgressPolicy({
      blockedHosts: [
        'blocked.example.com',
        '*.internal.example',
        '127.0.0.1',
        '169.254.169.254',
        '[::ffff:10.0.0.5]:8080',
      ],
    });
    expect(matchesHttpEgressTarget(blockOnly, new URL('https://blocked.example.com./a'))).toBe(
      false,
    );
    expect(matchesHttpEgressTarget(blockOnly, new URL('https://db.internal.example./a'))).toBe(
      false,
    );
    expect(matchesHttpEgressTarget(blockOnly, new URL('http://[::ffff:127.0.0.1]:8080/'))).toBe(
      false,
    );
    expect(matchesHttpEgressTarget(blockOnly, new URL('http://[::ffff:7f00:1]:3000/'))).toBe(false);
    expect(
      matchesHttpEgressTarget(
        blockOnly,
        new URL('http://[::ffff:169.254.169.254]/latest/meta-data/'),
      ),
    ).toBe(false);
    // Rule written in IPv4-mapped IPv6 form also matches dotted-quad IPv4 on the same port.
    expect(matchesHttpEgressTarget(blockOnly, new URL('http://10.0.0.5:8080/'))).toBe(false);
    expect(matchesHttpEgressTarget(blockOnly, new URL('http://10.0.0.5:8081/'))).toBe(true);

    // Multi-layer intersection (host + client): client can narrow host allowlist, never widen it.
    const hostEgress = validateHttpEgressPolicy({
      allowedHosts: ['*.example.com'],
      blockedHosts: ['revoked.example.com'],
    });
    const clientEgress = validateHttpEgressPolicy({
      allowedHosts: ['api.example.com:443', 'evil.other.org'],
      blockedHosts: ['blocked-by-client.example.com'],
    });
    const intersected = intersectHttpEgressPolicies(hostEgress, clientEgress);
    const clonedCarrier = structuredClone(
      attachHttpEgressPolicy(resolveResourcePolicy(), intersected),
    );
    expect(isResourcePolicy(clonedCarrier)).toBe(true);
    expect(matchesHttpEgressTarget(intersected, new URL('https://api.example.com/v1'))).toBe(true);
    expect(matchesHttpEgressTarget(intersected, new URL('http://api.example.com/v1'))).toBe(false);
    expect(matchesHttpEgressTarget(intersected, new URL('https://other.example.com/v1'))).toBe(
      false,
    );
    expect(matchesHttpEgressTarget(intersected, new URL('https://evil.other.org/v1'))).toBe(false);
    expect(matchesHttpEgressTarget(intersected, new URL('https://revoked.example.com/'))).toBe(
      false,
    );
    expect(
      matchesHttpEgressTarget(intersected, new URL('https://blocked-by-client.example.com/')),
    ).toBe(false);

    // Enforces 16-layer ceiling on composed allowedLayers.
    let composed = validateHttpEgressPolicy({ allowedHosts: ['a.example.com'] });
    const nextLayer = validateHttpEgressPolicy({ allowedHosts: ['a.example.com'] });
    for (let i = 1; i < 16; i++) {
      composed = intersectHttpEgressPolicies(composed, nextLayer);
    }
    expect(composed?.allowedLayers?.length).toBe(16);
    expect(() => intersectHttpEgressPolicies(composed, nextLayer)).toThrow(/allowedLayers/);
  });

  it('survives structured clone on the boot policy carrier and re-validates final Response.url', async () => {
    const egress = validateHttpEgressPolicy({ allowedHosts: ['allowed.example.com'] });
    const carrier = structuredClone(attachHttpEgressPolicy(resolveResourcePolicy(), egress));
    expect(isResourcePolicy(carrier)).toBe(true);
    installResourcePolicy(carrier);
    expect(httpEgressPolicy()).toEqual(egress);
    installResourcePolicy(DEFAULT_RESOURCE_POLICY);
    expect(httpEgressPolicy()).toBeUndefined();

    let cancelled = false;
    const fakeFetch: typeof fetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel() {
          cancelled = true;
        },
      });
      const response = new Response(stream, { status: 200 });
      Object.defineProperty(response, 'url', {
        value: 'https://redirected-disallowed.example.com/secret',
      });
      return response;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      vi.resetModules();
      const policyMod = await import('../../src/resource-policy');
      const httpMod = await import('../../src/browser-http');
      policyMod.installResourcePolicy(carrier);
      expect(policyMod.httpEgressPolicy()).toEqual(egress);

      const client = httpMod.createBrowserHttpClient(
        'https:',
        () => {},
        () => {},
        true,
      );
      const outcome = await new Promise<{ code?: unknown; kind?: unknown }>((resolve) => {
        const req = client.get('https://allowed.example.com/start', () => {
          resolve({ code: 'UNEXPECTED_RESPONSE' });
        });
        req.on('error', (err: unknown) => {
          resolve({
            code: typeof err === 'object' && err !== null ? Reflect.get(err, 'code') : undefined,
            kind: typeof err === 'object' && err !== null ? Reflect.get(err, 'kind') : undefined,
          });
        });
      });
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      expect(cancelled).toBe(true);
      expect(outcome).toEqual({ code: 'EACCES', kind: 'unsupported' });
    } finally {
      globalThis.fetch = originalFetch;
      installResourcePolicy(DEFAULT_RESOURCE_POLICY);
    }
  });
});
