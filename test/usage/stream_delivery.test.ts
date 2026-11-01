// Ported from: sdk/cliproxy/usage/stream_delivery_test.go
// Skipped cases: TestStreamDeliveryUntracked (no context: an untracked consumer simply holds no StreamDelivery),
//   TestWithoutStreamDeliveryPreservesContext (context.Context value isolation has no TS counterpart)
import { expect, test } from "bun:test";
import { StreamDelivery } from "../../src/usage/stream_delivery.ts";

test("StreamDeliverySurvivesCancellation", async () => {
  for (const deliveryErr of [undefined, new Error("io: read/write on closed pipe")]) {
    const controller = new AbortController();
    const delivery = new StreamDelivery();
    controller.abort(); // request cancellation does not resolve the delivery
    expect(delivery.finished).toBe(false);
    const result = delivery.wait();
    delivery.finish(deliveryErr);
    delivery.finish(new Error("context canceled"));
    expect((await result).error).toBe(deliveryErr);
  }
});

test("StreamDelivery notifies onFinish listeners synchronously and once", () => {
  const delivery = new StreamDelivery();
  const seen: unknown[] = [];
  delivery.onFinish(({ error }) => seen.push(error ?? "clean"));
  delivery.finish();
  delivery.finish(new Error("late"));
  expect(seen).toEqual(["clean"]);
  delivery.onFinish(({ error }) => seen.push(error ?? "after"));
  expect(seen).toEqual(["clean", "after"]);
});

test("StreamDeliveryRequiresProducerSupport", () => {
  const delivery = new StreamDelivery();
  expect(delivery.supported).toBe(false);
  const stop = delivery.support();
  expect(delivery.supported).toBe(true);
  stop();
  stop();
  expect(delivery.supported).toBe(false);
  delivery.finish();
});
