# Publicar una versión

[English](RELEASING.md) · **Español**

Las versiones se publican en npm como [`iamagnus`](https://www.npmjs.com/package/iamagnus)
mediante el workflow `Release`, con *provenance*, a través de la publicación de
confianza de npm (*trusted publishing*): en este repositorio no vive ningún
token.

## Configuración, una sola vez

npm solo permite configurar un trusted publisher en un paquete que ya existe,
así que la primera versión se publica a mano:

1. `npm login`, y después `npm publish --access public` desde un checkout limpio
   del commit de la versión. `prepublishOnly` corre antes el chequeo de tipos,
   los tests y el build.
2. En npmjs.com, abre *Settings → Trusted publishing* del paquete y agrega
   GitHub Actions: owner `MeGrimlock`, repositorio `magnus-node-sdk`, workflow
   `release.yml`, environment `npm`.
3. En GitHub, en *Settings → Environments*, crea un environment llamado `npm`.

## En cada versión

1. Pon la misma versión en `package.json` y en `VERSION` de `src/client.ts`.
2. Corre `npm run livecheck` contra la API de producción con un agente de
   prueba. Tienen que pasar los catorce chequeos.
3. Haz el commit, crea el tag y súbelo:

   ```bash
   git tag v0.2.0
   git push origin main v0.2.0
   ```

El workflow rechaza un tag que no coincida con las dos cadenas de versión, y
después `npm publish` corre el chequeo de tipos, los tests y el build antes de
subir el paquete.

## La instalación desde GitHub depende del tag y de `prepare`

La sección *Instalar sin el registro de npm* del README instala desde un tag de
este repositorio, así que funciona en cuanto el repositorio es público y el tag
está subido, haya aceptado npm la publicación o no. Cuando cambie la versión,
actualiza el tag en esa sección de `README.md` y de `README.es.md`, y en el
dashboard de Magnus (`sdk_links_section.dart` en el front end).

`dist/` no se commitea. Una instalación desde GitHub lo compila con el script
`prepare`; sin ese script el paquete se instala sin `dist/` y todos los imports
fallan.

Si `CONTRACT.md` cambió, cambia igual en los SDKs de Python y Go, junto con su
traducción `CONTRACT.es.md`.
