/**
 * integrate.ts — Merge completed worker branches into a target branch.
 * TypeScript replacement for integrate.sh.
 */

import { run, runOrDie } from "../shared/subprocess.ts";

interface Args {
  repo: string;
  workers: string[];
  target: string;
  testCmd: string | null;
  dryRun: boolean;
  autoResolve: boolean;
}

export function parseArgs(argv: string[]): Args {
  let repo = "";
  let workersRaw = "";
  let target = "main";
  let testCmd: string | null = null;
  let dryRun = false;
  let autoResolve = false;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--repo":
        repo = argv[++i] ?? "";
        break;
      case "--workers":
        workersRaw = argv[++i] ?? "";
        break;
      case "--target":
        target = argv[++i] ?? "main";
        break;
      case "--test-cmd":
        testCmd = argv[++i] ?? null;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--auto-resolve":
        autoResolve = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: integrate.ts --repo PATH --workers LIST [--target BRANCH] [--test-cmd CMD] [--dry-run] [--auto-resolve]",
        );
        process.exit(0);
        break;
      default:
        console.error(`ERROR: Unknown option: ${argv[i]}`);
        console.error("Run with --help for usage.");
        process.exit(1);
    }
  }

  if (!repo) {
    console.error("ERROR: --repo is required");
    process.exit(1);
  }
  if (!workersRaw) {
    console.error("ERROR: --workers is required");
    process.exit(1);
  }

  const workers = workersRaw
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);

  if (workers.length === 0) {
    console.error("ERROR: No workers specified");
    process.exit(1);
  }

  return { repo, workers, target, testCmd, dryRun, autoResolve };
}

export async function dryRun(repo: string, workers: string[], target: string): Promise<void> {
  for (const worker of workers) {
    const branch = `hive/${worker}`;

    const existsResult = run(["git", "rev-parse", "--verify", `refs/heads/${branch}`], {
      cwd: repo,
    });
    if (existsResult.exitCode !== 0) {
      console.log(`${branch}: branch does not exist — skipping`);
      continue;
    }

    const commits = run(["git", "log", "--oneline", `${target}..${branch}`], { cwd: repo });
    const commitLines = commits.stdout ? commits.stdout.split("\n").filter(Boolean) : [];

    const diff = run(["git", "diff", "--stat", `${target}...${branch}`], { cwd: repo });
    const diffSummary = diff.stdout
      ? diff.stdout.split("\n").filter(Boolean).slice(-1)[0] // last line is the summary
      : "(no changes)";

    console.log(`${branch}: ${commitLines.length} commit(s) ahead of ${target}. ${diffSummary}`);
  }
}

export async function integrate(
  repo: string,
  workers: string[],
  target: string,
  testCmd: string | null,
  autoResolve: boolean,
): Promise<void> {
  // 1. Check working tree is clean
  const diffResult = run(["git", "diff", "--quiet"], { cwd: repo });
  const diffCachedResult = run(["git", "diff", "--cached", "--quiet"], { cwd: repo });
  if (diffResult.exitCode !== 0 || diffCachedResult.exitCode !== 0) {
    console.error(
      "ERROR: Working directory has uncommitted changes. Commit or stash before integrating.",
    );
    process.exit(1);
  }

  // Record pre-merge SHA for rollback instructions
  const preMergeSha = runOrDie(["git", "rev-parse", "HEAD"], { cwd: repo });

  // 2. Checkout target branch
  runOrDie(["git", "checkout", target], { cwd: repo });

  const merged: string[] = [];

  // 3. Merge each worker
  for (const worker of workers) {
    const branch = `hive/${worker}`;

    const mergeResult = run(
      ["git", "merge", "--no-ff", branch, "-m", `hive: integrate ${worker}`],
      { cwd: repo },
    );

    if (mergeResult.exitCode !== 0) {
      // Get conflicting files
      const conflictResult = run(["git", "diff", "--name-only", "--diff-filter=U"], { cwd: repo });
      const conflictingFiles = conflictResult.stdout
        ? conflictResult.stdout.split("\n").filter(Boolean)
        : [];

      if (autoResolve && conflictingFiles.length > 0) {
        // Accept theirs for each conflicting file
        const checkoutResult = run(["git", "checkout", "--theirs", ...conflictingFiles], {
          cwd: repo,
        });
        const addResult = run(["git", "add", ...conflictingFiles], { cwd: repo });
        const commitResult = run(
          ["git", "commit", "-m", `hive: integrate ${worker} (auto-resolved conflicts)`],
          { cwd: repo },
        );

        if (
          checkoutResult.exitCode !== 0 ||
          addResult.exitCode !== 0 ||
          commitResult.exitCode !== 0
        ) {
          console.error(`ERROR: Cannot auto-resolve conflicts in ${branch}.`);
          console.error(`Rollback: git -C ${repo} reset --hard ${preMergeSha}`);
          process.exit(1);
        }
      } else {
        console.error(`ERROR: Merge conflict integrating ${branch}.`);
        if (conflictingFiles.length > 0) {
          console.error(
            `Conflicting files:\n${conflictingFiles.map((f) => `  - ${f}`).join("\n")}`,
          );
        }
        console.error(`Rollback: git -C ${repo} reset --hard ${preMergeSha}`);
        process.exit(1);
      }
    }

    merged.push(worker);
  }

  // 4. Run test command if provided
  if (testCmd) {
    const testParts = testCmd.split(/\s+/);
    const testResult = run(testParts, { cwd: repo });
    if (testResult.exitCode !== 0) {
      console.error(`ERROR: Tests failed.\nRollback: git -C ${repo} reset --hard ${preMergeSha}`);
      if (testResult.stdout) console.error(testResult.stdout);
      if (testResult.stderr) console.error(testResult.stderr);
      process.exit(1);
    }
    // 5. Print one-line summary with test result
    console.log(`Merged: ${merged.join(", ")} → ${target}. Tests: passed.`);
  } else {
    // 5. Print one-line summary without tests
    console.log(`Merged: ${merged.join(", ")} → ${target}.`);
  }
}

export async function main(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (parsed.dryRun) {
    await dryRun(parsed.repo, parsed.workers, parsed.target);
    return;
  }

  await integrate(parsed.repo, parsed.workers, parsed.target, parsed.testCmd, parsed.autoResolve);
}

// Run when executed directly
if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}
