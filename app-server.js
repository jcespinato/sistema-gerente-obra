const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const STATIC_ROOT = __dirname;
const RUNTIME_ROOT = process.pkg ? path.dirname(process.execPath) : __dirname;
const DATA_DIR = path.join(RUNTIME_ROOT, "data");
const UPLOADS_DIR = path.join(RUNTIME_ROOT, "uploads");
const STORE_PATH = path.join(DATA_DIR, "database.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const STATUS_OPTIONS = [
  "Pendente de aprovacao",
  "Solicitacao recebida",
  "Em cotacao",
  "Aguardando aprovacao",
  "Compra realizada",
  "Entregue",
  "Cancelado",
  "Recusado"
];

const PRIORITY_OPTIONS = ["Baixa", "Media", "Alta", "Urgente"];
const PURCHASE_STATUS_OPTIONS = ["Finalizada", "Cancelada"];
const PERMISSIONS_CATALOG = [
  { key: "dashboard.view", label: "Dashboard" },
  { key: "requests.create", label: "Criar demandas" },
  { key: "requests.manage", label: "Gerenciar demandas" },
  { key: "requests.approve", label: "Aprovar pedidos" },
  { key: "purchases.finalize", label: "Finalizar compras" },
  { key: "reports.view", label: "Ver relatorios" },
  { key: "history.view", label: "Ver historico" },
  { key: "users.manage", label: "Gerenciar usuarios" },
  { key: "projects.manage", label: "Gerenciar obras" },
  { key: "employee.requests.create", label: "Portal funcionario - criar" },
  { key: "employee.requests.view", label: "Portal funcionario - consultar" }
];
const ALL_PERMISSION_KEYS = PERMISSIONS_CATALOG.map((item) => item.key);
const DEFAULT_EMPLOYEE_PERMISSIONS = ["employee.requests.create", "employee.requests.view"];
const UNIT_OPTIONS = ["unidade", "metro", "metro2", "peca", "kilo", "grama"];
const MAX_BODY_SIZE = Number(process.env.MAX_BODY_SIZE || 15 * 1024 * 1024);
const sessions = new Map();

function now() {
  return new Date().toISOString();
}

