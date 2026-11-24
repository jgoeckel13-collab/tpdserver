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
 PDC.rev=st.rev;PDC.ver=st.ver;canEmail=!!st.mailOn;PDC.keep=st.keep||null;PDC.from=st.mailFrom||'';PDC.selfOn=!!st.selfOn;
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
const PD_SIGNED='pdc_signed_until',pdSigned=v=>{try{v?localStorage.setItem(PD_SIGNED,String(v)):localStorage.removeItem(PD_SIGNED)}catch{}};
const pdSignedOk=()=>{try{return +localStorage.getItem(PD_SIGNED)>Date.now()}catch{return false}};
/* officer data on this device: saved forms, recent forms and drafts */
async function pdWipeLocal(){try{for(const k of await caches.keys())if(k.startsWith('pd-central-officer'))await caches.delete(k)}catch{}
 await pdcClear();try{indexedDB.deleteDatabase('pd_recent_'+APP)}catch{}try{localStorage.removeItem(NS+'draft')}catch{}recent=[];pdSigned(0)}
if(APP==='officer'){const _r=render;render=function(){if(PDC.locked){$('#app').innerHTML='<div class="card" style="text-align:center"><h3 style="margin-top:0">Sign-in needed</h3><p>The server can\'t be reached and this device\'s sign-in has expired, so the officer app is locked.</p><p class="mut">Connect to the department network, then sign in again.</p><button onclick="location.href=\'login\'">Try again</button></div>';return}return _r.apply(this,arguments)}}
async function dbAll(){let st=null;
 try{st=await pdApi('GET','state?app='+APP)}catch(x){if(x.status===401&&APP==='officer'){pdSigned(0);location.href='login';return[]}}
 if(st){pdOffline(false);PDC.locked=false;if(APP==='officer'&&st.session)pdSigned(Date.now()+12*3600e3);pdApply(st);render();return await pdForms(st.forms||[])}
 pdOffline(true);if(APP==='officer'){if(!pdSignedOk()){PDC.locked=true;session=null;render();return[]}session={u:'Officer',role:'officer',open:true}}
 return(await pdcAll()).map(f=>({name:f.name,bytes:f.bytes,lang:f.lang,_id:f.id}))}
async function dbPut(o){try{const f=forms.find(x=>x.name===o.name&&x._id);let r;
  if(f)r=await pdApi('PUT','forms/'+f._id+'?lang='+encodeURIComponent(o.lang||'en'),o.bytes,true);
  else{r=await pdApi('POST','forms?audience='+(o.aud||(APP==='officer'?'officer':'all'))+'&lang='+encodeURIComponent(o.lang||'en')+'&name='+encodeURIComponent(o.name),o.bytes,true);
   for(const g of forms)if(g.name===o.name&&!g.builtin)g._id=r.id;o._id=r.id;o._aud=o.aud||(APP==='officer'?'officer':'all')}
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
async function pdOfficerLogout(){if(!confirm('Sign out of the officer app on this device? Recent forms and any unfinished form on this device are deleted.'))return;
 try{await pdApi('POST','logout')}catch{}
 await pdWipeLocal();location.href='login'}
async function resetPw(){const u=$('#ru').value,p=$('#rp').value,old=($('#rpo')||{}).value||'';if(!session)return;if(!old)return say('Enter your current password.');if(p.length<10)return say('Password must be at least 10 characters.');
 try{await pdApi('POST','password',{u,p,old});$('#rp').value='';$('#rpo').value='';say('Password updated.')}catch(x){say(x.message)}}
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
 <label class="chk"><input type="checkbox" id="mSelf"> Let visitors email themselves a copy (kiosk)</label>
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
 try{const m=await pdApi('GET','mail');$('#mOn').checked=!!m.on;$('#mSelf').checked=m.selfOn!==false;$('#mFrom').value=m.from||'';$('#mName').value=m.name||'';$('#mHost').value=m.host||'';$('#mPort').value=m.port||587;$('#mSec').value=m.sec||'starttls';$('#mUser').value=m.user||'';$('#mRk').value=m.relayKey||'';$('#mRo').value=m.relayOrigins||'';$('#mRa').value=m.relayAllow||'';$('#mPass').placeholder=m.passSet?'(saved - leave blank to keep)':''}catch(x){$('#mMsg').textContent=x.message}}
const pdMailVals=()=>({on:$('#mOn').checked,selfOn:$('#mSelf').checked,from:$('#mFrom').value.trim(),name:$('#mName').value.trim(),host:$('#mHost').value.trim(),port:+$('#mPort').value||587,sec:$('#mSec').value,user:$('#mUser').value.trim(),pass:$('#mPass').value,relayKey:$('#mRk').value.trim(),relayOrigins:$('#mRo').value.trim(),relayAllow:$('#mRa').value.trim()});
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
 catch(x){if(x.status===401&&APP==='officer'){pdSigned(0);if(home)location.href='login';else pdNote('Your sign-in expired. Finish this form, then sign in again.',true)}else if(!x.status)pdOffline(true)}},45000);
