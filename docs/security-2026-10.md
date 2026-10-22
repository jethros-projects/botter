# October 2026 Node.js security update

Botter 0.8.1-next.1 requires Node.js **22.23.4+, 24.22.1+, or 26.12.1+**
within those release lines. Upgrade the runtime itself, including embedded and
deployed copies; reinstalling Botter cannot repair Node.js. Unsupported versions
fail before SDK or CLI startup with `UNSUPPORTED_NODE_VERSION`.

The [Node.js October 21 advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
lists these fixes:

| Area | CVEs | Botter exposure assessment |
| --- | --- | --- |
| Brotli decoding | CVE-2026-111497 | Built-in fetch can decode compressed remote responses. |
| TLS identity checks | CVE-2026-105483, CVE-2026-106069, CVE-2026-106072 | Network transports use Node's TLS implementation. |
| DNS input validation | CVE-2026-105482 | No direct `dns.resolve` calls found; runtime DNS still warrants updating. |
| HTTP keep-alive | CVE-2026-105481 | No exploit reproduced; runtime HTTP code remains in scope. |
| Snapshot entropy reuse | CVE-2026-106074 | UUIDs are used, but Botter creates no startup snapshots or single-executable applications. |
| ZIP validation | CVE-2026-106070 | No use of Node's affected `ZipFile` API found. |
| Permission checks | CVE-2026-106071, CVE-2026-106073 | Botter supplies no permission sandbox; hosts relying on it must upgrade. |

These are source-based exposure assessments, not exploit confirmations. The
advisory distinguishes affected release lines; it does not make every issue
reachable from every Botter workflow. Node's release notes also include bundled
dependency and certificate updates:
[22.23.4](https://nodejs.org/en/blog/release/v22.23.4),
[24.22.1](https://nodejs.org/en/blog/release/v24.22.1), and
[26.12.1](https://nodejs.org/en/blog/release/v26.12.1).

These Node updates also include [c-ares 1.34.9](https://c-ares.org/changelog.html),
which fixes 11 [upstream security advisories](https://github.com/c-ares/c-ares/security/advisories)
published on October 20. Those advisories had no assigned CVE identifiers when
checked on October 22. Botter does not directly call the c-ares DNS APIs; this
is inherited runtime fix coverage, without a claim of demonstrated SDK
exploitation.

The runtime gate is a minimum security baseline. Keep installing subsequent
security updates in supported release lines. Odd, unknown, and prerelease Node
versions are unsupported. The SDK's existing account, transfer, and operation
limits remain in effect; prior live-account evidence is historical.
