/* ==== TPD Central: server sync (inserted by tpd_central.py; the app file itself is unchanged) ==== */
const PDC={rev:null,ver:null,pendingReload:false,offline:false,from:'',selfOn:false};
var canEmail=false;
async function api(m,p,b){return pdApi(m,p,b)} /* used by the app's built-in server-email path */
const PD_SYNC={officers:1,cc:1,kinds:1,gmkey:1};
const pdRaw=(k,v)=>{try{localStorage.setItem(NS+k,JSON.stringify(v))}catch{}};
async function pdApi(method,path,body,raw){
 const o={method,headers:{'x-pd':'1'},credentials:'same-origin',cache:'no-store'};
 if(body!==undefined){if(raw){o.body=body;o.headers['content-type']='application/pdf'}else{o.body=JSON.stringify(body);o.headers['content-type']='application/json'}}
 const r=await fetch('../api/'+path,o),ct=r.headers.get('content-type')||'';
 const d=ct.includes('json')?await r.json():(r.ok?await r.arrayBuffer():null);
 if(!r.ok)throw Object.assign(new Error((d&&d.error)||('Server error '+r.status)),{status:r.status});
 return d}
function pdNote(t,bad){let b=document.getElementById('pdcNote');
 if(!b){b=document.createElement('div');b.id='pdcNote';b.style.cssText='position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:99999;max-width:92vw;padding:9px 14px;border-radius:10px;font:600 14px system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.25)';b.onclick=()=>b.remove();document.body.appendChild(b)}
 b.style.background=bad?'#c0392b':'#0b1a55';b.style.color='#fff';b.textContent=t;clearTimeout(b._t);b._t=setTimeout(()=>b.remove(),bad?8000:4000)}
function pdOffline(on){if(on===PDC.offline)return;PDC.offline=on;let b=document.getElementById('pdcOff');
 if(on&&!b){b=document.createElement('div');b.id='pdcOff';b.textContent='Offline - using the saved copy';b.style.cssText='position:fixed;top:6px;right:8px;z-index:99998;padding:4px 10px;border-radius:8px;background:#b9770e;color:#fff;font:600 12px system-ui,sans-serif';document.body.appendChild(b)}
 if(!on&&b)b.remove()}

/* local copy of server forms, for offline use */
const pdcDb=()=>new Promise((ok,no)=>{const r=indexedDB.open('pdc_cache_'+APP,1);r.onupgradeneeded=()=>r.result.createObjectStore('forms',{keyPath:'id'});r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});
async function pdcAll(){try{const d=await pdcDb();return await new Promise(r=>{const q=d.transaction('forms').objectStore('forms').getAll();q.onsuccess=()=>r(q.result||[]);q.onerror=()=>r([])})}catch{return[]}}
async function pdcTx(fn){try{const d=await pdcDb();await new Promise(r=>{const t=d.transaction('forms','readwrite');fn(t.objectStore('forms'));t.oncomplete=r;t.onerror=r;t.onabort=r})}catch{}}
const pdcPut=o=>pdcTx(s=>s.put(o)),pdcDel=id=>pdcTx(s=>s.delete(id)),pdcClear=()=>pdcTx(s=>s.clear());

/* settings -> server */
{const _set=ls.set;ls.set=function(k,v){_set.call(ls,k,v);pdPush(k,v)}}
let pdQ={},pdT=null;
function pdPush(k,v){if(!PD_SYNC[k]||!session||PDC.offline)return;pdQ[k]=v;clearTimeout(pdT);pdT=setTimeout(pdFlush,250)}
async function pdFlush(){const q=pdQ;pdQ={};for(const k in q){try{const r=await pdApi('PUT','settings',{app:APP,key:k,value:q[k]});PDC.rev=r.rev}catch(x){pdNote('Not saved to the server: '+x.message,true)}}}