/* ==== end TPD Central ==== */

/* ==== Saved forms: a copy of each completed form kept on the server for the period an admin picks ==== */
const pdSleep=ms=>new Promise(r=>setTimeout(r,ms));
const pdFn=(r,en)=>String(r.name||'form').replace(/[^\p{L}\p{N}\- ]+/gu,'_').trim()+(en?'_English_copy_':'_')+(r.dt||'')+'.pdf';
async function pdKeepSave(r){
 if(!r||r._kept||!PDC.keep||!PDC.keep.on)return;r._kept=1;
 if(PDC.offline){if(APP==='officer')pdNote('Offline: this form was not saved on the server.',true);return}
 await pdSleep(800);for(let i=0;i<120&&r.en&&r.en.state==='working';i++)await pdSleep(1000); /* wait for the English copy */
 if(!r._aid)r._aid=r.rid||('k'+Date.now().toString(36)+Math.random().toString(36).slice(2,8));
 const cs=(r.copies||[]).filter(c=>c&&c.bytes);if(!cs.length)return;
 try{await pdApi('POST','saved?app='+APP,{cid:r._aid,name:r.name,lang:r.lang,dt:r.dt,tm:r.tm,pn:r.pn||'',
   officers:(r.sel||[]).map(o=>o.name),pdfs:cs.slice(0,3).map(c=>({filename:pdFn(r,c.key==='en'),pdf:toB64(new Uint8Array(c.bytes))}))})}
 catch(x){r._kept=0;if(APP==='officer')pdNote('Not saved on the server: '+x.message,true);else console.warn('save failed',x)}}
{const _go=go;go=function(v){const r=result;const o=_go.apply(this,arguments);if(v==='done'&&r)pdKeepSave(r);return o}}

const PD_DAYS={7:'1 week',14:'2 weeks',30:'30 days',60:'60 days',90:'90 days',180:'6 months',365:'1 year',730:'2 years',1095:'3 years',0:'Until an admin deletes them'};
const pdDate=ms=>new Date(ms).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
const pdSize=b=>b>1048576?(b/1048576).toFixed(1)+' MB':Math.ceil(b/1024)+' KB';
function pdKeepCard(){if(!session||session.role!=='admin'||PDC.offline)return'';setTimeout(pdKeepLoad,0);
 return`<div class="card" id="pdKeep"><h3 style="margin-top:0">🗄️ Saved forms</h3>
 <p class="mut">Keeps a copy of each completed form on this server so it can be opened, printed or emailed again later. Copies are deleted automatically when the time below runs out. The official copy should still go into the records system.</p>
 <label class="chk"><input type="checkbox" id="kOn"> Save completed forms on the server</label>
 <label>Keep saved forms for</label><select id="kDays"></select>
 <label class="chk"><input type="checkbox" id="kKiosk"> Save forms from the lobby kiosk</label>
 <label class="chk"><input type="checkbox" id="kOff"> Save forms from the officer app</label>
 <label>Who can see saved forms</label><select id="kSee"><option value="all">Everyone who signs in</option><option value="own">Officers see only forms they completed (staff and admins see all)</option></select>
 <p class="mut" id="kStat"></p>
 <div class="row"><button onclick="pdKeepSet()">Save settings</button><button class="alt" onclick="go('saved')">Open saved forms</button></div><p id="kMsg" class="mut"></p></div>`}
