# Contrato MCP publico de SWAT

Este contrato define la frontera entre el navegador publico y NeuralBus. No concede acceso directo al servidor MCP ni expone credenciales.

## Seguridad

- `SWAT_MCP_API_KEY` vive solo en el proceso del gateway.
- El navegador usa una fachada REST: `/api/v1/capabilities`, `/api/v1/feed` y `/api/v1/query`.
- Las tools upstream se declaran en `SWAT_MCP_FEED_TOOLS` y `SWAT_MCP_QUERY_TOOL`.
- El cliente nunca elige una tool MCP ni envia argumentos MCP arbitrarios.
- El gateway aplica limite por IP y tamano maximo de cuerpo.
- No se registran bodies, API keys ni respuestas sensibles en logs.

## Metodos upstream permitidos

El gateway usa internamente unicamente:

- `initialize`
- `notifications/initialized`
- `tools/list`
- `tools/call`

## Endpoints publicos

- `GET /healthz`
- `GET /api/v1/capabilities`
- `GET /api/v1/feed`
- `POST /api/v1/query` con `{ "query": "...", "locale": "es" }`

## Estados HTTP del gateway

| Estado | Significado |
|---|---|
| 200 | Respuesta MCP entregada |
| 204 | Preflight CORS aceptado |
| 400 | JSON invalido |
| 401 | Sesion publica desconocida |
| 403 | Tool no incluida en la allowlist publica |
| 405 | Metodo MCP no expuesto |
| 413 | Cuerpo demasiado grande |
| 429 | Limite de uso excedido |
| 502 | NeuralBus no accesible |
| 503 | Gateway sin configuracion segura |

## Limite actual

La allowlist y el rate limit estan en memoria del proceso. Antes de produccion deben respaldarse con la autenticacion y control de cuota de SWAT, y la sesion debe externalizarse si se ejecutan varias replicas.

