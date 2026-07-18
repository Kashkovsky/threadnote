import {Schema} from 'effect';

export class ApplicationError extends Schema.TaggedErrorClass<ApplicationError>()('ApplicationError', {
  cause: Schema.Defect(),
  message: Schema.String,
  operation: Schema.String,
}) {}

export function applicationError(operation: string, cause: unknown): ApplicationError {
  return new ApplicationError({
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
  });
}
