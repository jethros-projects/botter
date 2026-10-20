# Releasing Botter

Botter ships one package, `@jethros-projects/botter`, containing the typed SDK
and the `botter` executable. The source repository is
[jethros-projects/botter](https://github.com/jethros-projects/botter).
Preview versions use a suffix such as `0.8.1-next.0` and the explicit npm tag
`next`. Preview status describes the release channel; it does not establish
complete live verification or official support from the service provider.

## Prepare a candidate

1. Review the full diff and untracked files. Keep credentials, account traces,
   recordings, generated downloads, and private fixture journals out of Git.
2. Set the version in `package.json` and both root fields in
   `package-lock.json`. Review package links, README examples, the terminal
   image, licenses, and the documented API limitations.
3. Run `npm ci --ignore-scripts` and `npm run check`. CI checks Node.js 22 and
   24 on Linux and macOS. Its regression tests, strict packed SDK consumers,
   README examples, and isolated package install use offline fixtures.
4. Commit the exact reviewed source with the public identity below. Run CI on
   that commit. Use npm **11.11.1** for the maintainer release commands.
5. Run `npm run release:check`. Review
   `work/releases/<version>/verification.json`, `publication-metadata.json`,
   and the exact archive in that directory. Repacking must be byte-identical.
   Install that archive in a fresh directory, verify CLI help/version and SDK
   imports, and retain its hash with the source commit.

The [live verification guide](live-verification.md) is a separate opt-in gate.
Record the exact tested version, steps, failures, retained uploads, and fixture
cleanup. Never infer a passing real-account run from offline results or a
package rename. Never replay a send or upload after an uncertain result.

## Public Git identity

Configure the maintainer identity and tracked hook in this checkout before
creating commits or annotated tags:

```sh
git config --local user.name Jethro
git config --local user.email jethros-projects@users.noreply.github.com
git config --local user.useConfigOnly true
git config --local core.hooksPath .githooks
```

The pre-push hook checks reachable authors, committers, annotated taggers, and
historical and tracked source. The maintainer gate permits `Jethro` or
`jethros-projects` with the account's GitHub noreply address, including GitHub's
numeric-ID prefix. Ordinary contributor checks do not impose this identity.

Source checks derive the local username without storing it in the repository;
common CI usernames are excluded. Additional private terms can be supplied
locally as newline-separated `BOTTER_PRIVATE_TERMS`. Never commit those values.
Release metadata and archives also reject generic home paths and local file
URLs. Publication metadata, README, package metadata, and archive headers reject
unapproved email addresses; archive checks also reject local owners and unsafe
entries.
Hooks can be bypassed, and these checks cannot identify every personal detail
or recall a previously downloaded copy. Review public surfaces after publishing.

## Publish a preview

The maintainer must authorize publication. Confirm `npm whoami`, ownership of
the scoped package, and that the version is unused. Complete npm's normal
browser sign-in and security-key flow without copying credentials into source.

```sh
npm run release:check
npm run release:publish
```

Run these commands from the clean, complete source checkout. The publisher
accepts a directory only, scans reachable Git identities and source, archive
headers/content, and the prepared publication metadata, then captures the
final request in memory without authentication or network access. During real
publication, a guard compares the actual outgoing metadata and archive with
that snapshot before forwarding the registry PUT. Public npm source
fingerprints restrict the adapter to reviewed npm 11.11.1; changing that
implementation requires reviewing the adapter and its offline tests.

Do not bypass the guard with a raw publish command. Publishing a local tarball
with this npm version adds an absolute path to public `_from` and `_resolved`
metadata; a relative tarball argument still exposes an absolute `_resolved`.
Checking archive contents alone cannot detect that leak. Directory publication
avoids those injected source paths. npm also adds registry account information
on its server: review the public account profile separately, since local
metadata checks cannot control it or promise anonymity.

## Verify the public result

Enable private vulnerability reporting on GitHub before public source upload.
Push the reviewed source and matching annotated preview tag, then confirm CI.
Create a GitHub prerelease with the exact tested archive, source archive, and
checksums. Inspect source ZIP comments and headers as well as member contents.
Do not claim hosted CI provenance for a local terminal publication.

npm can scan a new upload before making it installable. After a successful
publish, check registry metadata before retrying an apparent 404: published
name/version pairs cannot be reused. Download the actual published archive,
compare its hash with the candidate, and test fresh Node 22 and 24 installs.
Review the complete public metadata, including npm-added account fields, and
inspect README links and the terminal image on both GitHub and npm.

Record the actual `next` and `latest` tags. npm may assign `latest` on the first
publication even when `next` was requested; a tag does not establish stability.
Keep preview installation instructions explicit with `@next`. Promoting a
release to stable, publishing a different package name, and deleting an older
version are separate maintainer decisions.
