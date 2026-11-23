import assert from "node:assert/strict"
import { test } from "node:test"
import { schemaType, toolParameters, toolSignature } from "./tools.ts"

test("signatures distinguish required arguments and preserve zero and false defaults", () => {
  const tool = {
    name: "read_namespace",
    inputSchema: { type: "object" as const, required: ["namespace"], properties: {
      namespace: { type: "string", description: "Namespace to read" },
      count: { type: "integer", default: 0 },
      includeFinished: { type: "boolean", default: false },
    } },
    outputSchema: { type: "object" as const, required: ["pods"], properties: { pods: { type: "array", items: { $ref: "#/$defs/Pod" } } } },
  }
  assert.equal(toolSignature(tool), "read_namespace(namespace: string, count?: integer, includeFinished?: boolean) → { pods: Array<Pod> }")
  assert.deepEqual(toolParameters(tool).map(p => [p.name, p.required, p.defaultValue]), [["namespace", true, undefined], ["count", false, "0"], ["includeFinished", false, "false"]])
})

test("schema types retain nullable alternatives, enum values and JSON pointer references", () => {
  assert.equal(schemaType({ anyOf: [{ type: "string" }, { type: "null" }] }), "string | null")
  assert.equal(schemaType({ type: ["integer", "null"] }), "integer | null")
  assert.equal(schemaType({ type: "string", enum: ["running", "finished"] }), '"running" | "finished"')
  assert.equal(schemaType({ $ref: "#/$defs/Group~1Version" }), "Group/Version")
  assert.equal(schemaType(false), "never")
})

test("large outputs stay compact and tools without an output schema make no return-type claim", () => {
  assert.equal(toolSignature({ name: "ping", inputSchema: { type: "object" } }), "ping()")
  const type = schemaType({ type: "object", properties: { a: { type: "object", properties: { deeply: { type: "string" } } }, b: { type: "string" }, c: { type: "boolean" }, d: { type: "integer" }, e: { type: "string" } } })
  assert.equal(type, "{ a?: object; b?: string; c?: boolean; d?: integer; … }")
})
