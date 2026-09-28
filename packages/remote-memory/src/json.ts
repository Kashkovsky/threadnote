import {Schema} from 'effect';
import type {JSONValue} from 'postgres';

const isJson = Schema.is(Schema.Json);
const isJsonObjectValue = Schema.is(Schema.JsonObject);

/** Validate values passed to Postgres' JSON parameter encoder. */
export function requireJsonValue(value: unknown): JSONValue {
  if (!isJson(value)) throw new TypeError('Expected a JSON-compatible value.');
  return value;
}

export function isJsonValue(value: unknown): value is JSONValue {
  return isJson(value);
}

export function isJsonObject(value: unknown): value is Schema.JsonObject {
  return isJsonObjectValue(value);
}