function pdKeepShow(k){$('#kOn').checked=!!k.on;$('#kKiosk').checked=!!k.kiosk;$('#kOff').checked=!!k.officer;$('#kSee').value=k.see==='own'?'own':'all';
 $('#kDays').innerHTML=(k.options||[7,14,30,60,90,180,365,730,1095,0]).map(d=>`<option value="${d}"${d===k.days?' selected':''}>${PD_DAYS[d]||d+' days'}</option>`).join('');
 $('#kStat').textContent=k.count+' form'+(k.count===1?'':'s')+' saved now ('+pdSize(k.bytes||0)+').';$('#pdKeep')._k=k}
async function pdKeepLoad(){const c=document.getElementById('pdKeep');if(!c||c._ld)return;c._ld=1;try{pdKeepShow(await pdApi('GET','keep'))}catch(x){$('#kMsg').textContent='Could not load: '+x.message}}
async function pdKeepSet(){const old=($('#pdKeep')._k)||{},days=+$('#kDays').value,g=$('#kMsg');
 if(old.count&&days&&(!old.days||days<old.days)&&!confirm('Saved forms older than '+PD_DAYS[days]+' will be deleted now. Continue?'))return;
 g.textContent='Saving...';
 try{const r=await pdApi('PUT','keep',{on:$('#kOn').checked,days,kiosk:$('#kKiosk').checked,officer:$('#kOff').checked,see:$('#kSee').value});
  pdKeepShow({...old,...r});PDC.keep={on:!!(r.on&&r[APP]),days:r.days,any:!!(r.on||r.count)};g.textContent='Saved.'}catch(x){g.textContent=x.message}}

/* Saved forms screen */
let pdSv=null;
function pdSavedHome(){if(view!=='home'||APP!=='officer'||PDC.offline||!PDC.keep||!PDC.keep.any)return;const a=$('#app');if(!a||a.querySelector('#pdSvBtn'))return;
 a.insertAdjacentHTML('beforeend',`<div class="card" id="pdSvBtn" style="margin-top:16px;text-align:center"><button class="big" onclick="go('saved')">🗄️ Saved forms</button>
 <p class="mut" style="margin:6px 0 0">${PDC.keep.days?'Completed forms are kept on the server for '+PD_DAYS[PDC.keep.days]+'.':'Completed forms are kept on the server.'}</p></div>`)}
function pdSavedRender(){const back=APP==='officer'?'home':'admin';
 $('#app').innerHTML=`<div class="card"><div class="row" style="justify-content:space-between;align-items:center"><h3 style="margin:0">🗄️ Saved forms</h3><button class="alt sm" onclick="go('${back}')">‹ Back</button></div>
 <p class="mut" id="svInfo">Loading...</p><input id="svQ" placeholder="Search by form, name, officer or date" oninput="pdSavedList()" autocomplete="off"><div id="svList"></div></div>`;pdSavedLoad()}
