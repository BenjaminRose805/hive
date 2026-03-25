/**
 * Thin wrappers around Bun.spawnSync for consistent subprocess execution.
 */

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export function run(cmd: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }): RunResult {
  if (process.env.HIVE_DEBUG) {
    process.stderr.write(`[hive] $ ${cmd.join(' ')}\n`)
  }
  const result = Bun.spawnSync(cmd, {
    cwd: opts?.cwd,
    env: opts?.env ? { ...process.env, ...opts.env } : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode ?? 1,
  }
}

export function runOrDie(cmd: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }): string {
  const result = run(cmd, opts)
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (exit ${result.exitCode}): ${cmd.join(' ')}\n${result.stderr}`)
  }
  return result.stdout
}
