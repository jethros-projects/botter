# Security

Botter handles account credentials and can send messages, invoke connected tools, manage resources, and transfer private files. Only run it with accounts and resources you are authorized to use.

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
