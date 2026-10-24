import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {Context, Effect, Layer, Schema, Stream} from "effect";
import {checkoutObservation, CheckoutObservation} from "../src/checkout-observation.js";
import {ProjectFileError} from "../src/project-files.js";
import {makeDefinitionFixture} from "./project-definitions-fixture.js";
import {ProjectSupervisorStore} from "../src/project-supervisor-store.js";
import {DashboardUpdates} from "../src/dashboard-updates.js";
import {openSupervisionStores, supervisionStoresLayer, temporaryDirectory} from "./support/g11-stores.js";

it.effect("completed folder checks persist only confirmed missing bindings, and persistence failure cannot hide folder truth", () => Effect.gen(function*() {
  const f = makeDefinitionFixture();
  const observed: Array<typeof CheckoutObservation.Type> = [];
  const definitions = yield* f.makeDefinitions({files: {...f.projectFiles, directoryExists: root => root === f.threadRoot ? Effect.succeed(false) : f.projectFiles.directoryExists(root)},
    options: {...f.definitionOptions, recordCheckoutObservation: (_, value) => Effect.sync(() => {observed.push(value);})}});
  const inventory = yield* definitions.checkoutInventory(f.projectId);
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0]?.missing, [{workspaceRoot: f.threadRoot, threadIds: ["thread"]}]);
  assert.equal(observed[0]?.projectRoot, f.root);
  const denied = yield* f.makeDefinitions({files: {...f.projectFiles, directoryExists: root => root === f.threadRoot ? Effect.fail(new ProjectFileError("permission_required")) : f.projectFiles.directoryExists(root)}});
  assert.deepEqual(checkoutObservation(yield* denied.checkoutInventory(f.projectId), 5).missing, []);
  const failing = yield* f.makeDefinitions({files: {...f.projectFiles, directoryExists: root => root === f.threadRoot ? Effect.succeed(false) : f.projectFiles.directoryExists(root)},
    options: {...f.definitionOptions, recordCheckoutObservation: () => Effect.fail("unavailable")}});
  assert.deepEqual((yield* failing.checkoutInventory(f.projectId)).targets, inventory.targets);
}));

it.effect("folder observations survive restart, reject older completions and decode stored rows", () => Effect.gen(function*() {
  const directory = yield* temporaryDirectory("checkout-observation-");
  const first = yield* openSupervisionStores(directory);
  yield* Effect.addFinalizer(() => first.close);
  const observation = {checkedAt: 20, projectRoot: "/work/project", missing: [{workspaceRoot: "/work/missing", threadIds: ["main"]}]};
  yield* first.supervisors.recordCheckoutObservation("project", observation);
  yield* first.supervisors.recordCheckoutObservation("project", {...observation, checkedAt: 10, missing: []});
  assert.deepEqual(yield* first.supervisors.checkoutObservation("project"), observation);
  yield* first.close;
  const second = yield* openSupervisionStores(directory);
  yield* Effect.addFinalizer(() => second.close);
  assert.deepEqual(yield* second.supervisors.checkoutObservation("project"), observation);
  yield* second.supervisors.recordCheckoutObservation("project", {...observation, checkedAt: 30, missing: []});
  assert.deepEqual((yield* second.supervisors.checkoutObservation("project"))?.missing, []);
  yield* second.sql`UPDATE meta SET value='{"checkedAt":"invalid"}' WHERE key='supervisor_checkout_observation:project'`;
  assert.equal((yield* Effect.flip(second.supervisors.checkoutObservation("project"))).reason, "supervision_row_invalid");
  assert.equal(Schema.is(CheckoutObservation)({checkedAt: 1, missing: []}), false);
}));

it.effect("committed folder changes invalidate Home and the project once, without timestamp-only refresh loops", () => Effect.gen(function*() {
  const directory = yield* temporaryDirectory("checkout-hints-");
  const events: Array<ReadonlyArray<string> | null> = [];
  const observer = DashboardUpdates.of({publish: keys => Effect.sync(() => {events.push(keys);}), stream: Stream.empty});
  const context = yield* Layer.build(supervisionStoresLayer(directory).pipe(Layer.provide(Layer.succeed(DashboardUpdates, observer))));
  const store = Context.get(context, ProjectSupervisorStore);
  const observation = {checkedAt: 10, projectRoot: "/project", missing: [{workspaceRoot: "/removed", threadIds: ["main"]}]};
  events.length = 0;
  yield* store.recordCheckoutObservation("project", observation);
  assert.deepEqual(events, [["overview", "project:project"]]);
  yield* store.recordCheckoutObservation("project", {...observation, checkedAt: 20});
  yield* store.recordCheckoutObservation("project", {...observation, checkedAt: 15, missing: []});
  assert.equal(events.length, 1);
  yield* store.recordCheckoutObservation("project", {...observation, checkedAt: 30, missing: []});
  assert.equal(events.length, 2);
}));
