import type { NormalizedEvent } from './types';
import schemaV1 = require('./normalizedEvent.v1.schema.json');
import schemaV2 = require('./normalizedEvent.v2.schema.json');
import schemaV3 = require('./normalizedEvent.v3.schema.json');

/**
 * JSON Schema (draft 2020-12) for one line of the event log, version 3:
 * version 2 plus the `outcome` kind and field, for outcome signals Snagboat
 * works out (tests going green, how you met a finding), and `todos`, the
 * agent's todo list on its todo tool calls. Version 2 added
 * `workspace`. Every version 1 and 2 event is a valid version 3 event, so
 * readers take all three.
 */
export const normalizedEventSchema = schemaV3;

/** Version 2, for event logs written before outcome events existed. */
export const normalizedEventSchemaV2 = schemaV2;

/** Version 1, for event logs written before `workspace` existed. */
export const normalizedEventSchemaV1 = schemaV1;

// Compile-time check: the current schema lists exactly NormalizedEvent's fields.
// Adding a field to one and not the other fails `tsc`. (Value types are checked
// at run time against real events in normalizedEventSchema.unit.test.ts.)
type SchemaFields = keyof typeof schemaV3.properties;
type MissingFromSchema = Exclude<keyof NormalizedEvent, SchemaFields>;
type MissingFromType = Exclude<SchemaFields, keyof NormalizedEvent>;
const fieldsMatch: [MissingFromSchema, MissingFromType] extends [never, never] ? true : never = true;
void fieldsMatch;

// Version 2 is version 3 without `outcome` and `todos`.
type V2Fields = keyof typeof schemaV2.properties;
type AddedInV3 = Exclude<SchemaFields, V2Fields>;
type RemovedInV3 = Exclude<V2Fields, SchemaFields>;
const v2IsV3WithoutOutcome: [AddedInV3, RemovedInV3, 'outcome' | 'todos'] extends ['outcome' | 'todos', never, AddedInV3] ? true : never = true;
void v2IsV3WithoutOutcome;

// And version 1 is version 2 without `workspace`.
type V1Fields = keyof typeof schemaV1.properties;
type AddedInV2 = Exclude<V2Fields, V1Fields>;
type RemovedInV2 = Exclude<V1Fields, V2Fields>;
const v1IsV2WithoutWorkspace: [AddedInV2, RemovedInV2, 'workspace'] extends ['workspace', never, AddedInV2] ? true : never = true;
void v1IsV2WithoutWorkspace;
