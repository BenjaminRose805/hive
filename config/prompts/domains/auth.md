# Auth Domain Knowledge

Domain-specific knowledge for agents working on authentication, authorization, and identity management. This content is role-agnostic — it applies whether you are designing, building, testing, or reviewing auth systems.

## OAuth2 / OIDC Flows

- **Authorization Code + PKCE**: Standard for web and mobile apps. Redirect user to provider, exchange code for tokens. Always use PKCE — even for server-side apps.
- **Client Credentials**: Machine-to-machine communication. No user involved. Used for service accounts.
- **Device Code**: For input-constrained devices (TVs, CLI tools). User authorizes on a separate device.
- **Implicit flow**: Deprecated. Do not use for new implementations. Tokens exposed in URL fragments.

## JWT (JSON Web Tokens)

- **Signature verification**: Always verify the signature. Use asymmetric keys (RS256, ES256) for distributed systems. Symmetric (HS256) only when issuer and consumer are the same service.
- **Expiry enforcement**: Set short expiry (15-60 minutes). Use refresh tokens for session continuity.
- **Token storage**: Browser: httpOnly secure cookie (preferred) or in-memory. Never localStorage — vulnerable to XSS. Mobile: secure keychain/keystore.
- **Claims validation**: Verify `iss` (issuer), `aud` (audience), `exp` (expiry), and `nbf` (not before). Do not trust unverified claims.
- **Token size**: JWTs grow with claims. Keep payloads minimal. Large tokens add overhead to every request.

## Session Management

- **Session regeneration**: Generate a new session ID after login to prevent session fixation attacks.
- **Cookie flags**: Always set `httpOnly` (no JS access), `Secure` (HTTPS only), `SameSite=Lax` or `Strict` (CSRF protection).
- **Expiry and idle timeout**: Set both absolute expiry and idle timeout. Destroy sessions on logout.
- **Server-side storage**: Store session data server-side (Redis, database). The cookie holds only the session ID.

## Multi-Factor Authentication (MFA)

- **TOTP**: Time-based one-time passwords (Google Authenticator, Authy). Standard, well-supported, works offline.
- **WebAuthn/FIDO2**: Hardware keys and biometrics. Strongest option. Phishing-resistant.
- **SMS/Email codes**: Better than nothing, but vulnerable to SIM swapping and email compromise. Use as fallback only.
- **Recovery codes**: Generate one-time recovery codes at MFA enrollment. Store hashed. Warn users to save them securely.

## Credential Storage

- **Password hashing**: Use bcrypt (cost factor 12+) or Argon2id. Never MD5, SHA-1, or SHA-256 for passwords.
- **Salt**: Use unique per-password salts. bcrypt and Argon2 handle this automatically.
- **Pepper**: Optional application-level secret added before hashing. Stored separately from the database.
- **Breach detection**: Check passwords against known breach databases (Have I Been Pwned API) at registration and login.

## RBAC / ABAC

- **RBAC (Role-Based Access Control)**: Assign permissions to roles, assign roles to users. Simple and effective for most applications.
- **ABAC (Attribute-Based Access Control)**: Evaluate policies based on user attributes, resource attributes, and context. More flexible, more complex.
- **Principle of least privilege**: Grant the minimum permissions needed. Default to deny.
- **Permission checks**: Enforce authorization at the API/service layer, not just the UI. UI checks are for UX, not security.

## Common Auth Vulnerabilities

- **Credential stuffing**: Attackers use leaked username/password pairs. Mitigate with rate limiting, MFA, and breach detection.
- **Session fixation**: Attacker sets a known session ID before the victim logs in. Mitigate by regenerating session ID on login.
- **Token leakage**: Tokens in URLs, logs, or error messages. Mitigate by using httpOnly cookies and scrubbing logs.
- **Privilege escalation**: User modifies their role or accesses other users' data. Mitigate with server-side authorization checks on every request.