function pdApply(st){
 PDC.rev=st.rev;PDC.ver=st.ver;canEmail=!!st.mailOn;PDC.from=st.mailFrom||'';PDC.selfOn=!!st.selfOn;
 officers=Array.isArray(st.officers)?st.officers:[];cc=st.cc||'';kindOv=st.kinds||{};
 pdRaw('officers',officers);pdRaw('cc',cc);pdRaw('kinds',kindOv);if('gmkey'in st)pdRaw('gmkey',st.gmkey||'');
 const s=st.session;
 if(APP==='officer')session=s?{u:s.u,role:s.role,open:true}:null;
 else if(session&&(!s||s.u!==session.u))session=null;
 users=st.needSetup?[]:(st.users||(session?[{u:session.u,role:session.role}]:[{u:'',role:''}]))}
async function pdUsers(){if(session&&session.role==='admin'){try{users=(await pdApi('GET','users')).users}catch{}}else if(session)users=[{u:session.u,role:session.role}]}

/* forms: server list + local cache */
async function pdForms(list){const cache=await pdcAll(),by=new Map(cache.map(f=>[f.id,f])),out=[];
 for(const f of list){let c=by.get(f.id);by.delete(f.id);
  if(!c||c.ver!==f.ver){try{const b=await pdApi('GET','forms/'+f.id);c={id:f.id,name:f.name,lang:f.lang,ver:f.ver,bytes:b};pdcPut(c)}catch{if(!c)continue}}
  else if(c.name!==f.name||c.lang!==f.lang){c.name=f.name;c.lang=f.lang;pdcPut(c)}
  out.push({name:f.name,bytes:c.bytes.slice(0),lang:f.lang,_id:f.id,_aud:f.audience})}
 for(const id of by.keys())pdcDel(id);return out}
async function dbAll(){let st=null;
 try{st=await pdApi('GET','state?app='+APP)}catch(x){if(x.status===401&&APP==='officer'){location.href='login';return[]}}
 if(st){pdOffline(false);pdApply(st);render();return await pdForms(st.forms||[])}
 pdOffline(true);if(APP==='officer')session={u:'Officer',role:'officer',open:true};
 return(await pdcAll()).map(f=>({name:f.name,bytes:f.bytes,lang:f.lang,_id:f.id}))}
async function dbPut(o){try{const f=forms.find(x=>x.name===o.name&&x._id);let r;
  if(f)r=await pdApi('PUT','forms/'+f._id+'?lang='+encodeURIComponent(o.lang||'en'),o.bytes,true);
  else{r=await pdApi('POST','forms?audience='+(APP==='officer'?'officer':'all')+'&lang='+encodeURIComponent(o.lang||'en')+'&name='+encodeURIComponent(o.name),o.bytes,true);
   for(const g of forms)if(g.name===o.name&&!g.builtin)g._id=r.id;o._id=r.id}
  PDC.rev=r.rev;pdcPut({id:r.id,name:o.name,lang:o.lang,ver:r.ver,bytes:o.bytes.slice(0)})}
 catch(x){pdNote('Form not saved to the server: '+x.message,true)}}
async function dbDel(n){const f=forms.find(x=>x.name===n&&x._id);if(!f)return;
 try{const r=await pdApi('DELETE','forms/'+f._id);PDC.rev=r.rev;pdcDel(f._id)}catch(x){pdNote('Not removed on the server: '+x.message,true)}}

/* accounts -> server */
async function createAdmin(){const u=$('#au').value.trim(),p=$('#ap').value;
 if(!u)return say('Enter a username.');if(p.length<10)return say('Password must be at least 10 characters.');if(p!==$('#ap2').value)return say('Passwords do not match.');
 try{const r=await pdApi('POST','setup',{u,p});session=r.session;users=[{u,role:'admin'}];touch();go('admin')}catch(x){say(x.message)}}
async function doLogin(){const u=$('#lu').value.trim(),p=$('#lp').value;lastU=u;
 try{const r=await pdApi('POST','login',{u,p});
  if(r.session.role==='officer'){pdApi('POST','logout').catch(()=>{});return say('That is an officer account. It can sign in to the officer app, not Staff setup.')}
  session=r.session;await pdUsers();touch();go('admin')}catch(x){say(x.message)}}
