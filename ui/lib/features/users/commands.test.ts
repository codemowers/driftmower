import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { addLocalGroupCommand, existingLocalGroups, removeGroupCommand, userSettingCommand } from "./commands.ts"
import type { OIDCUser } from "./types.ts"

const user: OIDCUser = { name: "alice", namespace: "passmower", groups: ["github.com:org:admins"], emails: [], passkeyCount: 0, memberships: [{ prefix:"github.com", name:"org:admins", source:"github", local:false }] }
const connection = { key: "key", name: "cluster", status: "available", aliases: [{ name: "cluster/passmower", namespace: "passmower" }] }

// Exercise the complete rendered shell pipeline. The fake kubectl applies the
// generated merge patch without contacting a cluster.
function run(command: string, resource: object) {
  const dir = mkdtempSync(join(tmpdir(), "driftmower-user-command-"))
  try {
    const bin = join(dir, "bin"); mkdirSync(bin)
    const input = join(dir, "user.json"); writeFileSync(input, JSON.stringify(resource))
    const resultFile = join(dir, "patched.json")
    writeFileSync(join(bin, "kubectl"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const resource = JSON.parse(fs.readFileSync(process.env.USER_INPUT, 'utf8'));
if (!args.includes('--context') || args[args.indexOf('--context') + 1] !== 'cluster/passmower' || args.includes('--namespace')) process.exit(20);
if (args[0] === 'get') { process.stdout.write(JSON.stringify(resource)); process.exit(0); }
if (args[0] !== 'patch') process.exit(21);
try {
 const inline=args.indexOf('-p');
 const patch = JSON.parse(inline>=0?args[inline+1]:fs.readFileSync(0, 'utf8'));
 function merge(target, patch) {
  for(const [key,value] of Object.entries(patch)) {
   if(value===null)delete target[key];
   else if(typeof value==='object'&&!Array.isArray(value))target[key]=merge(target[key]??{},value);
   else target[key]=value;
  }
  return target;
 }
 fs.writeFileSync(process.env.USER_RESULT, JSON.stringify(merge(resource,patch)));
} catch { process.exit(24); }
`, { mode: 0o755 })
    const result = spawnSync("/bin/bash", ["-o", "pipefail", "-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, USER_INPUT: input, USER_RESULT: resultFile }, encoding: "utf8" })
    return { status: result.status, output: result.status === 0 ? JSON.parse(readFileSync(resultFile, "utf8")) : undefined }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const base = { metadata: { uid: "uid", resourceVersion: "123" }, spec: { type: "person", groups: [{ prefix: "local", name: "operators" }] }, github: { groups: [{ prefix: "github.com", name: "org:admins" }, { prefix: "github.com", name: "org:devs" }] }, status: { groups: [{ prefix: "github.com", name: "org:admins" }] } }

test("remove command uses live arrays and preserves unrelated and derived groups", () => {
  const result = run(removeGroupCommand(user, "github.com:org:admins", connection), base)
  assert.equal(result.status, 0)
  assert.deepEqual(result.output.github.groups, [{ prefix: "github.com", name: "org:devs" }])
  assert.deepEqual(result.output.spec, base.spec)
  assert.deepEqual(result.output.status, base.status)
  assert.deepEqual(run(removeGroupCommand(user,"github.com:org:admins",connection),result.output).output,result.output)
  assert.doesNotMatch(removeGroupCommand(user,"github.com:org:admins",connection),/resourceVersion|metadata\/uid|op.*test/)
})
test("add local group is idempotent and keeps existing assignments", () => {
  const group = { prefix: "local", name: "admins' $(false)" }
  const command = addLocalGroupCommand(user, group, connection)
  const first = run(command, base)
  assert.equal(first.status, 0)
  assert.deepEqual(first.output.spec.groups, [group,...base.spec.groups])
  assert.deepEqual(run(command, first.output).output.spec.groups, first.output.spec.groups)
})
test("account settings preserve provider and local group data", () => {
  const result = run(userSettingCommand(user, "type", "banned", connection), base)
  assert.equal(result.status, 0)
  assert.equal(result.output.spec.type, "banned")
  assert.deepEqual(result.output.github, base.github)
  assert.deepEqual(result.output.spec.groups, base.spec.groups)
  assert.equal(run(userSettingCommand(user, "approved", true, connection), base).output.passmower.approved, true)
})
test("local group choices come from provenance rather than prefix guessing", () => {
  const groups = existingLocalGroups([{ ...user, memberships: [{ prefix: "github.com", name: "manual", source: "spec", local: true }, { prefix: "github.com", name: "org:admins", source: "github", local: false }] }])
  assert.deepEqual(groups, [{ prefix: "github.com", name: "manual" }])
})
