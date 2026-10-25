import { randomUUID } from "node:crypto";
import { useProjectBucketForTests } from "./packages/core/src/google/throttler";

// Per test file: see useProjectBucketForTests. throttle.test.ts opts back into "project" because
// it asserts on that bucket, using only fake-clock windows no other file touches.
useProjectBucketForTests(`project:test-${randomUUID()}`);

// No test may reach the public internet (a stray webhook delivery once could): see scripts/block-public-network.cjs.
import "./scripts/block-public-network.cjs";