function logout(){if(APP==='officer')return go('home');if(session)pdApi('POST','logout').catch(()=>{});session=null;editOff=-1;clearTimeout(idleT);go('home')}
async function pdOfficerLogout(){if(!confirm('Sign out of the officer app on this device?'))return;
 try{await pdApi('POST','logout')}catch{}
 try{for(const k of await caches.keys())if(k.startsWith('pd-central-officer'))await caches.delete(k)}catch{}
 await pdcClear();location.href='login'}
async function resetPw(){const u=$('#ru').value,p=$('#rp').value;if(!session)return;if(p.length<10)return say('Password must be at least 10 characters.');
 try{await pdApi('POST','password',{u,p});$('#rp').value='';say('Password updated.')}catch(x){say(x.message)}}
async function addUser(){if(!session||session.role!=='admin')return;const u=$('#nu').value.trim(),p=$('#np').value,role=$('#nr').value;
 if(!u)return say('Enter a username.');if(p.length<10)return say('Password must be at least 10 characters.');
 try{await pdApi('POST','users',{u,p,role});await pdUsers();render();say('Account added.')}catch(x){say(x.message)}}
async function delUser(i){const x=users[i];if(!session||session.role!=='admin'||!x||x.u===session.u)return;if(!confirm('Remove '+x.u+'?'))return;
 try{await pdApi('DELETE','users/'+encodeURIComponent(x.u));await pdUsers();render()}catch(e2){say(e2.message)}}

/* admin: email sending settings */
function pdMailCard(){if(!session||session.role!=='admin'||PDC.offline)return'';setTimeout(pdMailLoad,0);
 return`<div class="card" id="pdMail"><h3 style="margin-top:0">Email sending</h3>
 <p class="mut">When this is on, <b>Email officer</b> sends the signed PDF straight from the server: the selected officer(s) go in the To line, the CC above is copied, and it always comes from the sender address below. Visitors never see or type any address.</p>
 <label class="chk"><input type="checkbox" id="mOn"> Send email from the server</label>
 <label>Sender address (From)</label><input type="email" id="mFrom" placeholder="receptionist@tisburyma.gov" autocomplete="off">
 <label>Sender name</label><input type="text" id="mName" placeholder="Tisbury PD Receptionist" autocomplete="off">
 <label>Mail server (SMTP)</label><input type="text" id="mHost" placeholder="smtp.office365.com" autocapitalize="off" autocomplete="off">
 <div class="row"><div style="flex:1"><label>Port</label><input type="number" id="mPort" value="587"></div><div style="flex:1"><label>Security</label><select id="mSec"><option value="starttls">STARTTLS (587)</option><option value="ssl">SSL/TLS (465)</option><option value="none">None (25, internal relay)</option></select></div></div>
 <label>Sign-in username <span class="mut">(blank if the server needs none)</span></label><input type="text" id="mUser" autocapitalize="off" autocomplete="off">
 <label>Sign-in password</label><input type="password" id="mPass" autocomplete="new-password" placeholder="">
 <h4 style="margin:18px 0 4px">GitHub apps (optional)</h4>
 <p class="mut">Lets the standalone apps on GitHub Pages send through this server. The server must be reachable over HTTPS from where those apps run.</p>
 <label>Key for the GitHub apps (16+ characters; enter the same key in each app)</label><input type="text" id="mRk" autocomplete="off" autocapitalize="off">
 <label>Allowed app websites</label><input type="text" id="mRo" placeholder="https://yourname.github.io" autocomplete="off" autocapitalize="off">
 <label>Extra allowed officer addresses <span class="mut">(officers above are always allowed; e.g. @tisburyma.gov)</span></label><input type="text" id="mRa" autocomplete="off" autocapitalize="off">
 <div class="row"><button class="sm" onclick="pdMailSave()">Save</button><button class="alt sm" onclick="pdMailTest()">Send test email</button></div><p id="mMsg" class="mut"></p></div>`}
