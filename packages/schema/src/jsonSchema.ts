import type { NormalizedEvent } from './types';
import type { Experiment, PeriodReport, ProposalEvent, SetupEvent, SetupProposal } from './advisorRecords';
import schemaV1 = require('./normalizedEvent.v1.schema.json');
import schemaV2 = require('./normalizedEvent.v2.schema.json');
import schemaV3 = require('./normalizedEvent.v3.schema.json');
import periodReportV1 = require('./periodReport.v1.schema.json');
import proposalEventV1 = require('./proposalEvent.v1.schema.json');
import experimentV1 = require('./experiment.v1.schema.json');
import setupEventV1 = require('./setupEvent.v1.schema.json');

/**
 * JSON Schema (draft 2020-12) for one line of the event log, version 3:
 * version 2 plus the `outcome` kind and field, for outcome signals Snagboat
 * works out (tests going green, how you met a finding), `todos`, the
 * agent's todo list on its todo tool calls, and `taskOp`, a change its task
 * tools made to its plan. Version 2 added
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

// Version 2 is version 3 without `outcome`, `todos` and `taskOp`.
type V2Fields = keyof typeof schemaV2.properties;
type AddedInV3 = Exclude<SchemaFields, V2Fields>;
type RemovedInV3 = Exclude<V2Fields, SchemaFields>;
const v2IsV3WithoutOutcome: [AddedInV3, RemovedInV3, 'outcome' | 'todos' | 'taskOp'] extends ['outcome' | 'todos' | 'taskOp', never, AddedInV3] ? true : never = true;
void v2IsV3WithoutOutcome;

// And version 1 is version 2 without `workspace`.
type V1Fields = keyof typeof schemaV1.properties;
type AddedInV2 = Exclude<V2Fields, V1Fields>;
type RemovedInV2 = Exclude<V1Fields, V2Fields>;
const v1IsV2WithoutWorkspace: [AddedInV2, RemovedInV2, 'workspace'] extends ['workspace', never, AddedInV2] ? true : never = true;
void v1IsV2WithoutWorkspace;

/**
 * The goal tracking lifecycle's records (advisorRecords.ts), version 1: an advisor's period report, one
 * line of its proposal log, and an experiment. Types and a test-checked schema, as events have; nothing
 * validates against them at run time.
 */
export const periodReportSchema = periodReportV1;
export const proposalEventSchema = proposalEventV1;
export const experimentSchema = experimentV1;
/** One line of a setup conversation (snagboat-79f.7.15). */
export const setupEventSchema = setupEventV1;

// Compile-time check, as for events: each schema lists exactly its type's fields.
type Same<A, B> = [Exclude<A, B>, Exclude<B, A>] extends [never, never] ? true : never;
const reportFields: Same<keyof PeriodReport, keyof typeof periodReportV1.properties> = true;
const proposalFields: Same<keyof ProposalEvent, keyof typeof proposalEventV1.properties> = true;
const experimentFields: Same<keyof Experiment, keyof typeof experimentV1.properties> = true;
void reportFields;
void proposalFields;
void experimentFields;
const setupFields: Same<keyof SetupEvent, keyof typeof setupEventV1.properties> = true;
const setupProposalFields: Same<keyof SetupProposal, keyof typeof setupEventV1.properties.proposal.properties> = true;
void setupFields;
void setupProposalFields;
