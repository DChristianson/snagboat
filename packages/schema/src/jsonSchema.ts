import type { EventRefs, EventToolInput, NormalizedEvent } from './types';
import type { BranchRecord, CheckoutRecord, CommitRecord, FindingRecord, LinkRecord, PlanItemRecord, TransitionRecord } from './storeRecords';
import type { ExportCounts, ExportedEvent, ExportManifest, Redaction, SessionRecord } from './exportRecords';
import type { Experiment, PeriodReport, ProposalEvent, SetupEvent, SetupProposal } from './advisorRecords';
import schemaV1 = require('./normalizedEvent.v1.schema.json');
import schemaV2 = require('./normalizedEvent.v2.schema.json');
import schemaV3 = require('./normalizedEvent.v3.schema.json');
import schemaV4 = require('./normalizedEvent.v4.schema.json');
import exportedEventV4 = require('./exportedEvent.v4.schema.json');
import gitRecordV1 = require('./gitRecord.v1.schema.json');
import planRecordV1 = require('./planRecord.v1.schema.json');
import linkRecordV1 = require('./linkRecord.v1.schema.json');
import findingRecordV1 = require('./findingRecord.v1.schema.json');
import sessionRecordV1 = require('./sessionRecord.v1.schema.json');
import exportManifestV1 = require('./exportManifest.v1.schema.json');
import periodReportV1 = require('./periodReport.v1.schema.json');
import proposalEventV1 = require('./proposalEvent.v1.schema.json');
import experimentV1 = require('./experiment.v1.schema.json');
import setupEventV1 = require('./setupEvent.v1.schema.json');

/**
 * JSON Schema (draft 2020-12) for one line of the event log, version 4:
 * version 3 plus `toolInput`, the parts of a tool call's input worth drawing,
 * `refs`, the commit, branch or plan items a tool call observably acted on,
 * and `textTruncated`, set when stored text was cut at its cap. Version 3
 * added the `outcome` kind and field, for outcome signals Snagboat works out
 * (tests going green, how you met a finding), `todos`, the agent's todo list
 * on its todo tool calls, and `taskOp`, a change its task tools made to its
 * plan. Version 2 added `workspace`. Every version 1, 2 and 3 event is a
 * valid version 4 event, so readers take all four, and a version 3 reader
 * reads version 4 events, ignoring the fields it doesn't know.
 */
export const normalizedEventSchema = schemaV4;

/** Version 3, for event logs written before toolInput, refs and textTruncated existed. */
export const normalizedEventSchemaV3 = schemaV3;

/** Version 2, for event logs written before outcome events existed. */
export const normalizedEventSchemaV2 = schemaV2;

/** Version 1, for event logs written before `workspace` existed. */
export const normalizedEventSchemaV1 = schemaV1;

/**
 * One line of an export's events/YYYY-MM-DD.jsonl (docs/design/export.md): a version 4 event
 * without `workspace` and `raw`, which are never exported, plus `redactions`, which is export only.
 */
export const exportedEventSchema = exportedEventV4;

// Compile-time check: the current schema lists exactly NormalizedEvent's fields.
// Adding a field to one and not the other fails `tsc`. (Value types are checked
// at run time against real events in normalizedEventSchema.unit.test.ts.)
type Same<A, B> = [Exclude<A, B>, Exclude<B, A>] extends [never, never] ? true : never;
type SchemaFields = keyof typeof schemaV4.properties;
const fieldsMatch: Same<keyof NormalizedEvent, SchemaFields> = true;
void fieldsMatch;
const toolInputFields: Same<keyof EventToolInput, keyof typeof schemaV4.properties.toolInput.properties> = true;
const refsFields: Same<keyof EventRefs, keyof typeof schemaV4.properties.refs.properties> = true;
void toolInputFields;
void refsFields;
const exportedFields: Same<keyof ExportedEvent, keyof typeof exportedEventV4.properties> = true;
const redactionFields: Same<keyof Redaction, keyof typeof exportedEventV4.properties.redactions.items.properties> = true;
void exportedFields;
void redactionFields;

