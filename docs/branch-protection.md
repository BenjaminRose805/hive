# Branch Protection Rules for `master`

This document specifies the branch protection rules for the `master` branch, explains the rationale behind each rule, and provides step-by-step instructions for configuring them in GitHub.

---

## Summary of Rules

| Rule | Setting | Required? |
|------|---------|-----------|
| Require pull request before merging | 1 approval, dismiss stale | Yes |
| Require status checks to pass | `check` job, branch up to date | Yes |
| Require conversation resolution | Enabled | Yes |
| Require linear history | Enabled (squash merge) | Recommended |
| Require signed commits | Disabled | No |
| Restrict who can push | Disabled | No |
| Allow force pushes | Nobody | Yes |
| Allow deletions | Disabled | Yes |

---

## Rule Details and Rationale

### 1. Require a Pull Request Before Merging

**Setting:** Enabled — 1 required approval, dismiss stale approvals on new commits.

No code reaches `master` without a pull request that has been reviewed and approved. This ensures every change gets a second pair of eyes before it ships.

**Why dismiss stale approvals?** If a PR is approved and then new commits are pushed, the approval is invalidated. This prevents a scenario where an approved PR is silently modified after review.

### 2. Require Status Checks to Pass

**Setting:** Enabled — require the `check` job from the CI workflow. Require branches to be up to date before merging.

Every PR must pass the CI pipeline (typecheck, lint, test) before it can be merged. Requiring up-to-date branches means the PR must be rebased on the latest `master` before merging, so CI runs against the actual code that will land.

**Why require up-to-date branches?** Without this, two PRs that individually pass CI could conflict when both are merged. Requiring an up-to-date branch ensures CI validates the final merged state.

### 3. Require Conversation Resolution

**Setting:** Enabled.

All review comments and discussion threads on a PR must be resolved before merging. This prevents changes from being merged with unaddressed feedback.

**Why?** Review comments often flag real issues. Requiring resolution ensures nothing falls through the cracks — every concern is either addressed or explicitly acknowledged.

### 4. Require Linear History

**Setting:** Enabled (squash or rebase merges only — no merge commits).

The `master` branch maintains a linear commit history. Each PR becomes a single commit (via squash merge), making the history easy to read and bisect.

**Why?** Linear history makes `git log` readable, `git bisect` reliable, and reverts straightforward. Merge commits add noise without adding information.

### 5. Do NOT Require Signed Commits

**Setting:** Disabled.

GPG/SSH commit signing adds friction without proportional security benefit for this project. The PR review process and branch protection rules provide sufficient integrity guarantees.

### 6. Do NOT Restrict Who Can Push

**Setting:** Disabled.

This is a single-maintainer project. Restricting push access adds configuration overhead without practical benefit.

### 7. No Force Pushes Allowed

**Setting:** Allow force pushes set to **Nobody**.

Force pushing to `master` rewrites shared history and can cause data loss. This rule is non-negotiable.

### 8. No Branch Deletions

**Setting:** Allow deletions set to **false**.

Prevents accidental deletion of the `master` branch.

---

## Merge Strategy: Squash Merge

All PRs to `master` use **squash merge**. This means:

- Every PR becomes **one commit** on `master`, regardless of how many commits are on the feature branch.
- The **PR title** becomes the commit message on `master`.
- The individual commits from the feature branch are preserved in the PR history on GitHub but do not appear in the `master` log.

### Why Squash Merge?

| Benefit | Explanation |
|---------|-------------|
| Clean history | `master` has one commit per feature/fix — easy to scan |
| Meaningful commits | Each commit on `master` maps to a reviewed, approved PR |
| Easy reverts | Reverting a feature is one `git revert` on one commit |
| Reliable bisect | `git bisect` identifies the exact PR that introduced a regression |
| WIP freedom | Developers can commit freely on branches without polluting `master` history |

### PR Title Convention

Since the PR title becomes the `master` commit message, write clear, descriptive PR titles:

- `feat: add webhook retry logic with exponential backoff`
- `fix: prevent duplicate inbox messages on gateway restart`
- `docs: add branch protection setup guide`

Avoid generic titles like "fix bug" or "update code".

---

## GitHub UI Setup Instructions

### Step 1: Navigate to Branch Protection Settings

1. Go to your repository on GitHub.
2. Click **Settings** in the top navigation bar.
3. In the left sidebar, click **Branches** (under "Code and automation").
4. Under "Branch protection rules", click **Add branch protection rule** (or edit an existing rule for `master`).

### Step 2: Set the Branch Name Pattern

1. In the "Branch name pattern" field, enter: `master`

### Step 3: Configure Required Pull Requests

1. Check **Require a pull request before merging**.
2. Set **Required number of approvals before merging** to `1`.
3. Check **Dismiss stale pull request approvals when new commits are pushed**.

### Step 4: Configure Required Status Checks

1. Check **Require status checks to pass before merging**.
2. Check **Require branches to be up to date before merging**.
3. In the search box, search for and select the `check` status check (this is the job name from the CI workflow in `.github/workflows/ci.yml`).

> **Note:** The `check` status check only appears in the search results after the CI workflow has run at least once. Push a PR first if you don't see it listed.

### Step 5: Configure Conversation Resolution

1. Check **Require conversation resolution before merging**.

### Step 6: Configure Linear History

1. Check **Require linear history**.

### Step 7: Configure Force Push and Deletion Protection

1. Under "Allow force pushes", ensure it is set to **Disabled** (nobody can force push).
2. Ensure **Allow deletions** is **unchecked**.

### Step 8: Save

1. Click **Create** (or **Save changes** if editing an existing rule).

### Step 9: Configure Merge Strategy

This setting is separate from branch protection rules:

1. Go to **Settings** → **General**.
2. Scroll down to the **Pull Requests** section.
3. Uncheck **Allow merge commits** (disables merge commit strategy).
4. Check **Allow squash merging** and set the default commit message to **Pull request title**.
5. Uncheck **Allow rebase merging** (optional — squash is the team standard, but rebase can be left enabled as a fallback).
6. Click **Save**.

---

## Verification

After configuring, verify the rules work correctly:

1. **Create a test PR** against `master`.
2. Confirm the merge button is **blocked** until:
   - CI passes (the `check` job completes successfully).
   - At least one approval is given.
   - All conversations are resolved.
3. Confirm the merge button defaults to **Squash and merge**.
4. Attempt a force push to `master` from the command line — it should be rejected.
