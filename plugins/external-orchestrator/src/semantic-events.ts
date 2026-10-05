import type { ControlSemanticEventDto } from './control-client.js';
import { sanitizeExternalEvidenceString } from './evidence-sanitizer.js';
import type { SemanticProjectedEvent } from './semantic-wait.js';

const MAX_TITLE = 300;
const MAX_DETAIL = 300;
const MAX_METRIC = 160;
const MAX_KIND = 80;
const MAX_TOOL = 160;
const MAX_TURN = 256;
const MAX_PATH = 300;

function bounded(value: unknown, max: number, tokens: readonly string[]): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const safe = sanitizeExternalEvidenceString(value, tokens);
  return safe.length <= max ? safe : safe.slice(0, max);
}

function semanticSummary(event: ControlSemanticEventDto, tokens: readonly string[]): string | undefined {
  if (!event.tool) return undefined;
  const title = bounded(event.tool.summary.title, MAX_TITLE, tokens);
  const detail = bounded(event.tool.summary.detail, MAX_DETAIL, tokens);
  if (!title) return detail;
  return detail ? (title + ' — ' + detail).slice(0, MAX_TITLE + MAX_DETAIL + 3) : title;
}

/**
 * Narrow EO-internal semantic projection. Raw Local Control tool args/results are deliberately not
 * inspected: callers can pass accessor-backed objects and this function will never touch them.
 */
export function projectSemanticControlEvent(
  event: ControlSemanticEventDto,
  bearerTokens: Iterable<string> = [],
): SemanticProjectedEvent | null {
  if (!Number.isSafeInteger(event.seq) || event.seq < 0 || typeof event.kind !== 'string') return null;
  const tokens = [...bearerTokens];
  const turnId = bounded(event.turnId, MAX_TURN, tokens);
  const base: SemanticProjectedEvent = {
    seq: event.seq,
    kind: event.kind,
    ...(turnId ? { turnId } : {}),
  };

  switch (event.kind) {
    case 'assistant_message': {
      const state = bounded(event.state, MAX_KIND, tokens);
      return {
        ...base,
        ...(event.final === undefined ? {} : { final: event.final }),
        ...(state ? { state } : {}),
      };
    }
    case 'turn_end': {
      const outcome = bounded(event.outcome, MAX_KIND, tokens);
      return { ...base, ...(outcome ? { outcome } : {}) };
    }
    case 'chat_error':
      return {
        ...base,
        ...(event.recoverable === undefined ? {} : { recoverable: event.recoverable }),
        ...(event.blocking === undefined ? {} : { blocking: event.blocking }),
      };
    case 'tool_call': {
      const tool = event.tool;
      if (!tool) return base;
      const name = bounded(tool.name, MAX_TOOL, tokens);
      const outcome = bounded(tool.outcome, MAX_KIND, tokens);
      const title = bounded(tool.summary.title, MAX_TITLE, tokens);
      const detail = bounded(tool.summary.detail, MAX_DETAIL, tokens);
      const metric = bounded(tool.summary.metric, MAX_METRIC, tokens);
      const kind = bounded(tool.summary.kind, MAX_KIND, tokens);
      if (!name || !outcome || !title || !kind) return base;
      const summary = semanticSummary(event, tokens);
      return {
        ...base,
        ...(summary ? { summary } : {}),
        tool: {
          name,
          outcome,
          summary: {
            title,
            kind,
            ...(detail ? { detail } : {}),
            ...(metric ? { metric } : {}),
          },
          changes: tool.changes.slice(0, 64).map((change) => ({
            path: bounded(change.path, MAX_PATH, tokens) ?? '',
            added: Number.isSafeInteger(change.added) && change.added >= 0 ? change.added : 0,
            removed: Number.isSafeInteger(change.removed) && change.removed >= 0 ? change.removed : 0,
          })),
        },
      };
    }
    default:
      return base;
  }
}