async function pdMailLoad(){const c=document.getElementById('pdMail');if(!c||c._ld)return;c._ld=1;
 try{const m=await pdApi('GET','mail');$('#mOn').checked=!!m.on;$('#mFrom').value=m.from||'';$('#mName').value=m.name||'';$('#mHost').value=m.host||'';$('#mPort').value=m.port||587;$('#mSec').value=m.sec||'starttls';$('#mUser').value=m.user||'';$('#mRk').value=m.relayKey||'';$('#mRo').value=m.relayOrigins||'';$('#mRa').value=m.relayAllow||'';$('#mPass').placeholder=m.passSet?'(saved - leave blank to keep)':''}catch(x){$('#mMsg').textContent=x.message}}
const pdMailVals=()=>({on:$('#mOn').checked,from:$('#mFrom').value.trim(),name:$('#mName').value.trim(),host:$('#mHost').value.trim(),port:+$('#mPort').value||587,sec:$('#mSec').value,user:$('#mUser').value.trim(),pass:$('#mPass').value,relayKey:$('#mRk').value.trim(),relayOrigins:$('#mRo').value.trim(),relayAllow:$('#mRa').value.trim()});
async function pdMailSave(){const g=$('#mMsg');g.textContent='Saving...';try{const r=await pdApi('PUT','mail',pdMailVals());$('#mPass').value='';if(r.passSet)$('#mPass').placeholder='(saved - leave blank to keep)';canEmail=!!r.mailOn;PDC.from=r.from||'';PDC.selfOn=!!r.selfOn;g.textContent=r.mailOn?'Saved. Email officer now sends from '+r.from+'.':'Saved. Server email is off; Email officer uses the device mail app.'}catch(x){g.textContent=x.message}}
async function pdMailTest(){const g=$('#mMsg'),to=prompt('Send a test email to:',$('#mFrom').value.trim());if(!to)return;g.textContent='Sending...';
 try{await pdApi('PUT','mail',pdMailVals());$('#mPass').value='';await pdApi('POST','mail/test',{to});g.textContent='Test email sent to '+to+'. Check that inbox (and junk).'}catch(x){g.textContent='Test failed: '+x.message}}

/* Done screen: Print also emails the assisting officer(s) */
function pdDoneBtns(touch){const pr=touch?'🖨️ Print / Share':'🖨️ Print';
 if(!(canEmail&&!PDC.offline))return`<button class="big" onclick="printIt()">${pr}</button><button class="big" onclick="emailIt()">✉️ Email officer</button>`;
 const has=result&&result.sel&&result.sel.some(o=>o.email);
 return`<button class="big" onclick="pdPrint()">${has?pdT2('🖨️ Print / Sent to officer','🖨️ Imprimir / Enviado ao policial'):pr}</button><p id="pdPs" style="flex-basis:100%;margin:4px 0 0;min-height:1.2em;font-weight:600"></p>`}
function pdPrint(){const cs=selCopies();if(!cs.length)return needCopy();
 printIt(); /* print first: the share sheet / print dialog must open straight from the tap */
 const g=$('#pdPs'),offs=(result.sel||[]).filter(o=>o.email);if(!offs.length)return;
 const key=cs.map(c=>c.key).join(',');if(result._sentKey===key){if(g){g.style.color='#0a8f4a';g.textContent=pdT2('✓ Already sent to ','✓ Já enviado para ')+offs.map(o=>o.name).join(', ')}return}
 if(g){g.style.color='';g.textContent=pdT2('Sending to the officer...','Enviando ao policial...')}
 const both=cs.length>1,subject='Completed form: '+dispName()+' ('+result.dt+')'+(cs.some(c=>c.key==='en')?' - English copy':''),
  text='Completed form "'+dispName()+'" dated '+result.dt+'.'+(both?' Attached: the Portuguese original and the English copy.':' The PDF is attached.');
 pdApi('POST','email',{to:offs.map(o=>o.id),subject,text,pdfs:cs.map(c=>({filename:cName(c),pdf:toB64(c.bytes)}))})
  .then(()=>{result._sentKey=key;const h=$('#pdPs');if(h){h.style.color='#0a8f4a';h.textContent=pdT2('✓ Sent to ','✓ Enviado para ')+offs.map(o=>o.name).join(', ')}})
  .catch(x=>{const h=$('#pdPs');if(h){h.style.color='#c0392b';h.textContent=pdT2('Printed, but the email to the officer failed: ','Impresso, mas o e-mail ao policial falhou: ')+x.message+pdT2('. Please tell the front desk.','. Avise a recepção.')}})}

