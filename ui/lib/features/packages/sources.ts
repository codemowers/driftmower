import { packageIdentity } from "./types.ts"

export type PackageSource = {url:string;label:string;kind:"repository"|"registry";basis:"package identity"|"inferred"}
// These are hints, not provenance. No browser registry fetches or npm-scope ->
// GitHub-owner guesses: package scopes and hosting accounts are independent.
const known:Record<string,string>={
 "pkg:npm/react":"https://github.com/react/react",
 "pkg:npm/react-dom":"https://github.com/react/react",
 "pkg:npm/next":"https://github.com/vercel/next.js",
 "pkg:npm/express":"https://github.com/expressjs/express",
 "pkg:pypi/flask":"https://github.com/pallets/flask",
 "pkg:golang/stdlib":"https://github.com/golang/go",
}
export function packageSources(purl:string):PackageSource[]{
 const identity=packageIdentity(purl),match=/^pkg:([a-z0-9]+)\/(.+)$/.exec(identity)
 if(!match)return []
 let name:string
 try{name=decodeURIComponent(match[2])}catch{return []}
 if(name.split("/").some(p=>!p||p==="."||p==="..")||/[\\\s?#\x00-\x1f]/.test(name))return []
 const type=match[1],parts=name.split("/"),encoded=parts.map(encodeURIComponent).join("/")
 const out:PackageSource[]=[]
 const repo=(url:string,basis:PackageSource["basis"]="inferred")=>out.push({url,label:"Source repository",kind:"repository",basis})
 if(known[identity])repo(known[identity])
 else if(["github","gitlab","bitbucket"].includes(type)&&parts.length>=2&&(type!=="github"||parts.length===2))repo(`https://${type==="bitbucket"?"bitbucket.org":type+".com"}/${encoded}`,"package identity")
 else if(type==="golang"){
  const [host,owner,repository]=parts
  if(["github.com","codeberg.org","bitbucket.org"].includes(host)&&owner&&repository)repo(`https://${host}/${encodeURIComponent(owner)}/${encodeURIComponent(repository.replace(/\.git$/,""))}`)
  // GitLab can contain subgroups; never assume its first two segments are a repo.
  if(!out.length)out.push({url:`https://pkg.go.dev/${encoded}`,label:"Go module documentation",kind:"registry",basis:"package identity"})
 }
 if(type==="npm"&&(parts.length===1||(parts.length===2&&parts[0].startsWith("@"))))out.push({url:`https://www.npmjs.com/package/${encoded}`,label:"npm package",kind:"registry",basis:"package identity"})
 if(type==="pypi"&&parts.length===1)out.push({url:`https://pypi.org/project/${encoded}/`,label:"PyPI package",kind:"registry",basis:"package identity"})
 if(type==="nuget"&&parts.length===1)out.push({url:`https://www.nuget.org/packages/${encoded}`,label:"NuGet package",kind:"registry",basis:"package identity"})
 return out
}
export function imageFilePath(path:string){return path.startsWith("/")?path:`/${path}`}
