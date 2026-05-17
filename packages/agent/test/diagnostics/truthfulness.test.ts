import { describe, expect, test } from 'bun:test';
import {
  type LlmRequestTrace,
  type LlmResponseTrace,
  type TraceEvent,
  analyzeTruthfulness,
} from '../../src/index.js';

function req(overrides: Partial<LlmRequestTrace> = {}): TraceEvent {
  const data: LlmRequestTrace = {
    requestId: overrides.requestId ?? 'turn-1#0',
    turnId: overrides.turnId ?? 'turn-1',
    iteration: overrides.iteration ?? 0,
    ts: overrides.ts ?? 0,
    systemPrompt: overrides.systemPrompt ?? '',
    messages: overrides.messages ?? [],
    tools: overrides.tools ?? [],
    llm: overrides.llm ?? { id: 'test', supportsTools: true },
  };
  return { kind: 'llm_request', data };
}

function resp(overrides: Partial<LlmResponseTrace> = {}): TraceEvent {
  const data: LlmResponseTrace = {
    requestId: overrides.requestId ?? 'turn-1#0',
    ts: overrides.ts ?? 0,
    text: overrides.text ?? '',
    thinking: overrides.thinking ?? '',
    toolCalls: overrides.toolCalls ?? [],
  };
  return { kind: 'llm_response', data };
}

describe('analyzeTruthfulness', () => {
  test('empty trace produces zero turns and zero flags', () => {
    const report = analyzeTruthfulness([]);
    expect(report.totalAssistantTurns).toBe(0);
    expect(report.totalFlags).toBe(0);
    expect(report.violationRate).toBe(0);
  });

  test('grounded path is not flagged', () => {
    const events: TraceEvent[] = [
      req({
        messages: [
          {
            role: 'tool',
            callId: 'c1',
            name: 'firestore_discover_paths',
            text: '',
            resultJson: '{"paths":["users/abc123/orders"]}',
          },
        ],
      }),
      resp({ text: 'I see the path users/abc123/orders in the project.' }),
    ];
    const report = analyzeTruthfulness(events);
    expect(report.totalFlags).toBe(0);
    expect(report.totalAssistantTurns).toBe(1);
  });

  test('fabricated path is flagged', () => {
    const events: TraceEvent[] = [
      req({ messages: [] }),
      resp({ text: 'The collection users/fakeid/orders contains 5 documents.' }),
    ];
    const report = analyzeTruthfulness(events);
    expect(report.totalFlags).toBe(1);
    expect(report.flags[0]?.category).toBe('firestore-path');
    expect(report.flags[0]?.claim).toBe('users/fakeid/orders');
  });

  test('claim appearing in system prompt is grounded', () => {
    const events: TraceEvent[] = [
      req({
        systemPrompt: 'The project has a collection at internal/marker/path.',
        messages: [],
      }),
      resp({ text: 'Looking at internal/marker/path.' }),
    ];
    const report = analyzeTruthfulness(events);
    expect(report.totalFlags).toBe(0);
  });

  test('claim appearing in user prompt is grounded', () => {
    const events: TraceEvent[] = [
      req({
        messages: [{ role: 'user', text: 'Inspect users/myuser/profile please' }],
      }),
      resp({ text: 'Inspecting users/myuser/profile now.' }),
    ];
    const report = analyzeTruthfulness(events);
    expect(report.totalFlags).toBe(0);
  });

  test('response text derived from next request when no response event present', () => {
    const events: TraceEvent[] = [
      req({
        requestId: 't1#0',
        iteration: 0,
        messages: [],
      }),
      req({
        requestId: 't1#1',
        iteration: 1,
        messages: [{ role: 'assistant', text: 'Inspecting users/abc123/orders next.' }],
      }),
    ];
    const report = analyzeTruthfulness(events);
    expect(report.totalFlags).toBe(1);
    expect(report.flags[0]?.claim).toBe('users/abc123/orders');
  });

  test('stopwords like firestore or true are not flagged', () => {
    const events: TraceEvent[] = [
      req({}),
      resp({ text: 'The answer is `true` and we use `firestore`.' }),
    ];
    const report = analyzeTruthfulness(events);
    expect(report.totalFlags).toBe(0);
  });

  test('template paths with curly braces are not flagged', () => {
    const events: TraceEvent[] = [
      req({}),
      resp({ text: 'Use the path users/{userId}/orders/{orderId}.' }),
    ];
    const report = analyzeTruthfulness(events);
    expect(report.totalFlags).toBe(0);
  });

  test('violation rate computed across multiple turns', () => {
    const events: TraceEvent[] = [
      req({ requestId: 't1#0' }),
      resp({ requestId: 't1#0', text: 'I see users/real-id/orders.' }),
      req({ requestId: 't1#1' }),
      resp({ requestId: 't1#1', text: 'No paths involved here.' }),
    ];
    const report = analyzeTruthfulness(events);
    expect(report.totalAssistantTurns).toBe(2);
    expect(report.totalFlags).toBe(1);
    expect(report.violationRate).toBe(0.5);
  });

  test('duplicate fabrications in one turn count once', () => {
    const events: TraceEvent[] = [
      req({}),
      resp({
        text: 'See users/fake/x. Also users/fake/x again. And users/fake/x once more.',
      }),
    ];
    const report = analyzeTruthfulness(events);
    expect(report.totalFlags).toBe(1);
  });

  test('quoted identifier in backticks is flagged when ungrounded', () => {
    const events: TraceEvent[] = [
      req({}),
      resp({ text: 'The helper `isProjectMember` returns true for members.' }),
    ];
    const report = analyzeTruthfulness(events);
    expect(report.totalFlags).toBe(1);
    expect(report.flags[0]?.category).toBe('quoted-identifier');
    expect(report.flags[0]?.claim).toBe('isProjectMember');
  });

  test('grounded quoted identifier is not flagged', () => {
    const events: TraceEvent[] = [
      req({
        messages: [
          {
            role: 'tool',
            callId: 'c1',
            name: 'firestore_rules_stdlib_list',
            text: '',
            resultJson: '{"helpers":["isProjectMember","isOwner"]}',
          },
        ],
      }),
      resp({ text: 'The helper `isProjectMember` returns true for members.' }),
    ];
    const report = analyzeTruthfulness(events);
    expect(report.totalFlags).toBe(0);
  });
});
