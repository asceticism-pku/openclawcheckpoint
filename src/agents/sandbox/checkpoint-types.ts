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
};

export type CheckpointRegistry = {
  entries: CheckpointEntry[];
};
