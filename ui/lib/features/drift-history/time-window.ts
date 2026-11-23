export const SUMMARY_WINDOWS = [
 {label:"3 months",hours:2160},
 {label:"Month",hours:720},
 {label:"2 weeks",hours:336},
 {label:"Week",hours:168},
 {label:"3 days",hours:72},
 {label:"48h",hours:48},
 {label:"24h",hours:24},
 {label:"1h",hours:1},
] as const

export function summaryWindowLabel(hours:number){
 return SUMMARY_WINDOWS.find(window=>window.hours===hours)?.label??`${hours}h`
}

export function summaryAxisTime(time:number,hours:number){
 return new Date(time).toLocaleString(undefined,hours<=48?{hour:"2-digit",minute:"2-digit"}:{month:"short",day:"numeric"})
}
