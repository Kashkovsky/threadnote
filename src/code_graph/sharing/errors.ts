import {Schema} from 'effect';

export const GRAPH_SHARING_ERROR_KINDS = ['unavailable', 'verification-failed'] as const;
export type GraphSharingErrorKind = (typeof GRAPH_SHARING_ERROR_KINDS)[number];

export class GraphSharingError extends Schema.TaggedError<GraphSharingError>()('GraphSharingError', {
  cause: Schema.optionalKey(Schema.Defect()),
  kind: Schema.Literals(['unavailable', 'verification-failed']),
  message: Schema.String,
}) {}

export function graphSharingFailure(
  message: string,
  cause?: unknown,
  kind: GraphSharingErrorKind = 'verification-failed',
): GraphSharingError {
  return cause === undefined ? GraphSharingError.make({kind, message}) : GraphSharingError.make({cause, kind, message});
}

export function graphSharingUnavailable(message: string): GraphSharingError {
  return GraphSharingError.make({kind: 'unavailable', message});
}
