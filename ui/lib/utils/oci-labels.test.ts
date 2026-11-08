import assert from "node:assert/strict"
import test from "node:test"
import { sourceRefUrl, sourceRepoUrl } from "./oci-labels.ts"

test("source revision links use forge paths and encode refs", () => {
  assert.equal(sourceRefUrl("https://github.com/org/repo.git", "abc1234", "commit"), "https://github.com/org/repo/commit/abc1234")
  assert.equal(sourceRefUrl("https://github.com/org/repo", "v1.2", "tag"), "https://github.com/org/repo/tree/v1.2")
  assert.equal(sourceRefUrl("https://gitlab.example.com/group/sub/repo/", "release/1", "tag"), "https://gitlab.example.com/group/sub/repo/-/tree/release%2F1")
  assert.equal(sourceRefUrl("https://codeberg.org/org/repo", "v1", "tag"), "https://codeberg.org/org/repo/src/tag/v1")
  assert.equal(sourceRefUrl("javascript:alert(1)", "abc", "commit"), null)
  assert.equal(sourceRefUrl("https://user:secret@github.com/org/repo", "abc", "commit"), null)
  assert.equal(sourceRefUrl("https://unknown.example/org/repo", "abc", "commit"), null)
  assert.equal(sourceRepoUrl({"org.label-schema.vcs-url": "https://github.com/org/repo.git"}), "https://github.com/org/repo")
})
