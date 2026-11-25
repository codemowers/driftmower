type Hosting = {mcpUrl?:string;discoveryEnabled?:boolean;configUpdates?:boolean;browserProfilesEnabled?:boolean}
type AttemptStore = Pick<Storage,"getItem"|"setItem">

export const automaticLoginKey=(endpoint:string)=>`driftmower.auto-login:${endpoint}`

// Claim one redirect attempt per hosted endpoint in this browser window.
// A failed/cancelled login leaves Connect available without a redirect loop.
export function automaticLoginEndpoint(config:Hosting,pathname:string,storage:AttemptStore):string|undefined {
  if(!config.mcpUrl||config.discoveryEnabled||config.configUpdates||config.browserProfilesEnabled||["/settings","/callback"].includes(pathname.replace(/\/$/,"")))return
  const key=automaticLoginKey(config.mcpUrl)
  if(storage.getItem(key))return
  storage.setItem(key,"1")
  return config.mcpUrl
}
