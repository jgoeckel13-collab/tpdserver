# Tisbury PD Digital Receptionist - standalone PWAs (GitHub Pages)

Two installable web apps. No server needed: every device keeps its own officers, forms and settings.

| Folder | Who uses it |
|---|---|
| `pd-kiosk-pwa/` | Visitors in the lobby (public forms, English and Português) |
| `pd-officer-pwa/` | Officers (everything in the kiosk plus officer forms; no login) |

## Put it on GitHub Pages
1. Create a repository and upload **everything in this folder** (both app folders, `.nojekyll`, this README).
2. Repository **Settings > Pages**: Source = *Deploy from a branch*, Branch = `main`, folder `/ (root)`. Save.
3. After a minute the apps are at:
   - `https://<your-user>.github.io/<repo>/pd-kiosk-pwa/`
   - `https://<your-user>.github.io/<repo>/pd-officer-pwa/`
4. Open each address once, then install: Chrome/Edge address-bar install icon, iPad Share > Add to Home Screen, Android menu > Install app.

## Step 5 (Done screen)
- **Print / Send to officer** - prints, then opens an email to the officer(s) picked on the sign screen with the PDF attached (on a PC it downloads an email draft; open it and press Send. On a phone/tablet one share sheet offers Print and Mail).
- **Want a copy? Enter your email** - opens an email to the visitor's address with the PDF attached. Replies are set to bounce (Reply-To is an address that cannot exist).
- Without a server these emails are sent from **the device's own mail account**, so that address is what recipients see. Automatic sending, a fixed sender address, and shared data need the server version (`tpd_central.py`).

## Updating
Upload the changed files, then open the app's `sw.js` and change the `VERSION` value (any new text, e.g. add `-2`). Devices pick up the new version the next time they open the app online.

## First-time setup (each device)
Open the app > **Staff setup**: add officers and the email CC, import any extra PDFs. The kiosk asks you to create an admin account the first time.

## Important
- **GitHub Pages sites are public**, even from a private repository on most plans. The officer app has **no login**: anyone with the address can open it and the officer-only forms built into it. Don't link to it publicly, or use the server version, which requires sign-in.
- Data entered on a device (drafts, the officer app's recent forms) stays on that device.
- Works offline after the first visit.