async function pdSavedLoad(){try{pdSv=await pdApi('GET','saved?app='+APP);pdSavedList()}catch(x){if(x.status===401&&APP==='officer')return location.href='login';$('#svInfo').textContent=x.message}}
function pdSavedList(){const L=$('#svList'),I=$('#svInfo');if(!L||!pdSv)return;const q=($('#svQ').value||'').toLowerCase().trim();
 const it=pdSv.items.filter(x=>!q||[x.form,x.pn,x.by,x.dt,x.tm,(x.officers||[]).join(' '),pdDate(x.ts)].join(' ').toLowerCase().includes(q));
 I.textContent=(pdSv.days?'Forms are deleted automatically '+PD_DAYS[pdSv.days]+' after they are saved.':'Forms are kept until an admin deletes them.')+(pdSv.see==='own'&&session&&session.role==='officer'?' You see the forms you completed.':'')+' '+it.length+' shown.';
 L.innerHTML=it.length?it.map(x=>`<div style="border-top:1px solid var(--bd);padding:10px 0">
 <b>${e(x.form)}</b> <span class="mut">${e(x.dt||'')} ${e(x.tm||'')}</span><br>
 <small class="mut">${x.pn?'Name: '+e(x.pn)+' · ':''}${x.by==='kiosk'?'Lobby kiosk':'By '+e(x.by)}${x.officers&&x.officers.length?' · Officer: '+e(x.officers.join(', ')):''} · Saved ${pdDate(x.ts)} · ${x.expires?'Deleted '+pdDate(x.expires):'Kept until deleted'}</small>
 <div class="row" style="gap:6px;margin-top:6px">${x.files.map((f,i)=>`<button class="alt sm" onclick="window.open('../api/saved/${x.id}/${i}','_blank')">📄 ${i?'English copy':'Open'}</button>`).join('')}${pdSv.canEmail?`<button class="alt sm" onclick="pdSavedMail('${x.id}')">✉️ Email</button>`:''}${pdSv.canDelete?`<button class="alt sm" onclick="pdSavedDel('${x.id}')">🗑️ Delete</button>`:''}</div><div id="svm_${x.id}"></div></div>`).join(''):'<p class="mut">No saved forms'+(q?' match your search.':' yet.')+'</p>'}
function pdSavedMail(id){const b=$('#svm_'+id);if(!b)return;if(b.innerHTML){b.innerHTML='';return}const offs=officers.filter(o=>o.email);
 b.innerHTML=offs.length?`<div style="margin-top:6px">${offs.map(o=>`<label class="chk"><input type="checkbox" value="${e(o.id)}"> ${e(o.name)}</label>`).join('')}<button class="sm" onclick="pdSavedSend('${id}')">Send</button> <span class="mut" id="svs_${id}"></span></div>`:'<p class="mut">No officers have an email address.</p>'}
async function pdSavedSend(id){const b=$('#svm_'+id),g=$('#svs_'+id),to=[...b.querySelectorAll('input:checked')].map(i=>i.value);if(!to.length)return g.textContent='Pick an officer.';
 g.textContent='Sending...';try{await pdApi('POST','saved/'+id+'/email',{to});g.textContent='✓ Sent.'}catch(x){g.textContent=x.message}}
async function pdSavedDel(id){if(!confirm('Delete this saved form from the server? This cannot be undone.'))return;try{await pdApi('DELETE','saved/'+id);pdSv.items=pdSv.items.filter(x=>x.id!==id);pdSavedList()}catch(x){pdNote(x.message,true)}}
{const _r=render;render=function(){if(view==='saved'&&!PDC.locked){pdSavedRender();return}const o=_r.apply(this,arguments);pdSavedHome();return o}}

/* ==== People & sign-in: an admin picks who is admin, staff or officer; each person sets their own password from a one-time link ==== */
function acctHtml(){if(!session)return'';const adm=session.role==='admin';
 const mine=APP==='officer'?'':`<div class="card"><div class="li"><span>Signed in as <b>${e(session.u)}</b> (${e(session.role)})</span><button class="alt sm" onclick="logout()">Log out</button></div></div>
 <div class="card"><h3 style="margin-top:0">Change my password</h3><input type="hidden" id="ru" value="${e(session.u)}"><label>Your current password</label><input type="password" id="rpo" autocomplete="current-password"><label>New password (min 10 characters)</label><input type="password" id="rp" autocomplete="new-password"><div class="row"><button class="sm" onclick="resetPw()">Update password</button></div></div>`;
 return mine+(adm&&!PDC.offline?pdPeopleCard():'')+'<p id="amsg" style="color:#c0392b"></p>'}
