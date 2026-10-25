# Tisbury PD Digital Receptionist - shared server version

Runs on your own web server so every lobby device, tablet, phone and computer shares the same
forms, officers, staff accounts and settings. Nothing is stored in the visitor's browser.

## What you need
- A web host or computer that can run **Node.js 18 or newer** (a small VPS, an office PC, or a Node host such as Render, Railway or Fly.io).
- A domain or subdomain with **HTTPS**, for example `reception.yourtown.gov` (browsers require HTTPS for secure logins and the signature/PDF features).

## Quick start
```
cd pd-receptionist-server
npm install          # optional: only needed for automatic email (installs nodemailer)
npm start            # http://localhost:3000
```
Open the address, tap **Staff setup**, and create the admin account (first visit only).
Then import your PDFs (choose English or Português), add officers, and add staff accounts.

## Public lobby app and Officer portal (two addresses, one server)
The same server gives you two apps:

| Address | Who uses it | What it shows |
|---|---|---|
| `https://your-site/` | Visitors in the lobby | Only forms marked **Public + officers** |
| `https://your-site/officer/` | Officers | Staff login first, then **all** forms (public and officers-only) |

- In **Staff setup > Forms (fillable PDFs)** every form, including the built-in ones, has a **Public + officers / Officers only** menu. Changes apply right away.
- When you import a PDF you can choose who can use it before importing.
- Officers-only forms are not sent to the public page at all: the server withholds them (and their PDF files) until an officer is logged in.
- The officer portal uses the same accounts, officers list and email settings. It logs out after 15 minutes of no use.
- With `BASE_PATH=/reception` the portal is at `/reception/officer/`.
- Existing forms stay public until you change them.
- Built in and **officers-only by default**: *Consent to Search*, *Motor Vehicle Inventory*, *Vehicle Lockout Request* and the Portuguese *Assistência para Veículo Trancado* (its English copy is made from the English lockout form). You can switch any of them to public in Staff setup.

### Working without a connection (officer portal)
After an officer logs in once with a connection, the portal keeps working when the signal drops.
- **Mid-session drop:** forms that were already loaded keep opening, and filling, signing, printing and downloading all work.
- **Opening the portal with no connection:** the page loads from the device. The officer logs in with the same username and password and sees all forms, including officers-only ones. A "Offline mode" note is shown. Staff setup is not available offline.
- **Email:** when email is turned on at the server, an email that cannot be sent is saved on the device and sent automatically the next time that officer logs in with a connection. The officer can still print or download right away.
- **Security:** the offline copy (forms, officer list, queued emails) is encrypted on the device with a key made from the officer's password, so a lost phone does not expose officers-only forms without the password. After 5 wrong offline passwords the portal waits 5 minutes.
- **Expiry:** the offline copy stops working after `OFFLINE_DAYS` (default **7**) days without an online login. Set `OFFLINE_DAYS=0` to turn offline use off completely. If an officer leaves, remove their account and keep `OFFLINE_DAYS` short, because a phone that has not connected since cannot be told to delete its copy. An officer can also tap **Remove offline copy** on the home screen.
- The lobby page also loads offline now, because the PDF viewer is included with the app instead of loaded from the internet.

## Launch on Fly.io (quick test host)
Install flyctl, open a terminal in this folder and run `bash deploy-fly.sh`. It signs you in (you approve in the browser), creates the app in the `johnathon-goeckel` organization, creates a 1 GB data volume, and deploys one machine. Change the app name or region with `APP=... REGION=... bash deploy-fly.sh`. Add email/translation settings with `fly secrets set` (see the comment in the script). Keep it to one machine.

On the **Location** field (Motor Vehicle Inventory) and **Location of Service** (lockout forms), officers get a **Use my current location** (GPS) button.

## Put it on your website
1. **Link (easiest, most reliable):** run the app on a subdomain and link to it from your site:
   `<a href="https://reception.yourtown.gov/">Digital Receptionist</a>`
2. **Under your main domain** (for example `https://yourtown.gov/reception/`): put it behind your web server's reverse proxy and set `BASE_PATH=/reception`. nginx example:
   ```
   location /reception/ { proxy_pass http://127.0.0.1:3000; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header X-Forwarded-For $remote_addr; client_max_body_size 30m; }
   ```
   (start the app with `BASE_PATH=/reception npm start`)
3. **Embedded on a page:** `<iframe src="https://reception.yourtown.gov/" style="width:100%;height:90vh;border:0" allow="fullscreen"></iframe>`
   Set `FRAME_ANCESTORS="https://www.yourtown.gov"` so only your site can embed it. Staff login inside an iframe works best when the app is on a subdomain of the same site; some browsers (Safari) block login cookies inside iframes from a different site. If staff login fails in the iframe, have staff open the app address directly.

