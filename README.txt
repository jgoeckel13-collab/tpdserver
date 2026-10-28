TISBURY PD CENTRAL SERVER  (kiosk app + officer app, managed in one place)

START
  Double-click "Start TPD Central.bat"   (needs the "python" folder next to it, or Python installed)
    Visitor app:  http://localhost:8090/kiosk/
    Officer app:  http://localhost:8090/officer/   (sign-in required)

FIRST TIME
  1. Open the Visitor app > Staff setup > create the admin account.
  2. In Staff setup: add officers, the email CC, import PDFs, and add accounts.
     Roles:  Admin   - everything, including accounts
             Staff   - forms, officers and CC
             Officer - can sign in to the officer app and fill forms only

WHAT IS SHARED (stored on the server, same on every device)
  Accounts, officers, CC, imported PDFs (and their signature boxes), field types.
  PDFs imported in the Visitor app appear in both apps.
  PDFs imported in the Officer app are officer-only (never sent to the lobby/visitors).

WHAT STAYS ON EACH DEVICE
  In-progress drafts, and the officer app's "recent forms" (24 hours).

INCLUDED FORMS
  Both apps: Detail Voucher, Motor Vehicle Inventory (Good/Fair/Poor, damage diagram, photos),
  Motor Vehicle Crash Worksheet (photos), 24-hour recent forms (officer app), Portuguese->English copy.
  Photos use the device camera (HTTPS needed: use "Start TPD Central (network)").

UPDATING THE APPS
  Replace the files in central\kiosk or central\officer with the new version.
  No version numbers to change: devices notice and reload on their own within about
  a minute, the next time they are on the home screen (never in the middle of a form).

OFFLINE
  Each device keeps a copy, so the apps still open and fill forms with no connection.
  Changes to officers/forms need the server.
  Signing out of the officer app removes its saved copy from that device.

EMAIL OFFICER (sent by the server)
  Visitor app > Staff setup > "Email sending" (admin only):
    Sender address (From), sender name, mail server, port, security, sign-in.
  When it is on, the last screen's button becomes "Print / Sent to officer":
  tapping it prints AND the server emails the signed PDF (once, even if printed again):
    To   = the assisting officer(s) picked on the sign screen
    Cc   = the CC address in Staff setup
    From = the sender address above (always)
  Only officers saved in Staff setup can receive these emails.
  Use "Send test email" after saving. For Microsoft 365 use smtp.office365.com, 587,
  STARTTLS, with a mailbox IT sets up for this (SMTP sign-in must be allowed on it).
  The last screen (step 5) always has a "Want a copy? Enter your email" box
  in both apps while server email is on. The visitor's copy goes only to the address they type (no officers,
  no CC), with a fixed message, and Reply-To set to an address that cannot exist,
  so a reply bounces back to the visitor instead of reaching the sender mailbox.
  Limit: 3 per device per 10 minutes. Optional extra safety in the sender Gmail:
  Settings > Filters > create a filter that deletes mail not from your officers.
  When it is off, Email officer uses the device's own mail app as before.
  The mail password is stored in central\data\state.json - protect that folder.
  GitHub (standalone) apps can also send through this server: fill in "GitHub apps"
  in Email sending (key, allowed websites), then in each GitHub app enter
  https://<server address>/api/relay and the key. The server must be reachable over HTTPS.

DATA
  central\data  (state.json, forms\, audit.log)  - BACK THIS FOLDER UP.
  audit.log records sign-ins, failed sign-ins, account, setting and form changes.
  Forgot the admin password: close the server, run  Start TPD Central.bat --reset-users

OTHER COMPUTERS, TABLETS AND PHONES ON THE NETWORK
  1. Double-click "Start TPD Central (network).bat" (instead of the normal one).
     The window lists the addresses other devices use, e.g.  https://w-t-pd-stf4:8493/
     The PC name keeps working if the PC's IP address changes; the IP may not.
  2. Windows may ask to allow Python through the firewall: tick "Private networks" > Allow
     (needs admin). If no prompt appears and other devices can't connect, ask IT to allow
     inbound TCP port 8493 to this PC.
  3. Once on each other device: open  https://<that address>/setup  (click past the
     one-time warning), download the certificate and follow the steps for that device.
     Or have IT push cert\tpd-ca.crt to all PCs (Group Policy > Trusted Root CAs).
     After that: no warnings, and the apps work offline and can be installed.
  The certificate is made automatically (no installs needed) and renewed by itself when
  this PC's name or address changes; devices don't need to be set up again.
  KEEP cert\tpd-ca.key PRIVATE and back up the cert folder with the data folder.
  To use a certificate from IT instead: put server.crt and server.key in a folder named
  "cert-from-it" next to tpd_central.py.
  This PC must stay on with the server window open for other devices to use it.
