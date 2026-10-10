import {probeJamulus} from '../server/jamulus-probe.mjs';
const result=await probeJamulus({host:process.env.JAMULUS_HOST||'127.0.0.1',port:Number(process.env.JAMULUS_PORT||22124)});
console.log(JSON.stringify(result,null,2));
if(!result.reachable)process.exitCode=1;
