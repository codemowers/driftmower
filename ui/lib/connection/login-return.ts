const DEFAULT_PAGE = "/executive-summary"

// OIDC state is window-scoped by the existing sessionStorage state store.
// Only a local application path may be restored after its callback succeeds.
export function loginDestination(value:unknown,origin:string):string {
  if(typeof value!=="string"||!value.startsWith("/")||value.startsWith("//")||/[\\\r\n]/.test(value))return DEFAULT_PAGE
  let url:URL
  try {url=new URL(value,origin)} catch {return DEFAULT_PAGE}
  if(url.origin!==origin||["/","/callback","/settings"].includes(url.pathname.replace(/\/$/,"")||"/"))return DEFAULT_PAGE
  return url.pathname+url.search+url.hash
}

export function loginCallbackDestination(state:unknown,origin:string):string {
  return loginDestination(state&&typeof state==="object"&&"returnTo" in state?state.returnTo:undefined,origin)
}
