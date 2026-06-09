#!/usr/bin/env node
/**
 * Zentavo MCP server — manage your personal finances from Claude / ChatGPT.
 *
 * A thin tools layer over the Zentavo public API (/api/v1). It runs no LLM
 * itself: the host (Claude Desktop, Cursor, ChatGPT, etc.) calls these tools
 * with the user's own model, so token cost is on the user, not on Zentavo.
 *
 * Auth: set ZENTAVO_API_KEY (generated in the app at Configuración → API).
 * The key is bound to one plan, so the plan is resolved automatically.
 *
 * Usage in a host config:
 *   {
 *     "mcpServers": {
 *       "zentavo": {
 *         "command": "npx",
 *         "args": ["-y", "@zentavo/mcp"],
 *         "env": { "ZENTAVO_API_KEY": "zsk_live_..." }
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_KEY = process.env.ZENTAVO_API_KEY;
const BASE_URL = (process.env.ZENTAVO_BASE_URL || "https://zentavo.lat/api/v1").replace(/\/$/, "");

if (!API_KEY) {
  console.error("ZENTAVO_API_KEY no está definida. Genera una key en Configuración → API y pásala en el env del MCP.");
  process.exit(1);
}

/* ─── API helper ─── */

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg = data?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// Money is stored in milliunits (1000 = $1.00). The tools accept decimal
// amounts in the account's currency (e.g. 45.50) and convert at the boundary.
const toMilli = (n) => Math.round(Number(n) * 1000);

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e.message || e}` }], isError: true });

/* ─── Query-string builder (drops undefined) ─── */
function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/* ─── Server ─── */

const server = new McpServer({ name: "zentavo", version: "1.0.0" });

/* ── Lectura ── */

server.registerTool(
  "list_accounts",
  {
    title: "Listar cuentas",
    description: "Lista las cuentas del plan (bancos, efectivo, tarjetas, inversiones, préstamos) con su tipo y moneda.",
    inputSchema: { includeArchived: z.boolean().optional().describe("Incluir cuentas archivadas") },
  },
  async ({ includeArchived }) => {
    try {
      return ok(await api("GET", `/accounts${qs({ includeArchived })}`));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "list_transactions",
  {
    title: "Listar transacciones",
    description: "Lista transacciones (más recientes primero). Filtros opcionales por mes, rango, cuenta, categoría, tipo y texto.",
    inputSchema: {
      month: z.string().optional().describe("Mes YYYY-MM, o 'all' para todo el historial"),
      to: z.string().optional().describe("Fin de rango YYYY-MM (con month)"),
      accountId: z.string().optional(),
      categoryId: z.string().optional(),
      type: z.enum(["expense", "income", "transfer"]).optional(),
      search: z.string().optional().describe("Busca en negocio/nota (mín. 2 caracteres)"),
      limit: z.number().int().optional().describe("Default 100, máximo 500"),
    },
  },
  async (args) => {
    try {
      return ok(await api("GET", `/transactions${qs(args)}`));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "get_transaction",
  {
    title: "Obtener una transacción",
    description: "Obtiene una transacción por su id.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    try {
      return ok(await api("GET", `/transactions/${id}`));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "list_categories",
  {
    title: "Listar categorías",
    description: "Lista las categorías de gasto del plan.",
    inputSchema: { includeArchived: z.boolean().optional() },
  },
  async ({ includeArchived }) => {
    try {
      return ok(await api("GET", `/categories${qs({ includeArchived })}`));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "list_budgets",
  {
    title: "Listar presupuestos del mes",
    description: "Lista las asignaciones de presupuesto por categoría de un mes.",
    inputSchema: { month: z.string().optional().describe("Mes YYYY-MM (default: mes actual)") },
  },
  async ({ month }) => {
    try {
      return ok(await api("GET", `/budgets${qs({ month })}`));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "get_summary",
  {
    title: "Resumen del mes",
    description: "Totales del mes: entró, salió, listo para asignar, patrimonio, y desglose por categoría. Montos en milliunits (1000 = $1.00).",
    inputSchema: {
      month: z.string().optional().describe("Mes YYYY-MM, o 'all'. Default: mes actual"),
      to: z.string().optional(),
      accountIds: z.string().optional().describe("IDs de cuenta separados por coma"),
    },
  },
  async (args) => {
    try {
      return ok(await api("GET", `/summary${qs(args)}`));
    } catch (e) { return fail(e); }
  }
);

/* ── Escritura ── */

server.registerTool(
  "create_transaction",
  {
    title: "Crear transacción",
    description:
      "Registra un gasto, ingreso o transferencia. El monto va en la moneda de la cuenta (ej. 45.50), se convierte solo. Para gasto necesitas categoryId; para transferencia, transferAccountId.",
    inputSchema: {
      type: z.enum(["expense", "income", "transfer"]),
      accountId: z.string().describe("Cuenta origen"),
      amount: z.number().positive().describe("Monto en la moneda de la cuenta, ej. 45.50"),
      categoryId: z.string().optional().describe("Requerido para gastos"),
      transferAccountId: z.string().optional().describe("Cuenta destino, requerido para transferencias"),
      payee: z.string().optional().describe("Negocio o quién pagó"),
      note: z.string().optional(),
      date: z.string().optional().describe("Fecha YYYY-MM-DD (default: hoy)"),
    },
  },
  async ({ amount, ...rest }) => {
    try {
      return ok(await api("POST", "/transactions", { ...rest, amount: toMilli(amount) }));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "update_transaction",
  {
    title: "Editar transacción",
    description: "Actualiza solo los campos que envíes de una transacción existente. El monto va en la moneda de la cuenta.",
    inputSchema: {
      id: z.string(),
      type: z.enum(["expense", "income", "transfer"]).optional(),
      accountId: z.string().optional(),
      amount: z.number().positive().optional().describe("Monto en la moneda de la cuenta, ej. 52.00"),
      categoryId: z.string().optional(),
      transferAccountId: z.string().optional(),
      payee: z.string().optional(),
      note: z.string().optional(),
      date: z.string().optional(),
    },
  },
  async ({ id, amount, ...rest }) => {
    try {
      const body = { ...rest };
      if (amount !== undefined) body.amount = toMilli(amount);
      return ok(await api("PATCH", `/transactions/${id}`, body));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "delete_transaction",
  {
    title: "Borrar transacción",
    description: "Borra una transacción por su id.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    try {
      return ok(await api("DELETE", `/transactions/${id}`));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "create_category",
  {
    title: "Crear categoría",
    description: "Crea una categoría de gasto.",
    inputSchema: {
      name: z.string(),
      icon: z.string().optional().describe("Emoji, ej. 🐶"),
      sortOrder: z.number().int().optional(),
    },
  },
  async (args) => {
    try {
      return ok(await api("POST", "/categories", args));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "assign_budget",
  {
    title: "Asignar presupuesto",
    description: "Asigna (o actualiza) el monto presupuestado de una categoría en un mes. El monto va en la moneda base del plan, ej. 5000.",
    inputSchema: {
      month: z.string().describe("Mes YYYY-MM"),
      categoryId: z.string(),
      assigned: z.number().nonnegative().describe("Monto a asignar, ej. 5000"),
    },
  },
  async ({ month, categoryId, assigned }) => {
    try {
      return ok(await api("PUT", "/budgets", { month, categoryId, assigned: toMilli(assigned) }));
    } catch (e) { return fail(e); }
  }
);

/* ─── Connect ─── */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Zentavo MCP listo · base ${BASE_URL}`);
}

main().catch((e) => {
  console.error("Fallo al iniciar Zentavo MCP:", e);
  process.exit(1);
});
