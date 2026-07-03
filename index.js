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
    // Keep the HTTP status visible so the model can tell permission problems
    // (403) apart from bad input (400) or rate limits (429) and explain them.
    throw new Error(`HTTP ${res.status}: ${data?.error || text || "error"}`);
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

const MONTH_RE = /^(\d{4}-(0[1-9]|1[0-2])|all)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const server = new McpServer({ name: "zentavo", version: "1.4.0" });

server.registerTool(
  "list_plans",
  {
    title: "Listar planes",
    description: "Lista los planes configurados en esta conexión (vienen del env local, no del servidor). Si hay más de uno, pasa el nombre en el parámetro 'plan' de las demás herramientas. Incluye la moneda base de cada plan cuando el servidor está disponible.",
    inputSchema: {},
  },
  async () => {
    const plans = await Promise.all(
      PLAN_NAMES.map(async (name) => {
        try {
          const me = await api(PLANS[name], "GET", "/me");
          return { name, baseCurrency: me?.plan?.baseCurrency, planName: me?.plan?.name, scopes: me?.key?.scopes };
        } catch {
          return { name };
        }
      })
    );
    return ok({ plans, multi: MULTI });
  }
);

/* ── Lectura ── */

server.registerTool(
  "list_accounts",
  {
    title: "Listar cuentas",
    description: "Lista las cuentas del plan (bancos, efectivo, tarjetas, inversiones, préstamos) con su tipo y moneda. Con withBalances=true incluye el saldo actual (en milliunits: 1000 = $1.00).",
    inputSchema: {
      includeArchived: z.boolean().optional().describe("Incluir cuentas archivadas"),
      withBalances: z.boolean().optional().describe("Incluir el saldo actual de cada cuenta"),
      ...planParam,
    },
  },
  async ({ plan, includeArchived, withBalances }) => {
    try {
      return ok(await api(resolveKey(plan), "GET", `/accounts${qs({ includeArchived, withBalances })}`));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "list_transactions",
  {
    title: "Listar transacciones",
    description: "Lista transacciones (más recientes primero). Filtros opcionales por mes, rango, cuenta, categoría, tipo y texto.",
    inputSchema: {
      month: z.string().regex(MONTH_RE, "Formato: YYYY-MM o 'all'").optional().describe("Mes YYYY-MM, o 'all' para todo el historial"),
      to: z.string().regex(MONTH_RE, "Formato: YYYY-MM").optional().describe("Fin de rango YYYY-MM (con month)"),
      accountId: z.string().optional(),
      categoryId: z.string().optional(),
      type: z.enum(["expense", "income", "transfer"]).optional(),
      search: z.string().optional().describe("Busca en negocio/nota (mín. 2 caracteres)"),
      limit: z.number().int().max(500).optional().describe("Default 100, máximo 500"),
      before: z.string().optional().describe("Cursor de paginación: fecha ISO. La respuesta trae hasMore y nextBefore — pasa nextBefore aquí para la siguiente página"),
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
  "get_category",
  {
    title: "Obtener una categoría",
    description: "Obtiene una categoría por su id.",
    inputSchema: { id: z.string(), ...planParam },
  },
  async ({ plan, id }) => {
    try {
      return ok(await api(resolveKey(plan), "GET", `/categories/${id}`));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "list_loans",
  {
    title: "Listar préstamos",
    description: "Lista los préstamos del plan con su saldo actual en milliunits (1000 = $1.00), en la moneda base del plan. balance > 0 = te deben; balance < 0 = debes. Para registrar un abono usa create_loan con direction 'borrow' y el mismo contactName.",
    inputSchema: { includeArchived: z.boolean().optional(), ...planParam },
  },
  async ({ plan, includeArchived }) => {
    try {
      return ok(await api(resolveKey(plan), "GET", `/loans${qs({ includeArchived })}`));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "get_networth_history",
  {
    title: "Historial de patrimonio",
    description: "Puntos mensuales de patrimonio neto en la moneda base del plan (milliunits), con ingreso y gasto por mes. Útil para '¿cómo va mi patrimonio este año?'.",
    inputSchema: {
      months: z.number().int().max(60).optional().describe("Cuántos meses hacia atrás (default 12, máx 60)"),
      from: z.string().regex(/^\d{4}-\d{2}$/, "Formato: YYYY-MM").optional(),
      to: z.string().regex(/^\d{4}-\d{2}$/, "Formato: YYYY-MM").optional(),
      accountIds: z.string().optional().describe("IDs de cuenta separados por coma"),
      ...planParam,
    },
  },
  async ({ plan, ...args }) => {
    try {
      return ok(await api(resolveKey(plan), "GET", `/networth-history${qs(args)}`));
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
      month: z.string().regex(MONTH_RE, "Formato: YYYY-MM o 'all'").optional().describe("Mes YYYY-MM, o 'all'. Default: mes actual"),
      to: z.string().regex(MONTH_RE, "Formato: YYYY-MM").optional(),
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
      "Registra un gasto, ingreso o transferencia. Si el monto está en una divisa diferente a la de la cuenta (ej. pagas $300 MXN con una cuenta USD), pasa spentCurrency='MXN' — el servidor convierte automáticamente. Sin spentCurrency, el monto va directo en la moneda de la cuenta. Para gasto necesitas categoryId; para transferencia, transferAccountId.",
    inputSchema: {
      type: z.enum(["expense", "income", "transfer"]),
      accountId: z.string().describe("Cuenta origen"),
      amount: z.number().positive().describe("Monto del gasto. Si spentCurrency está definido, en esa divisa; si no, en la moneda de la cuenta."),
      spentCurrency: z.string().length(3).optional().describe("Divisa del monto si difiere de la cuenta, ej. 'MXN' para una cuenta USD. El servidor calcula el equivalente en la moneda de la cuenta."),
      categoryId: z.string().optional().describe("Requerido para gastos"),
      transferAccountId: z.string().optional().describe("Cuenta destino, requerido para transferencias"),
      transferAmount: z.number().positive().optional().describe("En transferencias entre monedas: monto exacto que recibe la cuenta destino (en su divisa). Si se omite, se calcula con el tipo de cambio del día."),
      payee: z.string().optional().describe("Negocio o quién pagó"),
      note: z.string().optional(),
      date: z.string().regex(DATE_RE, "Formato: YYYY-MM-DD").optional().describe("Fecha YYYY-MM-DD (default: hoy)"),
      ...planParam,
    },
  },
  async ({ plan, amount, spentCurrency, transferAmount, ...rest }) => {
    try {
      const body = { ...rest };
      if (spentCurrency) {
        body.spentCurrency = spentCurrency.toUpperCase();
        body.spentAmount = toMilli(amount);
        body.amount = 0;
      } else {
        body.amount = toMilli(amount);
      }
      if (transferAmount !== undefined) body.transferAmount = toMilli(transferAmount);
      return ok(await api(resolveKey(plan), "POST", "/transactions", body));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "create_loan",
  {
    title: "Registrar préstamo o abono",
    description:
      "Registra un préstamo a/de una persona, o un abono a un préstamo existente. Crea (o reutiliza, por contactName) la cuenta de préstamo del contacto y hace la transferencia en un paso. direction 'lend' = tú prestas (sale dinero de tu cuenta, sube lo que te deben); 'borrow' = te pagan/te abonan o te prestan (entra a tu cuenta, baja lo que te deben). Para registrar un pago de un préstamo usa 'borrow' con el mismo contactName. El monto va en la moneda de la cuenta, ej. 500.",
    inputSchema: {
      contactName: z.string().describe("Nombre de la persona, ej. Juan"),
      direction: z.enum(["lend", "borrow"]).describe("'lend' prestas tú; 'borrow' te pagan/abonan"),
      accountId: z.string().describe("Tu cuenta on-budget de donde sale o entra el dinero"),
      amount: z.number().positive().describe("Monto en la moneda de la cuenta, ej. 500. Si spentCurrency está definido, en esa divisa."),
      spentCurrency: z.string().length(3).optional().describe("Divisa del monto si difiere de la cuenta, ej. 'MXN' para una cuenta USD."),
      note: z.string().optional(),
      ...planParam,
    },
  },
  async ({ plan, amount, spentCurrency, ...rest }) => {
    try {
      const body = { ...rest };
      if (spentCurrency) {
        body.spentCurrency = spentCurrency.toUpperCase();
        body.spentAmount = toMilli(amount);
      } else {
        body.amount = toMilli(amount);
      }
      return ok(await api(resolveKey(plan), "POST", "/loans", body));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "update_transaction",
  {
    title: "Editar transacción",
    description: "Actualiza solo los campos que envíes de una transacción existente. Para cambiar el monto en una divisa distinta a la de la cuenta, manda amount + spentCurrency juntos. Mandar solo amount re-expresa el monto en la moneda de la cuenta (borra la divisa anterior si la había).",
    inputSchema: {
      id: z.string(),
      type: z.enum(["expense", "income", "transfer"]).optional(),
      accountId: z.string().optional(),
      amount: z.number().positive().optional().describe("Monto. Si spentCurrency está definido, en esa divisa; si no, en la moneda de la cuenta."),
      spentCurrency: z.string().length(3).optional().describe("Divisa del monto si difiere de la cuenta, ej. 'MXN' para una cuenta USD. Requiere mandar amount también."),
      categoryId: z.string().optional(),
      transferAccountId: z.string().optional(),
      transferAmount: z.number().positive().optional().describe("En transferencias entre monedas: monto que recibe la cuenta destino (en su divisa)."),
      payee: z.string().optional(),
      note: z.string().optional(),
      date: z.string().regex(DATE_RE, "Formato: YYYY-MM-DD").optional(),
      ...planParam,
    },
  },
  async ({ plan, id, amount, spentCurrency, transferAmount, ...rest }) => {
    try {
      if (spentCurrency && amount === undefined) {
        return fail(new Error("Para cambiar la divisa manda también 'amount' (el monto en esa divisa)."));
      }
      const body = { ...rest };
      if (spentCurrency && amount !== undefined) {
        body.spentCurrency = spentCurrency.toUpperCase();
        body.spentAmount = toMilli(amount);
        body.amount = 0;
      } else if (amount !== undefined) {
        body.amount = toMilli(amount);
      }
      if (transferAmount !== undefined) body.transferAmount = toMilli(transferAmount);
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
  "update_category",
  {
    title: "Editar categoría",
    description: "Actualiza solo los campos que envíes de una categoría (nombre, emoji, orden, archivada). Para 'borrar' una categoría con transacciones, archívala con archived=true.",
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      icon: z.string().optional().describe("Emoji, ej. 🐶"),
      sortOrder: z.number().int().optional(),
      archived: z.boolean().optional(),
      ...planParam,
    },
  },
  async ({ plan, id, ...args }) => {
    try {
      return ok(await api(resolveKey(plan), "PATCH", `/categories/${id}`, args));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "delete_category",
  {
    title: "Borrar categoría",
    description: "Borra una categoría por su id. Falla con 409 si tiene transacciones — en ese caso archívala con update_category (archived=true).",
    inputSchema: { id: z.string(), ...planParam },
  },
  async ({ plan, id }) => {
    try {
      return ok(await api(resolveKey(plan), "DELETE", `/categories/${id}`));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "create_account",
  {
    title: "Crear cuenta",
    description: "Crea una cuenta en el plan (banco, efectivo, tarjeta, inversión...). onBudget se deriva del tipo: checking/savings/cash/credit_card afectan presupuesto; loan/asset/liability solo patrimonio.",
    inputSchema: {
      name: z.string().describe("Ej. BBVA Débito"),
      type: z.enum(["checking", "savings", "cash", "credit_card", "other_asset", "other_liability"]),
      currency: z.string().length(3).optional().describe("Default: la moneda base del plan"),
      note: z.string().optional(),
      ...planParam,
    },
  },
  async ({ plan, ...args }) => {
    try {
      return ok(await api(resolveKey(plan), "POST", "/accounts", args));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "update_account",
  {
    title: "Editar cuenta",
    description: "Actualiza solo los campos que envíes de una cuenta. Usa archived=true para archivarla.",
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      type: z.enum(["checking", "savings", "cash", "credit_card", "other_asset", "other_liability"]).optional(),
      currency: z.string().length(3).optional(),
      note: z.string().optional(),
      archived: z.boolean().optional(),
      ...planParam,
    },
  },
  async ({ plan, id, ...args }) => {
    try {
      return ok(await api(resolveKey(plan), "PATCH", `/accounts/${id}`, args));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "assign_budget",
  {
    title: "Asignar presupuesto",
    description: "Asigna (o actualiza) el monto presupuestado de una categoría en un mes. El monto va en la moneda base del plan, ej. 5000.",
    inputSchema: {
      month: z.string().regex(/^\d{4}-\d{2}$/, "Formato: YYYY-MM").describe("Mes YYYY-MM"),
      categoryId: z.string(),
      assigned: z.number().nonnegative().describe("Monto a asignar, ej. 5000. En la moneda base del plan (vela en list_plans)."),
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
