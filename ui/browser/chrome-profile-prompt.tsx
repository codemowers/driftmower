"use client"

import {useEffect,useRef} from "react"
import {create} from "zustand"

type Profile={directory:string;name:string}
type Choice={name:string;profiles:Profile[];resolve:(directory:string|null)=>void}
const useChoice=create<{choice:Choice|null}>(()=>({choice:null}))

export function chooseChromeProfile(name:string,profiles:Profile[]):Promise<string|null>{
 return new Promise(resolve=>useChoice.setState({choice:{name,profiles,resolve}}))
}

export function ChromeProfilePrompt(){
 const choice=useChoice(s=>s.choice)
 const dialog=useRef<HTMLDialogElement>(null)
 useEffect(()=>{
  if(choice)dialog.current?.showModal()
 },[choice])
 if(!choice)return null
 function finish(value:string|null){choice!.resolve(value);useChoice.setState({choice:null})}
 return <dialog ref={dialog} aria-labelledby="chrome-profile-title" className="m-auto w-full max-w-md rounded-lg border bg-background p-6 text-foreground shadow-lg backdrop:bg-black/40" onCancel={event=>{event.preventDefault();finish(null)}}>
  <div className="space-y-4">
   <h2 id="chrome-profile-title" className="text-lg font-semibold">Choose Chrome profile</h2>
   <p className="break-all text-sm">Which Chrome profile should open {choice.name}?</p>
   <div className="grid gap-2">{choice.profiles.map(profile=><button key={profile.directory} type="button" aria-label={`Use Chrome profile ${profile.name}`} className="rounded border px-3 py-2 text-left hover:bg-muted" onClick={()=>finish(profile.directory)}><span className="font-medium">{profile.name}</span><span className="ml-2 text-sm text-muted-foreground">{profile.directory}</span></button>)}</div>
   <p className="text-sm text-muted-foreground">Remembered for this connection. Clear the association in Settings to choose again.</p>
   <div className="flex justify-end"><button type="button" className="rounded border px-3 py-2" onClick={()=>finish(null)}>Cancel</button></div>
  </div>
 </dialog>
}
