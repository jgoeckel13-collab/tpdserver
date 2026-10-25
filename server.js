'use strict';
/* Tisbury PD Digital Receptionist - shared server (no dependencies; nodemailer optional for email) */
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=+process.env.PORT||3000,HOST=process.env.HOST||'0.0.0.0';
const BASE=(process.env.BASE_PATH||'').replace(/\/+$/,'');
const DATA=path.resolve(process.env.DATA_DIR||path.join(__dirname,'data')),FORMS=path.join(DATA,'forms'),PUB=path.join(__dirname,'public');
fs.mkdirSync(FORMS,{recursive:true});
let nodemailer=null;try{nodemailer=require('nodemailer')}catch{}
const SMTP_OK=!!(nodemailer&&process.env.SMTP_HOST&&process.env.SMTP_FROM);
const transporter=SMTP_OK?nodemailer.createTransport({host:process.env.SMTP_HOST,port:+process.env.SMTP_PORT||587,secure:process.env.SMTP_SECURE==='1',auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined}):null;
const OFFLINE_DAYS=process.env.OFFLINE_DAYS===undefined?7:Math.max(0,Math.min(60,Math.floor(+process.env.OFFLINE_DAYS||0)));
const SAMESITE=process.env.COOKIE_SAMESITE||'Lax',FRAME=process.env.FRAME_ANCESTORS||"'self'";

/* ---------- storage ---------- */
const SF=path.join(DATA,'state.json');let S={users:[],officers:[],cc:'',forms:[],aud:{}};
try{S=Object.assign(S,JSON.parse(fs.readFileSync(SF,'utf8')))}catch{}
if(!S.aud)S.aud={};
const save=()=>{const t=SF+'.tmp';fs.writeFileSync(t,JSON.stringify(S,null,1));fs.renameSync(t,SF)};
const audit=(ev,who,x)=>{try{fs.appendFileSync(path.join(DATA,'audit.log'),JSON.stringify({t:new Date().toISOString(),ev,who,...x})+'\n')}catch{}};
if(process.argv.includes('--reset-users')){S.users=[];save();console.log('All staff accounts removed. Open the app to create a new admin.');process.exit(0)}

/* ---------- security helpers ---------- */
const hashPw=(pw,salt)=>crypto.scryptSync(pw,salt,64).toString('hex');
const mkUser=(u,p,role)=>{const salt=crypto.randomBytes(16).toString('hex');return{u,role,salt,hash:hashPw(p,salt),fails:0,lock:0}};
const same=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const sess=new Map(),IDLE=30*60e3,MAXAGE=12*3600e3;
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(/;\s*/).filter(Boolean).map(c=>{const i=c.indexOf('=');return[c.slice(0,i),decodeURIComponent(c.slice(i+1))]}));
function getSess(req){const t=cookies(req).pdsid,s=t&&sess.get(t);if(!s)return null;const n=Date.now();if(n-s.last>IDLE||n-s.created>MAXAGE){sess.delete(t);return null}s.last=n;
 const u=S.users.find(x=>x.u===s.u);if(!u){sess.delete(t);return null}s.role=u.role;return s}
function setCookie(req,res,val,age){const sec=process.env.COOKIE_SECURE==='1'||req.headers['x-forwarded-proto']==='https'||SAMESITE==='None';
 res.setHeader('Set-Cookie',`pdsid=${val}; HttpOnly; Path=${BASE||'/'}; SameSite=${SAMESITE}; Max-Age=${age}${sec?'; Secure':''}`)}