## Settings (environment variables)
| Name | Meaning | Default |
|---|---|---|
| `PORT` / `HOST` | where it listens | 3000 / 0.0.0.0 |
| `DATA_DIR` | where forms, officers and accounts are stored | `./data` |
| `OFFLINE_DAYS` | days an officer's offline copy works without an online login (0 = off) | `7` |
| `BASE_PATH` | sub-path, e.g. `/reception` | none |
| `FRAME_ANCESTORS` | sites allowed to embed it | `'self'` |
| `COOKIE_SECURE` | set `1` to force secure cookies (automatic behind HTTPS proxy) | auto |
| `COOKIE_SAMESITE` | `Lax`, or `None` (HTTPS only) for cross-site embedding | Lax |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_SECURE` `SMTP_FROM` | turns on automatic email (see below) | off |

## Automatic email to the assisting officer
Run `npm install`, then set the SMTP variables, for example:
```
SMTP_HOST=smtp.office365.com SMTP_PORT=587 SMTP_USER=receptionist@yourtown.gov SMTP_PASS=... SMTP_FROM="Tisbury PD Receptionist <receptionist@yourtown.gov>" npm start
```
When email is on, the **Email officer** button sends the signed PDF as an attachment straight from the server
(and officer email addresses are no longer sent to visitors' browsers). When it is off, the button opens the
device's share sheet / mail app as before. Email can only be sent to officers saved in Staff setup.

## English copy of Portuguese forms
When a visitor finishes a **Portuguese** form, the app also makes an **English copy**, and the officer can choose the Portuguese original, the English copy, or both to **print, download or email** (email sends both as separate attachments). The finish screen and the email text are always in English.
- For the **Voluntary Statement** and **Trespass Notice**, the English copy is the actual English form filled in with the same answers (the assisting officer's name goes in "Officer (Print)"). The last page notes that it is a copy of the Portuguese original.
- For any other Portuguese form (for example the Request for Information) the English copy is a translated summary of the entries and signatures, which needs translation turned on (below).
- Long free-text answers (such as the statement) are translated into English when translation is on. When it is off, they are copied exactly as written and the finish screen says so. Names, addresses, phone numbers and dates are always copied as written.

To turn translation on, set an Anthropic API key before starting the app:
```
ANTHROPIC_API_KEY=sk-ant-... npm start        # optional: ANTHROPIC_MODEL=claude-sonnet-5-5
```
Without a key the paired English forms still work (long text is copied as written); other Portuguese forms offer only the original.

**Before enabling, check your policies:** what visitors type (names, addresses, statements) is sent over the internet to the Anthropic API to be translated. Confirm with your town counsel / IT / records-retention rules that this is allowed for the forms you use. The translation is a machine translation: have important documents reviewed by a qualified translator. The server log (`audit.log`) records that a translation happened (item and character counts), not its content.

## Android app (.apk)
Once the app is running on your HTTPS address, you can turn it into an installable Android app (.apk) without writing code:
1. Open **pwabuilder.com**, paste your app's address, and choose **Package for stores > Android**.
2. Download the package. It contains a signed `.apk` (to install directly on tablets/phones) and an `.aab` (for Google Play). **Keep the signing key file and password it gives you** - you need them for every future update.
3. PWABuilder also gives you a small `assetlinks.json` file. Save it in this app as `public/.well-known/assetlinks.json` (create the folder) and restart. This makes the app open full screen with no browser bar.
4. To install the `.apk` on a device: copy it over, open it, and allow "install unknown apps" for that source when asked.
The Android app is the same website in a full-screen Chrome shell, so it always shows the latest version and shares the same data as every other device.
Android devices can also use **Chrome menu > Install app** to get an icon without any .apk.

## Keeping it running
- Data lives in the `data` folder (`state.json`, `forms/`, `audit.log`). **Back this folder up.**
- `audit.log` records logins, failed logins, form and officer changes, and emails sent.
- Keep it running with a process manager (systemd, pm2) or use the included `Dockerfile`.
- Forgot the admin password: stop the app, run `node server.js --reset-users`, start it, and create a new admin (forms and officers are kept).

## Security notes
- Passwords are stored hashed (scrypt). Five wrong tries lock that account for 5 minutes. Sessions end after 30 idle minutes (the screen also logs out after 5 minutes idle).
- Only staff can change forms, officers and accounts; only the admin manages accounts. Visitors can only read forms and finish a form.
- Always serve it over HTTPS. Keep Node updated.
- The page library for the on-screen form viewer (pdf.js) loads from cdnjs.cloudflare.com. If that is blocked, the app falls back to a plain list of fields.

## Built in
Forms built into the app (English: Detail Request Form; Portuguese: Solicitação de Informações, Declaração Voluntária) appear automatically. Anything staff import is stored on the server and appears on every device within a minute.
