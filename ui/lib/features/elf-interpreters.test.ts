import assert from "node:assert/strict"
import test from "node:test"
import { interpreterGroups } from "./elf-interpreters.ts"

test("interpreter grouping preserves architecture and distinguishes missing evidence from static", () => {
  const groups = interpreterGroups([
    { path: "/bin/app", linking: "dynamic", architecture: "EM_X86_64", interpreter: "/lib/ld-musl-x86_64.so.1" },
    { path: "/bin/other", linking: "dynamic", architecture: "EM_AARCH64", interpreter: "/lib/ld-musl-x86_64.so.1" },
    { path: "/bin/static", linking: "static" },
    { path: "/bin/dynamic", linking: "dynamic" },
    { path: "/lib/library.so", linking: "shared object" },
    { path: "/bin/broken", linking: "static", error: "truncated ELF" },
  ])
  assert.equal(groups.length, 6)
  assert.equal(groups.filter(g => g.family === "musl-style loader name").length, 2)
  assert.equal(groups.find(g => g.label.startsWith("Static"))?.binaries[0].path, "/bin/static")
  assert.equal(groups.find(g => g.label.startsWith("Unknown /"))?.binaries[0].path, "/bin/broken")
  assert.equal(groups.find(g => g.label.startsWith("Dynamic"))?.binaries[0].path, "/bin/dynamic")
})

test("only recognizable loader basenames receive family hints", () => {
  const groups = interpreterGroups([
    { path: "/bin/a", linking: "dynamic", interpreter: "/lib64/ld-linux-x86-64.so.2" },
    { path: "/bin/b", linking: "dynamic", interpreter: "/custom/musl-wrapper" },
  ])
  assert.equal(groups.find(g => g.binaries[0].path === "/bin/a")?.family, "glibc-style loader name")
  assert.equal(groups.find(g => g.binaries[0].path === "/bin/b")?.family, "Other loader")
})