const hits=new Map();function limited(key,max,win){const n=Date.now(),a=(hits.get(key)||[]).filter(t=>n-t<win);a.push(n);hits.set(key,a);return a.length>max}
setInterval(()=>{const n=Date.now();for(const[k,s]of sess)if(n-s.last>IDLE)sess.delete(k);for(const[k,a]of hits)if(!a.some(t=>n-t<600e3))hits.delete(k)},60e3).unref();
const ip=req=>(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();

/* ---------- http helpers ---------- */
const json=(res,code,o)=>{const b=JSON.stringify(o);res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(b)};
const fail=(res,code,msg)=>json(res,code,{error:msg});
function body(req,limit){return new Promise((ok,no)=>{const c=[];let n=0;req.on('data',d=>{n+=d.length;if(n>limit){no(Object.assign(new Error('Too large'),{code:413}));req.destroy()}else c.push(d)});req.on('end',()=>ok(Buffer.concat(c)));req.on('error',no)})}
const readJson=async(req,limit=1e6)=>{const b=await body(req,limit);try{return JSON.parse(b.toString()||'{}')}catch{throw Object.assign(new Error('Bad JSON'),{code:400})}};
const isPdf=b=>b.length>8&&b.slice(0,5).toString()==='%PDF-';
const cleanName=n=>{n=path.basename(String(n||'form').replace(/[\u0000-\u001f\\\/]/g,'')).trim().slice(0,120)||'form';return/\.pdf$/i.test(n)?n:n+'.pdf'};
const okEmail=e=>!e||(e.length<=200&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
const pub=o=>({u:o.u,role:o.role});

const TR_PROMPT='You are a careful translator for a police department. Translate the following form entries from Portuguese into English. For each item return the translated "label" (a form field name) and the translated "value" (what the person wrote). Rules: translate faithfully and completely, without adding, omitting, softening or interpreting anything; keep proper names, street addresses, phone numbers, numbers, dates and times exactly as written; keep line breaks; if a value is already in English or is empty, return it unchanged; do not add commentary. Reply with only JSON in this form: {"items":[{"id":"...","label":"...","value":"..."}]} using the same ids.';
/* ---------- built-in forms & who may see them ---------- */
const INDEX_FILE=path.join(PUB,'index.html');let FULL='';const BUILT=new Map();
const BRE=/\{name:'((?:[^'\\]|\\.)*)',lang:'(\w+)',builtin:true,b:'([A-Za-z0-9+\/=]*)'\},?/g;
try{FULL=fs.readFileSync(INDEX_FILE,'utf8');for(const m of FULL.matchAll(BRE))BUILT.set(m[1],{lang:m[2],buf:Buffer.from(m[3],'base64')})}catch(x){console.error('Could not read public/index.html',x.message)}
const OFFICER_DEFAULT=new Set(['consent to search.pdf','motor vehicle inventory.pdf','vehicle lockout request.pdf','assistência para veículo trancado.pdf','detail voucher.pdf']); // new forms start as officers-only until changed in Staff setup
const audOf=name=>{const k=String(name).toLowerCase(),v=S.aud[k];return v==='officer'||v==='both'?v:(OFFICER_DEFAULT.has(k)?'officer':'both')};
const pageCache=new Map();
function page(mode){const key=mode+'|'+[...BUILT.keys()].filter(n=>audOf(n)==='officer').join('|');let h=pageCache.get(key);if(h)return h;
 h=FULL.replace(BRE,(all,name)=>audOf(name)==='officer'?'':all);
 const inj=mode==='officer'?'<base href="../"><meta name="robots" content="noindex"><script>window.PD_MODE="officer"</script>':'';
 h=h.replace(/<head>/i,m=>m+inj);if(pageCache.size>20)pageCache.clear();pageCache.set(key,h);return h}

