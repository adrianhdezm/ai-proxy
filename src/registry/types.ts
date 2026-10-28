// Model registry types. Port of the relevant parts of internal/registry/model_registry.go.

/** Provider-specific reasoning/thinking budget capabilities. */
export interface ThinkingSupport {
  /** Minimum allowed thinking budget (inclusive). */
  min?: number;
  /** Maximum allowed thinking budget (inclusive). */
  max?: number;
  /** Whether 0 is a valid value (disables thinking). */
  zeroAllowed?: boolean;
  /** Whether -1 is a valid value (dynamic thinking budget). */
  dynamicAllowed?: boolean;
  /** Claude thinking.type sent when thinking is turned off ("" means "disabled"). */
  disableType?: string;
  /** Discrete reasoning effort levels (e.g. low/medium/high). Level-based when set. */
  levels?: string[];
}

export interface ModelInfo {
  /** Unique identifier for the model. */
  id: string;
  /** Object type (typically "model"). */
  object?: string;
  /** Creation timestamp (unix seconds). */
  created?: number;
  /** Organization that owns the model. */
  ownedBy?: string;
  /** Model type: "claude", "gemini", "openai", "codex". */
  type: string;
  displayName?: string;
  /** Gemini-style model name ("models/..."). */
  name?: string;
  version?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  contextLength?: number;
  maxCompletionTokens?: number;
  supportedParameters?: string[];
  supportedInputModalities?: string[];
  supportedOutputModalities?: string[];
  /** Thinking/reasoning capabilities; undefined means the model cannot think. */
  thinking?: ThinkingSupport;
  /** Defined through the config file's models[] array; thinking passes through unvalidated. */
  userDefined?: boolean;
  /** Compatibility handling for configured API-key models. */
  isCompat?: boolean;
}
