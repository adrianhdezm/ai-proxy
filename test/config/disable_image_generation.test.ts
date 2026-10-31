// Ported from: internal/config/disable_image_generation_mode_test.go
// Skipped cases: TestDisableImageGenerationMode_UnmarshalJSON (JSON config decoding not carried; YAML only).
import { expect, test } from "bun:test";
import { parseConfig } from "../../src/config/load.ts";

const opts = { env: {}, home: "/home/tester", warn: () => {} };

test("TestDisableImageGenerationMode_UnmarshalYAML: false and true", () => {
  expect(parseConfig("multimedia:\n  disable-image-generation: false\n", opts).multimedia.disableImageGeneration).toBe(false);
  expect(parseConfig("multimedia:\n  disable-image-generation: true\n", opts).multimedia.disableImageGeneration).toBe(true);
});

// Upstream also accepts "chat" (strip the image_generation tool everywhere except /v1/images/*) and
// "passthrough" (forward the client payload untouched). The port only has the boolean switch; the modes
// need the Codex executor's tool injection/stripping and the images handler to learn a third state.
test.todo("TestDisableImageGenerationMode_UnmarshalYAML: chat and passthrough modes (executor/images handler support missing)", () => {
  expect(parseConfig("multimedia:\n  disable-image-generation: chat\n", opts).multimedia.disableImageGeneration).toBe("chat" as never);
  expect(parseConfig("multimedia:\n  disable-image-generation: passthrough\n", opts).multimedia.disableImageGeneration).toBe("passthrough" as never);
});
