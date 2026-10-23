# Start here (no technical knowledge needed)

This is a program that helps you sell and lease aircraft. It keeps your aircraft and buyers in one place, suggests replies to buyers, and **never sends anything until you approve it**. You can try it on your own computer first, then put it on the internet for your team.

## Part 1. Try it on your own computer (about 10 minutes)

1. **Install Node.js** (a free helper program). Go to **https://nodejs.org**, download the button marked **LTS**, and install it by clicking Next. If you already have it, skip this.
2. **Download this project.** Click this link: **https://github.com/Ljupcho1982/Jetblue/archive/refs/heads/ccr-4429975c-yke6ow.zip**
   Open the downloaded file and choose "Extract all" (Windows) or double-click it (Mac). You get a folder called `Jetblue-ccr-4429975c-yke6ow`.
3. **Start it.**
   - **Windows:** open the folder and double-click **start.bat**. If Windows warns you, choose "More info", then "Run anyway".
   - **Mac:** open the **Terminal** app, type `bash ` (with a space), drag the file **start.sh** from the folder into the Terminal window, and press Enter.
4. Your web browser opens (or go to **http://127.0.0.1:3000**). The first screen asks you to **create the administrator account**. Choose a long password and **write it down**: there is no "forgot password" email.
5. Look around. It starts with **sample aircraft and invented prices** so you can practise. Add a buyer under **Leads**, open a deal, type in the buyer's offer, and read the suggested reply. Nothing leaves your computer.
6. To stop it, close the window (Windows) or press **Ctrl+C** (Mac).

When you are ready to use your own aircraft, stop it and start it again with the word **real** after the file name (`start.bat real`, or `bash start.sh real` on Mac). That starts empty. Then use **Inventory, Import from CSV** to load your aircraft (there is a template to download on that page).

Your information is saved in the folder `platform/data` on your computer. Copy that folder somewhere safe to make a backup.

### If the browser says "refused to connect" (ERR_CONNECTION_REFUSED)

That message only means the program is **not running**. A browser cannot start it; the black window from `start.bat` (or `start.sh`) is the program, and it must stay open.

1. Look for the black window. It should say `Platform on http://127.0.0.1:3000` (the number may be 3001 or higher if 3000 was busy; the browser opens on the right one by itself). Keep it open.
2. If the window shows a message, it says what to fix. The usual ones:
   - **"Cannot find the platform folder"**: you started it from inside the zip. Right-click the zip, choose Extract All, and start it from the new folder.
   - **"Node.js is not installed"** or **"too old"**: install the LTS version from https://nodejs.org, **restart the computer**, and start it again. (Version 22.13 or newer is needed.)
   - **"Port ... is already in use"**: the program is already running in another window. Use that one, or close it and start again.
3. If the window disappears instantly: open the folder, click the address bar at the top, type `cmd` and press Enter, then type `start.bat` and press Enter. The window now stays open. Take a photo or screenshot of the text and send it to me.
4. Make sure you downloaded the **latest zip** (the link in Part 1 always gives the newest version).

### Ако пишува „refused to connect" (ERR_CONNECTION_REFUSED)

Тоа значи само дека програмата **не работи**. Прелистувачот не може сам да ја стартува. Црниот прозорец од `start.bat` е самата програма и мора да остане отворен.

1. Побарај го црниот прозорец. Треба да пишува `Platform on http://127.0.0.1:3000` (бројот може да е 3001 или повисок ако 3000 е зафатен; прелистувачот сам се отвора на вистинската адреса). Остави го отворен.
2. Ако прозорецот прикажува порака, таа кажува што да поправиш. Најчести:
   - **„Cannot find the platform folder"**: си го стартувал од внатре во zip-от. Десен клик на zip, „Extract All", па стартувај од новата папка.
   - **„Node.js is not installed"** или **„too old"**: инсталирај ја LTS верзијата од https://nodejs.org, **рестартирај го компјутерот** и стартувај пак. (Треба верзија 22.13 или понова.)
   - **„Port ... is already in use"**: програмата веќе работи во друг прозорец. Користи го тој, или затвори го и стартувај пак.
3. Ако прозорецот исчезне веднаш: отвори ја папката, кликни на адресната лента горе, напиши `cmd` и притисни Enter, па напиши `start.bat` и притисни Enter. Сега прозорецот останува отворен. Сликај го текстот и испрати ми го.
4. Провери дали си го симнал **најновиот zip** (линкот во Дел 1 секогаш дава најнова верзија).

## Part 2. Put it on the internet for your team (about 1 hour, a few dollars a month)

You need two things from other companies. **I cannot create or pay for these for you.**

1. **A small server.** At any hosting company (DigitalOcean, Hetzner, Vultr, Linode, AWS Lightsail...) rent a basic **Ubuntu** server with **2 GB of memory**. They email you an address and a way to log in.
2. **A web address**, for example `deals.yourcompany.com`. In your domain provider's settings, add a record of type **A** that points that name to the server's address. Wait about 15 minutes.

Then log in to the server (the hosting company explains how; it is a text window) and paste these four lines, replacing the address in the last line with yours:

```
sudo apt-get update && sudo apt-get install -y unzip curl
curl -L -o app.zip https://github.com/Ljupcho1982/Jetblue/archive/refs/heads/ccr-4429975c-yke6ow.zip
unzip app.zip && cd Jetblue-ccr-4429975c-yke6ow
sudo bash setup-server.sh deals.yourcompany.com
```

It installs everything, switches on the secure padlock (HTTPS) automatically, and tells you when it is ready. **Open your address straight away and create the administrator account**, because the first person to open it becomes the administrator. The script also creates a secret code in `platform/.env`; **copy the `APP_SECRET` line into your password manager.**

If something does not work, run `docker compose logs --tail 50` in that folder and send me what it prints.

## Part 4. Cloudflare

Cloudflare cannot run the real program on its own "Workers" hosting: the real program is a normal server with a database file, and Workers cannot run that without rewriting it. Two things do work on Cloudflare today.

### A. Put the clickable demo online (free, about 5 minutes, no server)
This is the same demo you saw in the browser: sample data only, nothing saved. It is a plain web page, so Cloudflare hosts it easily, and you get a shareable web address.
1. Do Part 1 first so Node.js is installed and the project is extracted.
2. Open a terminal **in the `platform` folder** (open the folder, click the address bar, type `cmd`, press Enter).
3. Run these two commands. The first opens your browser so you can sign in to your Cloudflare account (it is free to create one); the second builds and publishes the demo:
```
npx wrangler login
npm run deploy:preview
```
4. It prints an address like `https://aircraft-deal-preview.YOURNAME.workers.dev`. Open it. To update it later, run the second command again.

Prefer clicking over typing? In the Cloudflare dashboard go to **Workers & Pages**, create an application from a Git repository, pick this GitHub project and branch, and set: root directory `platform`, build command `npm run build:preview`, deploy command `npx wrangler deploy`. (Cloudflare changes its screens now and then, so the wording may differ a little.)

### B. Use the real program from the internet through Cloudflare (a "tunnel")
The real program keeps running on your own computer (or a small server), and a free Cloudflare tunnel gives it a secure `https://` address that others can open. Nothing is uploaded to Cloudflare except the traffic passing through.
1. **Create the administrator account first, on your own computer** (Part 1, open http://127.0.0.1:3000). The first person to open a new installation becomes the administrator, so never put an empty installation on the internet.
2. Install the Cloudflare tunnel program (`cloudflared`): Windows, in a terminal run `winget install Cloudflare.cloudflared`; Mac, run `brew install cloudflared`.
3. Start the program as in Part 1 but tell it a proxy is in front of it. In a terminal in the project folder:
   - Windows: `set TRUST_PROXY=1` and then `start.bat real`
   - Mac: `TRUST_PROXY=1 bash start.sh real`
4. Open a **second** terminal window and run:
```
cloudflared tunnel --url http://127.0.0.1:3000
```
   (If the first window says the program is on a different port, use that number instead of 3000.) It prints a temporary address ending in `trycloudflare.com`. That is your public address. It changes each time you start it.
5. Turn on two-factor sign-in on the Account page before sharing the address, and give people only the roles they need. The computer must stay on and awake while others use it. For a permanent address on your own domain, use a "named tunnel" (in the Cloudflare dashboard under Zero Trust, Networks, Tunnels) instead of the temporary one.

A tunnel from a home computer is fine for a trial. For a team that depends on it, a small rented server (Part 2) is more reliable, and it can sit behind Cloudflare too.

## Part 5. Before real customers

- Read **platform/PILOT.md**: a two-week checklist for trying it with one or two brokers.
- Turn on two-factor sign-in (Account page). Administrators are required to by default on a server.
- **Your GitHub project is public, and that is fine.** It was checked: the whole history contains no passwords, keys or personal data, every change is credited to a generic "Claude" author (not your email), and the settings file `.env`, the database (`platform/data`), backups and your sanctions list are all excluded from Git so they cannot be uploaded by accident. The app's security does not depend on the code being secret. Three things to remember:
  - **Never commit real data.** Do not put real buyers, passwords, the `.env` file or your own aircraft price limits in files you upload to GitHub. (The sample aircraft and prices in the code are invented.)
  - **The project uses the MIT licence** (see the file `LICENSE`): anyone may use, copy, change and sell it, as long as they keep the copyright notice, and it comes with no warranty. The notice names your GitHub account; if you want your real name there, edit that one line.
  - `docs/business-plan.md` is public too. Delete it from the project if you would rather not publish your plan.
- Ask a compliance adviser and a lawyer to review the screening and privacy handling before you contact real buyers.

## What this does not do
It does not check aircraft ownership or registration, write contracts, handle payments or financing, or send replies without your approval. Those stay with you.
