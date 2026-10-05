// The SDK's default validator is imported even when Client gets an explicit
// provider. The browser build replaces that module so all SDK defaults use
// validation without runtime code generation, including future UI features.
export { CfWorkerJsonSchemaValidator as AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