function todayString() {
  const date = new Date();
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeUnit(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeRole(role) {
  const value = String(role || "").trim().toUpperCase();
  if (["ADMIN", "ADMINISTRADOR", "ADM"].includes(value)) return "ADM";
  if (["FUNCIONARIO", "FUNC"].includes(value)) return "FUNCIONARIO";
  return "FUNCIONARIO";
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function normalizePermissions(role, permissions) {
  if (normalizeRole(role) === "ADM") return [...ALL_PERMISSION_KEYS];
  const allowed = new Set(ALL_PERMISSION_KEYS);
  const list = Array.isArray(permissions) ? permissions : [];
  const filtered = list.filter((item) => allowed.has(item));
  return filtered.length ? filtered : [...DEFAULT_EMPLOYEE_PERMISSIONS];
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const iterations = 150000;
  const hash = crypto.pbkdf2Sync(String(password), salt, iterations, 64, "sha512").toString("hex");
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash) return false;

  if (storedHash.startsWith("pbkdf2$")) {
    const [, iterationsRaw, salt, expectedHash] = storedHash.split("$");
    const iterations = Number(iterationsRaw);
    if (!iterations || !salt || !expectedHash) return false;

    const computedHash = crypto.pbkdf2Sync(String(password), salt, iterations, 64, "sha512").toString("hex");
    const expectedBuffer = Buffer.from(expectedHash, "hex");
    const computedBuffer = Buffer.from(computedHash, "hex");
    if (expectedBuffer.length !== computedBuffer.length) return false;
    return crypto.timingSafeEqual(expectedBuffer, computedBuffer);
  }

  const legacy = crypto.createHash("sha256").update(String(password)).digest("hex");
  return legacy === storedHash;
}

function defaultStore() {
  return {
    counters: { users: 1, projects: 1, requests: 0, purchases: 0, history: 0 },
    users: [
      {
        id: 1,
        username: "admin",
        password_hash: hashPassword("admin123"),
        role: "ADM",
        permissions: [...ALL_PERMISSION_KEYS],
        project_id: null,
        project_name: "",
        created_at: now()
      }
    ],
    projects: [
      {
        id: 1,
        name: "Obra Geral",
        address: "Endereco nao informado",
        created_at: now(),
        updated_at: now(),
        deleted_at: null
      }
    ],
    requests: [],
    purchases: [],
    history: []
  };
}

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) {
    const initial = defaultStore();
    fs.writeFileSync(STORE_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }

  const loaded = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  const users = Array.isArray(loaded.users) ? loaded.users : [];
  if (!loaded.counters || typeof loaded.counters !== "object") loaded.counters = {};
  if (!Array.isArray(loaded.users)) loaded.users = [];
  if (!Array.isArray(loaded.projects)) loaded.projects = [];
  if (!Array.isArray(loaded.requests)) loaded.requests = [];
  if (!Array.isArray(loaded.purchases)) loaded.purchases = [];
  if (!Array.isArray(loaded.history)) loaded.history = [];
  if (!loaded.projects.length) {
    const firstProject = {
      id: 1,
      name: "Obra Geral",
      address: "Endereco nao informado",
      created_at: now(),
      updated_at: now(),
      deleted_at: null
    };
    loaded.projects.push(firstProject);
    loaded.counters.projects = Math.max(Number(loaded.counters.projects || 0), 1);
  }
  let changed = false;

  for (const user of users) {
    const normalizedRole = normalizeRole(user.role);
    if (user.role !== normalizedRole) {
      user.role = normalizedRole;
      changed = true;
    }
    const normalizedPermissions = normalizePermissions(user.role, user.permissions);
    if (JSON.stringify(user.permissions || []) !== JSON.stringify(normalizedPermissions)) {
      user.permissions = normalizedPermissions;
      changed = true;
    }
    if (!user.password_hash) {
      user.password_hash = hashPassword(crypto.randomBytes(24).toString("hex"));
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(user, "project_id")) {
      user.project_id = null;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(user, "project_name")) {
      user.project_name = "";
      changed = true;
    }
  }

  for (const project of loaded.projects) {
    if (!Object.prototype.hasOwnProperty.call(project, "address")) {
      project.address = String(project.notes || "").trim() || "Endereco nao informado";
      changed = true;
    }
  }

  for (const request of loaded.requests) {
    if (!Object.prototype.hasOwnProperty.call(request, "budget_notes")) {
      request.budget_notes = "";
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(request, "budget_attachment_path")) {
      request.budget_attachment_path = null;
      changed = true;
    }
  }

  for (const purchase of loaded.purchases) {
    const idsFromArray = Array.isArray(purchase.request_ids) ? purchase.request_ids : [];
    const ids = idsFromArray.length
      ? idsFromArray
      : (Number(purchase.request_id || 0) > 0 ? [Number(purchase.request_id)] : []);
    const normalizedIds = [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
    if (JSON.stringify(ids) !== JSON.stringify(normalizedIds)) {
      purchase.request_ids = normalizedIds;
      changed = true;
    } else if (!Array.isArray(purchase.request_ids)) {
      purchase.request_ids = normalizedIds;
      changed = true;
    }
    const firstRequestId = purchase.request_ids[0] || null;
    if (Number(purchase.request_id || 0) !== Number(firstRequestId || 0)) {
      purchase.request_id = firstRequestId;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(purchase, "block_name") || !String(purchase.block_name || "").trim()) {
      purchase.block_name = String(purchase.supplier || "").trim() || `Compra #${purchase.id}`;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(purchase, "budget_reference")) {
      purchase.budget_reference = "";
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(purchase, "invoice_file_path")) {
      purchase.invoice_file_path = null;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(purchase, "approved_budget_file_path")) {
      purchase.approved_budget_file_path = null;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(purchase, "delivery_deadline") || !isIsoDate(purchase.delivery_deadline)) {
      purchase.delivery_deadline = isIsoDate(purchase.purchase_date) ? purchase.purchase_date : todayString();
      changed = true;
    }
    if (!PURCHASE_STATUS_OPTIONS.includes(String(purchase.status || ""))) {
      purchase.status = "Finalizada";
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(purchase, "canceled_reason")) {
      purchase.canceled_reason = "";
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(purchase, "canceled_at")) {
      purchase.canceled_at = null;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(purchase, "updated_at")) {
      purchase.updated_at = purchase.created_at || now();
      changed = true;
    }
  }

  const counterMaxes = {
    users: loaded.users.reduce((max, item) => Math.max(max, Number(item.id || 0)), 0),
    projects: loaded.projects.reduce((max, item) => Math.max(max, Number(item.id || 0)), 0),
    requests: loaded.requests.reduce((max, item) => Math.max(max, Number(item.id || 0)), 0),
    purchases: loaded.purchases.reduce((max, item) => Math.max(max, Number(item.id || 0)), 0),
    history: loaded.history.reduce((max, item) => Math.max(max, Number(item.id || 0)), 0)
  };

  for (const [collection, maxValue] of Object.entries(counterMaxes)) {
    if (Number(loaded.counters[collection] || 0) < maxValue) {
      loaded.counters[collection] = maxValue;
      changed = true;
    }
    if (!Number.isFinite(Number(loaded.counters[collection]))) {
      loaded.counters[collection] = maxValue;
      changed = true;
    }
  }

  if (Number(loaded.counters.projects || 0) < 1) {
    loaded.counters.projects = 1;
    changed = true;
  }

  if (changed) fs.writeFileSync(STORE_PATH, JSON.stringify(loaded, null, 2));
  return loaded;
}

let store = loadStore();

function saveStore() {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function nextId(collection) {
  if (!store.counters || typeof store.counters !== "object") store.counters = {};
  if (!Number.isFinite(Number(store.counters[collection]))) store.counters[collection] = 0;
  store.counters[collection] += 1;
  return store.counters[collection];
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".csv": "text/csv; charset=utf-8"
  };
  res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  return cookieHeader.split(";").reduce((acc, cookie) => {
    const [key, ...value] = cookie.trim().split("=");
    if (!key) return acc;
    acc[key] = decodeURIComponent(value.join("="));
    return acc;
  }, {});
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let finished = false;

    const complete = (error, value) => {
      if (finished) return;
      finished = true;
      if (error) reject(error);
      else resolve(value);
    };

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_SIZE) {
        const error = new Error("Arquivo ou requisicao excede o tamanho maximo permitido");
        error.statusCode = 413;
        complete(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => complete(null, Buffer.concat(chunks)));
    req.on("error", (error) => complete(error));
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function parseJsonBuffer(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8") || "{}");
  } catch {
    return {};
  }
}

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=([^;]+)/i.exec(contentType || "");
  if (!boundaryMatch) return { fields: {}, files: {} };

  const boundary = `--${boundaryMatch[1]}`;
  const raw = buffer.toString("binary");
  const parts = raw.split(boundary).slice(1, -1);
  const fields = {};
  const files = {};

  for (const part of parts) {
    const trimmed = part.replace(/^\r\n/, "");
    const separatorIndex = trimmed.indexOf("\r\n\r\n");
    if (separatorIndex === -1) continue;
    const headerText = trimmed.slice(0, separatorIndex);
    let bodyBinary = trimmed.slice(separatorIndex + 4).replace(/\r\n$/, "");
    const disposition = /name="([^"]+)"/i.exec(headerText);
    if (!disposition) continue;
    const fieldName = disposition[1];
    const fileNameMatch = /filename="([^"]*)"/i.exec(headerText);
    if (fileNameMatch && fileNameMatch[1]) {
      files[fieldName] = {
        filename: sanitizeFileName(path.basename(fileNameMatch[1])),
        content: Buffer.from(bodyBinary, "binary")
      };
    } else {
      fields[fieldName] = Buffer.from(bodyBinary, "binary").toString("utf8");
    }
  }

  return { fields, files };
}

