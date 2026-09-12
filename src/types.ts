export type PullRequestLifecycleStatus = "open" | "closed";

export interface PullRequestState {
  repository: string;
  pull_request_number: number;

  /**
   * Open PRs are eligible for conflict checks.
   * Closed PRs are retained for history but never re-checked.
   */
  status: PullRequestLifecycleStatus;

  /** True when the PR was closed via merge. */
  merged: boolean;

  base_branch: string;
  base_sha: string;

  head_branch: string;
  head_sha: string;

  author_login: string;

  mergeable: boolean | null;
  mergeable_state: string | null;

  /**
   * Whether the PR was last observed as having conflicts.
   * Derived from `mergeable === false`.
   */
  conflicted: boolean;

  /** When this state was last written. */
  observed_at: string;

  /**
   * Set after we notify the author about a conflict.
   * Cleared when the PR becomes mergeable again so a later
   * clean → conflicted transition can notify again.
   */
  conflict_notified: boolean;

  /** GitHub issue comment ID of the conflict notification. */
  conflict_comment_id?: number;

  /** GitHub issue comment ID of the file-overlap report. */
  overlap_comment_id?: number;

  /**
   * Changed filenames for this PR (from pulls.listFiles).
   * Used so overlap checks do not re-fetch every open PR on each sync.
   */
  changed_files?: string[];

  /** Head SHA that `changed_files` was captured for. */
  changed_files_sha?: string;
}
