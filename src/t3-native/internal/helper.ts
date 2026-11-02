import { Cause, Effect, Exit, Fiber, Ref, Schema, Scope, type Deferred } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { NativeRpcShape } from "../../supervisor-native.js";
import { selectTranslation } from "../build.js";
import {
  HelperTask, HelperTaskDelete, HelperTaskList, HelperTaskUpsert, HelperTaskUpsertReply, isHelperWebhookPath, WebhookDeliveriesRequest, WebhookDelivery, WebhookDeliveryDetail,
  WebhookDeliveryList, WebhookDeliveryRequest, WebhookPost, webhookBody, type NativeRecord, type BuildFacts, type HelperTaskView,
  type T3Operation, type WebhookDeliveryView, type WebhookReply,
} from "../contracts.js";
import { T3InvalidInput, T3WebhookError, type T3RequestError } from "../errors.js";
import type { T3HelperFamily, T3InFlight } from "../service.js";
import { malformedReply, otherwise, requestError, untilCancelled } from "./classify.js";

/*
 * The helper family over the operate credential's native client and the root HTTP client: the scheduler's task snapshot, delivery
 * log and task changes keep the client's deadlines and classification; the webhook POST keeps the helper transport's exchange: it is
 * started by the initiation, awaited outside it, released by closing its scope, and never repeated.
 */

export interface HelperClients {
  readonly operate: NativeRpcShape;
  readonly http: HttpClient.HttpClient;
  // the T3 base url the webhook paths resolve against; a POST never leaves its origin
  readonly baseUrl: string;
  readonly observed: Ref.Ref<BuildFacts | null>;
}

const isHelperTaskList: (value: unknown) => value is typeof HelperTaskList.Type = Schema.is(HelperTaskList);
const isDeliveriesRequest: (value: unknown) => value is WebhookDeliveriesRequest = Schema.is(WebhookDeliveriesRequest);
const isDeliveryList: (value: unknown) => value is typeof WebhookDeliveryList.Type = Schema.is(WebhookDeliveryList);
const isDeliveryRequest: (value: unknown) => value is WebhookDeliveryRequest = Schema.is(WebhookDeliveryRequest);
const isDeliveryDetail: (value: unknown) => value is typeof WebhookDeliveryDetail.Type = Schema.is(WebhookDeliveryDetail);
const isTaskUpsert: (value: unknown) => value is HelperTaskUpsert = Schema.is(HelperTaskUpsert);
const isUpsertReply: (value: unknown) => value is typeof HelperTaskUpsertReply.Type = Schema.is(HelperTaskUpsertReply);
const isTaskDelete: (value: unknown) => value is HelperTaskDelete = Schema.is(HelperTaskDelete);
const isWebhookPost: (value: unknown) => value is WebhookPost = Schema.is(WebhookPost);
const isHelperTask: (value: unknown) => value is HelperTask = Schema.is(HelperTask);
const isWebhookDelivery: (value: unknown) => value is WebhookDelivery = Schema.is(WebhookDelivery);
// each present task or delivery as received: its typed view, or the same object when its declared fields break the pinned types
const taskView = (task: NativeRecord): HelperTaskView => isHelperTask(task) ? {_tag: "Task", task} : {_tag: "Nonconforming", task};
const deliveryView = (delivery: NativeRecord): WebhookDeliveryView =>
  isWebhookDelivery(delivery) ? {_tag: "Delivery", delivery} : {_tag: "Nonconforming", delivery};
// a 2xx webhook reply names the native delivery when its body is readable
const isPostReply = Schema.is(Schema.Struct({deliveryId: Schema.String}));

// the webhook URL of a task path: a hook path on the T3 origin itself, without a query or fragment
const webhookEndpoint = (path: string, baseUrl: string): URL | null => {
  if (!isHelperWebhookPath(path)) return null;
  try {
    const endpoint = new URL(path, baseUrl);
    return endpoint.origin !== new URL(baseUrl).origin || endpoint.search || endpoint.hash ? null : endpoint;
  } catch {
    return null;
  }
};

// any failure or defect of a started POST leaves its outcome unknown; an interruption stays an interruption
const uncertainPost = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, T3WebhookError, R> =>
  Effect.catchCauseIf(effect, (cause) => !Cause.hasInterruptsOnly(cause),
    () => Effect.fail(new T3WebhookError({operation: "helper/postWebhook"}))) as Effect.Effect<A, T3WebhookError, R>;

