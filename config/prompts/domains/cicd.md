# CI/CD Domain Knowledge

Domain-specific knowledge for agents working on continuous integration, continuous delivery, and deployment automation. This content is role-agnostic — it applies whether you are designing, building, testing, or reviewing CI/CD systems.

## Pipeline Design

- **Fast feedback**: Optimize for developer feedback time. Run fast checks first (lint, type check, unit tests), slow checks later (integration tests, e2e, security scans).
- **Parallel stages**: Run independent steps in parallel. Linting, unit tests, and security scans have no dependencies on each other — run them simultaneously.
- **Fail fast**: Stop the pipeline on first failure. Do not waste compute running integration tests if the build is broken.
- **Deterministic builds**: The same commit should produce the same artifact every time. Pin dependency versions. Use lock files. Avoid fetching latest tags.
- **Pipeline as code**: Define pipelines in version-controlled files (`.github/workflows/*.yml`, `Jenkinsfile`, `.gitlab-ci.yml`). Review pipeline changes like any other code.

## Deployment Strategies

- **Blue-green**: Run two identical environments. Deploy to inactive, test, then switch traffic. Instant rollback by switching back. Requires 2x infrastructure.
- **Canary**: Route a small percentage of traffic (1-5%) to the new version. Monitor error rates and latency. Gradually increase traffic or rollback. Lower risk than full cutover.
- **Rolling update**: Incrementally replace instances. Each new instance must pass health checks before the next is replaced. Good for stateless services.
- **Feature flags**: Deploy code without activating features. Enable features gradually per user, region, or percentage. Decouple deployment from release.
- **Recreate**: Stop all old instances, deploy new ones. Simple but causes downtime. Only acceptable for development environments.

## Artifact Management

- **Immutable artifacts**: Build once, deploy everywhere. Do not rebuild for each environment — promote the same artifact through dev, staging, production.
- **Versioning**: Tag artifacts with git SHA or semantic version. Make it easy to determine exactly what code is in a given artifact.
- **Retention policy**: Define how long artifacts are kept. Clean up old artifacts to manage storage costs.
- **Integrity**: Sign artifacts and verify signatures before deployment. Prevent tampering between build and deploy.

## Environment Promotion

- **Environment parity**: Staging should mirror production as closely as possible (same OS, same config, same resource limits). Differences cause "works on staging" bugs.
- **Configuration per environment**: Use environment variables or config files for environment-specific values. Same artifact, different config.
- **Promotion gates**: Require automated tests to pass and manual approval (for production) before promotion. No direct deployment to production.
- **Database compatibility**: Ensure database migrations are compatible across environments. Run migrations before code deployment.

## Rollback Procedures

- **Automated rollback**: Trigger rollback automatically when health checks fail post-deployment. Do not require manual intervention for obvious failures.
- **Rollback testing**: Test rollback procedures regularly. An untested rollback plan is not a plan.
- **Database rollback**: If a deployment includes database migrations, ensure migrations are backward-compatible or have a separate rollback path.
- **Communication**: Notify the team when a rollback occurs. Include what was deployed, what failed, and what was rolled back to.

## Release Automation

- **Semantic versioning**: Use semver (MAJOR.MINOR.PATCH) for releases. Breaking changes increment major, features increment minor, fixes increment patch.
- **Changelog generation**: Auto-generate changelogs from commit messages or PR titles. Use conventional commits to categorize changes.
- **Release branches**: For complex projects, use release branches to stabilize before deployment. For simple projects, deploy from main.
- **Notification**: Notify stakeholders (Slack, email, Discord) when releases are deployed. Include version, changelog summary, and deployment status.
