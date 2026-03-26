# Infrastructure Domain Knowledge

Domain-specific knowledge for agents working on infrastructure, containers, networking, and cloud resources. This content is role-agnostic — it applies whether you are designing, building, testing, or reviewing infrastructure.

## Docker

- **Multi-stage builds**: Separate build stage (compilers, dev dependencies) from runtime stage (only the application binary and runtime dependencies). This reduces image size dramatically.
- **Minimal base images**: Use `alpine`, `distroless`, or `scratch` where possible. Smaller images have fewer vulnerabilities and faster pull times.
- **Layer caching**: Order Dockerfile instructions from least-changing to most-changing. `COPY package.json` before `COPY src/` so dependency installation is cached.
- **No secrets in images**: Never `COPY` or `ARG` secrets into images. Use runtime environment variables, mounted secrets, or init containers.
- **Health checks**: Define `HEALTHCHECK` in the Dockerfile or orchestrator. Health checks enable automated restarts and traffic routing.
- **Non-root user**: Run containers as a non-root user. Add `USER <nonroot>` in the Dockerfile after installing dependencies.

## Infrastructure as Code (IaC)

- **Version control everything**: Terraform, CloudFormation, Helm charts, Ansible playbooks — all infrastructure definitions live in git.
- **State management**: Terraform state must be stored remotely (S3, GCS) with locking (DynamoDB). Local state files cause conflicts in teams.
- **Modular design**: Break infrastructure into reusable modules (networking, compute, storage). Modules should have clear inputs and outputs.
- **Plan before apply**: Always review the execution plan before applying changes. Automated pipelines should require approval for production changes.
- **Drift detection**: Periodically check for manual changes that diverge from IaC definitions. Drift causes confusion and outages.

## Networking

- **VPCs and subnets**: Use private subnets for application and data tiers. Public subnets only for load balancers and bastion hosts.
- **Security groups**: Apply least-privilege rules. Allow only necessary ports and source IPs. Deny by default.
- **Firewalls**: Layer network controls — security groups at the instance level, NACLs at the subnet level, WAF at the edge.
- **DNS**: Use meaningful, consistent DNS naming. Internal services use private DNS zones. TTL values balance caching and update speed.
- **Service mesh**: For complex microservice topologies, consider a service mesh (Istio, Linkerd) for mTLS, traffic management, and observability.

## Container Orchestration

- **Resource requests and limits**: Always set CPU and memory requests (for scheduling) and limits (for protection). Missing limits allow a single container to starve others.
- **Liveness and readiness probes**: Liveness restarts unhealthy containers. Readiness removes them from traffic. Configure both with appropriate thresholds.
- **Rolling updates**: Deploy with rolling update strategy. Set `maxUnavailable` and `maxSurge` to control rollout speed and availability.
- **Pod disruption budgets**: Define minimum available replicas during maintenance. Prevents voluntary evictions from taking down a service.
- **Namespace isolation**: Use namespaces to separate environments and teams. Apply network policies to restrict cross-namespace traffic.

## Cloud Patterns

- **Immutable infrastructure**: Replace instances instead of patching them. Build new AMIs/images, deploy them, and terminate old ones.
- **Auto-scaling**: Scale based on metrics (CPU, request count, queue depth). Set minimum and maximum bounds. Test scaling behavior under load.
- **Multi-AZ deployment**: Distribute resources across availability zones for resilience. Single-AZ deployments have a blast radius of one datacenter.
- **Cost awareness**: Tag resources for cost allocation. Use spot/preemptible instances for non-critical workloads. Right-size instances based on actual usage.
- **Disaster recovery**: Define RTO (recovery time) and RPO (recovery point). Test backup and restore procedures. Document recovery runbooks.