export const makeHelper = ({operate, http, baseUrl, observed}: HelperClients): T3HelperFamily => {
  const invalid = (operation: T3Operation) => Effect.fail(new T3InvalidInput({operation}));
  const call = (operation: T3Operation, tag: string, payload: Readonly<Record<string, unknown>>, cancel: Deferred.Deferred<void> | undefined) =>
    Effect.mapError(Effect.suspend(() => operate.call(tag, payload, cancel)), (error) => requestError(operation, error));

  const tasks = (cancel?: Deferred.Deferred<void>): Effect.Effect<ReadonlyArray<HelperTaskView>, T3RequestError> =>
    Effect.flatMap(Effect.mapError(Effect.suspend(() => operate.call("scheduledTasks.subscribe", {}, cancel, "firstChunk")),
      (error) => requestError("helper/tasks", error)),
    (value) => isHelperTaskList(value) ? Effect.succeed(value.tasks.map(taskView)) : Effect.fail(malformedReply("helper/tasks")));

  const webhookDeliveries = (request: WebhookDeliveriesRequest, cancel?: Deferred.Deferred<void>):
    Effect.Effect<ReadonlyArray<WebhookDeliveryView>, T3RequestError | T3InvalidInput> => {
    if (!isDeliveriesRequest(request)) return invalid("helper/webhookDeliveries");
    return Effect.flatMap(call("helper/webhookDeliveries", "scheduledTasks.listWebhookDeliveries", {id: request.taskId}, cancel),
      (value) => isDeliveryList(value) ? Effect.succeed(value.deliveries.map(deliveryView)) : Effect.fail(malformedReply("helper/webhookDeliveries")));
  };

  const webhookDelivery = (request: WebhookDeliveryRequest, cancel?: Deferred.Deferred<void>):
    Effect.Effect<WebhookDeliveryView, T3RequestError | T3InvalidInput> => {
    if (!isDeliveryRequest(request)) return invalid("helper/webhookDelivery");
    return Effect.flatMap(call("helper/webhookDelivery", "scheduledTasks.getWebhookDelivery", {id: request.taskId, deliveryId: request.deliveryId}, cancel),
      (value) => isDeliveryDetail(value) ? Effect.succeed(deliveryView(value.delivery)) : Effect.fail(malformedReply("helper/webhookDelivery")));
  };

  // an enabled webhook task on the project root, created by the system; requireExisting is sent only for a task known to exist
  const upsertTask = (request: HelperTaskUpsert, cancel?: Deferred.Deferred<void>): Effect.Effect<HelperTaskView, T3RequestError | T3InvalidInput> => {
    if (!isTaskUpsert(request)) return invalid("helper/upsertTask");
    return Effect.flatMap(call("helper/upsertTask", "scheduledTasks.upsert", {id: request.taskId, ...(request.requireExisting ? {requireExisting: true} : {}),
      commandId: request.commandId, title: request.title, prompt: request.prompt, enabled: true, schedule: {type: "webhook"}, projectId: request.projectId,
      threadId: request.threadId, workspaceStrategy: {type: "root"}, modelSelection: request.modelSelection, runtimeMode: request.runtimeMode,
      interactionMode: request.interactionMode, createdBy: "system", creationSource: "server"}, cancel),
    (value) => isUpsertReply(value) ? Effect.succeed(taskView(value.task)) : Effect.fail(malformedReply("helper/upsertTask")));
  };

  const deleteTask = (request: HelperTaskDelete, cancel?: Deferred.Deferred<void>): Effect.Effect<void, T3RequestError | T3InvalidInput> =>
    isTaskDelete(request) ? Effect.asVoid(call("helper/deleteTask", "scheduledTasks.delete", {id: request.taskId}, cancel)) : invalid("helper/deleteTask");

  /*
   * The exchange belongs to the POST from its start: the release closes it, which aborts whatever is still open (a reply held between
   * its headers and its body read, a body never read, an interrupted wait); a completed read is unaffected. No client span and no
   * trace headers: a span would carry the webhook path, which holds the hook token.
   */
  const initiateWebhook = (endpoint: URL, body: string, cancel: Deferred.Deferred<void> | undefined): Effect.Effect<T3InFlight<WebhookReply, T3WebhookError>> =>
    Effect.gen(function* () {
      const exchange = yield* Scope.make();
      const request = HttpClient.withScope(http).execute(HttpClientRequest.post(endpoint).pipe(HttpClientRequest.bodyText(body, "application/json")))
        .pipe(Scope.provide(exchange), Effect.provideService(HttpClient.TracerDisabledWhen, () => true));
      const post = yield* Effect.forkDetach(request, {startImmediately: true});
      const result = Effect.gen(function* () {
        const response = yield* untilCancelled(Fiber.join(post), cancel);
        if (response.status >= 400 && response.status < 500) {
          const refused: WebhookReply = {_tag: "Refused", httpStatus: response.status};
          return refused;
        }
        if (response.status < 200 || response.status >= 300) {
          const unconfirmed: WebhookReply = {_tag: "Unconfirmed", httpStatus: response.status};
          return unconfirmed;
        }
        // a 2xx is recorded acceptance even when its body cannot be read; only the delivery id is then unknown
        const reply = yield* untilCancelled(response.json, cancel).pipe(otherwise(null));
        const accepted: WebhookReply = isPostReply(reply) ? {_tag: "Accepted", deliveryId: reply.deliveryId} : {_tag: "Accepted"};
        return accepted;
      });
      return {
        // the POST was started: from now on it may reach T3
        sent: Effect.succeed(true),
        result: uncertainPost(result),
        // exactly once, at any end of the operation
        release: Scope.close(exchange, Exit.void).pipe(Effect.andThen(Fiber.interrupt(post)), Effect.asVoid),
      };
    });

  const postWebhook: T3HelperFamily["postWebhook"] = {
    prepare: (post) => Effect.gen(function* () {
      const operation = "helper/postWebhook" as const;
      if (!isWebhookPost(post)) return yield* new T3InvalidInput({operation});
      const endpoint = webhookEndpoint(post.path, baseUrl);
      if (endpoint === null) return yield* new T3InvalidInput({operation});
      yield* selectTranslation(operation, yield* Ref.get(observed));
      const body = webhookBody(post);
      return {operation, initiate: (cancel?: Deferred.Deferred<void>) => initiateWebhook(endpoint, body, cancel)};
    }),
  };

  return {tasks, webhookDeliveries, webhookDelivery, upsertTask, deleteTask, postWebhook};
};
