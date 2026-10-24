import { Schema } from "effect";
import type { ProjectCheckoutInventoryInfo } from "./project-definitions-contract.js";

/** Last completed folder check, retained for database-only dashboard reads. */
export const CheckoutObservation = Schema.Struct({
  checkedAt: Schema.Finite,
  projectRoot: Schema.NullOr(Schema.String),
  missing: Schema.Array(Schema.Struct({workspaceRoot: Schema.String, threadIds: Schema.Array(Schema.String)})),
});
export type CheckoutObservationInfo = typeof CheckoutObservation.Type;
export const checkoutObservation = (inventory: ProjectCheckoutInventoryInfo, checkedAt: number): CheckoutObservationInfo => ({
  checkedAt,
  projectRoot: inventory.targets.find(target => target.isProjectFolder)?.workspaceRoot ?? null,
  missing: inventory.targets.filter(target => target.presence === "missing").map(target => ({
    workspaceRoot: target.workspaceRoot, threadIds: target.members.map(member => member.threadId),
  })),
});