function saveUploadedFile(file, prefix) {
  if (!file || !file.content || !file.filename) return null;
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const storedName = `${prefix}-${stamp}-${file.filename}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, storedName), file.content);
  return `/uploads/${storedName}`;
}

function createSession(user) {
  const token = crypto.randomBytes(24).toString("hex");
  const project = user.project_id ? findProjectById(user.project_id) : null;
  sessions.set(token, {
    id: user.id,
    username: user.username,
    role: normalizeRole(user.role),
    permissions: normalizePermissions(user.role, user.permissions),
    project_id: user.project_id || null,
    project_name: project?.name || user.project_name || "",
    createdAt: now()
  });
  return token;
}

function getSession(req) {
  const token = parseCookies(req).session_token;
  return token ? sessions.get(token) : null;
}

function addHistory(entityType, entityId, action, details, username) {
  store.history.unshift({
    id: nextId("history"),
    entity_type: entityType,
    entity_id: entityId,
    action,
    details: details || {},
    username: username || "sistema",
    created_at: now()
  });
  saveStore();
}

function hasPermission(session, permission) {
  if (!session) return false;
  if (session.role === "ADM") return true;
  return Array.isArray(session.permissions) && session.permissions.includes(permission);
}

function requireAnyPermission(res, session, permissions) {
  if (permissions.some((permission) => hasPermission(session, permission))) return true;
  json(res, 403, { error: "Sem permissao para esta acao" });
  return false;
}

function findActiveUserByUsername(username) {
  const target = normalizeUsername(username);
  return store.users.find((item) => normalizeUsername(item.username) === target && item.deleted_at !== true);
}

function findActiveUserById(id) {
  return store.users.find((item) => Number(item.id) === Number(id) && item.deleted_at !== true);
}

function activeAdminsCount(excludedId = null) {
  return store.users.filter((item) => {
    if (item.deleted_at === true) return false;
    if (normalizeRole(item.role) !== "ADM") return false;
    if (excludedId !== null && Number(item.id) === Number(excludedId)) return false;
    return true;
  }).length;
}

function activeProjects() {
  return (store.projects || []).filter((item) => !item.deleted_at);
}

function findProjectById(id) {
  return activeProjects().find((item) => Number(item.id) === Number(id));
}

function findProjectByName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  return activeProjects().find((item) => String(item.name || "").trim().toLowerCase() === normalized);
}

function activePurchases() {
  return store.purchases.filter((item) => (item.status || "Finalizada") !== "Cancelada");
}

function purchaseRequestIds(purchase) {
  const idsFromArray = Array.isArray(purchase?.request_ids) ? purchase.request_ids : [];
  const ids = idsFromArray.length
    ? idsFromArray
    : (Number(purchase?.request_id || 0) > 0 ? [Number(purchase.request_id)] : []);
  return [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
}

function activePurchaseRequestIdsSet() {
  const ids = new Set();
  for (const purchase of activePurchases()) {
    for (const requestId of purchaseRequestIds(purchase)) ids.add(requestId);
  }
  return ids;
}

function resolveRequestsForPurchase(purchase) {
  return purchaseRequestIds(purchase)
    .map((requestId) => store.requests.find((item) => Number(item.id) === Number(requestId)))
    .filter(Boolean);
}

function priorityRank(priority) {
  return { Urgente: 1, Alta: 2, Media: 3, Baixa: 4 }[priority] || 999;
}

function validateFinalizableRequests(requestIds) {
  const ids = [...new Set((Array.isArray(requestIds) ? requestIds : [requestIds])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return { error: "Selecione ao menos um item para finalizar" };

  const purchasedIds = activePurchaseRequestIdsSet();
  const requests = [];

  for (const requestId of ids) {
    const request = store.requests.find((item) => Number(item.id) === requestId && !item.deleted_at);
    if (!request) return { error: `Demanda #${requestId} nao encontrada` };
    if (purchasedIds.has(requestId)) return { error: `A demanda #${requestId} ja esta em uma compra finalizada` };
    if ((request.approval_state || "Aprovado") === "Recusado" || request.status === "Recusado") {
      return { error: `A demanda #${requestId} foi recusada e nao pode ser finalizada` };
    }
    if (["Entregue", "Cancelado"].includes(request.status)) {
      return { error: `A demanda #${requestId} esta com status ${request.status} e nao pode ser finalizada` };
    }
    requests.push(request);
  }

  const firstProject = String(requests[0]?.project_name || "").trim();
  if (requests.some((request) => String(request.project_name || "").trim() !== firstProject)) {
    return { error: "Selecione itens da mesma obra para criar o bloco de compra" };
  }

  return { ids, requests, projectName: firstProject };
}

function finalizePurchaseGroup(payload, username) {
  const blockName = String(payload.block_name || "").trim();
  const supplier = String(payload.supplier || "").trim();
  const amountPaid = Number(payload.amount_paid);
  const purchaseDate = String(payload.purchase_date || "").trim();
  const deliveryDeadline = String(payload.delivery_deadline || "").trim() || purchaseDate;
  const invoiceNumber = String(payload.invoice_number || "").trim();
  const paymentMethod = String(payload.payment_method || "").trim();
  const observations = String(payload.observations || "").trim();
  const budgetReference = String(payload.budget_reference || "").trim();

  if (!blockName) return { error: "Informe o nome do bloco de compra" };
  if (!supplier) return { error: "Informe a loja/fornecedor" };
  if (!Number.isFinite(amountPaid) || amountPaid < 0) return { error: "Valor total da compra invalido" };
  if (!isIsoDate(purchaseDate)) return { error: "Data da compra invalida" };
  if (!isIsoDate(deliveryDeadline)) return { error: "Prazo de entrega invalido" };

  const validated = validateFinalizableRequests(payload.request_ids);
  if (validated.error) return validated;

  const purchase = {
    id: nextId("purchases"),
    request_id: validated.ids[0],
    request_ids: validated.ids,
    block_name: blockName,
    supplier,
    amount_paid: amountPaid,
    purchase_date: purchaseDate,
    delivery_deadline: deliveryDeadline,
    invoice_number: invoiceNumber,
    budget_reference: budgetReference,
    payment_method: paymentMethod,
    observations,
    invoice_file_path: null,
    approved_budget_file_path: null,
    status: "Finalizada",
    canceled_reason: "",
    canceled_at: null,
    created_at: now(),
    updated_at: now()
  };

  store.purchases.push(purchase);
  for (const request of validated.requests) {
    request.status = "Compra realizada";
    request.approval_state = "Aprovado";
    request.updated_at = now();
  }
  saveStore();
  addHistory("purchase", purchase.id, "finalized_group", {
    ...purchase,
    request_ids: validated.ids,
    project_name: validated.projectName
  }, username);
  return { purchase };
}

function projectSummary(projectName) {
  const requests = activeRequests().filter((item) => item.project_name === projectName);
  const requestIds = new Set(requests.map((request) => Number(request.id)));
  const purchases = activePurchases().filter((purchase) => purchaseRequestIds(purchase).some((id) => requestIds.has(id)));
  const totalSpent = purchases.reduce((sum, item) => sum + Number(item.amount_paid || 0), 0);
  const open = requests.filter((row) => !["Entregue", "Cancelado", "Recusado"].includes(row.status)).length;
  const pendingApproval = requests.filter((row) => (row.approval_state || "Aprovado") === "Pendente").length;
  return {
    project: projectName,
    totalRequests: requests.length,
    openRequests: open,
    pendingApproval,
    completedPurchases: purchases.length,
    totalSpent: Number(totalSpent.toFixed(2))
  };
}

function activeRequests() {
  return store.requests.filter((item) => !item.deleted_at);
}

function mapRequest(item) {
  return {
    ...item,
    approval_state: item.approval_state || "Aprovado",
    approval_reason: item.approval_reason || "",
    source: item.source || "desktop",
    requested_by_user_id: item.requested_by_user_id || null,
    budget_notes: item.budget_notes || "",
    isOverdue: !["Entregue", "Cancelado", "Recusado"].includes(item.status) && item.needed_by_date < todayString(),
    budgetAttachmentUrl: item.budget_attachment_path || null
  };
}

