import {Effect, Schema} from 'effect';
import {tryPromiseWithConsole} from './console.js';

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
  tryPromiseWithConsole({try: evaluate, catch: cause => applicationError(operation, cause)});

export const fromPromiseError = <A>(evaluate: () => PromiseLike<A>) =>
  tryPromiseWithConsole({
    try: evaluate,
    catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
  });

export const fromSync = <A>(operation: string, evaluate: () => A) =>
  Effect.try({try: evaluate, catch: cause => applicationError(operation, cause)});
