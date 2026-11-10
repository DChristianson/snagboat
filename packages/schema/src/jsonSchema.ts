import type { NormalizedEvent } from './types';
import schemaV1 = require('./normalizedEvent.v1.schema.json');
import schemaV2 = require('./normalizedEvent.v2.schema.json');

/**
 * JSON Schema (draft 2020-12) for one line of the event log, version 2: version
 * 1 plus `workspace`, which events in the per-user store carry. Every version 1
 * event is a valid version 2 event, so readers take both.
 */
export const normalizedEventSchema = schemaV2;

/** Version 1, for event logs written before `workspace` existed. */
export const normalizedEventSchemaV1 = schemaV1;

// Compile-time check: the current schema lists exactly NormalizedEvent's fields.
// Adding a field to one and not the other fails `tsc`. (Value types are checked
// at run time against real events in normalizedEventSchema.unit.test.ts.)
type SchemaFields = keyof typeof schemaV2.properties;
type MissingFromSchema = Exclude<keyof NormalizedEvent, SchemaFields>;
type MissingFromType = Exclude<SchemaFields, keyof NormalizedEvent>;
const fieldsMatch: [MissingFromSchema, MissingFromType] extends [never, never] ? true : never = true;
void fieldsMatch;

// And version 1 is version 2 without `workspace`.
type V1Fields = keyof typeof schemaV1.properties;
type AddedInV2 = Exclude<SchemaFields, V1Fields>;
type RemovedInV2 = Exclude<V1Fields, SchemaFields>;
const v1IsV2WithoutWorkspace: [AddedInV2, RemovedInV2, 'workspace'] extends ['workspace', never, AddedInV2] ? true : never = true;
void v1IsV2WithoutWorkspace;
