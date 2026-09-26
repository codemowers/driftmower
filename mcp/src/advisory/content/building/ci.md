# Continuous integration

- Build images through a GitHub Actions pipeline and scan them for vulnerabilities.
- Run integration tests with Docker Compose, using the development image and dependencies aligned with production.
- Test the images in both Compose and Kubernetes environments.
- Keep environment-variable names consistent across stages.

- Publishing `latest` and using it in main-branch chart defaults is acceptable. At tag/release time, substitute immutable image references, build once for the source revision, and promote the same image digest through staging and production. Evaluate development defaults separately from release configuration. Supply environment-specific configuration at deployment time.
- Give each release a unique identity recording the source revision, image digest, and configuration revision. Retain the information and artifacts needed to roll back.

TODO: Registry publishing, signing, and concrete release-promotion commands.
