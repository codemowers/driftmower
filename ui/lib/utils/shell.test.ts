import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { shellQuote } from "./shell.ts"

test("shell snippets keep ordinary Kubernetes arguments readable", () => {
  for (const value of ["cluster.example.test", "demo", "lolcatz-database", "cluster/demo", "user@example.com", "cluster.postgresql.cnpg.io"]) assert.equal(shellQuote(value), value)
})
test("shell quoting preserves placeholders, empty strings and metacharacters literally", () => {
  for (const value of ["", "<context>", "two words", "a'b", "$(printf injected)", "`printf injected`", "x;y", "a\nb", "*.yaml", "~/.kube/config"]) {
    const result = spawnSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(value)}`], { encoding: "utf8" })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, value)
  }
})
