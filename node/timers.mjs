// Node timers accept a signed 32-bit delay. Chain longer requested durations
// rather than letting Node clamp them to 1ms. A zero duration disables the timer.
export function armTimeout(callback,milliseconds){if(!(milliseconds>0))return ()=>{};const started=Date.now();let timer,cancelled=false;const step=()=>{if(cancelled)return;const remaining=milliseconds-(Date.now()-started);if(remaining<=0){callback();return;}timer=setTimeout(step,Math.min(remaining,2147483647));};step();return ()=>{cancelled=true;clearTimeout(timer);};}