/* visitor: email me a copy (Done screen) */
const pdT2=(en,pt)=>LANG==='pt'?pt:en;
function pdSelfBtn(){if(!(canEmail&&!PDC.offline))return'';
 return`<div id="pdSelf" style="flex-basis:100%;width:100%;box-sizing:border-box;margin-top:12px;padding:14px;border:1px solid var(--bd);border-radius:12px;text-align:left">
  <label for="pdSe" style="font-weight:600">${pdT2('Want a copy? Enter your email (optional)','Quer uma cópia? Digite seu e-mail (opcional)')}</label>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px"><input type="email" id="pdSe" inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="200" placeholder="name@example.com" style="flex:1;min-width:200px;margin:0" onkeydown="if(event.key==='Enter')pdSelfMail()">
  <button id="pdSo" onclick="pdSelfMail()">${pdT2('📧 Send me a copy','📧 Enviar para mim')}</button></div>
  <p class="mut" style="font-size:13px;margin:6px 0 0">${pdT2('Automatic message: replies are not received.','Mensagem automática: respostas não são recebidas.')}</p>
  <p id="pdSm" style="min-height:1.2em;margin:4px 0 0;font-weight:600"></p></div>`}
async function pdSelfMail(){const cs=selCopies();if(!cs.length)return needCopy();
 const inp=$('#pdSe'),msg=$('#pdSm'),b=$('#pdSo');if(!inp)return;const em=inp.value.trim();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)){msg.style.color='#c0392b';msg.textContent=pdT2('Enter a valid email address.','Digite um endereço de e-mail válido.');inp.focus();return}
 b.disabled=true;msg.style.color='';msg.textContent=pdT2('Sending...','Enviando...');
 try{await pdApi('POST','email',{self:em,app:APP,lang:LANG,name:dispName(),pdfs:selCopies().map(c=>({filename:cName(c),pdf:toB64(c.bytes)}))});
  msg.style.color='#0a8f4a';msg.textContent=pdT2('Sent to ','Enviado para ')+em+pdT2('. Check your inbox (and junk folder).','. Verifique sua caixa de entrada (e a pasta de spam).');inp.value='';b.disabled=false}
 catch(x){b.disabled=false;msg.style.color='#c0392b';msg.textContent=pdT2('Could not send: ','Não foi possível enviar: ')+x.message}}

/* central updates: new app version or new shared data */
async function pdRefresh(){const r=await dbAll(),bn=new Set(BUILTIN.map(x=>x.name));forms=[...builtinForms(),...r.filter(x=>!bn.has(x.name))];render()}
setInterval(async()=>{if(document.hidden)return;const home=view==='home';
 try{const v=await pdApi('GET','version?app='+APP);pdOffline(false);
  if(PDC.ver&&v.ver!==PDC.ver){PDC.pendingReload=true}
  if(PDC.pendingReload&&home){location.reload();return}
  if(PDC.rev!==null&&v.rev!==PDC.rev&&home)await pdRefresh()}
 catch(x){if(x.status===401&&APP==='officer'){if(home)location.href='login';else pdNote('Your sign-in expired. Finish this form, then sign in again.',true)}else if(!x.status)pdOffline(true)}},45000);
/* ==== end TPD Central ==== */