function listRequests(filters = {}, session = null) {
  let rows = activeRequests();

  if (session && !hasPermission(session, "requests.manage") && !hasPermission(session, "requests.approve")) {
    rows = rows.filter((row) => Number(row.requested_by_user_id || 0) === Number(session.id));
  }

  if (filters.onlyOpen) {
    const finalized = activePurchaseRequestIdsSet();
    rows = rows.filter((row) => !finalized.has(row.id));
  }
  if (filters.pendingApproval) rows = rows.filter((row) => (row.approval_state || "Aprovado") === "Pendente");
  if (filters.project) rows = rows.filter((row) => row.project_name === filters.project);
  if (filters.status) rows = rows.filter((row) => row.status === filters.status);
  if (filters.priority) rows = rows.filter((row) => row.priority === filters.priority);
  if (filters.approvalState) rows = rows.filter((row) => (row.approval_state || "Aprovado") === filters.approvalState);
  if (filters.deadline === "overdue") rows = rows.filter((row) => row.needed_by_date < todayString() && !["Entregue", "Cancelado", "Recusado"].includes(row.status));
  if (filters.deadline === "week") {
    const limit = new Date();
    limit.setDate(limit.getDate() + 7);
    rows = rows.filter((row) => row.needed_by_date >= todayString() && row.needed_by_date <= limit.toISOString().slice(0, 10));
  }
  if (filters.search) {
    const term = filters.search.toLowerCase();
    rows = rows.filter((row) =>
      [row.item_name, row.description, row.project_name, row.requester_name].some((value) => String(value).toLowerCase().includes(term))
    );
  }

  return rows
    .slice()
    .sort((a, b) => (priorityRank(a.priority) - priorityRank(b.priority)) || a.needed_by_date.localeCompare(b.needed_by_date) || b.id - a.id)
    .map(mapRequest);
}

function listPurchases(filters = {}) {
  let rows = store.purchases.map((purchase) => {
    const requests = resolveRequestsForPurchase(purchase);
    if (!requests.length) return null;
    const projectNames = [...new Set(requests.map((request) => request.project_name))];
    const itemNames = requests.map((request) => request.item_name).filter(Boolean);
    const highestPriority = requests.map((request) => request.priority).sort((a, b) => priorityRank(a) - priorityRank(b))[0] || "";
    const requestIds = requests.map((request) => Number(request.id));

    return {
      ...purchase,
      request_id: requestIds[0] || null,
      request_ids: requestIds,
      block_name: String(purchase.block_name || "").trim() || String(purchase.supplier || "").trim() || `Compra #${purchase.id}`,
      item_count: requests.length,
      item_name: itemNames.join(" | "),
      item_names: itemNames,
      project_name: projectNames.join(" / "),
      priority: highestPriority,
      request_status: requests.length === 1 ? requests[0].status : "Agrupado",
      purchase_status: purchase.status || "Finalizada"
    };
  }).filter(Boolean);

  if (filters.project) rows = rows.filter((row) => row.project_name === filters.project);
  if (filters.supplier) rows = rows.filter((row) => row.supplier === filters.supplier);
  if (filters.status) rows = rows.filter((row) => row.purchase_status === filters.status);
  if (filters.search) {
    const term = filters.search.toLowerCase();
    rows = rows.filter((row) => [row.item_name, row.project_name, row.supplier, row.block_name, row.invoice_number]
      .some((value) => String(value || "").toLowerCase().includes(term)));
  }
  if (filters.startDate) rows = rows.filter((row) => row.purchase_date >= filters.startDate);
  if (filters.endDate) rows = rows.filter((row) => row.purchase_date <= filters.endDate);
  return rows.sort((a, b) => b.purchase_date.localeCompare(a.purchase_date) || b.id - a.id);
}

function getDashboard() {
  const requests = activeRequests();
  const purchases = activePurchases();
  const purchasedRequestIds = activePurchaseRequestIdsSet();
  const currentMonth = todayString().slice(0, 7);
  const requestsByProjectMap = {};
  const statusMap = {};

  for (const request of requests) {
    requestsByProjectMap[request.project_name] = (requestsByProjectMap[request.project_name] || 0) + 1;
    statusMap[request.status] = (statusMap[request.status] || 0) + 1;
  }

  return {
    openDemandCount: requests.filter((row) => !purchasedRequestIds.has(Number(row.id)) && !["Entregue", "Cancelado", "Recusado"].includes(row.status)).length,
    completedCount: purchases.length,
    monthlySpend: purchases.filter((item) => item.purchase_date.slice(0, 7) === currentMonth).reduce((sum, item) => sum + Number(item.amount_paid), 0),
    requestsByProject: Object.entries(requestsByProjectMap).map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total),
    expiringSoon: requests.filter((row) => row.needed_by_date >= todayString() && row.needed_by_date <= new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) && !["Entregue", "Cancelado", "Recusado"].includes(row.status)),
    overdue: requests.filter((row) => row.needed_by_date < todayString() && !["Entregue", "Cancelado", "Recusado"].includes(row.status)),
    statusChart: Object.entries(statusMap).map(([label, total]) => ({ label, total })).sort((a, b) => b.total - a.total)
  };
}

function groupSum(rows, keyField, valueField) {
  const map = {};
  for (const row of rows) map[row[keyField]] = (map[row[keyField]] || 0) + Number(row[valueField] || 0);
  return Object.entries(map).map(([label, total]) => ({ label, total: Number(total.toFixed(2)) })).sort((a, b) => b.total - a.total);
}

function groupCount(rows, keyField) {
  const map = {};
  for (const row of rows) map[row[keyField]] = (map[row[keyField]] || 0) + 1;
  return Object.entries(map).map(([label, total]) => ({ label, total })).sort((a, b) => b.total - a.total);
}

function getReports(startDate, endDate) {
  let purchases = listPurchases({}).filter((item) => item.purchase_status === "Finalizada");
  if (startDate) purchases = purchases.filter((item) => item.purchase_date >= startDate);
  if (endDate) purchases = purchases.filter((item) => item.purchase_date <= endDate);
  const materials = purchases.flatMap((purchase) =>
    resolveRequestsForPurchase(purchase).map((request) => ({ item_name: request.item_name }))
  );
  return {
    byProject: groupSum(purchases, "project_name", "amount_paid"),
    byMonth: groupSum(purchases.map((item) => ({ ...item, month: item.purchase_date.slice(0, 7) })), "month", "amount_paid"),
    bySupplier: groupSum(purchases, "supplier", "amount_paid"),
    topMaterials: groupCount(materials, "item_name").slice(0, 10),
    delayedPurchases: purchases.filter((item) => item.delivery_deadline < todayString()),
    totalsByProject: groupSum(purchases, "project_name", "amount_paid").map((item) => ({ project: item.label, total: item.total }))
  };
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return [headers.join(","), ...rows.map((row) => headers.map((key) => escape(row[key])).join(","))].join("\n");
}

function serveStatic(req, res, pathname) {
  const root = pathname.startsWith("/uploads/") ? RUNTIME_ROOT : STATIC_ROOT;
  const fullPath = path.join(root, pathname);
  if (!fullPath.startsWith(root) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    res.writeHead(404);
    res.end("Nao encontrado");
    return;
  }
  sendFile(res, fullPath);
}

