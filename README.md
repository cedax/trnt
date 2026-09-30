# Magnet Box

App privada y mínima para pegar enlaces magnet, comprobar que existan pares con piezas útiles, descargar a disco y reproducir videos desde el navegador.

El mismo campo acepta una URL de resultados de búsqueda de Pirate Bay. La app extrae la consulta, usa la API JSON pública, ignora los resultados que reportan cero seeders, elimina duplicados e importa hasta 50 torrents por operación. Puedes cambiar ese máximo con `SEARCH_IMPORT_LIMIT` (entre 1 y 100). El número publicado de seeders es orientativo; cada torrent sigue pasando después por la comprobación real de pares de Magnet Box.

Cada descarga activa puede pausarse y reanudarse. Al cancelar, el torrent se detiene, se quita de la lista y se eliminan sus archivos parciales.

Los videos se muestran como una galería adaptable con miniaturas. En computadora se previsualizan al dejar el mouse encima; en Android, al mantener presionada la miniatura.

La barra de búsqueda encuentra torrents y videos por nombre. También puedes filtrar por estado, ordenar los resultados y quitar una descarga completa de la lista sin borrar sus archivos.

Si agregas nuevamente el mismo magnet, la app verifica los datos que ya existen y descarga únicamente los archivos o fragmentos faltantes. Los archivos completos reutilizados tampoco se eliminan al cancelar una reanudación.

El estado se guarda en `downloads/.magnet-box-state.json`: magnets, metadatos del torrent, piezas verificadas, pausa y fechas de modificación. Al reiniciar el servicio, las descargas se restauran automáticamente y los archivos sin cambios usan una verificación rápida en lugar de recalcular todos sus hashes.

Los torrents nuevos se guardan en carpetas independientes identificadas por su hash para impedir que dos descargas con nombres iguales oculten o sobrescriban archivos. Las descargas creadas con versiones anteriores conservan su ubicación original.

## Antes de ejecutarla

La configuración privada está en `.env`, que Git ignora. En un servidor nuevo, crea el archivo a partir del ejemplo:

```bash
cp .env.example .env
nano .env
```

Cambia como mínimo `APP_USER`, `APP_PASSWORD` y `SESSION_SECRET`. También puedes configurar los puertos, carpeta de descargas, duración de sesión, conexiones máximas, trackers y opciones de importación desde ese archivo.

La contraseña solo existe en el backend. El navegador envía lo que escribes en el formulario y conserva únicamente una cookie de sesión `HttpOnly`.

## Ejecutar

Requiere Node.js 20.12 o superior.

```bash
npm install
npm start
```

Abre `http://IP-DEL-SERVIDOR:3250`. Los archivos se guardan en `./downloads`; ambos valores pueden cambiarse en `.env`.

## EC2

En Ubuntu, instala Node.js 20.12+, copia esta carpeta y `.env`, ejecuta `npm install --omit=dev` y arranca con `npm start`. Para dejarlo permanente puedes usar `pm2`:

```bash
sudo npm install -g pm2
pm2 start server.js --name magnet-box
pm2 save
pm2 startup
```

Para uso real, pon Nginx o Caddy delante con HTTPS y no expongas el puerto 3250 públicamente. Abre TCP y UDP `6881` (o el valor de `TORRENT_PORT`) en el grupo de seguridad para mejorar la conectividad entre pares.

## Notas

- La app espera hasta 90 segundos por pares que tengan piezas faltantes. Si aún no aparecen, mantiene el torrent en espera y continúa buscando sin descargar datos inútiles.
- MP4 y WebM suelen reproducirse en todos los navegadores. MKV/AVI dependen de los códecs del navegador; la app no transcodifica para mantenerse ligera.
- Usa la aplicación únicamente con contenido que tengas derecho a descargar y compartir.
