import assert from "node:assert/strict"
import test from "node:test"
import { containerImageHref, parseContainerImagePath } from "./image-artifacts.ts"

test("container image paths separate the image name, artifact and subpage", () => {
  const key = "docker.dragonflydb.io/dragonflydb/dragonfly"
  const digest = "sha256:84b1009aee0b68327758bce8e99ed514f782d713353acc46caf5738feaa481d6"
  const href = containerImageHref(key, digest, "sbom")
  assert.equal(href, `/container-images/${key}/-/${digest}/sbom`)
  const segments = href.slice("/container-images/".length).split("/")
  assert.deepEqual(parseContainerImagePath(segments), { key, artifact: digest, subpage: "sbom" })
  assert.deepEqual(parseContainerImagePath(key.split("/")), { key })
  assert.deepEqual(parseContainerImagePath([...key.split("/"), "-", "ref%2Fwith%2Fslashes"]), { key, artifact: "ref/with/slashes", subpage: undefined })
})
