import {strict as assert} from "node:assert"
import {signalPoints,currentSignal,type SignalHistory} from "./signals.ts"

const history:SignalHistory={signal:"cves",query:"",start:0,end:120,stepSeconds:60,warnings:[],series:[{name:"critical",values:[[0,2],[120,0]]}]}
assert.deepEqual(signalPoints(history,["critical"]),[{t:0,critical:2},{t:60000,critical:null},{t:120000,critical:0}])
assert.equal(currentSignal(history,"critical"),0)
assert.equal(currentSignal({...history,end:180},"critical"),null)
assert.equal(currentSignal(undefined,"critical"),null)
