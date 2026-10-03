import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {
  createMatchedEvaluationContinuationPhaseOneSelectionV1,
  parseMatchedEvaluationContinuationPhaseOneTaskPacketV1,
} from "../../scripts/run-matched-evaluation.ts";
import {parseMatchedEvaluationCorpusV1, parseMatchedEvaluationManifestV1} from "../../apps/threadnote/src/evaluation/matched-evaluation.ts";
import {parseMatchedTokenEfficiencyStudyV1} from "../../apps/threadnote/src/evaluation/matched-token-efficiency.ts";

const root = "/Users/denyskashkovskyi/.codex/worktrees/5-1-beta-release/threadnote/.context/actual-token-study-v19-20261003";
const corpus = parseMatchedEvaluationCorpusV1(JSON.parse(await readFile(join(root, "prepared-study/corpus.json"), "utf8")));
const manifest = parseMatchedEvaluationManifestV1(JSON.parse(await readFile(join(root, "prepared-study/manifest.json"), "utf8")));
const study = parseMatchedTokenEfficiencyStudyV1(JSON.parse(await readFile(join(root, "prepared-study/study.json"), "utf8")));

const configurations = {
  tsk_6f8c95b80697e7612413ed04: {
    name: "click",
    key: "click-short-help",
    allowed: ["tests/test_utils/test_make_default_short_help.py"],
    marker: "Update the existing `sentence < max` parameter input from `123 567 9. aaaa bbb` to `123 567 9. Aaaa bbb` while keeping its expected value, then add a focused parameter case with the id `lowercase-following-abbreviation`.",
  },
  tsk_a009739c16abeecaeafe13cb: {
    name: "pluggy",
    key: "pluggy-multiple-hookimpls",
    allowed: ["testing/test_pluginmanager.py"],
    marker: "Add the focused regression as `test_unregister_plugin_with_multi_hookimpls`. Before unregistering, assert that `get_hookcallers(plugin)` returns each affected HookCaller exactly once; then unregister and assert that every implementation owned by that plugin is gone while another plugin's implementation remains.",
  },
  tsk_8b02783134c4b12b327add82: {
    name: "chi",
    key: "chi-walk-route-collision",
    allowed: ["tree_test.go"],
    marker: "Add the focused regression as `TestWalkRouteWithHandlerAndSubrouter`. Build `/foo` with a nested `/bar` Route containing `GET /{id}`, then register `GET /bar` on the `/foo` router; assert that Walk includes both `GET /foo/bar` and `GET /foo/bar/{id}`.",
  },
  tsk_3e2e9ab2f03a7d743856d6fd: {
    name: "gin",
    key: "gin-skipped-node-state",
    allowed: ["routes_test.go"],
    marker: "Name the focused regression with the prefix `TestIssue4818_`. Reproduce the fixed-method-tree failure with OPTIONS and GET on `/:p0/:p1/a/:p2`; PATCH on `/b/:p0/:p1/c`; DELETE on `/b/:p0/:p1/d/:p3`; GET on `/b/:p0/:p1/e/f`; POST and OPTIONS on `/b/:p0/:p1/g/:p4/h`; DELETE on `/b/cache`; GET and POST on `/b/clients/:p1/g`; and PATCH and OPTIONS on `/b/clients/:p1/g/:p4`. Assert that POST `/b/clients/42` does not panic and returns 404.",
  },
  tsk_fc18a74be8742c6a9d6397ed: {
    name: "echo",
    key: "echo-shared-problem-error",
    allowed: ["rfc9457_test.go"],
    marker: "Add the focused regression as `TestProblemDetailsHTTPErrorHandler_DoesNotMutateSharedProblem`.",
  },
} as const;

for (const task of corpus.tasks) {
  const configuration = configurations[task.taskId as keyof typeof configurations];
  if (!configuration) throw new Error(`Missing configuration for ${task.taskId}`);
  const manifestTask = manifest.tasks.find(candidate => candidate.taskId === task.taskId);
  const taskContext = study.taskContexts.find(candidate => candidate.taskId === task.taskId);
  const cluster = study.clusters.find(candidate => candidate.clusterId === taskContext?.clusterId);
  if (!manifestTask || !taskContext || !cluster) throw new Error(`Missing frozen identity for ${task.taskId}`);
  const check = `v19-verifier.py ${configuration.name}`;
  const packet = parseMatchedEvaluationContinuationPhaseOneTaskPacketV1({
    phaseOneAllowedPaths: configuration.allowed,
    phaseTwoProtectedPaths: configuration.allowed,
    phaseOneDirective: [
      "Phase 1 only: add the smallest focused regression that reproduces the reported defect, and edit no file outside the allowed regression path.",
      configuration.marker,
      "Inspect the unchanged production source deeply enough to diagnose the defect, but stop before changing production code or implementing the fix.",
      "Run the required focused check once after adding the regression; failure that demonstrates the defect is expected.",
      "In the final seven-line diagnosis, cite the regression and at least one unchanged production source anchor as repository-relative `path:start-end` ranges.",
    ].join(" "),
    phaseOneFocusedChecks: [check],
    phaseTwoFocusedChecks: [check],
    phaseTwoPrompt: "Continue from the sealed Phase 1 checkpoint. Implement the smallest general production correction for the reported defect while keeping the committed regression unchanged and preserving adjacent public behavior. Run the required sealed focused check after the implementation.",
    repositoryName: configuration.name,
    sourceRevision: cluster.revision,
    sourceTaskPrompt: task.prompt,
    status: "draft-unsealed",
    taskKey: configuration.key,
    treatmentSet: "automated-context-graph-v1",
    version: 4,
  });
  const directory = join(root, "tasks", configuration.name);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const packetBytes = Buffer.from(`${JSON.stringify(packet, undefined, 2)}\n`);
  const selection = createMatchedEvaluationContinuationPhaseOneSelectionV1({
    packet,
    repositoryRevision: cluster.revision,
    task: manifestTask,
    taskPacketSha256: createHash("sha256").update(packetBytes).digest("hex"),
    taskPrompt: task.prompt,
  });
  await writeFile(join(directory, "phase-one-task-packet.json"), packetBytes, {mode: 0o600});
  await writeFile(join(directory, "phase-one-expected-selection.json"), `${JSON.stringify(selection, undefined, 2)}\n`, {mode: 0o600});
}