async function handleApi(req, res, pathname, session) {
  const method = req.method || "GET";
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === "/api/login" && method === "POST") {
    const body = parseJsonBuffer(await readBody(req));
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const user = findActiveUserByUsername(username);
    if (!user || !verifyPassword(password, user.password_hash)) return json(res, 401, { error: "Usuario ou senha invalidos" });

    if (!String(user.password_hash || "").startsWith("pbkdf2$")) {
      user.password_hash = hashPassword(password);
      saveStore();
    }

    const token = createSession(user);
    const project = user.project_id ? findProjectById(user.project_id) : null;
    const payloadUser = {
      id: user.id,
      username: user.username,
      role: normalizeRole(user.role),
      permissions: normalizePermissions(user.role, user.permissions),
      project_id: user.project_id || null,
      project_name: project?.name || user.project_name || ""
    };
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": `session_token=${token}; HttpOnly; Path=/; SameSite=Lax`
    });
    return res.end(JSON.stringify(payloadUser));
  }

  if (pathname === "/api/logout" && method === "POST") {
    const token = parseCookies(req).session_token;
    if (token) sessions.delete(token);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax"
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === "/api/session" && method === "GET") return json(res, 200, { authenticated: Boolean(session), user: session || null });
  if (!session) return json(res, 401, { error: "Nao autenticado" });

  if (pathname === "/api/meta" && method === "GET") {
    return json(res, 200, {
      statusOptions: STATUS_OPTIONS,
      priorityOptions: PRIORITY_OPTIONS,
      unitOptions: UNIT_OPTIONS,
      purchaseStatusOptions: PURCHASE_STATUS_OPTIONS,
      permissionsCatalog: PERMISSIONS_CATALOG
    });
  }

  if (pathname === "/api/projects" && method === "GET") {
    if (!requireAnyPermission(res, session, ["users.manage", "projects.manage", "requests.create", "requests.manage", "employee.requests.create"])) return;
    const projects = activeProjects().map((item) => ({
      id: item.id,
      name: item.name,
      address: item.address || "",
      created_at: item.created_at
    }));
    return json(res, 200, projects);
  }

  if (pathname === "/api/projects" && method === "POST") {
    if (!requireAnyPermission(res, session, ["projects.manage", "users.manage"])) return;
    const body = parseJsonBuffer(await readBody(req));
    const name = String(body.name || "").trim();
    const address = String(body.address || "").trim();
    if (!name) return json(res, 400, { error: "Informe o nome da obra" });
    if (!address) return json(res, 400, { error: "Informe o endereco da obra" });
    if (activeProjects().some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      return json(res, 400, { error: "Ja existe obra com este nome" });
    }

    const project = {
      id: nextId("projects"),
      name,
      address,
      created_at: now(),
      updated_at: now(),
      deleted_at: null
    };
    store.projects.push(project);
    saveStore();
    addHistory("project", project.id, "created", project, session.username);
    return json(res, 201, project);
  }

  const projectSummaryMatch = /^\/api\/projects\/(\d+)\/summary$/.exec(pathname);
  if (projectSummaryMatch && method === "GET") {
    if (!requireAnyPermission(res, session, ["projects.manage", "users.manage", "reports.view", "requests.manage"])) return;
    const project = findProjectById(Number(projectSummaryMatch[1]));
    if (!project) return json(res, 404, { error: "Obra nao encontrada" });
    return json(res, 200, projectSummary(project.name));
  }

  const projectMatch = /^\/api\/projects\/(\d+)$/.exec(pathname);
  if (projectMatch && method === "DELETE") {
    if (!requireAnyPermission(res, session, ["projects.manage", "users.manage"])) return;
    const project = findProjectById(Number(projectMatch[1]));
    if (!project) return json(res, 404, { error: "Obra nao encontrada" });
    if (store.users.some((user) => user.deleted_at !== true && Number(user.project_id || 0) === Number(project.id))) {
      return json(res, 400, { error: "Existem usuarios vinculados a esta obra" });
    }
    if (activeRequests().some((request) => request.project_name === project.name)) {
      return json(res, 400, { error: "Existem pedidos vinculados a esta obra" });
    }
    project.deleted_at = now();
    project.updated_at = now();
    saveStore();
    addHistory("project", project.id, "deleted", {}, session.username);
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/users" && method === "GET") {
    if (!requireAnyPermission(res, session, ["users.manage"])) return;
    const users = store.users
      .filter((item) => item.deleted_at !== true)
      .map((item) => ({
        project: item.project_id ? findProjectById(item.project_id)?.name || item.project_name || "" : "",
        project_id: item.project_id || null,
        id: item.id,
        username: item.username,
        role: normalizeRole(item.role),
        permissions: normalizePermissions(item.role, item.permissions),
        created_at: item.created_at
      }));
    return json(res, 200, users);
  }

  if (pathname === "/api/users" && method === "POST") {
    if (!requireAnyPermission(res, session, ["users.manage"])) return;
    const body = parseJsonBuffer(await readBody(req));

    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const role = normalizeRole(body.role || "FUNCIONARIO");
    const permissions = normalizePermissions(role, body.permissions || []);
    const projectId = body.project_id ? Number(body.project_id) : null;
    const project = projectId ? findProjectById(projectId) : null;

    if (!username) return json(res, 400, { error: "Informe um nome de usuario" });
    if (password.length < 6) return json(res, 400, { error: "Senha deve ter pelo menos 6 caracteres" });
    if (role === "FUNCIONARIO" && !project) return json(res, 400, { error: "Selecione a obra do funcionario" });
    const normalizedUsername = normalizeUsername(username);
    if (store.users.some((item) => item.deleted_at !== true && normalizeUsername(item.username) === normalizedUsername)) {
      return json(res, 400, { error: "Usuario ja existente" });
    }

    const user = {
      id: nextId("users"),
      username,
      password_hash: hashPassword(password),
      role,
      permissions,
      project_id: project?.id || null,
      project_name: project?.name || "",
      created_at: now(),
      updated_at: now(),
      deleted_at: false
    };
    store.users.push(user);
    saveStore();
    addHistory("user", user.id, "created", { username: user.username, role: user.role, permissions: user.permissions }, session.username);
    return json(res, 201, {
      id: user.id,
      username: user.username,
      role: user.role,
      project: user.project_name,
      project_id: user.project_id,
      permissions: user.permissions,
      created_at: user.created_at
    });
  }

  const userMatch = /^\/api\/users\/(\d+)$/.exec(pathname);
  if (userMatch && method === "PUT") {
    if (!requireAnyPermission(res, session, ["users.manage"])) return;
    const target = findActiveUserById(Number(userMatch[1]));
    if (!target) return json(res, 404, { error: "Usuario nao encontrado" });

    const body = parseJsonBuffer(await readBody(req));
    const username = String(body.username || target.username).trim();
    const role = normalizeRole(body.role || target.role);
    const permissions = normalizePermissions(role, body.permissions || target.permissions);
    const projectId = body.project_id !== undefined ? Number(body.project_id || 0) || null : (target.project_id || null);
    const project = projectId ? findProjectById(projectId) : null;

    if (!username) return json(res, 400, { error: "Informe um nome de usuario" });
    if (role === "FUNCIONARIO" && !project) return json(res, 400, { error: "Selecione a obra do funcionario" });
    const normalizedUsername = normalizeUsername(username);
    if (store.users.some((item) => item.deleted_at !== true && item.id !== target.id && normalizeUsername(item.username) === normalizedUsername)) {
      return json(res, 400, { error: "Usuario ja existente" });
    }
    if (target.id === session.id && body.active === false) {
      return json(res, 400, { error: "Nao e possivel desativar o proprio usuario" });
    }
    if (normalizeRole(target.role) === "ADM" && role !== "ADM" && activeAdminsCount(target.id) === 0) {
      return json(res, 400, { error: "Deve existir pelo menos um administrador ativo" });
    }

    target.username = username;
    target.role = role;
    target.permissions = permissions;
    target.project_id = project?.id || null;
    target.project_name = project?.name || "";
    if (body.password) {
      if (String(body.password).length < 6) return json(res, 400, { error: "Senha deve ter pelo menos 6 caracteres" });
      target.password_hash = hashPassword(String(body.password));
    }
    if (body.active === false) target.deleted_at = true;
    target.updated_at = now();
    saveStore();
    addHistory("user", target.id, "updated", { username: target.username, role: target.role, permissions: target.permissions }, session.username);

    if (target.id === session.id) {
      const token = parseCookies(req).session_token;
      if (token) {
        sessions.set(token, {
          id: target.id,
          username: target.username,
          role: normalizeRole(target.role),
          permissions: normalizePermissions(target.role, target.permissions),
          project_id: target.project_id || null,
          project_name: target.project_name || "",
          createdAt: session.createdAt || now()
        });
      }
    }

    return json(res, 200, {
      id: target.id,
      username: target.username,
      role: target.role,
      project: target.project_name,
      project_id: target.project_id,
      permissions: target.permissions,
      created_at: target.created_at
    });
  }

  if (userMatch && method === "DELETE") {
    if (!requireAnyPermission(res, session, ["users.manage"])) return;
    const target = findActiveUserById(Number(userMatch[1]));
    if (!target) return json(res, 404, { error: "Usuario nao encontrado" });
    if (target.id === session.id) return json(res, 400, { error: "Nao e possivel remover o proprio usuario" });
    if (normalizeRole(target.role) === "ADM" && activeAdminsCount(target.id) === 0) {
      return json(res, 400, { error: "Deve existir pelo menos um administrador ativo" });
    }

    target.deleted_at = true;
    target.updated_at = now();
    saveStore();
    addHistory("user", target.id, "deleted", {}, session.username);
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/dashboard" && method === "GET") {
    if (!requireAnyPermission(res, session, ["dashboard.view"])) return;
    return json(res, 200, getDashboard());
  }

  if (pathname === "/api/requests" && method === "GET") {
    if (!requireAnyPermission(res, session, ["requests.manage", "requests.approve", "employee.requests.view"])) return;
    return json(res, 200, listRequests({
      onlyOpen: url.searchParams.get("onlyOpen") === "true",
      pendingApproval: url.searchParams.get("pendingApproval") === "true",
      project: url.searchParams.get("project") || "",
      status: url.searchParams.get("status") || "",
      priority: url.searchParams.get("priority") || "",
      approvalState: url.searchParams.get("approvalState") || "",
      deadline: url.searchParams.get("deadline") || "",
      search: url.searchParams.get("search") || ""
    }, session));
  }

  if (pathname === "/api/requests" && method === "POST") {
    if (!requireAnyPermission(res, session, ["requests.create", "requests.manage"])) return;
    const body = parseJsonBuffer(await readBody(req));
    const required = ["item_name", "quantity", "unit", "project_name", "requester_name", "request_date", "needed_by_date", "priority"];
    const missing = required.filter((field) => !String(body[field] || "").trim());
    if (missing.length) return json(res, 400, { error: `Campos obrigatorios: ${missing.join(", ")}` });
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return json(res, 400, { error: "Quantidade invalida" });
    const unit = normalizeUnit(body.unit);
    if (!UNIT_OPTIONS.includes(unit)) return json(res, 400, { error: "Unidade invalida" });
    if (!PRIORITY_OPTIONS.includes(String(body.priority || ""))) return json(res, 400, { error: "Prioridade invalida" });
    const status = String(body.status || "Solicitacao recebida");
    if (!STATUS_OPTIONS.includes(status)) return json(res, 400, { error: "Status invalido" });
    const requestDate = String(body.request_date || "").trim();
    const neededByDate = String(body.needed_by_date || "").trim();
    if (!isIsoDate(requestDate) || !isIsoDate(neededByDate)) return json(res, 400, { error: "Datas invalidas" });
    const project = findProjectByName(body.project_name);
    if (!project) return json(res, 400, { error: "Selecione uma obra valida" });

    const request = {
      id: nextId("requests"),
      item_name: body.item_name.trim(),
      description: String(body.description || "").trim(),
      quantity,
      unit,
      project_name: project.name,
      requester_name: body.requester_name.trim(),
      request_date: requestDate,
      needed_by_date: neededByDate,
      priority: body.priority,
      notes: (body.notes || "").trim(),
      status,
      approval_state: body.approval_state || "Aprovado",
      approval_reason: body.approval_reason || "",
      source: body.source || "desktop",
      requested_by_user_id: session.id,
      budget_notes: "",
      budget_attachment_path: null,
      created_at: now(),
      updated_at: now(),
      deleted_at: null
    };
    store.requests.push(request);
    saveStore();
    addHistory("request", request.id, "created", request, session.username);
    return json(res, 201, { id: request.id });
  }

  if (pathname === "/api/employee/requests" && method === "POST") {
    if (!requireAnyPermission(res, session, ["employee.requests.create"])) return;
    const body = parseJsonBuffer(await readBody(req));
    const required = ["item_name", "quantity", "unit"];
    const missing = required.filter((field) => !String(body[field] || "").trim());
    if (missing.length) return json(res, 400, { error: `Campos obrigatorios: ${missing.join(", ")}` });
    const quantity = Number(body.quantity);
    if (!quantity || quantity <= 0) return json(res, 400, { error: "Quantidade invalida" });
    const projectName = String(session.project_name || "").trim();
    if (!projectName) return json(res, 400, { error: "Funcionario sem obra vinculada. Contate o administrador." });
    const unit = normalizeUnit(body.unit);
    if (!UNIT_OPTIONS.includes(unit)) return json(res, 400, { error: "Unidade invalida" });
    const neededByDate = String(body.needed_by_date || "").trim() || todayString();
    if (!isIsoDate(neededByDate)) return json(res, 400, { error: "Data de entrega invalida" });

    const request = {
      id: nextId("requests"),
      item_name: body.item_name.trim(),
      description: String(body.description || "").trim(),
      quantity,
      unit,
      project_name: projectName,
      requester_name: session.username,
      request_date: todayString(),
      needed_by_date: neededByDate,
      priority: PRIORITY_OPTIONS.includes(body.priority) ? body.priority : "Media",
      notes: (body.notes || "").trim(),
      status: "Pendente de aprovacao",
      approval_state: "Pendente",
      approval_reason: "",
      source: "web",
      requested_by_user_id: session.id,
      budget_notes: "",
      budget_attachment_path: null,
      created_at: now(),
      updated_at: now(),
      deleted_at: null
    };
    store.requests.push(request);
    saveStore();
    addHistory("request", request.id, "employee_created", request, session.username);
    return json(res, 201, { id: request.id });
  }

  if (pathname === "/api/employee/requests" && method === "GET") {
    if (!requireAnyPermission(res, session, ["employee.requests.view"])) return;
    return json(res, 200, listRequests({
      onlyOpen: false,
      pendingApproval: false,
      project: "",
      status: url.searchParams.get("status") || "",
      priority: "",
      approvalState: url.searchParams.get("approvalState") || "",
      deadline: "",
      search: url.searchParams.get("search") || ""
    }, session));
  }

  const requestIdMatch = /^\/api\/requests\/(\d+)$/.exec(pathname);
  if (requestIdMatch && method === "PUT") {
    if (!requireAnyPermission(res, session, ["requests.manage"])) return;
    const body = parseJsonBuffer(await readBody(req));
    const request = store.requests.find((item) => item.id === Number(requestIdMatch[1]) && !item.deleted_at);
    if (!request) return json(res, 404, { error: "Demanda nao encontrada" });
    const required = ["item_name", "project_name", "requester_name", "request_date", "needed_by_date", "priority", "status"];
    const missing = required.filter((field) => !String(body[field] || "").trim());
    if (missing.length) return json(res, 400, { error: `Campos obrigatorios: ${missing.join(", ")}` });
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return json(res, 400, { error: "Quantidade invalida" });
    const unit = normalizeUnit(body.unit);
    if (!UNIT_OPTIONS.includes(unit)) return json(res, 400, { error: "Unidade invalida" });
    if (!PRIORITY_OPTIONS.includes(String(body.priority || ""))) return json(res, 400, { error: "Prioridade invalida" });
    if (!STATUS_OPTIONS.includes(String(body.status || ""))) return json(res, 400, { error: "Status invalido" });
    const requestDate = String(body.request_date || "").trim();
    const neededByDate = String(body.needed_by_date || "").trim();
    if (!isIsoDate(requestDate) || !isIsoDate(neededByDate)) return json(res, 400, { error: "Datas invalidas" });
    const project = findProjectByName(body.project_name);
    if (!project) return json(res, 400, { error: "Selecione uma obra valida" });

    Object.assign(request, {
      item_name: String(body.item_name || "").trim(),
      description: String(body.description || ""),
      quantity,
      unit,
      project_name: project.name,
      requester_name: String(body.requester_name || "").trim(),
      request_date: requestDate,
      needed_by_date: neededByDate,
      priority: body.priority,
      notes: body.notes || "",
      status: body.status,
      approval_state: body.approval_state || request.approval_state || "Aprovado",
      approval_reason: body.approval_reason || request.approval_reason || "",
      updated_at: now()
    });
    saveStore();
    addHistory("request", request.id, "updated", request, session.username);
    return json(res, 200, { ok: true });
  }

  if (requestIdMatch && method === "DELETE") {
    if (!requireAnyPermission(res, session, ["requests.manage"])) return;
    const request = store.requests.find((item) => item.id === Number(requestIdMatch[1]) && !item.deleted_at);
    if (!request) return json(res, 404, { error: "Demanda nao encontrada" });
    request.deleted_at = now();
    request.updated_at = now();
    saveStore();
    addHistory("request", request.id, "deleted", {}, session.username);
    return json(res, 200, { ok: true });
  }

  const statusMatch = /^\/api\/requests\/(\d+)\/status$/.exec(pathname);
  if (statusMatch && method === "PATCH") {
    if (!requireAnyPermission(res, session, ["requests.manage"])) return;
    const body = parseJsonBuffer(await readBody(req));
    const request = store.requests.find((item) => item.id === Number(statusMatch[1]) && !item.deleted_at);
    if (!request) return json(res, 404, { error: "Demanda nao encontrada" });
    const status = String(body.status || "");
    if (!STATUS_OPTIONS.includes(status)) return json(res, 400, { error: "Status invalido" });
    request.status = status;
    request.updated_at = now();
    saveStore();
    addHistory("request", request.id, "status_changed", { status }, session.username);
    return json(res, 200, { ok: true });
  }

  const approvalMatch = /^\/api\/requests\/(\d+)\/approval$/.exec(pathname);
  if (approvalMatch && method === "PATCH") {
    if (!requireAnyPermission(res, session, ["requests.approve"])) return;
    const body = parseJsonBuffer(await readBody(req));
    const request = store.requests.find((item) => item.id === Number(approvalMatch[1]) && !item.deleted_at);
    if (!request) return json(res, 404, { error: "Demanda nao encontrada" });

    const decision = String(body.decision || "").toLowerCase();
    const reason = String(body.reason || "").trim();
    if (!["approve", "reject"].includes(decision)) return json(res, 400, { error: "Decisao invalida" });

    if (decision === "approve") {
      request.approval_state = "Aprovado";
      request.approval_reason = reason;
      if (request.status === "Pendente de aprovacao") request.status = "Solicitacao recebida";
      request.updated_at = now();
      saveStore();
      addHistory("request", request.id, "approved", { reason }, session.username);
      return json(res, 200, { ok: true, approvalState: "Aprovado" });
    }

    request.approval_state = "Recusado";
    request.approval_reason = reason;
    request.status = "Recusado";
    request.updated_at = now();
    saveStore();
    addHistory("request", request.id, "rejected", { reason }, session.username);
    return json(res, 200, { ok: true, approvalState: "Recusado" });
  }

  const budgetMatch = /^\/api\/requests\/(\d+)\/budget-attachment$/.exec(pathname);
  if (budgetMatch && method === "POST") {
    if (!requireAnyPermission(res, session, ["requests.manage", "purchases.finalize"])) return;
    const request = store.requests.find((item) => item.id === Number(budgetMatch[1]) && !item.deleted_at);
    if (!request) return json(res, 404, { error: "Demanda nao encontrada" });
    const body = parseJsonBuffer(await readBody(req));
    const budgetNotes = String(body.budget_notes || "").trim();
    if (!budgetNotes) return json(res, 400, { error: "Informe as cotacoes e observacoes do orcamento" });
    request.budget_notes = budgetNotes;
    request.updated_at = now();
    saveStore();
    addHistory("request", request.id, "budget_updated", { budget_notes: request.budget_notes }, session.username);
    return json(res, 200, { ok: true, budget_notes: request.budget_notes });
  }

  const finalizeMatch = /^\/api\/requests\/(\d+)\/finalize$/.exec(pathname);
  if (finalizeMatch && method === "POST") {
    if (!requireAnyPermission(res, session, ["purchases.finalize"])) return;
    const rawBody = await readBody(req);
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    const payload = contentType.includes("application/json")
      ? parseJsonBuffer(rawBody)
      : parseMultipart(rawBody, req.headers["content-type"]).fields;
    const result = finalizePurchaseGroup({
      ...payload,
      request_ids: [Number(finalizeMatch[1])],
      block_name: String(payload.block_name || "").trim() || `Compra item #${Number(finalizeMatch[1])}`
    }, session.username);
    if (result.error) return json(res, 400, { error: result.error });
    return json(res, 201, { ok: true, purchaseId: result.purchase.id });
  }

  if (pathname === "/api/purchases/finalize-group" && method === "POST") {
    if (!requireAnyPermission(res, session, ["purchases.finalize"])) return;
    const body = parseJsonBuffer(await readBody(req));
    const result = finalizePurchaseGroup(body, session.username);
    if (result.error) return json(res, 400, { error: result.error });
    return json(res, 201, { ok: true, purchaseId: result.purchase.id });
  }

  const purchaseStatusMatch = /^\/api\/purchases\/(\d+)\/status$/.exec(pathname);
  if (purchaseStatusMatch && method === "PATCH") {
    if (!requireAnyPermission(res, session, ["purchases.finalize"])) return;
    const body = parseJsonBuffer(await readBody(req));
    const purchase = store.purchases.find((item) => Number(item.id) === Number(purchaseStatusMatch[1]));
    if (!purchase) return json(res, 404, { error: "Compra nao encontrada" });
    const status = String(body.status || "");
    if (!PURCHASE_STATUS_OPTIONS.includes(status)) return json(res, 400, { error: "Status de compra invalido" });

    purchase.status = status;
    purchase.updated_at = now();
    if (status === "Cancelada") {
      purchase.canceled_reason = String(body.reason || "").trim();
      purchase.canceled_at = now();
    } else {
      purchase.canceled_reason = "";
      purchase.canceled_at = null;
    }

    for (const requestId of purchaseRequestIds(purchase)) {
      const request = store.requests.find((item) => Number(item.id) === Number(requestId) && !item.deleted_at);
      if (!request) continue;
      request.status = status === "Cancelada" ? "Cancelado" : "Compra realizada";
      request.updated_at = now();
    }

    saveStore();
    addHistory("purchase", purchase.id, "status_changed", { status, reason: purchase.canceled_reason }, session.username);
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/purchases" && method === "GET") {
    if (!requireAnyPermission(res, session, ["reports.view", "purchases.finalize"])) return;
    return json(res, 200, listPurchases({
      project: url.searchParams.get("project") || "",
      supplier: url.searchParams.get("supplier") || "",
      status: url.searchParams.get("status") || "",
      search: url.searchParams.get("search") || "",
      startDate: url.searchParams.get("startDate") || "",
      endDate: url.searchParams.get("endDate") || ""
    }));
  }

  if (pathname === "/api/history" && method === "GET") {
    if (!requireAnyPermission(res, session, ["history.view"])) return;
    return json(res, 200, store.history.slice(0, 200));
  }
  if (pathname === "/api/reports" && method === "GET") {
    if (!requireAnyPermission(res, session, ["reports.view"])) return;
    return json(res, 200, getReports(url.searchParams.get("startDate") || "", url.searchParams.get("endDate") || ""));
  }

  if (pathname === "/api/exports/purchases.csv" && method === "GET") {
    if (!requireAnyPermission(res, session, ["reports.view", "purchases.finalize"])) return;
    const csv = toCsv(listPurchases({
      project: url.searchParams.get("project") || "",
      supplier: url.searchParams.get("supplier") || "",
      status: url.searchParams.get("status") || "",
      search: url.searchParams.get("search") || "",
      startDate: url.searchParams.get("startDate") || "",
      endDate: url.searchParams.get("endDate") || ""
    }));
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=historico-compras.csv" });
    return res.end(csv);
  }

  if (pathname === "/api/exports/reports.csv" && method === "GET") {
    if (!requireAnyPermission(res, session, ["reports.view"])) return;
    const report = getReports(url.searchParams.get("startDate") || "", url.searchParams.get("endDate") || "");
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=relatorio-gastos-por-obra.csv" });
    return res.end(toCsv(report.totalsByProject));
  }

  if (pathname === "/api/exports/reports-print" && method === "GET") {
    if (!requireAnyPermission(res, session, ["reports.view"])) return;
    const report = getReports(url.searchParams.get("startDate") || "", url.searchParams.get("endDate") || "");
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatorio de Compras</title><style>body{font-family:Arial,sans-serif;padding:32px;color:#182534}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #d4dce3;padding:10px;text-align:left}th{background:#eef3f8}</style></head><body><h1>Relatorio de Gastos por Obra</h1><p>Gerado em ${new Date().toLocaleString("pt-BR")}</p><table><thead><tr><th>Obra</th><th>Total</th></tr></thead><tbody>${report.totalsByProject.map((row) => `<tr><td>${escapeHtml(row.project)}</td><td>R$ ${Number(row.total).toFixed(2)}</td></tr>`).join("")}</tbody></table><script>window.onload=()=>window.print()</script></body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  return json(res, 404, { error: "Rota nao encontrada" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    const session = getSession(req);

    if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname, session);
    if (pathname === "/" || pathname === "/employee" || pathname === "/employee/") return serveStatic(req, res, "/public/employee.html");
    if (pathname === "/adm" || pathname === "/adm/") return serveStatic(req, res, "/public/index.html");
    if (pathname.startsWith("/public/") || pathname.startsWith("/uploads/")) return serveStatic(req, res, pathname);
    return serveStatic(req, res, "/public/employee.html");
  } catch (error) {
    if (Number(error?.statusCode) === 413) {
      return json(res, 413, { error: "Arquivo ou requisicao excede o tamanho maximo permitido" });
    }
    console.error(error);
    return json(res, 500, { error: "Erro interno do servidor" });
  }
});

server.listen(PORT, () => {
  console.log(`Sistema disponivel em http://localhost:${PORT}`);
  console.log(`Portal do funcionario: http://localhost:${PORT}/`);
  console.log(`Portal administrativo: http://localhost:${PORT}/adm`);
});
