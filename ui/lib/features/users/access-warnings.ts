import type {UserAccess} from "./types"

export function accessWarningReasons(access:Pick<UserAccess,"warnings"|"examined"|"incomplete">):string[]{
 const scopes=new Set(["Cluster-wide review",...access.examined,...access.incomplete].filter(Boolean))
 return [...new Set(access.warnings.map(warning=>{
  const split=warning.indexOf(": ")
  return split>=0&&scopes.has(warning.slice(0,split))?warning.slice(split+2):warning
 }))]
}
