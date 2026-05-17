/**
 * `@inbrowser/agent/cli` — programmatic entry to the same CLI surface
 * the `agent` binary exposes. Use this when embedding the CLI inside
 * another process (e.g. an MCP server, an in-process supervisor) so
 * that argv parsing, hardening, and output emission stay consistent.
 */

export { main } from './main.js';
export type { MainOptions } from './main.js';
export { runCommand } from './commands/run.js';
export type { RunCommandIO, RunPayload } from './commands/run.js';
export { fleetCommand } from './commands/fleet.js';
export type { FleetCommandIO } from './commands/fleet.js';
export { describeCommand } from './commands/describe.js';
export { schemaCommand } from './commands/schema.js';
export { helpCommand, versionCommand } from './commands/help.js';
export { parseArgs, UsageError, InputHardeningError } from './parse.js';
export type { ParsedArgs } from './parse.js';
export { createEmitter, errorEvent, pickMode } from './output.js';
export type { Emitter, OutputMode, OutputOptions } from './output.js';
export { hardenString, hardenPath } from './hardening.js';
export type { HardeningRules } from './hardening.js';
export { openSessionLog, defaultLogDir } from './session-log.js';
export type { SessionLog, OpenSessionLogOptions } from './session-log.js';
export { scriptedLlm, fakeSandbox, writeRulesTool, writeCodeTool } from './fixtures.js';
export type { ScenarioId } from './fixtures.js';
export { CLI_SPEC, findCommand } from './spec.js';
export type { CliSpec, CommandSpec, OptionSpec, OptionType } from './spec.js';
