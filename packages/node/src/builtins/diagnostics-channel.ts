import diagnosticsChannel from 'internal/nodelib/diagnostics_channel';
import { setGuestProcess } from '../node-internal/process-ref';
import { preserveFunctionNames } from '../node-internal/util';

preserveFunctionNames([
  [diagnosticsChannel.Channel, 'Channel'],
  [Reflect.get(diagnosticsChannel, 'TracingChannel'), 'TracingChannel'],
  [diagnosticsChannel.channel, 'channel'],
  [diagnosticsChannel.hasSubscribers, 'hasSubscribers'],
  [diagnosticsChannel.subscribe, 'subscribe'],
  [diagnosticsChannel.unsubscribe, 'unsubscribe'],
  [diagnosticsChannel.tracingChannel, 'tracingChannel'],
]);

export function createDiagnosticsChannelBuiltin(process: { env: Record<string, unknown> }) {
  setGuestProcess(process);
  return diagnosticsChannel;
}
