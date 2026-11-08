# SWAT MCP Gateway

Gateway minimo para que el navegador consuma NeuralBus sin recibir la API key privada.

## Configuracion

```powershell
Copy-Item .env.example .env
# Editar .env y completar SWAT_MCP_API_KEY, SWAT_MCP_FEED_TOOLS y SWAT_MCP_QUERY_TOOL
Set-Location gateway
npm run check
npm start
```

La API key solo se lee desde el proceso Node. El navegador consume la fachada REST
`http://localhost:8787/api/v1` en desarrollo o el dominio publico del gateway en produccion.

## Endpoints

- `GET /healthz`: estado de configuracion sin revelar secretos.
- `GET /api/v1/capabilities`: capacidades publicas, no el catalogo MCP completo.
- `GET /api/v1/feed`: ejecuta internamente los feeds configurados.
- `POST /api/v1/query`: ejecuta internamente la consulta configurada.

Las tools upstream deben declararse explicitamente en `SWAT_MCP_FEED_TOOLS` y
`SWAT_MCP_QUERY_TOOL`. El cliente nunca elige una tool MCP ni envia argumentos arbitrarios.

