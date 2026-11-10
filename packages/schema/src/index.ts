// @snagboat/schema: the records Snagboat and Factory Clock share
// (docs/design/architecture-rfc.md). Self-contained and browser-safe:
// nothing here imports Node builtins, vscode, or the rest of Snagboat.
export * from './types';
export * from './toolCategory';
export * from './eventDay';
export * from './sessions';
export * from './contextMarks';
export * from './sessionModel';
export * from './jsonSchema';
