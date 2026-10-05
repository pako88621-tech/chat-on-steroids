import assert from 'node:assert/strict';
import test from 'node:test';
import type { ControlSemanticEventDto } from '../control-client.js';
import { projectSemanticControlEvent } from '../semantic-events.js';

function toolEvent(): ControlSemanticEventDto {
  const value = {
    seq: 7,
    position: 7,
    time: 1_000,
    kind: 'tool_call',
    source: 'mcp',
    turnId: 'turn-7',
    tool: {
      callId: 'call-7',
      name: 'update_plan',
      outcome: 'ok',
      durationMs: 12,
      attribution: 'request_id',
      summary: { title: 'Updated plan', detail: '2 / 3 completed', tone: 'neutral', kind: 'session' },
      changes: [],
    },
  } as unknown as ControlSemanticEventDto;
  Object.defineProperty(value.tool!, 'args', { get() { throw new Error('raw args were read'); } });
  Object.defineProperty(value.tool!, 'result', { get() { throw new Error('raw result was read'); } });
  return value;
}

test('semantic event projection never reads raw tool args or results', () => {
  assert.deepEqual(projectSemanticControlEvent(toolEvent()), {
    seq: 7,
    kind: 'tool_call',
    turnId: 'turn-7',
    summary: 'Updated plan — 2 / 3 completed',
    tool: {
      name: 'update_plan',
      outcome: 'ok',
      summary: { title: 'Updated plan', detail: '2 / 3 completed', kind: 'session' },
      changes: [],
    },
  });
});

test('semantic event projection keeps only structured terminal facts', () => {
  const final = projectSemanticControlEvent({
    seq: 9, position: 9, time: 1_100, kind: 'assistant_message', source: 'extension',
    turnId: 'turn-7', final: true, state: 'final',
  } as ControlSemanticEventDto);
  assert.deepEqual(final, { seq: 9, kind: 'assistant_message', turnId: 'turn-7', final: true, state: 'final' });

  const ended = projectSemanticControlEvent({
    seq: 10, position: 10, time: 1_200, kind: 'turn_end', source: 'extension',
    turnId: 'turn-7', outcome: 'completed', detail: 'secret text',
  } as ControlSemanticEventDto);
  assert.deepEqual(ended, { seq: 10, kind: 'turn_end', turnId: 'turn-7', outcome: 'completed' });
});

test('semantic checkpoint text and paths are sanitized before they can leave the classifier boundary', () => {
  const event = toolEvent();
  event.tool!.summary.title = 'Used Bearer secret-token';
  event.tool!.summary.detail = '/Users/alice/private/file.ts';
  event.tool!.changes = [{ path: 'C:\\Users\\alice\\private.txt', added: 1, removed: 0 }];
  const projected = projectSemanticControlEvent(event, ['secret-token']);
  assert(projected?.tool);
  const json = JSON.stringify(projected);
  assert.equal(json.includes('secret-token'), false);
  assert.equal(json.includes('/Users/alice'), false);
  assert.equal(json.includes('C:\\Users\\alice'), false);
});
