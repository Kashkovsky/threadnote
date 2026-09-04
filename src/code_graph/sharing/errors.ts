import {Schema} from 'effect';

export class GraphSharingError extends Schema.TaggedError<GraphSharingError>()('GraphSharingError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export function graphSharingFailure(message: string, cause?: unknown): GraphSharingError {
  return cause === undefined ? GraphSharingError.make({message}) : GraphSharingError.make({cause, message});
}
