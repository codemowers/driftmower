import assert from "node:assert/strict"
import test from "node:test"
import { expandedStorage } from "./quantity.ts"
import { volumeCommands, volumeCleanupCommands } from "./commands.ts"
import { volumePath, type VolumeDetail, type Volumes } from "./types.ts"

const detail: VolumeDetail = {
  claim: { namespace: "team", name: "data", uid: "claim-uid", phase: "Bound", storageClass: "local", requestedStorage: "8Gi", provisionedStorage: "8Gi", volumeMode: "Filesystem", accessModes: ["ReadWriteOnce"], boundVolume: "pv-data", usage: { usedBytes: null, capacityBytes: null, inodes: null, inodesUsed: null }, canExpand: true, usedBy: [] },
  persistentVolume: { name: "pv-data", uid: "pv-uid", phase: "Bound", capacityStorage: "8Gi", storageClass: "local", volumeMode: "Filesystem", accessModes: ["ReadWriteOnce"], reclaimPolicy: "Delete", csiDriver: "csi.example", claim: { namespace: "team", name: "data" }, lastPhaseTransitionTime: null, affinity: null },
  storageClass: { name: "local", provisioner: "csi.example", parameters: {}, reclaimPolicy: "Delete", volumeBindingMode: "WaitForFirstConsumer", allowVolumeExpansion: true, mountOptions: [] },
  claimState: "exists", warnings: [],
}
const connection = { key: "key", name: "cluster", status: "available", aliases: [{ name: "cluster" }, { name: "cluster/team", namespace: "team" }] }
test("volume commands prefer PVC, including when opening its PV page", () => {
  const commands = volumeCommands(detail, "10Gi", connection)!
  assert.equal(commands.target, "PVC")
  assert.match(commands.remove!, /^kubectl delete --context cluster\/team pvc data --ignore-not-found$/)
  assert.match(commands.resize!, /--type=merge/)
  const patch=JSON.parse(commands.resize!.split(" -p '")[1].slice(0,-1))
  assert.deepEqual(patch,{spec:{resources:{requests:{storage:"10Gi"}}}})
  assert.doesNotMatch(commands.resize!,/test|uid|resourceVersion/)
  assert.equal(volumeCommands(detail,"10Gi",connection)?.resize,commands.resize)
  assert.equal(volumeCommands(detail, "4Gi", connection)?.resize, undefined)
  assert.equal(volumePath(detail.claim), "/volumes/pvc/team/data")
})
test("PV commands are offered only after PVC absence has been established", () => {
  const gone = { ...detail, claim: null, claimState: "missing" as const }
  assert.equal(volumeCommands(gone, "10Gi", connection)?.remove, "kubectl delete --context cluster pv pv-data --ignore-not-found")
  assert.equal(volumeCommands(gone, "10Gi", connection)?.resize, undefined)
  assert.equal(volumeCommands({ ...gone, claimState: "unknown" }, "10Gi", connection)?.remove, undefined)
  assert.equal(volumePath(null, detail.persistentVolume), "/volumes/pv/pv-data")
})

test("resize shortcuts calculate fixed 20, 50 and 100 percent targets",()=>{
 const targets=[20,50,100].map(p=>expandedStorage("8Gi",p))
 assert.deepEqual(targets,["9831Mi","12Gi","16Gi"])
 for(const target of targets){
  const command=volumeCommands(detail,target!,connection)?.resize
  assert.ok(command)
  assert.equal(volumeCommands(detail,target!,connection)?.resize,command)
 }
})

test("cleanup separates unused PVCs from unclaimed PVs with metadata and selected contexts", () => {
 const claim = {...detail.claim!, createdAt: "2026-11-01T00:00:00Z"}
 const volumes: Volumes = {claims: [claim, {...claim, name: "busy", boundVolume: "pv-busy", usedBy: [{name: "running", uid: "pod"}]}], persistentVolumes: [detail.persistentVolume!, {...detail.persistentVolume!, name: "released", phase: "Released", claim: {namespace: "old", name: "gone"}, createdAt: "2026-10-01T00:00:00Z"}], storageClasses: [detail.storageClass!], degraded: [], prometheusUrl: null}
 const commands = volumeCleanupCommands(volumes, connection)
 assert.match(commands.pvc, /# team\/data \| created 2026-11-01T00:00:00Z \| size 8Gi/)
 assert.match(commands.pvc, /kubectl delete --context cluster\/team pvc data/)
 assert.doesNotMatch(commands.pvc, /busy/)
 assert.match(commands.pv, /# old\/gone \| pv released \| created 2026-10-01T00:00:00Z/)
 assert.match(commands.pv, /kubectl delete --context cluster pv released/)
 assert.doesNotMatch(commands.pv, /pv-data/)
 assert.match(volumeCleanupCommands({...volumes, degraded: [{source: "pods", message: "forbidden"}]}, connection).pvc, /^# No unused PVCs/)
})
