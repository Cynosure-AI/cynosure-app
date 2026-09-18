import { computed, onUnmounted, ref, type Ref } from "vue";
import { api } from "../api/client";
import type { MemoryFileStatus, MemoryIndexJob } from "../api/types";
import { useMemoryJobsStore } from "../stores/memory-jobs.store";

const ACTIVE_JOB_STATUSES = new Set<MemoryIndexJob["status"]>(["queued", "running", "retrying"]);

/** Owns polling and job transitions for one memory folder's document list. */
export function useMemoryDocumentJobs(options: {
  folderId: Ref<string>;
  files: Ref<MemoryFileStatus[]>;
  reloadFiles: () => Promise<void>;
  onCompleted: () => void;
}) {
  const appJobs = useMemoryJobsStore();
  const jobs = ref<MemoryIndexJob[]>([]);
  const handledTerminalJobIds = ref<Set<string>>(new Set());
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const runningJobs = computed(() => jobs.value.filter(isActive));

  function activeJob(kind: MemoryIndexJob["kind"], fileName: string): MemoryIndexJob | undefined {
    return jobs.value.find((job) => job.kind === kind && job.fileName === fileName && isActive(job));
  }

  function isJobActive(kind: MemoryIndexJob["kind"], fileName: string): boolean {
    return Boolean(activeJob(kind, fileName));
  }

  function resumableJob(fileName: string): MemoryIndexJob | undefined {
    const latest = jobs.value
      .filter((job) => job.kind === "deep-research" && job.fileName === fileName)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return latest?.status === "cancelled" && (latest.progressCurrent || 0) > 0 && latest.progressCurrent! < (latest.progressTotal || 0)
      ? latest
      : undefined;
  }

  /** Terminal jobs that ended in a failure the user has not dismissed yet. */
  const failedJobs = computed(() =>
    jobs.value.filter((job) => job.status === "error" || job.status === "dead_letter"),
  );

  /** A background job can fail long after the click that started it, so the
   * failure is kept visible until the user acknowledges it. Dismissal is
   * persisted server-side; otherwise the failure would return on reload. */
  async function dismissFailure(jobId: string): Promise<void> {
    try {
      await api.memoryFolders.discardJob(jobId);
      jobs.value = jobs.value.filter((job) => job.id !== jobId);
      appJobs.removeJob(jobId);
    } catch {
      await loadJobs();
    }
  }

  /** Dismiss every failed job in this folder. */
  async function dismissAllFailures(): Promise<void> {
    try {
      await api.memoryFolders.dismissJobFailures(options.folderId.value);
      const failedIds = new Set(failedJobs.value.map((job) => job.id));
      jobs.value = jobs.value.filter((job) => !failedIds.has(job.id));
      for (const id of failedIds) appJobs.removeJob(id);
    } catch {
      await loadJobs();
    }
  }

  function upsertJob(job: MemoryIndexJob): void {
    jobs.value = [...jobs.value.filter((item) => item.id !== job.id), job];
    appJobs.upsertJob(job);
    if (isActive(job)) startPolling();
  }

  async function applyTerminalJobs(nextJobs: MemoryIndexJob[]): Promise<void> {
    const seen = new Set(handledTerminalJobIds.value);
    const terminalJobs = nextJobs.filter((job) => !isActive(job) && !seen.has(job.id));
    if (!terminalJobs.length) return;
    for (const job of terminalJobs) seen.add(job.id);
    handledTerminalJobIds.value = seen;
    await options.reloadFiles();
    options.onCompleted();
  }

  async function loadJobs(): Promise<void> {
    try {
      const nextJobs = await api.memoryFolders.listJobs(options.folderId.value);
      jobs.value = nextJobs;
      await applyTerminalJobs(nextJobs);
      if (nextJobs.some(isActive)) startPolling();
      else stopPolling();
    } catch {
      jobs.value = [];
      stopPolling();
    }
  }

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => void loadJobs(), 2000);
  }

  function stopPolling(): void {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  async function startFileJob(kind: "reindex" | "deep-research", fileName: string): Promise<void> {
    try {
      const job = kind === "reindex"
        ? await api.memoryFolders.startReindexFile(options.folderId.value, fileName)
        : await api.memoryFolders.startDeepResearchFile(options.folderId.value, fileName);
      upsertJob(job);
    } catch {
      // The next authoritative refresh exposes failures without inventing a
      // second client-side job state machine.
    }
  }

  async function reindexFile(fileName: string): Promise<void> {
    await startFileJob("reindex", fileName);
  }

  async function extractKnowledgeFromFile(fileName: string): Promise<void> {
    await startFileJob("deep-research", fileName);
  }

  async function reindexAll(): Promise<void> {
    for (const file of options.files.value.filter((item) =>
      item.supported && (item.status === "needs_reindex" || item.status === "not_indexed"))) {
      if (!isJobActive("reindex", file.fileName)) await reindexFile(file.fileName);
    }
  }

  async function cancelJob(job?: MemoryIndexJob): Promise<void> {
    if (!job) return;
    try {
      upsertJob(await api.memoryFolders.cancelJob(job.id));
      await options.reloadFiles();
    } catch {
      // Polling remains the source of truth if cancellation races completion.
    }
  }

  async function discardJob(job?: MemoryIndexJob): Promise<void> {
    if (!job) return;
    try {
      await api.memoryFolders.discardJob(job.id);
      jobs.value = jobs.value.filter((item) => item.id !== job.id);
      appJobs.removeJob(job.id);
    } catch {
      await loadJobs();
    }
  }

  function reset(): void {
    // Show app-wide active work immediately while loadJobs refreshes the
    // authoritative folder-specific list.
    jobs.value = appJobs.activeJobs.filter((job) => job.folderId === options.folderId.value);
    handledTerminalJobIds.value = new Set();
  }

  function deepResearchProgress(fileName: string): string {
    const job = activeJob("deep-research", fileName);
    if (job?.status === "queued") return "Queued";
    return job?.progressCurrent && job.progressTotal ? `Batch ${job.progressCurrent}/${job.progressTotal}` : "Researching";
  }

  function searchIndexProgress(fileName: string): string {
    return activeJob("reindex", fileName)?.status === "queued" ? "Queued" : "Indexing";
  }

  onUnmounted(stopPolling);

  return {
    jobs,
    runningJobs,
    activeJob,
    isJobActive,
    isJobRunning: isJobActive,
    resumableJob,
    failedJobs,
    dismissFailure,
    dismissAllFailures,
    upsertJob,
    loadJobs,
    reindexFile,
    extractKnowledgeFromFile,
    reindexAll,
    cancelJob,
    discardJob,
    reset,
    deepResearchProgress,
    searchIndexProgress,
  };
}

function isActive(job: MemoryIndexJob): boolean {
  return ACTIVE_JOB_STATUSES.has(job.status);
}