/* ---------- API ---------- */
async function api(req,res,p,q){
 const m=req.method,s=getSess(req);
 if(m!=='GET'&&m!=='HEAD'&&req.headers['x-pd']!=='1')return fail(res,403,'Bad request');
 const staff=()=>{if(!s){fail(res,401,'Please log in');return false}return true},admin=()=>{if(!staff())return false;if(s.role!=='admin'){fail(res,403,'Admin only');return false}return true};
 if(p==='state'&&m==='GET'){const withMail=!!s||!SMTP_OK;
  const bl=[...BUILT].map(([name,v])=>({name,lang:v.lang,aud:audOf(name)})).filter(b=>s||b.aud!=='officer'),fl=S.forms.map(f=>({id:f.id,name:f.name,lang:f.lang,aud:audOf(f.name)})).filter(f=>s||f.aud!=='officer');
  return json(res,200,{offlineDays:OFFLINE_DAYS,builtins:bl,needSetup:!S.users.length,session:s?{u:s.u,role:s.role}:null,canEmail:SMTP_OK,canTranslate:!!process.env.ANTHROPIC_API_KEY,cc:withMail?S.cc:'',
   officers:S.officers.map(o=>withMail?o:{id:o.id,name:o.name}),forms:fl})}
 if(p==='forms'&&m==='GET')return json(res,200,{forms:S.forms.map(f=>({id:f.id,name:f.name,lang:f.lang,aud:audOf(f.name)})).filter(f=>s||f.aud!=='officer')});
 if(p==='builtin'&&m==='GET'){const n=q.get('name'),b=BUILT.get(n);if(!b)return fail(res,404,'Form not found');if(audOf(n)==='officer'&&!staff())return;res.writeHead(200,{'content-type':'application/pdf','cache-control':'no-store','content-length':b.buf.length});return res.end(b.buf)}
 if(p==='audience'&&m==='PUT'){if(!staff())return;const b=await readJson(req),n=String(b.name||''),key=n.toLowerCase();if(!BUILT.has(n)&&!S.forms.some(f=>f.name.toLowerCase()===key))return fail(res,404,'Form not found');
  S.aud[key]=b.aud==='officer'?'officer':'both';save();pageCache.clear();audit('form-audience',s.u,{name:n,aud:b.aud==='officer'?'officer':'both'});return json(res,200,{ok:true})}
 if(p==='setup'&&m==='POST'){if(S.users.length)return fail(res,409,'Already set up');const b=await readJson(req),u=String(b.u||'').trim(),pw=String(b.p||'');
  if(!u||u.length>60)return fail(res,400,'Enter a username.');if(pw.length<10)return fail(res,400,'Password must be at least 10 characters.');
  S.users.push(mkUser(u,pw,'admin'));save();audit('setup',u);const t=crypto.randomBytes(32).toString('hex');sess.set(t,{u,role:'admin',created:Date.now(),last:Date.now()});setCookie(req,res,t,MAXAGE/1000);return json(res,200,{session:{u,role:'admin'}})}
 if(p==='login'&&m==='POST'){if(limited('login:'+ip(req),30,60e3))return fail(res,429,'Too many attempts. Wait a minute.');const b=await readJson(req),u=String(b.u||'').trim(),pw=String(b.p||'');
  const r=S.users.find(x=>x.u.toLowerCase()===u.toLowerCase());
  if(r&&r.lock>Date.now())return fail(res,429,'Too many attempts. Try again in '+Math.ceil((r.lock-Date.now())/60000)+' min.');
  const h=hashPw(pw,r?r.salt:'0'.repeat(32));
  if(!r||!same(h,r.hash)){if(r){r.fails=(r.fails||0)+1;if(r.fails>=5){r.lock=Date.now()+300e3;r.fails=0}save()}audit('login-failed',u,{ip:ip(req)});return fail(res,401,'Incorrect username or password.')}
  r.fails=0;save();const t=crypto.randomBytes(32).toString('hex');sess.set(t,{u:r.u,role:r.role,created:Date.now(),last:Date.now()});setCookie(req,res,t,MAXAGE/1000);audit('login',r.u,{ip:ip(req)});return json(res,200,{session:pub(r)})}
 if(p==='logout'&&m==='POST'){const t=cookies(req).pdsid;if(t)sess.delete(t);setCookie(req,res,'',0);return json(res,200,{ok:true})}
 if(p==='users'&&m==='GET'){if(!admin())return;return json(res,200,{users:S.users.map(pub)})}
 if(p==='users'&&m==='POST'){if(!admin())return;const b=await readJson(req),u=String(b.u||'').trim(),pw=String(b.p||''),role=b.role==='admin'?'admin':'staff';
  if(!u||u.length>60)return fail(res,400,'Enter a username.');if(S.users.some(x=>x.u.toLowerCase()===u.toLowerCase()))return fail(res,409,'Username already exists.');if(pw.length<10)return fail(res,400,'Password must be at least 10 characters.');
  S.users.push(mkUser(u,pw,role));save();audit('user-add',s.u,{user:u,role});return json(res,200,{ok:true})}
 if(p.startsWith('users/')&&m==='DELETE'){if(!admin())return;const u=decodeURIComponent(p.slice(6));if(u===s.u)return fail(res,400,'You cannot remove your own account.');
  const i=S.users.findIndex(x=>x.u===u);if(i<0)return fail(res,404,'Not found');S.users.splice(i,1);save();for(const[k,v]of sess)if(v.u===u)sess.delete(k);audit('user-remove',s.u,{user:u});return json(res,200,{ok:true})}
 if(p==='password'&&m==='POST'){if(!staff())return;const b=await readJson(req),u=String(b.u||''),pw=String(b.p||'');
  if(s.role!=='admin'&&u!==s.u)return fail(res,403,'Not allowed');if(pw.length<10)return fail(res,400,'Password must be at least 10 characters.');
  const r=S.users.find(x=>x.u===u);if(!r)return fail(res,404,'Not found');Object.assign(r,mkUser(u,pw,r.role),{u:r.u});save();audit('password',s.u,{user:u});return json(res,200,{ok:true})}
 if(p==='officers'&&m==='PUT'){if(!staff())return;const b=await readJson(req);if(!Array.isArray(b.officers)||b.officers.length>300)return fail(res,400,'Bad officers list');
  const out=[];for(const o of b.officers){const name=String(o.name||'').trim().slice(0,100),email=String(o.email||'').trim();if(!name)continue;if(!okEmail(email))return fail(res,400,'Invalid email for '+name);out.push({id:/^[\w-]{8,64}$/.test(o.id||'')?o.id:crypto.randomUUID(),name,email})}
  const cc=String(b.cc||'').trim();if(!okEmail(cc))return fail(res,400,'Invalid CC email');S.officers=out;S.cc=cc;save();audit('officers',s.u,{count:out.length});return json(res,200,{officers:out,cc})}
 if(p==='forms'&&m==='POST'){if(!staff())return;const buf=await body(req,25e6);if(!isPdf(buf))return fail(res,400,'That is not a PDF file.');
  const name=cleanName(q.get('name')),lang=q.get('lang')==='pt'?'pt':'en';let f=S.forms.find(x=>x.name.toLowerCase()===name.toLowerCase());
  if(f){f.lang=lang;f.name=name}else{f={id:crypto.randomUUID(),name,lang};S.forms.push(f)}
  if(q.get('aud')==='officer'||q.get('aud')==='both')S.aud[name.toLowerCase()]=q.get('aud');
  fs.writeFileSync(path.join(FORMS,f.id+'.pdf'),buf);save();audit('form-upload',s.u,{name,lang});return json(res,200,{id:f.id})}
 const fm=/^forms\/([\w-]{8,64})$/.exec(p);
 if(fm){const f=S.forms.find(x=>x.id===fm[1]);if(!f)return fail(res,404,'Form not found');const fp=path.join(FORMS,f.id+'.pdf');
  if(m==='GET'){if(audOf(f.name)==='officer'&&!staff())return;try{const b=fs.readFileSync(fp);res.writeHead(200,{'content-type':'application/pdf','cache-control':'no-store','content-length':b.length});return res.end(b)}catch{return fail(res,404,'Form file missing')}}
  if(m==='PUT'){if(!staff())return;const buf=await body(req,25e6);if(!isPdf(buf))return fail(res,400,'That is not a PDF file.');fs.writeFileSync(fp,buf);audit('form-update',s.u,{name:f.name});return json(res,200,{ok:true})}
  if(m==='DELETE'){if(!staff())return;S.forms=S.forms.filter(x=>x.id!==f.id);delete S.aud[f.name.toLowerCase()];save();try{fs.unlinkSync(fp)}catch{}audit('form-remove',s.u,{name:f.name});return json(res,200,{ok:true})}}

 if(p==='translate'&&m==='POST'){const KEY=process.env.ANTHROPIC_API_KEY;if(!KEY)return fail(res,501,'Translation is not set up on the server.');
  if(limited('tr:'+ip(req),20,600e3))return fail(res,429,'Too many translation requests. Try again later.');
  const b=await readJson(req,1e6),items=Array.isArray(b.items)?b.items:[];let total=0;
  if(!items.length||items.length>300)return fail(res,400,'Bad items');
  const clean=items.map(it=>{const o={id:String(it.id||'').slice(0,40),label:String(it.label||'').slice(0,300),value:String(it.value||'').slice(0,30000)};total+=o.label.length+o.value.length;return o});
  if(total>150000)return fail(res,413,'Too much text');
  try{const r=await fetch(process.env.ANTHROPIC_API_URL||'https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},
    body:JSON.stringify({model:process.env.ANTHROPIC_MODEL||'claude-sonnet-5-5',max_tokens:16000,temperature:0,messages:[{role:'user',content:TR_PROMPT+'\n\n'+JSON.stringify({items:clean})}]})});
   if(!r.ok)throw new Error('API '+r.status);const d=await r.json(),txt=(d.content||[]).map(c=>c.text||'').join(''),i=txt.indexOf('{'),j=txt.lastIndexOf('}');
   const parsed=JSON.parse(txt.slice(i,j+1)),got={};for(const it of parsed.items||[])got[String(it.id)]=it;
   const out=clean.map(o=>{const g=got[o.id]||{};return{id:o.id,label:typeof g.label==='string'?g.label:o.label,value:typeof g.value==='string'?g.value:o.value}});
   audit('translate',ip(req),{items:out.length,chars:total});return json(res,200,{items:out})}
  catch(x){audit('translate-failed',ip(req),{err:String(x.message).slice(0,200)});return fail(res,502,'The translation could not be completed.')}}
 if(p==='email'&&m==='POST'){if(!SMTP_OK)return fail(res,501,'Email is not set up on the server.');if(limited('mail:'+ip(req),10,600e3))return fail(res,429,'Too many emails. Try again later.');
  const b=await readJson(req,30e6),ids=Array.isArray(b.to)?b.to:[],offs=S.officers.filter(o=>ids.includes(o.id)&&o.email);
  if(!offs.length)return fail(res,400,'The selected officer(s) have no email address.');
  const list=Array.isArray(b.pdfs)?b.pdfs:[{filename:b.filename,pdf:b.pdf}];if(!list.length||list.length>3)return fail(res,400,'Invalid attachments');
  const atts=[];let tot=0;for(const it of list){const pdf=Buffer.from(String(it.pdf||''),'base64');tot+=pdf.length;if(!isPdf(pdf)||tot>20e6)return fail(res,400,'Invalid PDF');atts.push({filename:cleanName(it.filename),content:pdf,contentType:'application/pdf'})}
  const fn=atts.map(a=>a.filename).join(', '),subject=String(b.subject||'Completed form').replace(/[\r\n]+/g,' ').slice(0,200),text=String(b.text||'').slice(0,2000);
  try{await transporter.sendMail({from:process.env.SMTP_FROM,to:offs.map(o=>o.email),cc:S.cc||undefined,subject,text,attachments:atts});audit('email',ip(req),{to:offs.map(o=>o.name),file:fn});return json(res,200,{ok:true})}
  catch(x){audit('email-failed',ip(req),{err:String(x.message).slice(0,200)});return fail(res,502,'The email could not be sent.')}}
 return fail(res,404,'Not found')}

