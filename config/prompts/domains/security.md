# Security Domain Knowledge

Domain-specific knowledge for agents working on security-sensitive systems. This content is role-agnostic — it applies whether you are designing, building, testing, or reviewing security aspects.

## OWASP Top 10 Checklist

When working on any security-sensitive code, systematically check for:
1. **Broken Access Control**: Authorization checks on every protected resource. Privilege escalation paths.
2. **Cryptographic Failures**: Sensitive data encrypted in transit (TLS) and at rest. No weak algorithms (MD5, SHA-1 for security).
3. **Injection**: SQL, command, and template injection. Parameterized queries. Input validation.
4. **Insecure Design**: Threat model coverage. Trust boundary identification. Assumption documentation.
5. **Security Misconfiguration**: Default credentials removed. Unnecessary services disabled. Error messages sanitized.
6. **Vulnerable Components**: Dependencies scanned for CVEs. Versions current. Lock files committed.
7. **Authentication Failures**: Password policies enforced. Session handling secure. MFA available.
8. **Software and Data Integrity Failures**: Code authenticity verified. Dependency integrity checked. CI/CD pipeline secured.
9. **Logging & Monitoring Failures**: Security events logged. Alerts configured. Audit trail maintained.
10. **SSRF**: User input influencing HTTP requests validated strictly. URL allowlists enforced.

## Input Validation and Sanitization

- **All inputs are untrusted**: Form inputs, API parameters, file uploads, headers, cookies, URL parameters — validate everything.
- **Allowlist over denylist**: Define what is acceptable (allowlist), not what is forbidden (denylist). Denylist approaches miss novel attack vectors.
- **Validate type, length, format, and content**: A valid email is not just a string — it matches a pattern, has a reasonable length, and does not contain injection payloads.
- **Context-aware output encoding**: Encode output for its context (HTML encoding for HTML, URL encoding for URLs, SQL parameterization for queries).

## Injection Prevention

- **SQL injection**: Use parameterized queries or prepared statements. Never concatenate user input into SQL strings. ORMs help but are not immune — verify generated queries.
- **Command injection**: Use array-based command execution APIs (`execFile`, not `exec`). Never pass user input through a shell.
- **Template injection**: Use auto-escaping template engines. Do not construct templates from user input.
- **Header injection**: Validate and sanitize values used in HTTP headers. Newline characters in headers enable response splitting.

## Secrets Management

- **No hardcoded secrets**: API keys, tokens, passwords, and private keys must never appear in source code, config files, or Docker images.
- **Environment variables**: Load secrets from environment variables or a secrets manager (AWS Secrets Manager, HashiCorp Vault, 1Password).
- **Rotation**: Establish rotation schedules for all credentials. Verify old credentials are revoked after rotation.
- **Logging**: Never log secrets, tokens, or credentials. Scrub sensitive values from error messages and stack traces.
- **Access control**: Limit who and what can read secrets. Use least-privilege access policies.

## Dependency Scanning

- **Automated scanning**: Run `npm audit`, Snyk, or Dependabot on every build. Do not ignore warnings.
- **Maintenance assessment**: Prefer actively maintained dependencies. Check GitHub activity, release frequency, and security response history.
- **Supply chain integrity**: Use lock files. Verify package checksums. Pin versions to avoid supply chain attacks via compromised updates.
- **Transitive dependencies**: Vulnerabilities in transitive (indirect) dependencies are just as dangerous. Monitor the full dependency tree.

## Threat Modeling (STRIDE)

- **Spoofing**: Can an attacker impersonate a user or service? Verify authentication at every boundary.
- **Tampering**: Can data be modified in transit or at rest? Use integrity checks (HMAC, signatures, checksums).
- **Repudiation**: Can actions be denied? Maintain audit logs with tamper-evident properties.
- **Information Disclosure**: Can sensitive data leak through errors, logs, timing, or side channels?
- **Denial of Service**: Can an attacker exhaust resources? Apply rate limits, size limits, and timeouts.
- **Elevation of Privilege**: Can a user gain unauthorized permissions? Enforce authorization at every layer.

## Trust Boundaries

- **Identify boundaries**: Client/server, service/service, user/system, internal/external network. Data crossing a boundary must be validated.
- **Defense in depth**: Do not rely on a single control. Validate at the API gateway AND the service. Encrypt at the network AND application layer.
- **Assume breach**: Design systems so that a compromised component cannot compromise the entire system. Segment access, limit blast radius.

## Cryptographic Decisions

- **Use established libraries**: Never implement your own crypto. Use libsodium, OpenSSL, or platform-provided crypto APIs.
- **Algorithm selection**: AES-256-GCM for symmetric encryption. RSA-2048+ or Ed25519 for asymmetric. Argon2id or bcrypt for password hashing.
- **Key management**: Generate keys with cryptographically secure randomness. Store keys in HSMs or key management services. Rotate regularly.
- **TLS configuration**: Use TLS 1.2+ only. Disable weak cipher suites. Use HSTS headers.