// Version 3 is version 4 without `toolInput`, `refs` and `textTruncated`.
type V3Fields = keyof typeof schemaV3.properties;
type AddedInV4 = Exclude<SchemaFields, V3Fields>;
type RemovedInV4 = Exclude<V3Fields, SchemaFields>;
const v3IsV4WithoutToolInput: [AddedInV4, RemovedInV4, 'toolInput' | 'refs' | 'textTruncated'] extends ['toolInput' | 'refs' | 'textTruncated', never, AddedInV4] ? true : never = true;
void v3IsV4WithoutToolInput;

// Version 2 is version 3 without `outcome`, `todos` and `taskOp`.
type V2Fields = keyof typeof schemaV2.properties;
type AddedInV3 = Exclude<V3Fields, V2Fields>;
type RemovedInV3 = Exclude<V2Fields, V3Fields>;
const v2IsV3WithoutOutcome: [AddedInV3, RemovedInV3, 'outcome' | 'todos' | 'taskOp'] extends ['outcome' | 'todos' | 'taskOp', never, AddedInV3] ? true : never = true;
void v2IsV3WithoutOutcome;

// And version 1 is version 2 without `workspace`.
type V1Fields = keyof typeof schemaV1.properties;
type AddedInV2 = Exclude<V2Fields, V1Fields>;
type RemovedInV2 = Exclude<V1Fields, V2Fields>;
const v1IsV2WithoutWorkspace: [AddedInV2, RemovedInV2, 'workspace'] extends ['workspace', never, AddedInV2] ? true : never = true;
void v1IsV2WithoutWorkspace;

/**
 * The store's git, plan, link and finding records (storeRecords.ts, docs/design/export.md),
 * version 1: one schema per store file. git.jsonl and plan.jsonl hold several record types, told
 * apart by `record`, so their schemas are an anyOf of one definition each ($defs). The export
 * writes the same records, sanitized. Types and test-checked schemas, as events have; nothing
 * validates against them at run time.
 */
export const gitRecordSchema = gitRecordV1;
export const planRecordSchema = planRecordV1;
export const linkRecordSchema = linkRecordV1;
export const findingRecordSchema = findingRecordV1;
/** One line of an export's sessions.jsonl (exportRecords.ts). */
export const sessionRecordSchema = sessionRecordV1;
/** An export folder's manifest.json (exportRecords.ts). */
export const exportManifestSchema = exportManifestV1;

// Compile-time check, as for events: each schema lists exactly its type's fields.
const commitFields: Same<keyof CommitRecord, keyof typeof gitRecordV1.$defs.commit.properties> = true;
const branchFields: Same<keyof BranchRecord, keyof typeof gitRecordV1.$defs.branch.properties> = true;
const checkoutFields: Same<keyof CheckoutRecord, keyof typeof gitRecordV1.$defs.checkout.properties> = true;
const itemFields: Same<keyof PlanItemRecord, keyof typeof planRecordV1.$defs.item.properties> = true;
const transitionFields: Same<keyof TransitionRecord, keyof typeof planRecordV1.$defs.transition.properties> = true;
const linkFields: Same<keyof LinkRecord, keyof typeof linkRecordV1.properties> = true;
const findingFields: Same<keyof FindingRecord, keyof typeof findingRecordV1.properties> = true;
const sessionFields: Same<keyof SessionRecord, keyof typeof sessionRecordV1.properties> = true;
const manifestFields: Same<keyof ExportManifest, keyof typeof exportManifestV1.properties> = true;
const countsFields: Same<keyof ExportCounts, keyof typeof exportManifestV1.properties.counts.properties> = true;
void commitFields;
void branchFields;
void checkoutFields;
void itemFields;
void transitionFields;
void linkFields;
void findingFields;
void sessionFields;
void manifestFields;
void countsFields;

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
