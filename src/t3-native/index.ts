// The public surface of the T3 integration: the T3Native service, its shape and the contracts its callers need. Business modules import
// only this file; everything under ./internal is private to the integration.
export * from "./contracts.js";
export * from "./errors.js";
export { buildFacts, referenceBuilds } from "./build.js";
export {
  T3Native,
  type T3BuildFamily, type T3Command, type T3FileCommits, type T3FileReads, type T3FilesFamily, type T3FileWrites, type T3HelperFamily,
  type T3InFlight, type T3NativeShape, type T3OrchestrationCommands, type T3OrchestrationFamily, type T3PreparedCommand,
  type T3TerminalFamily, type TerminalAttachHandlers, type TerminalAttachStep, type T3Endpoint, type T3NativeClients, type T3NativeCredentials,
} from "./service.js";