const PD_ROLES=[['none','No sign-in'],['officer','Officer'],['staff','Staff'],['admin','Admin']];
function pdPeopleCard(){setTimeout(pdPeopleLoad,0);
 return`<div class="card" id="pdPeople"><h3 style="margin-top:0">👥 People &amp; sign-in</h3>
 <p class="mut">Pick what each person can do. <b>Admin</b>: everything, including this list and email settings. <b>Staff</b>: forms and officers in Staff setup. <b>Officer</b>: the officer app only.
 When you give someone a sign-in, they get a one-time setup link and choose their own password. You never see or type it.</p>
 <div id="pplLink"></div><div id="ppl" class="mut">Loading...</div>
 <h4 style="margin:18px 0 4px">Someone not on the officer list</h4>
 <div class="row" style="margin:0"><input type="text" id="pxN" placeholder="Name" style="flex:1;min-width:140px"><input type="email" id="pxE" placeholder="Email (optional)" style="flex:1;min-width:160px">
 <select id="pxR" style="width:auto"><option value="officer">Officer</option><option value="staff">Staff</option><option value="admin">Admin</option></select><button class="sm" onclick="pdPeopleAdd()">Give sign-in</button></div></div>`}
let pdPpl=[];
async function pdPeopleLoad(){const box=document.getElementById('ppl');if(!box)return;
 try{const r=await pdApi('GET','users');pdPpl=r.users||[];users=pdPpl;pdPeopleList()}catch(x){box.textContent='Could not load: '+x.message}}
function pdAcctFor(o){const em=(o.email||'').toLowerCase();return pdPpl.find(x=>x.oid&&x.oid===o.id)||(em&&pdPpl.find(x=>!x.oid&&(x.email||'').toLowerCase()===em))}
function pdStatus(a){if(!a)return'<span class="mut">No sign-in</span>';
 const st=a.active?'<span style="color:var(--ok)">✓ Password set</span>':(a.linkExp?'⏳ Waiting for them to set a password (link expires '+pdDate(a.linkExp)+')':'⚠️ Setup link expired: send a new one');
 return`<span class="mut">Username <b>${e(a.u)}</b></span> · ${st}`}
function pdRoleSel(cur,key,self){return`<select style="width:auto" ${self?'disabled title="You cannot change your own role"':''} onchange="pdRole('${key}',this.value,this)">${PD_ROLES.map(([v,l])=>`<option value="${v}" ${v===cur?'selected':''}>${l}</option>`).join('')}</select>`}
function pdRow(name,sub,a,key){const self=a&&session&&a.u===session.u;
 return`<div class="li" style="flex-wrap:wrap;gap:6px"><div style="flex:1;min-width:180px"><b>${e(name)}</b>${sub?` <span class="mut">${e(sub)}</span>`:''}<br><small>${pdStatus(a)}</small></div>
 <span class="row" style="margin:0;gap:6px">${pdRoleSel(a?a.role:'none',key,self)}${a&&!self?`<button class="alt sm" onclick="pdLink('${e(a.u)}')">${a.active?'Send password reset link':'Send new setup link'}</button>`:''}</span></div>`}
function pdPeopleList(){const box=document.getElementById('ppl');if(!box)return;const used=new Set();
 const rows=officers.filter(o=>o.id).map(o=>{const a=pdAcctFor(o);if(a)used.add(a.u);return pdRow(o.name,o.email,a,'o:'+o.id)});
 const other=pdPpl.filter(a=>!used.has(a.u)).map(a=>pdRow(a.name||a.u,a.email||'',a,'u:'+a.u));
 box.className='';box.innerHTML=(rows.join('')||'<p class="mut">No officers on the list yet.</p>')+(other.length?'<h4 style="margin:16px 0 4px">Other sign-ins</h4>'+other.join(''):'')}
