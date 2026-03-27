export type CheckpointStrategy = "criu" | "docker-commit" | "overlay" | "auto";

export type CheckpointConfig = {
  enabled: boolean;
  strategy: CheckpointStrategy;
  /** Only checkpoint after mutating tools (exec, write, edit, apply_patch, bash). */
  onlyMutating: boolean;
  /** Maximum number of checkpoints to keep per container. */
  maxSnapshots: number;
  /** TTL in milliseconds — checkpoints older than this are auto-pruned. */
  ttlMs: number;
  /** Tools to skip checkpointing for. */
  skipTools: string[];
  /**
   * Checkpoint stride: only create a checkpoint every Nth mutating tool call per session.
   * Defaults to 1 (checkpoint on every mutating tool call). Set to e.g. 3 to checkpoint
   * only every 3rd mutating tool call.
   */
  checkpointStride?: number;
  /**
   * Enable adaptive stride — automatically increases the stride interval when tool calls
   * are frequent (e.g. rapid benchmark execution) and decreases it when calls are infrequent.
   */
  adaptiveStride?: boolean;
  /**
   * Maximum total checkpoint storage in bytes across all checkpoints for a container.
   * Oldest checkpoints are pruned first when this budget is exceeded.
   */
  maxTotalSizeBytes?: number;
  /**
   * Also snapshot the in-memory session state (tool call history, loop detection state)
   * alongside the container checkpoint. Defaults to true when checkpoints are enabled.
   */
  memoryCheckpoint?: boolean;
};

export type CheckpointEntry = {
  id: string;
  containerName: string;
  sessionKey: string;
  toolCallId: string;
  toolName: string;
  phase: "before" | "after";
  createdAtMs: number;
  snapshotRef: string;
  strategy: CheckpointStrategy;
  restorable: boolean;
  /** Human/agent-readable label for this checkpoint (e.g., "before-firefox-config"). */
  label?: string;
  /** Why this checkpoint was created. Defaults to "auto" for backward compatibility. */
  source?: "auto" | "agent" | "user";
  /** Agent's description of the state at this checkpoint. */
  description?: string;
  /** What was tried after this checkpoint (populated on restore). */
  explorationLog?: string[];
  /**
   * For overlay strategy: the ID of the checkpoint this one is based on (incremental chain).
   * When restoring, checkpoints are applied in order from root to target.
   */
  parentCheckpointId?: string;
  /**
   * Path to the serialized in-memory session state snapshot (.json file on the host).
   * Present when `memoryCheckpoint` was enabled during creation.
   */
  memorySnapshotPath?: string;
  /**
   * Size of the checkpoint snapshot artifact in bytes (overlay tar or docker image layer).
   * Used for disk-budget-aware pruning when `maxTotalSizeBytes` is configured.
   */
  sizeBytes?: number;
};

export type CheckpointRegistry = {
  entries: CheckpointEntry[];
};
