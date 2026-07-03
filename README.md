# Zentavo MCP

Servidor [MCP](https://modelcontextprotocol.io) para manejar tus finanzas de **Zentavo** desde Claude, ChatGPT, Cursor o cualquier cliente compatible — en lenguaje natural.

No corre ningún modelo: es una capa de herramientas sobre la API pública de Zentavo (`/api/v1`). El LLM lo pone tu cliente (Claude/ChatGPT), así que **los tokens los pagas tú en tu cuenta**, no Zentavo.

## Requisitos

1. Una cuenta de Zentavo con acceso activo.
2. Una o más **API keys**: en la app → **Configuración → API** → crear key (`read` y/o `write`). Cópiala (solo se muestra una vez). **Cada key queda atada a un plan.**
3. Node.js ≥ 18.

## Configurar en tu cliente

### Un solo plan

La key va en `ZENTAVO_API_KEY`:

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

### Varios planes

Genera una key por plan y pásalas en `ZENTAVO_PLANS` (JSON con `name` + `key`). Una sola conexión cubre todos:

```json
{
  "mcpServers": {
    "zentavo": {
      "command": "npx",
      "args": ["-y", "github:magiobus/zentavomcp"],
      "env": {
        "ZENTAVO_PLANS": "[{\"name\":\"personal\",\"key\":\"zsk_live_AAA\"},{\"name\":\"negocio\",\"key\":\"zsk_live_BBB\"},{\"name\":\"casa\",\"key\":\"zsk_live_CCC\"}]"
      }
    }
  }
}
```

Con varios planes, cada herramienta acepta un parámetro **`plan`** (el `name`) que decide a cuál mandar. Usa `list_plans` para ver los nombres disponibles. El modelo puede inferirlo del contexto (*"en mi plan de negocio, registra…"*).

Opcional: `ZENTAVO_BASE_URL` (default `https://zentavo.lat/api/v1`).

### Desarrollo local (sin npm)

```json
{
  "mcpServers": {
    "zentavo": {
      "command": "node",
      "args": ["/ruta/absoluta/a/zentavomcp/index.js"],
      "env": { "ZENTAVO_API_KEY": "zsk_live_..." }
    }
  }
}
```

Reinicia el cliente y ya puedes pedirle cosas como *"¿cuánto gasté este mes?"* o *"registra un gasto de 120 en Oxxo"*.

## Herramientas

- **Planes:** `list_plans` (ver los planes configurados en esta conexión, con su moneda base).
- **Lectura** (key con scope `read`): `list_accounts` (con `withBalances` opcional), `list_transactions` (con paginación `before`/`hasMore`), `get_transaction`, `list_categories`, `get_category`, `list_budgets`, `get_summary`, `list_loans`, `get_networth_history`.
- **Escritura** (key con scope `write`): `create_transaction`, `update_transaction`, `delete_transaction`, `create_category`, `update_category`, `delete_category`, `assign_budget`, `create_loan`, `create_account`, `update_account`.

Los montos van como decimal (ej. `45.50`); el server los convierte a milliunits para la API. Si el monto está en una divisa distinta a la de la cuenta, pasa `spentCurrency` (ej. `"MXN"` pagando con cuenta USD) y el servidor convierte con el tipo de cambio del día. Las **respuestas** de la API traen los montos en milliunits (`1000 = $1.00`).

### Préstamos

`create_loan` con `direction: "lend"` registra que prestaste; con `"borrow"` que te prestaron **o que te abonaron un préstamo existente** (mismo `contactName`). `list_loans` da el saldo por contacto: positivo = te deben, negativo = debes.

## Probar con MCP Inspector

```bash
ZENTAVO_API_KEY=zsk_live_... npx @modelcontextprotocol/inspector node index.js
```

Con `ZENTAVO_BASE_URL=http://localhost:3000/api/v1` puedes apuntar a un server local.

## Notas

- Si una key pierde acceso (suscripción vencida o te sacan del plan), sus herramientas devuelven error — las demás siguen.
- Una key `read` que intente escribir recibe `HTTP 403` (el error incluye el status para que el modelo lo explique).
- La API tiene rate limit (~300 req/min por key); al excederlo verás `HTTP 429`.
- Docs de la API: `https://zentavo.lat/docs`.
