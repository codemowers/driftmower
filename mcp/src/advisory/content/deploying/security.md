# Runtime security

- Use a read-only root filesystem and explicit writable mounts for application state and scratch data. See `building/general` for image file permissions and runtime identity compatibility, and `deploying/general` for admission-owned settings.
- Keep secrets out of source control and images. Use Vault for secret storage/versioning, Docker secrets or environment variables locally, and Kubernetes Secrets in the cluster.

- For components that authenticate to each other using shared passwords or tokens, use the platform's Mittwald secret generator. Declare `StringSecret.secretgenerator.mittwald.de` resources and consume the generated Kubernetes Secret from both components through Secret references or mounted files.
- Commit the generator resource, never the generated credential. Give separate component relationships their own credentials and coordinate credential rotation with all consumers. Use an operator's existing generated credentials when that operator already owns authentication.
- The secret generator is part of platform provisioning. Consult the provisioning guidance for resource setup, and use the advertised MCP capability and namespace-readiness tools to inspect the deployment environment.
- Use internal TLS alongside generated credentials; see `deploying/networking` through `get_engineering_advisory`. Do not disable certificate or hostname verification.

- Set `seccompProfile.type: RuntimeDefault` at Pod level.
- Register the application with the selected OIDC provider, using authorization code flow with PKCE and explicit HTTPS redirect URIs for browser clients. Consume provisioned credentials through Secret references; configure API issuer and audience consistently. Keep confidential client credentials on the server.
- Discover the installed provider and its provisioning interface before relying on them. When using Passmower `OIDCClient.codemowers.cloud`, read `crds/oidcclient.codemowers.cloud` for its requirements and generated Secret mappings.
- Generate application session-signing secrets once through `StringSecret.secretgenerator.mittwald.de` and share the resulting Secret across replicas. Avoid regeneration on every deployment; rotate deliberately.
