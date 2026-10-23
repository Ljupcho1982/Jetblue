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

## Part 3. Before real customers

- Read **platform/PILOT.md**: a two-week checklist for trying it with one or two brokers.
- Turn on two-factor sign-in (Account page). Administrators are required to by default on a server.
- **Check the repository is private.** Your GitHub project is currently *public*, which means anyone can read the code and the business plan in `docs/`. On GitHub: Settings, scroll to the bottom, "Change visibility". (If you make it private, the download links above will stop working for the server; then download the zip while signed in and upload it to the server instead.)
- Ask a compliance adviser and a lawyer to review the screening and privacy handling before you contact real buyers.

## What this does not do
It does not check aircraft ownership or registration, write contracts, handle payments or financing, or send replies without your approval. Those stay with you.