const pdFindKey=k=>k.startsWith('u:')?pdPpl.find(x=>x.u===k.slice(2)):pdAcctFor(officers.find(o=>o.id===k.slice(2))||{});
async function pdRole(key,role,sel){const a=pdFindKey(key),g=document.getElementById('amsg');if(g)g.textContent='';
 try{if(!a&&role!=='none'){pdShowLink(await pdApi('POST','users/invite',{oid:key.slice(2),role,base:location.origin,send:!!canEmail}))}
  else if(a&&role==='none'){if(!confirm('Remove the sign-in for '+(a.name||a.u)+'? They will be signed out everywhere.')){sel.value=a.role;return}await pdApi('DELETE','users/'+encodeURIComponent(a.u))}
  else if(a&&role!==a.role){if(role==='admin'&&!confirm('Make '+(a.name||a.u)+' an admin? Admins can change everything, including who is an admin.')){sel.value=a.role;return}await pdApi('PUT','users/'+encodeURIComponent(a.u),{role})}
  await pdPeopleLoad()}catch(x){pdNote(x.message,true);await pdPeopleLoad()}}
async function pdLink(u){try{pdShowLink(await pdApi('POST','users/invite',{u,base:location.origin,send:!!canEmail}));await pdPeopleLoad()}catch(x){pdNote(x.message,true)}}
async function pdPeopleAdd(){const name=$('#pxN').value.trim(),email=$('#pxE').value.trim(),role=$('#pxR').value;if(!name)return pdNote('Enter the person\'s name.',true);
 try{pdShowLink(await pdApi('POST','users/invite',{name,email,role,base:location.origin,send:!!canEmail}));$('#pxN').value='';$('#pxE').value='';await pdPeopleLoad()}catch(x){pdNote(x.message,true)}}
function pdShowLink(r){const b=document.getElementById('pplLink');if(!b)return;const who=(r.user&&r.user.name)||r.u;
 b.innerHTML=`<div style="border:2px solid var(--ac);border-radius:12px;padding:12px;margin:0 0 12px;background:rgba(32,144,208,.06)"><b>Setup link for ${e(who)}</b> <span class="mut">(username ${e(r.u)}, works once, expires ${pdDate(r.exp)})</span>
 <p style="margin:6px 0">${r.emailed?'✓ Emailed to '+e(r.user.email)+'. You can also give them the link below.':(r.emailError?'⚠️ The email could not be sent ('+e(r.emailError)+'). Give them the link below instead.':'Give this link to '+e(who)+' (text, email or in person). They open it and choose their password.')}</p>
 <div class="row" style="margin:0"><input type="text" readonly value="${e(r.link)}" style="flex:1;min-width:200px;font-size:14px" onclick="this.select()"><button class="sm" onclick="navigator.clipboard.writeText(this.previousElementSibling.value).then(()=>pdNote('Link copied.'),()=>this.previousElementSibling.select())">Copy link</button><button class="alt sm" onclick="document.getElementById('pplLink').innerHTML=''">Done</button></div>
 ${/localhost|127\.0\.0\.1/.test(r.link)?'<p class="mut" style="margin:6px 0 0">This link uses this computer\'s own address. Start the server with Start TPD Central (network) so other devices can open it.</p>':''}</div>`;b.scrollIntoView({block:'nearest'})}
/* server release next to the app version */
{const _a=pdApply;pdApply=function(st){_a.apply(this,arguments);const el=document.getElementById('appver');if(el&&st&&st.server&&typeof APP_VER!=='undefined')el.textContent='App version '+APP_VER+' · Server '+st.server}}
