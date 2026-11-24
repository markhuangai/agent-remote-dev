export function reconcileUpload(input: {
  api: (path: string) => Promise<any>;
  repository: string;
  lineage: {
    run_id: string;
    run_attempt: string;
    workflow_id: number;
    workflow_path: string;
    workflow_sha: string;
    branch: string;
  };
  name: string;
  root: string;
  kind: "checkpoint" | "record";
}): Promise<{ id: number }>;
