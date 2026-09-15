# Releasing

Releases are published to npm as [`iamagnus`](https://www.npmjs.com/package/iamagnus)
by the `Release` workflow, with provenance, through npm trusted publishing: no
token lives in this repository.

## One-time setup

npm only lets you configure a trusted publisher on a package that already
exists, so the very first version goes out by hand:

1. `npm login`, then `npm publish --access public` from a clean checkout of the
   release commit. `prepublishOnly` runs the typecheck, the tests and the build
   first.
2. On npmjs.com, open the package's *Settings → Trusted publishing* and add
   GitHub Actions: owner `MeGrimlock`, repository `magnus-node-sdk`, workflow
   `release.yml`, environment `npm`.
3. On GitHub, under *Settings → Environments*, create an environment named
   `npm`.

## Each release

1. Set the same version in `package.json` and in `VERSION` in `src/client.ts`.
2. Run `npm run livecheck` against the production API with a test agent. All
   fourteen checks must pass.
3. Commit, then tag and push:

   ```bash
   git tag v0.2.0
   git push origin main v0.2.0
   ```

The workflow refuses a tag that does not match both version strings, then
`npm publish` runs the typecheck, the tests and the build before uploading.

If `CONTRACT.md` changed, it changes identically in the Python and Go SDKs.