/* ---------- static files ---------- */
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'};
function headers(res){res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
 if(process.env.CSP!=='off')res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://maps.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com; connect-src 'self' https://cdnjs.cloudflare.com https://maps.googleapis.com https://nominatim.openstreetmap.org; worker-src 'self' blob: https://cdnjs.cloudflare.com; frame-src 'self' blob:; object-src 'self' blob: data:; base-uri 'self'; form-action 'self'; frame-ancestors "+FRAME)}
http.createServer(async(req,res)=>{
 headers(res);
 try{const u=new URL(req.url,'http://x');let p=decodeURIComponent(u.pathname);
  if(BASE){if(p===BASE){res.writeHead(301,{Location:BASE+'/'});return res.end()}if(!p.startsWith(BASE+'/'))return fail(res,404,'Not found');p=p.slice(BASE.length)}
  if(p.startsWith('/api/'))return await api(req,res,p.slice(5),u.searchParams);
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end()}
  const idx=mode=>{if(!FULL){res.writeHead(500);return res.end('Missing index')}res.writeHead(200,{'content-type':MIME['.html'],'cache-control':'no-store'});res.end(req.method==='HEAD'?undefined:page(mode))};
  if(p==='/officer'){res.writeHead(301,{Location:BASE+'/officer/'});return res.end()}
  if(p==='/officer/'||p==='/officer/index.html')return idx('officer');
  if(p==='/'||p==='/index.html')return idx('public');
  if(p.endsWith('/'))p+='index.html';const fp=path.join(PUB,path.normalize(p));
  if(!fp.startsWith(PUB+path.sep)||fp===INDEX_FILE){res.writeHead(403);return res.end()}
  fs.readFile(fp,(err,b)=>{if(err){res.writeHead(404,{'content-type':'text/plain'});return res.end('Not found')}
   const ext=path.extname(fp).toLowerCase();res.writeHead(200,{'content-type':MIME[ext]||'application/octet-stream','cache-control':ext==='.html'||fp.endsWith('sw.js')?'no-cache':'public, max-age=86400'});res.end(req.method==='HEAD'?undefined:b)})
 }catch(x){if(!res.headersSent)fail(res,x.code===413?413:x.code===400?400:500,x.code===413?'File too large':x.code===400?'Bad request':'Server error');else res.end();if(!x.code)console.error(x)}
}).listen(PORT,HOST,()=>console.log(`Tisbury PD Receptionist running on http://${HOST}:${PORT}${BASE||''}/  (email ${SMTP_OK?'ON':'off'})`));
