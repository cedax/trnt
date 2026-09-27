# Magnet Box

App privada y mínima para pegar enlaces magnet, comprobar que exista al menos un seeder completo, descargar a disco y reproducir videos desde el navegador.

## Antes de ejecutarla

Abre `server.js` y cambia estas constantes:

```js
const APP_USER = 'admin'
const APP_PASSWORD = 'cambia-esta-clave'
const SESSION_SECRET = 'cambia-tambien-esta-frase-larga-y-privada'
```

La contraseña solo existe en el backend. El navegador envía lo que escribes en el formulario y conserva únicamente una cookie de sesión `HttpOnly`.

## Ejecutar

Requiere Node.js 20 o superior.

```bash
npm install
npm start
```

Abre `http://IP-DEL-SERVIDOR:3000`. Los archivos se guardan en `./downloads`. Puedes cambiar la ruta con `DOWNLOAD_DIR=/ruta/grande`, el puerto web con `PORT=3000` y el puerto BitTorrent con `TORRENT_PORT=6881`.

## EC2

En Ubuntu, instala Node.js 20+, copia esta carpeta, ejecuta `npm install --omit=dev` y arranca con `npm start`. Para dejarlo permanente puedes usar `pm2`:

```bash
sudo npm install -g pm2
pm2 start server.js --name magnet-box
pm2 save
pm2 startup
```

Para uso real, pon Nginx o Caddy delante con HTTPS y no expongas el puerto 3000 públicamente. Abre TCP y UDP `6881` (o el valor de `TORRENT_PORT`) en el grupo de seguridad para mejorar la conectividad entre pares.

## Notas

- La verificación espera hasta 35 segundos por un par que tenga el torrent completo. Si no aparece, no selecciona ni descarga piezas.
- MP4 y WebM suelen reproducirse en todos los navegadores. MKV/AVI dependen de los códecs del navegador; la app no transcodifica para mantenerse ligera.
- Usa la aplicación únicamente con contenido que tengas derecho a descargar y compartir.
