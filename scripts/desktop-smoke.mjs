import assert from 'node:assert/strict';
const base='http://127.0.0.1:3188',html=await(await fetch(base+'/')).text(),config=JSON.parse(html.match(/window.psalmonyDesktop=(.*?);<\/script>/)[1]);
assert.equal((await fetch(base+'/desktop/audio')).status,403);
assert.equal((await fetch(base+'/desktop/disconnect',{method:'POST'})).status,403);
assert.equal((await fetch(base+'/desktop/audio',{headers:{'X-Psalmony-Desktop':config.token,Origin:'https://example.com'}})).status,403);
assert.equal((await fetch(base+'/api/auth/logout',{method:'POST',headers:{'X-Psalmony-Desktop':config.token,Origin:'https://example.com','Content-Type':'application/json'},body:'{}'})).status,403);
if(process.argv[2]){const offline=process.argv[2]==='offline';const r=await fetch(base+'/desktop/network',{method:'POST',headers:{'X-Psalmony-Desktop':config.token,'Content-Type':'application/json'},body:JSON.stringify({offline})});assert.equal(r.status,200);assert.equal((await r.json()).offline,offline);if(offline)assert.equal((await fetch(base+'/api/health')).status,503);console.log('Local host/origin/token boundaries passed; offline mode:',offline);}else console.log('Local host/origin/token boundaries passed');
