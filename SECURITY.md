# Security

Botter handles account credentials and can send messages, invoke connected tools, manage resources, and transfer private files. Only run it with accounts and resources you are authorized to use.

## Required runtime

Use Node.js **22.23.4+, 24.22.1+, or 26.12.1+** within those release lines.
The [October 2026 update](docs/security-2026-10.md) explains the upstream
vulnerabilities and exposure limits. Botter rejects unsupported runtimes with
`UNSUPPORTED_NODE_VERSION` before SDK or CLI startup. Updating the npm package
does not patch Node.js: update the runtime separately, including any embedded
or deployed copy. Unknown major versions and prereleases require review before
they are supported.

## Reporting a vulnerability

Use the repository's private vulnerability reporting feature when available. Otherwise, contact the maintainer privately through their repository profile before sharing details. Do not post tokens, account data, exploit details involving another user's resources, or unsanitized command output in a public issue.

Include the affected version, platform, a minimal reproduction using synthetic data, expected and actual behavior, and the security impact. Never include a working credential. There is no guaranteed response time or formal security support period.

## Credentials and output

Browser sign-in persists a session in macOS Keychain or a private credential file. `BOTTER_AUTH_FILE` selects a file; `GROK_BRIDGE_AUTH_FILE` remains a compatibility fallback. File storage checks ownership and permissions and refuses unsafe existing destinations. Do not share credential files or relax their permissions.

Use `botter auth-status` to inspect session metadata. `botter logout` clears botter's stored session; it does not revoke sessions in other clients. If credentials are exposed, use the service's account controls to revoke the affected session as well.

Command output may contain private conversations, file references, or third-party tool results. Review and redact it before sharing. Keep downloaded files, webhook keys, environment files, and live test recordings outside the repository.

## API boundaries

Botter uses unofficial internal APIs. The service enforces account permissions, and availability may change. The support manifest limits callable operations and request shapes; it does not certify every connected tool or prevent side effects requested through messages or tool calls. Review write commands and tool arguments before running them.

Normal development checks are offline. Live writes require a deliberately selected account and disposable resources; they are not part of CI.

## Publication privacy

Maintainer release checks inspect Git identities, committed source, package
metadata, and archive contents and headers before publishing. Follow the
[release guide](docs/releasing.md) and use the guarded directory publisher;
local tarball publication can expose machine paths in npm metadata. Review
public GitHub and npm account information separately. These checks reduce
accidental exposure; they cannot remove previously shared copies or guarantee
that arbitrary user content contains no personal information.
