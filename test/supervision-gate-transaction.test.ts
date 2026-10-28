import assert from "node:assert/strict";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect";
import { GuidanceDb, PolicyDb } from "../src/db.js";
import { AdmissionInsideTransaction, makeSupervisionGate, type GateGuard } from "../src/supervision-gate.js";
import { guidanceDb, policyDb, temporaryDataDirectory } from "./support/guidance-store-services.js";

// CT-LIN-07 (target regression, plan 3.11 item 2): an admission section is never acquired inside a guidance transaction. A
// request made while the calling fiber has the run's guidance client in a transaction dies with AdmissionInsideTransaction,
// before the section runs and without holding the permit; outside a transaction, and inside a transaction of another client,
// the same request is admitted

const openGuard: GateGuard = {scopeEnabled: () => Effect.succeed(true), supervisionStopped: () => Effect.succeed(false),
  workflowEditingEnabled: () => Effect.succeed(true)};

const live = <A, E, R>(body: Effect.Effect<A, E, R>) => body.pipe(Effect.provide(NodeServices.layer));

it.live("CT-LIN-07: admission requested inside a guidance transaction dies before its section runs and leaves the permit free", () => live(Effect.gen(function* () {
  const directory = yield* temporaryDataDirectory("ct-lin-07-");
  const observed = yield* Effect.gen(function* () {
    const db = yield* GuidanceDb;
    const policy = yield* PolicyDb;
    const gate = yield* makeSupervisionGate(openGuard);
    const entered: string[] = [];
    const section = (label: string) => gate.admit(() => Effect.sync(() => {entered.push(label);}));
    const inside = yield* Effect.exit(db.withTransaction(Effect.andThen(db`SELECT 1`, section("inside"))));
    const outside = yield* Effect.exit(section("outside"));
    const otherClient = yield* Effect.exit(policy.withTransaction(section("policy-transaction")));
    return {inside, outside, otherClient, entered};
  }).pipe(Effect.provide(guidanceDb(directory)), Effect.provide(policyDb(directory)));
  assert.ok(Exit.isFailure(observed.inside));
  assert.ok(Cause.hasDies(observed.inside.cause), "a defect, not a typed failure");
  assert.ok(Cause.squash(observed.inside.cause) instanceof AdmissionInsideTransaction);
  assert.ok(Exit.isSuccess(observed.outside), "the permit was not left held by the refused request");
  assert.ok(Exit.isSuccess(observed.otherClient), "a transaction of another client does not refuse admission");
  assert.deepEqual(observed.entered, ["outside", "policy-transaction"], "the refused section never ran");
})), {timeout: 10_000});

// the non-waiting section of a decision made on native state read just before it (apply_return): while another section holds the gate it
// answers none and its body never runs; once the gate is free it runs as an ordinary section, and inside a transaction it dies alike
it.live("an available-only admission never waits behind a held section and otherwise runs as an ordinary section", () => live(Effect.gen(function* () {
  const directory = yield* temporaryDataDirectory("gate-if-available-");
  const observed = yield* Effect.gen(function* () {
    const db = yield* GuidanceDb;
    const gate = yield* makeSupervisionGate(openGuard);
    const entered: string[] = [];
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* Effect.forkChild(gate.admit(() => Effect.andThen(Deferred.succeed(held, undefined), Deferred.await(release))));
    yield* Deferred.await(held);
    const busy = yield* gate.admitIfAvailable(() => Effect.sync(() => {entered.push("while held");return "ran";}));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    const free = yield* gate.admitIfAvailable(() => Effect.sync(() => {entered.push("when free");return "ran";}));
    const inside = yield* Effect.exit(db.withTransaction(Effect.andThen(db`SELECT 1`, gate.admitIfAvailable(() => Effect.sync(() => {entered.push("inside");})))));
    return {busy, free, inside, entered};
  }).pipe(Effect.provide(guidanceDb(directory)), Effect.provide(policyDb(directory)));
  assert.ok(Option.isNone(observed.busy));
  assert.deepEqual(observed.free, Option.some("ran"));
  assert.ok(Exit.isFailure(observed.inside) && Cause.squash(observed.inside.cause) instanceof AdmissionInsideTransaction);
  assert.deepEqual(observed.entered, ["when free"]);
})), {timeout: 10_000});
