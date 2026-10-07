# Magnus SDK para Node.js

[English](README.md) · **Español**

El cliente oficial de Node.js y TypeScript para
**[Magnus Core](https://core.iamagnus.com)**: agentes de IA gobernados detrás de
una API compatible con OpenAI. El modelo entiende y redacta; las reglas del
agente deciden qué pasa y qué acciones esperan una confirmación, y cada turno
deja una traza.

```bash
npm install iamagnus
```

Node 20+. Sin dependencias en tiempo de ejecución. ESM, con tipos incluidos. Si
`npm install iamagnus` falla, el mismo paquete se instala directo desde GitHub:
ver [Instalar sin el registro de npm](#instalar-sin-el-registro-de-npm).

```ts
import { MagnusClient } from "iamagnus";

const client = new MagnusClient({
  baseUrl: "https://app.iamagnus.com",
  apiKey: "magnus_sys_...",
});

const [agent] = await client.listAgents();

// Un hilo por usuario final: lo continúa `user`, no el historial reenviado.
const chat = client.conversation(agent.id, { user: "jane@company.com" });

console.log(await chat.send("Hola, ¿qué puedes hacer?"));
console.log(await chat.send("¿Y el precio?"));
```

## Instalar sin el registro de npm

Úsalo cuando el paquete no está en npm o la máquina no llega al registro. El
código es el mismo y el import también:
`import { MagnusClient } from "iamagnus"`.

**Desde GitHub.** npm descarga un tag de este repositorio y lo compila al
instalarlo. Necesita `git` en la máquina:

```bash
npm install github:ABZ-LABS/magnus-node-sdk#v0.1.0
```

lo que deja esto en `package.json`:

```json
"dependencies": {
  "iamagnus": "github:ABZ-LABS/magnus-node-sdk#v0.1.0"
}
```

Fija un tag, como arriba, para que cada instalación reciba el mismo código.
`#main` sigue al último commit, que no es una versión publicada. Compilar al
instalar trae TypeScript del registro de npm por un momento; si el registro no
está accesible en absoluto, usa un tarball.

**Sin acceso de red a GitHub ni a npm** (un CI cerrado, la red de un cliente).
Construye el tarball una vez en una máquina con acceso y entrega el archivo
junto con el proyecto:

```bash
git clone --branch v0.1.0 https://github.com/ABZ-LABS/magnus-node-sdk
cd magnus-node-sdk && npm ci && npm pack
# iamagnus-0.1.0.tgz va dentro del proyecto, por ejemplo en vendor/

npm install ./vendor/iamagnus-0.1.0.tgz
```

El tarball está completo: la biblioteca no tiene dependencias en tiempo de
ejecución.

## Obtener una API key

1. En el dashboard de Magnus, abre **System API Keys**, en *Integration keys*
   del menú lateral. La ven los administradores de la organización.
2. **Create key**, y elige **qué agente responde** (*Which agent should
   answer?*). Una key se crea para un agente y siempre responde como ese
   agente: `listAgents()` devuelve exactamente ese, y nombrar otro agente de
   tu organización se rechaza con `model_not_allowed`. Las keys para tus
   propios agentes requieren un plan pago; los agentes de muestra están
   abiertos en todos los planes.
3. En **What will use this key?**, deja **My app or backend**. Esa elección
   queda registrada en cada turno que corre la key, así que conviene una key
   por integración en lugar de una compartida.
4. **Cópiala en el momento.** Magnus guarda solo un hash y muestra la key una
   sola vez.

Las keys empiezan con `magnus_sys_` (`magnus_gpt_` si se crearon para un
cliente de chat como OpenWebUI).

> **No confundir con "LLM API Keys".** Esa pantalla guarda *tus* credenciales
> de OpenAI, Anthropic u otro proveedor, para que Magnus llame a los modelos en
> tu nombre. No te autentican contra Magnus; usar una aquí da 401.

## Apuntar el cliente a un despliegue

La URL base es configuración, no una constante: la biblioteca no trae nada de
`iamagnus.com` incorporado. El servicio alojado es `https://app.iamagnus.com`,
la misma dirección que el dashboard. Pasa la **raíz del servidor**, sin `/v1`:
el cliente arma `/v1/...` por su cuenta, más `/api/health/simple`, que vive
fuera de ese prefijo.

```ts
const hosted = new MagnusClient({ baseUrl: "https://app.iamagnus.com", apiKey: "magnus_sys_..." });
const local  = new MagnusClient({ baseUrl: "http://localhost:5001",    apiKey: "magnus_sys_..." });

// En un despliegue, lee las dos del entorno:
const client = new MagnusClient({
  baseUrl: process.env.MAGNUS_BASE_URL!,
  apiKey: process.env.MAGNUS_API_KEY!,
});
```

Una barra final se recorta, y una URL vacía falla al construir el cliente en
lugar de aparecer como un error de transporte ilegible.

### Probar la URL y la key por separado

```ts
await client.health();      // sin key: prueba que la URL es correcta
await client.listAgents();  // usa la key: prueba la credencial
```

Si `health()` funciona y `listAgents()` lanza un 401, el problema es la key, no
la URL, y viceversa.

## En qué se diferencia de OpenAI

**La key elige el agente.** `model` no decide quién responde; lo decide el
agente de la key. Nombrar otro agente de la organización se rechaza
(`model_not_allowed`), y cualquier otro valor, como `gpt-4o`, se ignora, así
que un cliente de OpenAI funciona sin cambios.

**Un hilo es el usuario final, no el historial.** El servidor lee solo el
último mensaje del usuario y guarda la memoria y el estado de la conversación
de su lado, así que reenviar el historial no restaura nada. Hay un hilo vivo
por (API key, `user`, agente): el mismo `user` lo continúa, y termina tras 30
minutos sin actividad. **Pasa siempre `user`**: sin él, todos los que llaman
con la key comparten un mismo hilo. Cada respuesta informa en qué sesión corrió
el servidor, pero devolverle un id de sesión no permite elegir, retomar ni
reiniciar un hilo.

**El agente es dueño del turno.** `tools`, `tool_choice`, `functions`,
`function_call`, `response_format` y `n > 1` se *rechazan*, no se ignoran: las
herramientas se configuran por agente y el formato de la respuesta lo decide el
agente. `temperature`, `max_tokens`, `top_p`, `stop`, `seed` y
`presence_penalty` se aceptan y se ignoran: también los maneja el agente.
Algunos clientes de OpenAI mandan `tool_choice: "auto"` o
`response_format: {"type": "text"}` por defecto; cuentan como definidos y se
rechazan, así que quítalos.

**Algunos límites responden 200.** Cuando un usuario final, la organización o
su plan se quedan sin turnos, el turno devuelve HTTP 200 con una frase en lugar
de una respuesta, `usage_source: "estimated"` y sin trace id; no un 429. La
lista está en [CONTRACT.es.md](CONTRACT.es.md#límites-que-responden-200).

**Una persona puede tomar la conversación.** Cuando el agente deriva a alguien
de tu equipo, o lo toman desde el panel, el agente deja de responder hasta que
el equipo se la devuelva. Cada turno sigue devolviendo 200 —primero el mensaje
de derivación del agente, después un aviso fijo— y `chat.handoff` es `true`
mientras una persona esté a cargo. Lo que escribe la persona no es la
respuesta a ningún turno, así que este cliente lo trae —algo que un cliente de
OpenAI no puede hacer—:

```ts
await chat.send("Quiero hablar con alguien");
if (chat.handoff) {
  // Consulta cada 5 s y termina cuando vuelve el agente; author es siempre "human".
  for await (const message of chat.follow()) show(message.content);
}
```

`chat.updates()` devuelve lo nuevo sin esperar, para tu propio bucle, y
`follow({ signal })` se corta con un `AbortSignal`. Para no mostrar una
respuesta dos veces entre reinicios, guardá `chat.lastUpdateId` y volvé a
ponerlo en la conversación nueva.

**Un turno en streaming puede fallar después del HTTP 200.** Una vez que salió
el primer fragmento, la línea de estado ya no se puede cambiar, así que el
fallo llega *dentro* del stream. Este cliente lanza un `StreamError` en lugar
de entregar una respuesta truncada como si fuera un éxito.

## Streaming

```ts
const stream = await chat.stream("Cuéntame más");

for await (const delta of stream) {
  process.stdout.write(delta);
}

console.log(stream.text, stream.sessionId, stream.magnus.usage_source);
```

`await stream.collect()` lo consume en una sola llamada. Dos formas son
normales y las dos se manejan: token por token, y un único delta para un turno
que el servidor entrega entero. `{ includeUsage: true }` agrega el fragmento
final con `stream.usage`.

Un turno que falla a mitad del stream lanza la excepción fuera del bucle:

```ts
import { StreamError } from "iamagnus";

try {
  for await (const delta of stream) process.stdout.write(delta);
} catch (error) {
  if (error instanceof StreamError) {
    // error.partialText es lo que el lector ya vio
    console.error(error.code, error.serverMessage);
  }
}
```

## Errores

Cada fallo trae el sobre de error del servidor:

```ts
import { AuthenticationError, RateLimitError, UnsupportedParameterError } from "iamagnus";

try {
  await client.chat(agentId, messages);
} catch (error) {
  if (error instanceof RateLimitError) await sleep((error.retryAfter ?? 5) * 1000);
  else if (error instanceof UnsupportedParameterError) console.error(`rechazado: ${error.param}`);
  else if (error instanceof AuthenticationError) throw new Error("API key inválida");
}
```

| Clase | Estado |
|---|---|
| `InvalidRequestError` | 400, incluido `code: model_not_allowed` (la key es de otro agente) |
| `UnsupportedParameterError` | 400, `code: unsupported_parameter` (extiende la anterior) |
| `AuthenticationError` | 401 |
| `PermissionDeniedError` | 403, la organización de la key no existe o está desactivada |
| `NotFoundError` | 404 |
| `ConflictError` | 409, un turno con este `Idempotency-Key` sigue corriendo |
| `RateLimitError` | 429, ver `.retryAfter` |
| `ServerError` | 5xx |
| `MagnusConnectionError` / `MagnusTimeoutError` | nunca llegó a Magnus, o dejó de esperar |
| `StreamError` | el turno falló después de abrirse el stream |

Todas extienden `MagnusError`. `.status`, `.type`, `.code`, `.param`,
`.headers` y `.serverMessage` traen las palabras del propio servidor.

## Reintentos e idempotencia

Un turno hace avanzar la conversación y puede correr herramientas con efectos,
así que reintentarlo a ciegas puede duplicarlos. Por eso este cliente
reintenta:

- **GET** siempre, ante 429/5xx y fallos de transporte;
- **POST** solo si pasaste un `idempotencyKey`, porque entonces el servidor
  repite su primera respuesta en lugar de correr el turno otra vez;
- **nunca un stream**: un cuerpo en streaming no se puede repetir.

Se respeta `Retry-After`; si no viene, la espera crece exponencialmente con
variación aleatoria.

```ts
await client.chat(agentId, messages, { idempotencyKey: crypto.randomUUID() });
```

Usa un UUID nuevo en cada turno: el servidor compara la key en toda la
organización durante 24 horas, sin mirar el cuerpo ni el usuario final.

## Medición

`response.usage` trae los conteos reales de tokens del proveedor cuando
`response.magnus.usage_source === "measured"`. `"estimated"` significa que el
turno nunca llegó a un LLM, lo que incluye los límites que responden 200, y los
números son una heurística de `len/4`. **No factures sobre una estimación.**

`client.rateLimitRemaining` guarda el último cupo visto para la key.

## Multi-tenencia

`{ user: "jane@company.com" }` en el cliente, en la conversación o en una
llamada. Define el campo `user` de OpenAI, y es lo que separa a tus usuarios
finales: cada valor es una persona, con su propio hilo y su memoria, y una
llamada sin él cae en el único hilo que comparten todos los de la key. Lo que
va antes de una `@` pasa a ser el nombre que ve el agente. Los valores dependen
de la key: una key nueva o rotada hace empezar de cero a cada persona.

## Verificar un despliegue

`magnus-livecheck` corre los catorce chequeos de [CONTRACT.es.md](CONTRACT.es.md)
contra un despliegue real y sale con un código distinto de cero salvo que pasen
todos:

```bash
export MAGNUS_BASE_URL=https://app.iamagnus.com
export MAGNUS_API_KEY=magnus_sys_...   # una key creada para un agente de prueba

npx magnus-livecheck
```

Los chequeos 5, 8, 9, 10 y 13 corren turnos reales, que gastan tokens y quedan
registrados como cualquier conversación. Una key responde solo como su propio
agente, así que crea la key para un agente de prueba.

## API

| | |
|---|---|
| `new MagnusClient({ baseUrl, apiKey, user?, timeout?, maxRetries?, authScheme? })` | |
| `health()` | prueba de alcance sin autenticación |
| `listAgents()` / `getAgent(id)` | agentes; un id desconocido es `null` |
| `chat(agent, messages, opts?)` | un turno completo |
| `streamChat(agent, messages, opts?)` | un turno en streaming |
| `sendMessage(agent, content, opts?)` | entra texto, sale texto |
| `conversation(agent, { user?, sessionId? })` | un hilo para un usuario final: `.send()`, `.stream()`, `.reset()`; después de cada turno `.lastTraceId`, `.lastUsageSource` y `.handoff`; las respuestas del equipo con `.updates()` y `.follow({ intervalMs?, signal? })` |
| `conversationUpdates(agent, { user?, after? })` | una página de respuestas del equipo, en crudo |

`opts.extraBody` reenvía campos del servidor más nuevos que esta biblioteca.
Cada detalle del cable está en [CONTRACT.es.md](CONTRACT.es.md).

## Desarrollo

```bash
npm install
npm run verify   # chequeo de tipos + tests
```

La suite corre contra un Magnus falso que implementa
[CONTRACT.md](CONTRACT.md) sobre sockets reales, así que el framing de SSE y
los cortes entre fragmentos se ejercitan de verdad. Correr los tests de
TypeScript directamente requiere Node 22.18 o posterior. Las versiones se
describen en [RELEASING.es.md](RELEASING.es.md).

## Licencia

[Apache License 2.0](LICENSE). Ver [NOTICE](NOTICE) para la atribución.
