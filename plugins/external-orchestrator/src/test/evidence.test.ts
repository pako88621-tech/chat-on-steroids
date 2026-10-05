import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EvidenceReadError,
  projectControlEvent,
  readEvidencePage,
  waitForEvidence,
  type EvidenceControlClient,
  type EvidenceControlResponse,
} from '../evidence.js';

interface ClientCall {
  path: string;
  options: { timeoutMs?: number; signal?: AbortSignal } | undefined;
  at: number;
}

type ClientHandler = (
  path: string,
  options: { timeoutMs?: number; signal?: AbortSignal } | undefined,
  call: number,
) => EvidenceControlResponse<unknown> | Promise<EvidenceControlResponse<unknown>>;

class StubClient implements EvidenceControlClient {
  readonly calls: ClientCall[] = [];

  constructor(private readonly handler: ClientHandler) {}

  async get<T = unknown>(
    path: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<EvidenceControlResponse<T>> {
    this.calls.push({ path, options, at: Date.now() });
    return await this.handler(path, options, this.calls.length) as EvidenceControlResponse<T>;
  }
}

function okPage(events: unknown[], nextFrom: number, total = events.length): EvidenceControlResponse<unknown> {
  return { status: 200, body: { events, total, nextFrom }, retryAfterMs: null };
}

function note(seq: number, message = `note-${seq}`): Record<string, unknown> {
  return { seq, time: 1_700_000_000_000 + seq, kind: 'note', message: { text: message } };
}

function expectEvidenceError(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof EvidenceReadError && error.code === code;
}

test('projects only allowlisted evidence fields and never copies raw tool args/results', () => {
  const bearer = 'eo-current-bearer-token-1234567890';
  const hostPath = '/Users/alice/private/work/result.txt';
  const projected = projectControlEvent({
    seq: 7,
    time: 1234,
    kind: 'tool_call',
    turnId: `turn-${bearer}`,
    messageId: 'message-7',
    resolvedModel: 'gpt-test',
    tool: {
      name: 'exec_command',
      outcome: 'success',
      summary: {
        title: `Ran with ${bearer}`,
        detail: `Wrote ${hostPath}`,
        metric: '1 file',
      },
      durationMs: 42,
      changes: [{ path: hostPath, added: 3, removed: 1 }],
      args: { command: `cat ${hostPath}`, authorization: `Bearer ${bearer}`, rawArgSecret: 'arg-secret' },
      result: { stdout: 'result-secret', path: hostPath },
    },
  }, 'detail', [bearer]);

  assert.ok(projected);
  assert.equal(projected.kind, 'tool_call');
  assert.equal(projected.summary, 'Ran with [secret-redacted] — Wrote [host-path-redacted] (1 file)');
  assert.deepEqual(JSON.parse(JSON.stringify(projected.detail)), {
    changes: [{ path: '[host-path-redacted]', added: 3, removed: 1 }],
    detail: 'Wrote [host-path-redacted]',
    duration_ms: 42,
    message_id: 'message-7',
    metric: '1 file',
    model: 'gpt-test',
    outcome: 'success',
    title: 'Ran with [secret-redacted]',
    tool: 'exec_command',
    turn_id: 'turn-[secret-redacted]',
  });
  const published = JSON.stringify(projected);
  for (const forbidden of [bearer, hostPath, 'arg-secret', 'result-secret', '"args"', '"result"']) {
    assert.equal(published.includes(forbidden), false, `published evidence leaked ${forbidden}`);
  }
});

test('omits malformed and unknown event kinds while advancing by the page nextFrom cursor', async () => {
  const client = new StubClient(() => okPage([
    { seq: 20, time: 20, kind: 'future_kind', secret: 'must-not-publish' },
    { seq: 21, kind: 'note', message: { text: 'missing time' } },
    note(22, 'publishable'),
  ], 91, 3));

  const page = await readEvidencePage(client, { sessionId: 'session-1234', cursor: 10, limit: 5 });
  assert.equal(page.cursor, 91, 'cursor must be Control API nextFrom, not derived from the last projected seq');
  assert.equal(page.caught_up, true);
  assert.deepEqual(page.items.map((item) => item.seq), [22]);
  assert.equal(JSON.stringify(page.items).includes('must-not-publish'), false);
  assert.equal(client.calls[0]?.path, '/v1/sessions/session-1234/events?from=10&limit=5');
});

test('uses exactly one row of lookahead to determine caught_up at a full page boundary', async (t) => {
  await t.test('empty lookahead is caught up', async () => {
    const client = new StubClient((_path, _options, call) => {
      if (call === 1) return okPage([note(1), note(2)], 50, 2);
      return okPage([], 50, 2);
    });
    const page = await readEvidencePage(client, { sessionId: 'session-lookahead', cursor: 0, limit: 2 });
    assert.equal(page.caught_up, true);
    assert.equal(page.cursor, 50);
    assert.deepEqual(client.calls.map((call) => call.path), [
      '/v1/sessions/session-lookahead/events?from=0&limit=2',
      '/v1/sessions/session-lookahead/events?from=50&limit=1',
    ]);
  });

  await t.test('one lookahead row means more evidence exists', async () => {
    const client = new StubClient((_path, _options, call) => {
      if (call === 1) return okPage([note(1), note(2)], 50, 3);
      return okPage([note(3)], 51, 3);
    });
    const page = await readEvidencePage(client, { sessionId: 'session-lookahead-more', cursor: 0, limit: 2 });
    assert.equal(page.caught_up, false);
    assert.equal(page.cursor, 50, 'lookahead must not consume the caller-visible cursor');
    assert.equal(client.calls.length, 2);
  });
});

test('bounds evidence cursors/limits and rejects a response page larger than the requested limit', async () => {
  const bounded = new StubClient((path) => {
    const from = Number(new URL(`http://local${path}`).searchParams.get('from'));
    return okPage([], from, 0);
  });
  await readEvidencePage(bounded, { sessionId: 'session-bounds', cursor: -9, limit: 999 });
  await readEvidencePage(bounded, { sessionId: 'session-bounds', cursor: 3, limit: 0 });
  await readEvidencePage(bounded, { sessionId: 'session-bounds', cursor: 4, limit: Number.NaN });
  assert.deepEqual(bounded.calls.map((call) => call.path), [
    '/v1/sessions/session-bounds/events?from=0&limit=100',
    '/v1/sessions/session-bounds/events?from=3&limit=1',
    '/v1/sessions/session-bounds/events?from=4&limit=40',
  ]);

  const oversized = new StubClient(() => okPage([note(1), note(2)], 2, 2));
  await assert.rejects(
    readEvidencePage(oversized, { sessionId: 'session-oversized', cursor: 0, limit: 1 }),
    expectEvidenceError('internal_error'),
  );
});

test('wait begins at the supplied cursor and returns the server nextFrom cursor with the first projected row', async () => {
  const client = new StubClient(() => okPage([note(88, 'ready')], 144, 1));
  const result = await waitForEvidence(client, { sessionId: 'session-wait-cursor', cursor: 37, waitMs: 2_000 });
  assert.equal(client.calls[0]?.path, '/v1/sessions/session-wait-cursor/events?from=37&limit=1');
  assert.equal(result.cursor, 144);
  assert.equal(result.timedOut, false);
  assert.equal(result.item?.seq, 88);
});

test('wait caps the requested timeout at 30 seconds before issuing another read', async () => {
  let reads = 0;
  const client = new StubClient(() => {
    reads += 1;
    return okPage([], 0, 0);
  });
  const ticks = [1_000, 31_000];
  const result = await waitForEvidence(client, {
    sessionId: 'session-time-cap',
    waitMs: 999_999,
    now: () => ticks.shift() ?? 31_000,
  });
  assert.deepEqual(result, { cursor: 0, timedOut: true });
  assert.equal(reads, 0, 'a capped 30s deadline should already be expired at t=31s');
});

test('wait backs off idle polling from 600ms to 900ms before returning evidence', async () => {
  const client = new StubClient((_path, _options, call) => {
    if (call < 3) return okPage([], 0, 0);
    return okPage([note(1, 'after-idle')], 1, 1);
  });
  const result = await waitForEvidence(client, { sessionId: 'session-idle-backoff', waitMs: 5_000 });
  assert.equal(result.item?.summary, 'after-idle');
  assert.equal(client.calls.length, 3);
  const firstGap = client.calls[1]!.at - client.calls[0]!.at;
  const secondGap = client.calls[2]!.at - client.calls[1]!.at;
  assert.ok(firstGap >= 500, `first idle gap too short: ${firstGap}ms`);
  assert.ok(secondGap >= 800, `second idle gap did not back off: ${secondGap}ms`);
});

test('wait honors Retry-After for 429 rate limits and 503 busy responses', async (t) => {
  for (const scenario of [
    { name: '429 rate limit', status: 429, body: { error: 'rate_limited' }, retryAfterMs: 1_200, minimumGap: 1_100 },
    { name: '503 busy', status: 503, body: { error: 'busy' }, retryAfterMs: 1_400, minimumGap: 1_300 },
  ] as const) {
    await t.test(scenario.name, async () => {
      const client = new StubClient((_path, _options, call) => {
        if (call === 1) {
          return { status: scenario.status, body: scenario.body, retryAfterMs: scenario.retryAfterMs };
        }
        return okPage([note(9, scenario.name)], 10, 1);
      });
      const result = await waitForEvidence(client, { sessionId: `session-${scenario.status}`, waitMs: 5_000 });
      assert.equal(result.item?.seq, 9);
      assert.equal(client.calls.length, 2);
      const gap = client.calls[1]!.at - client.calls[0]!.at;
      assert.ok(gap >= scenario.minimumGap, `${scenario.name} retried too early after ${gap}ms`);
    });
  }
});

test('AbortSignal interrupts an idle wait promptly', async () => {
  const controller = new AbortController();
  const client = new StubClient(() => okPage([], 0, 0));
  const started = Date.now();
  const pending = waitForEvidence(client, {
    sessionId: 'session-abort',
    waitMs: 5_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.ok(Date.now() - started < 500, 'abort should interrupt the 600ms idle sleep');
});

test('allows only one active wait loop per session and releases the slot after cancellation', async () => {
  const controller = new AbortController();
  const blockingClient = new StubClient((_path, options) => new Promise<EvidenceControlResponse<unknown>>((_resolve, reject) => {
    const rejectAborted = (): void => reject(Object.assign(new Error('request aborted'), { code: 'request_aborted' }));
    if (options?.signal?.aborted) rejectAborted();
    else options?.signal?.addEventListener('abort', rejectAborted, { once: true });
  }));
  const first = waitForEvidence(blockingClient, {
    sessionId: 'session-single-loop',
    waitMs: 5_000,
    signal: controller.signal,
  });

  await assert.rejects(
    waitForEvidence(new StubClient(() => okPage([], 0, 0)), {
      sessionId: 'session-single-loop',
      waitMs: 1_000,
    }),
    (error: unknown) => expectEvidenceError('busy')(error)
      && (error as EvidenceReadError).retryAfterMs === 600,
  );

  controller.abort();
  await assert.rejects(first, (error: unknown) => error instanceof Error && error.name === 'AbortError');

  const released = await waitForEvidence(new StubClient(() => okPage([note(2, 'released')], 3, 1)), {
    sessionId: 'session-single-loop',
    waitMs: 1_000,
  });
  assert.equal(released.item?.summary, 'released');
});
