import type { NormalizedEvent } from './types';
import schema = require('./normalizedEvent.v1.schema.json');

/** JSON Schema (draft 2020-12) for one line of the event log, version 1. */
export const normalizedEventSchema = schema;

// Compile-time check: the schema lists exactly NormalizedEvent's fields. Adding a
// field to one and not the other fails `tsc`. (Value types are checked at run time
// against real events in normalizedEventSchema.unit.test.ts.)
type SchemaFields = keyof typeof schema.properties;
type MissingFromSchema = Exclude<keyof NormalizedEvent, SchemaFields>;
type MissingFromType = Exclude<SchemaFields, keyof NormalizedEvent>;
const fieldsMatch: [MissingFromSchema, MissingFromType] extends [never, never] ? true : never = true;
void fieldsMatch;
