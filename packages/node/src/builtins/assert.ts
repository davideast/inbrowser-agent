import assert from 'internal/nodelib/assert';
import assertStrict from 'internal/nodelib/assert/strict';
import { format, inspect } from 'internal/nodelib/util/inspect';
import { registerErrorInspect } from '../node-internal/errors';

registerErrorInspect(inspect, format);

export function createAssertBuiltins() {
  return {
    assert,
    'assert/strict': assertStrict,
  };
}
