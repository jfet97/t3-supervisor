# Release notes

For a user-visible change, run `pnpm changeset`, select `@jfet97/t3-supervisor`, choose
patch, including for features, and describe the change for users. Minor and major
bumps require Andrea to explicitly change the current patch-only policy. Commit the generated
Markdown file with the implementation. Infrastructure-only changes can omit one.

Changesets collects these notes into a version pull request and `CHANGELOG.md`.
See [the release guide](../RELEASING.md) for channels and publishing.
