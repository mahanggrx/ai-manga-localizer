import test from "node:test";
import assert from "node:assert/strict";
import { assessResourceHeadroom } from "../src/system-resources.ts";

test("resource guard accepts sufficient physical and commit headroom", () => {
  assert.deepEqual(assessResourceHeadroom({
    totalPhysicalMiB: 16_000,
    availablePhysicalMiB: 6_000,
    committedMiB: 28_000,
    commitLimitMiB: 42_000,
    commitHeadroomMiB: 14_000,
  }), {
    ok: true,
    code: "RESOURCE_HEADROOM_OK",
    detail: "6000 MiB physical memory and 14000 MiB commit headroom available",
  });
});

test("resource guard fails closed when physical memory is low", () => {
  const result = assessResourceHeadroom({
    totalPhysicalMiB: 16_000,
    availablePhysicalMiB: 2_000,
    committedMiB: 30_000,
    commitLimitMiB: 42_000,
    commitHeadroomMiB: 12_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PHYSICAL_MEMORY_LOW");
});

test("resource guard fails closed when Windows commit headroom is low", () => {
  const result = assessResourceHeadroom({
    totalPhysicalMiB: 16_000,
    availablePhysicalMiB: 5_000,
    committedMiB: 40_000,
    commitLimitMiB: 42_000,
    commitHeadroomMiB: 2_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "COMMIT_HEADROOM_LOW");
});

test("resource guard reports an explicit warning state when commit counters are unavailable", () => {
  const result = assessResourceHeadroom({
    totalPhysicalMiB: 16_000,
    availablePhysicalMiB: 6_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "COMMIT_COUNTER_UNAVAILABLE");
});
