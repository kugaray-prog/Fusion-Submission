# GeoAttend — Paano Patakbuhin

## A. Unang beses (bagong setup)

1. Buksan ang Docker Desktop at hintaying "Running" na.

2. Ihanda ang .env. Kung wala pa, kopyahin ang .env.example bilang .env. Siguraduhing tama ang:
   - HOST_LAN_IP: ang Wi-Fi IPv4 ng PC mo (makikita sa ipconfig). Kailangan ito, kasi hindi magsisimula ang expo kapag wala nito.
   - MOBILE_API_BASE_URL at DEVTUNNEL_ID: kailangan lang kung gagamit ng Google Sign-In sa phone.

3. I-build at simulan lahat:

   docker compose up -d --build

   Ganito ang pagkakasunod ng pag-start: db (MySQL) → app (Node server, magsisimula lang kapag healthy na ang db) → expo at tunnel.

4. I-seed ang database (isang beses lang ito):

   docker compose exec app npm run seed

   Gagawa ito ng admin account: admin@my.cspc.edu.ph / password, maliban kung iba ang nakalagay sa DEFAULT_ADMIN_EMAIL / DEFAULT_ADMIN_PASSWORD sa .env.

5. (Opsyonal) Mag-login sa tunnel, isang beses lang, kung kailangan ang HTTPS para sa Google Sign-In:

   docker compose run --rm tunnel login

6. Buksan ang website: http://localhost:3000

7. Mobile app: ipakita ang QR code at i-scan ito gamit ang Expo Go. Dapat nasa iisang Wi-Fi ang phone at ang PC.

   docker compose logs expo --tail 60

## B. Sa mga susunod na araw (hal. pagka-restart ng PC)

1. Buksan ang Docker Desktop.
2. docker compose up -d
3. Buksan ang http://localhost:3000. Para sa phone, i-scan ulit ang QR (docker compose logs expo --tail 60).

Hindi na kailangang mag-seed o mag-build ulit.

## C. Habang nagde-develop

Automatic na ang reload. Basta naka-on ang Docker (docker compose up -d), i-save mo lang ang file sa VS Code at kusa na itong mag-a-update. Hindi mo na kailangang mag-rebuild, mag-restart, o pindutin ang Reload.

1. Website o server

- views/ o public/ (HTML, CSS, JS ng browser): kusang magre-refresh ang browser pagka-save.
- controllers/, routes/, services/, server.js atbp.: kusang magre-restart ang server (nodemon), tapos kusang magre-refresh ang browser pagbalik ng server (mga 2-3 segundo).

Tingnan sa docker compose logs -f app ang "[nodemon] restarting" o "[livereload]" para makita na nakita ang binago mo.

2. Mobile app (mobile/src/, mobile/App.js)

Kusang mag-a-update ang app sa Expo Go (Fast Refresh) pagka-save. Makikita sa docker compose logs -f expo ang "[poll-watch] changed: ...".

Kung minsan hindi nag-update (hal. may error dati sa code), iling ang phone → Reload, o i-restart ang Expo:

docker compose restart expo

3. .env o docker-compose.yml

docker compose up -d

Kusa nitong ire-recreate ang mga container na naapektuhan.

4. Kung nag-install ka ng bagong package (binago ang package.json)

Server: docker compose up -d --build -V app
Mobile: docker compose build expo, tapos docker compose up -d expo

(Ang -V sa server ay para palitan ang lumang node_modules sa loob ng container ng bago.)

## D. Mga madalas gamitin

Gusto mong gawin	Command
Tingnan ang error ng server	docker compose logs -f app
Tingnan ang error ng mobile bundler	docker compose logs -f expo
Ipakita ulit ang Expo QR	docker compose logs expo --tail 60
I-restart ang Expo	docker compose restart expo
Tingnan kung tumatakbo lahat	docker compose ps
Simulan lahat (hal. pagkatapos mag-restart ng PC)	docker compose up -d
