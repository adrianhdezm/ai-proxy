// Ported from: sdk/cliproxy/auth/priority_test.go
// Skipped cases: none
import { expect, test } from "bun:test";
import { AttributeFilePriority, applyAuthPriorityMetadata } from "../../../src/auth/manager/index.ts";
import { auth } from "./helpers.ts";

test("ApplyAuthPriorityMetadataClearsUntrustedFileMarker", () => {
  for (const metadata of [{}, { priority: "bad" }]) {
    const a = auth({ id: "a", attributes: { priority: "7", [AttributeFilePriority]: "true" }, metadata: { priority: 7 } });
    applyAuthPriorityMetadata(a, metadata);
    expect(AttributeFilePriority in a.attributes).toBe(false);
    expect(a.attributes.priority).toBe("7");
    expect(a.metadata.priority).toBe(7);
  }
});

test("ApplyAuthPriorityMetadataIgnoresInvalidFilePriority", () => {
  const a = auth({ id: "a", attributes: { priority: "7" }, metadata: { priority: 7 } });
  applyAuthPriorityMetadata(a, { priority: "bad" });
  expect(a.attributes.priority).toBe("7");
  expect(a.metadata.priority).toBe(7);
  expect(AttributeFilePriority in a.attributes).toBe(false);
});

test("ApplyAuthPriorityMetadataPreservesBuiltinNumericConversion", () => {
  const a = auth({ id: "a" });
  applyAuthPriorityMetadata(a, { priority: 1.5 });
  expect(a.attributes.priority).toBe("1");
  expect(a.metadata.priority).toBe(1.5);
  expect(a.attributes[AttributeFilePriority]).toBe("true");
});
