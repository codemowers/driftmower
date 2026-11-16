// Limit simultaneous browser history reads to three.
// Queue pending work without retaining completed responses.
let active=0
const waiting:(()=>void)[]=[]
export async function historyRequest<T>(request:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
 if(active<3&&!waiting.length)active++
 else await new Promise<void>(resolve=>waiting.push(resolve))
 try{
  if(signal?.aborted)throw new DOMException("Aborted","AbortError")
  return await request()
 }finally{
  const next=waiting.shift()
  if(next)next()
  else active--
 }
}
