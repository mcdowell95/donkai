const STATUS_META: Record<string, { cls: string; label?: string; pulse?: boolean }> = {
  running: { cls: "blue", pulse: true },
  suspended_local: { cls: "amber", label: "needs you!" },
  awaiting_review: { cls: "purple" },
  error: { cls: "red" },
  failed: { cls: "red" },
  merged: { cls: "green" },
  done: { cls: "green" },
  completed: { cls: "green" },
  taken_over: { cls: "amber", label: "taken over" },
  queued: { cls: "gray" },
};

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { cls: "gray" };
  return (
    <span class={`badge badge-${meta.cls}${meta.pulse ? " badge-pulse" : ""}`}>
      <span class="badge-dot" />
      {meta.label ?? status.replace(/_/g, " ")}
    </span>
  );
}
