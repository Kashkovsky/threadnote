import {Effect, Schema} from 'effect';

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

export const fromPromise = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({try: evaluate, catch: cause => applicationError(operation, cause)});

export const fromPromiseInterruptible = <A, E>(
  evaluate: (signal: AbortSignal) => PromiseLike<A>,
  onError: (cause: unknown) => E,
) => Effect.tryPromise({try: evaluate, catch: onError});

export const fromSync = <A>(operation: string, evaluate: () => A) =>
  Effect.try({try: evaluate, catch: cause => applicationError(operation, cause)});
