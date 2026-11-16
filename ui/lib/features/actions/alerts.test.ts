import {strict as assert} from "node:assert"
import {alertActions,alertHref,type FiringAlert} from "./alerts.ts"

const alert=(overrides:Partial<FiringAlert>):FiringAlert=>({alertname:"test",severity:"warning",namespace:"team",startsAt:"2026-01-01T00:00:00Z",labels:{},fingerprint:"id",silencedBy:[],inhibitedBy:[],...overrides})
const groups=alertActions([
 alert({labels:{serviceaccount:"worker"},severity:"warning"}),
 alert({labels:{serviceaccount:"worker"},severity:"critical"}),
 alert({labels:{pod:"other"},severity:"info"}),
 alert({namespace:"secret",severity:"critical"}),
 alert({severity:"critical",silencedBy:["silence"]}),
 alert({severity:"critical",inhibitedBy:["parent"]}),
],["team"])
assert.equal(groups.length,2)
assert.equal(groups[0].alerts.length,2)
assert.equal(groups[0].alerts[0].severity,"critical")
assert.equal(groups[1].alerts[0].severity,"info")
assert.equal(alertHref(alert({labels:{serviceaccount:"worker"}})),"/service-accounts/team/worker")
assert.equal(alertActions([alert({})],[]).length,0)
