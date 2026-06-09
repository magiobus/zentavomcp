#!/usr/bin/env node
/**
 * Zentavo MCP server — manage your personal finances from Claude / ChatGPT.
 *
 * A thin tools layer over the Zentavo public API (/api/v1). It runs no LLM
 * itself: the host (Claude Desktop, Cursor, ChatGPT, etc.) calls these tools
 * with the user's own model, so token cost is on the user, not on Zentavo.
 *
 * Auth — two ways:
 *   - Single plan:  ZENTAVO_API_KEY=zsk_live_...
 *   - Many plans:   ZENTAVO_PLANS='[{"name":"personal","key":"zsk_..."},
 *                                    {"name":"negocio","key":"zsk_..."}]'
 * Each key is bound to one plan (generated at Configuración → API). With
 * several plans, pass `plan` on each tool (use list_plans to see the names).
 *
 * Example host config:
 *   {
 *     "mcpServers": {
 *       "zentavo": {
 *         "command": "npx",
 *         "args": ["-y", "github:magiobus/zentavomcp"],
 *         "env": { "ZENTAVO_PLANS": "[{\"name\":\"personal\",\"key\":\"zsk_live_...\"}]" }
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.ZENTAVO_BASE_URL || "https://zentavo.lat/api/v1").replace(/\/$/, "");

/* ─── Plan resolution from env ─── */

function loadPlans() {
  const raw = process.env.ZENTAVO_PLANS;
  if (raw) {
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch {
      console.error('ZENTAVO_PLANS no es JSON válido. Esperado: [{"name":"personal","key":"zsk_..."}]');
      process.exit(1);
    }
    if (!Array.isArray(arr) || arr.length === 0) {
      console.error("ZENTAVO_PLANS debe ser un arreglo con al menos un plan.");
      process.exit(1);
    }
    const map = {};
    for (const p of arr) {
      if (!p?.name || !p?.key) {
        console.error('Cada plan en ZENTAVO_PLANS necesita "name" y "key".');
        process.exit(1);
      }
      map[p.name] = p.key;
    }
    return map;
  }
  if (process.env.ZENTAVO_API_KEY) {
    return { default: process.env.ZENTAVO_API_KEY };
  }
  console.error("Falta auth: define ZENTAVO_API_KEY (un plan) o ZENTAVO_PLANS (varios). Genera keys en Configuración → API.");
  process.exit(1);
}

const PLANS = loadPlans();
const PLAN_NAMES = Object.keys(PLANS);
const MULTI = PLAN_NAMES.length > 1;

// Resolve the API key for a request. With one plan, `plan` is ignored.
// With several, `plan` is required and must match a configured name.
function resolveKey(plan) {
  if (!MULTI) return PLANS[PLAN_NAMES[0]];
  if (!plan) {
    throw new Error(`Manejas varios planes (${PLAN_NAMES.join(", ")}). Pasa 'plan' en la herramienta — usa list_plans para verlos.`);
  }
  const key = PLANS[plan];
  if (!key) throw new Error(`Plan "${plan}" no existe. Disponibles: ${PLAN_NAMES.join(", ")}.`);
  return key;
}

// `plan` param, added to every data tool. Only meaningful when MULTI.
const planParam = {
  plan: z
    .string()
    .optional()
    .describe(MULTI ? `Plan a usar: ${PLAN_NAMES.join(", ")}` : "Plan (solo tienes uno; opcional)"),
};

/* ─── API helper ─── */

async function api(key, method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
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
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

// Money is milliunits (1000 = $1.00). Tools take decimal amounts and convert.
const toMilli = (n) => Math.round(Number(n) * 1000);

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e.message || e}` }], isError: true });

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/* ─── Server ─── */

const server = new McpServer({ name: "zentavo", version: "1.1.0" });

server.registerTool(
  "list_plans",
  {
    title: "Listar planes",
    description: "Lista los planes disponibles en esta conexión. Si hay más de uno, pasa el nombre en el parámetro 'plan' de las demás herramientas.",
    inputSchema: {},
  },
  async () => ok({ plans: PLAN_NAMES, multi: MULTI })
);

/* ── Lectura ── */

server.registerTool(
  "list_accounts",
  {
    title: "Listar cuentas",
    description: "Lista las cuentas del plan (bancos, efectivo, tarjetas, inversiones, préstamos) con su tipo y moneda.",
    inputSchema: { includeArchived: z.boolean().optional().describe("Incluir cuentas archivadas"), ...planParam },
  },
  async ({ plan, includeArchived }) => {
    try {
      return ok(await api(resolveKey(plan), "GET", `/accounts${qs({ includeArchived })}`));
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
      ...planParam,
    },
  },
  async ({ plan, ...args }) => {
    try {
      return ok(await api(resolveKey(plan), "GET", `/transactions${qs(args)}`));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "get_transaction",
  {
    title: "Obtener una transacción",
    description: "Obtiene una transacción por su id.",
    inputSchema: { id: z.string(), ...planParam },
  },
  async ({ plan, id }) => {
    try {
      return ok(await api(resolveKey(plan), "GET", `/transactions/${id}`));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "list_categories",
  {
    title: "Listar categorías",
    description: "Lista las categorías de gasto del plan.",
    inputSchema: { includeArchived: z.boolean().optional(), ...planParam },
  },
  async ({ plan, includeArchived }) => {
    try {
      return ok(await api(resolveKey(plan), "GET", `/categories${qs({ includeArchived })}`));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "list_budgets",
  {
    title: "Listar presupuestos del mes",
    description: "Lista las asignaciones de presupuesto por categoría de un mes.",
    inputSchema: { month: z.string().optional().describe("Mes YYYY-MM (default: mes actual)"), ...planParam },
  },
  async ({ plan, month }) => {
    try {
      return ok(await api(resolveKey(plan), "GET", `/budgets${qs({ month })}`));
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
      ...planParam,
    },
  },
  async ({ plan, ...args }) => {
    try {
      return ok(await api(resolveKey(plan), "GET", `/summary${qs(args)}`));
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
      ...planParam,
    },
  },
  async ({ plan, amount, ...rest }) => {
    try {
      return ok(await api(resolveKey(plan), "POST", "/transactions", { ...rest, amount: toMilli(amount) }));
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
      ...planParam,
    },
  },
  async ({ plan, id, amount, ...rest }) => {
    try {
      const body = { ...rest };
      if (amount !== undefined) body.amount = toMilli(amount);
      return ok(await api(resolveKey(plan), "PATCH", `/transactions/${id}`, body));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "delete_transaction",
  {
    title: "Borrar transacción",
    description: "Borra una transacción por su id.",
    inputSchema: { id: z.string(), ...planParam },
  },
  async ({ plan, id }) => {
    try {
      return ok(await api(resolveKey(plan), "DELETE", `/transactions/${id}`));
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
      ...planParam,
    },
  },
  async ({ plan, ...args }) => {
    try {
      return ok(await api(resolveKey(plan), "POST", "/categories", args));
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
      ...planParam,
    },
  },
  async ({ plan, month, categoryId, assigned }) => {
    try {
      return ok(await api(resolveKey(plan), "PUT", "/budgets", { month, categoryId, assigned: toMilli(assigned) }));
    } catch (e) { return fail(e); }
  }
);

/* ─── Connect ─── */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Zentavo MCP listo · base ${BASE_URL} · planes: ${PLAN_NAMES.join(", ")}`);
}

main().catch((e) => {
  console.error("Fallo al iniciar Zentavo MCP:", e);
  process.exit(1);
});
