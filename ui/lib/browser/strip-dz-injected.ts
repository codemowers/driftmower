/**
 * Inlined in the root layout & runs before the Next.js client bundle.
 * Some extensions insert nodes with `id^="dz-"` / `dz-container`, which then
 * corrupt the React tree and cause hydration to fail. Removing them as early
 * as possible (plus observing for re-injections) fixes that.
 */
export const STRIP_DZ_INJECTED = `(function(){
function strip(root){try{root.querySelectorAll('[id^="dz-"],[class~="dz-container"]').forEach(function(el){el.parentNode&&el.parentNode.removeChild(el)})}catch(e){}}
strip(document);
var o=new MutationObserver(function(){strip(document)});
if(document.documentElement){o.observe(document.documentElement,{childList:true,subtree:true})}
})();`
