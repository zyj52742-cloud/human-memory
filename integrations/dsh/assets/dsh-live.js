(function(){
 'use strict';if(!window.__MEMORY_DSH__)return;
 let signature=window.__MEMORY_NETWORK__?.runtimeSignature||null,busy=false,disposed=false;const controller=new AbortController();
 async function poll(){
   if(disposed||document.hidden||busy||window.__MEMORY_EDITING__)return;busy=true;
   try{const r=await fetch('/dsh-memory/status',{signal:controller.signal});if(!r.ok||disposed)return;const s=await r.json();if(disposed)return;
     if(window.__MEMORY_EDITING__)return;
     if(signature===null)signature=s.signature;
     else if(s.signature!==signature){const url=new URL(location.href);const id=window.__ATLAS__?.state.selected;if(id)url.searchParams.set('select',id);window.__MEMORY_FRAME__?.dispose();location.replace(url.href);}
   }catch(e){if(e.name!=='AbortError'){} }finally{busy=false;}
 }
 const timer=setInterval(poll,10000);
 function dispose(){if(disposed)return;disposed=true;clearInterval(timer);controller.abort();removeEventListener('pagehide',dispose);}
 window.__MEMORY_LIVE__={dispose};addEventListener('pagehide',dispose,{once:true});poll();
})();
