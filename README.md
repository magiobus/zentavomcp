# Zentavo MCP

Servidor [MCP](https://modelcontextprotocol.io) para manejar tus finanzas de **Zentavo** desde Claude, ChatGPT, Cursor o cualquier cliente compatible — en lenguaje natural.

No corre ningún modelo: es una capa de herramientas sobre la API pública de Zentavo (`/api/v1`). El LLM lo pone tu cliente (Claude/ChatGPT), así que **los tokens los pagas tú en tu cuenta**, no Zentavo.

## Requisitos

1. Una cuenta de Zentavo con acceso activo.
2. Una **API key**: en la app → **Configuración → API** → crear key (con permiso `read` y/o `write`). Cópiala (solo se muestra una vez). La key queda atada a un plan.
3. Node.js ≥ 18.

## Configurar en tu cliente

La key va en la variable de entorno `ZENTAVO_API_KEY`. Opcional: `ZENTAVO_BASE_URL` (default `https://zentavo.lat/api/v1`).

### Claude Desktop / Cursor

Edita el archivo de config MCP (`claude_desktop_config.json` o el de Cursor):

```json
{
  "mcpServers": {
    "zentavo": {
      "command": "npx",
      "args": ["-y", "github:magiobus/zentavomcp"],
      "env": { "ZENTAVO_API_KEY": "zsk_live_..." }
    }
  }
}
```

Para desarrollo local (sin npm), apunta a la carpeta directamente:

```json
{
  "mcpServers": {
    "zentavo": {
      "command": "node",
      "args": ["/ruta/absoluta/a/ynabsito/mcp/index.js"],
      "env": { "ZENTAVO_API_KEY": "zsk_live_..." }
    }
  }
}
```

Reinicia el cliente y ya puedes pedirle cosas como *"¿cuánto gasté este mes?"* o *"registra un gasto de 120 en Oxxo"*.

## Herramientas

**Lectura** (key con scope `read`): `list_accounts`, `list_transactions`, `get_transaction`, `list_categories`, `list_budgets`, `get_summary`.

**Escritura** (key con scope `write`): `create_transaction`, `update_transaction`, `delete_transaction`, `create_category`, `assign_budget`.

Los montos en las herramientas van en la moneda de la cuenta como decimal (ej. `45.50`); el server los convierte a milliunits para la API. El plan lo resuelve la key — no tienes que mandarlo.

## Notas

- Si la key pierde acceso (suscripción vencida o te sacan del plan), las herramientas devuelven error.
- Una key `read` que intente escribir recibe 403.
- Docs de la API: `https://zentavo.lat/docs`.
