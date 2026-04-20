const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const DB_PATH = path.join(DATA_DIR, "compras.db");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
const sessions = new Map();

const STATUS_OPTIONS = [
  "Solicitacao recebida",
  "Em cotacao",
  "Aguardando aprovacao",
  "Compra realizada",
  "Entregue",
  "Cancelado"
];

const PRIORITY_OPTIONS = ["Baixa", "Media", "Alta", "Urgente"];

function now() {
  return new Date().toISOString();
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
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
  fs.createReadStream(filePath)
    .on("error", () => {
      res.writeHead(404);
      res.end("Arquivo nao encontrado");
    })
    .pipe(res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" }));
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
    req
      .on("data", (chunk) => chunks.push(chunk))
      .on("end", () => resolve(Buffer.concat(chunks)))
      .on("error", reject);
  });
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
    let bodyBinary = trimmed.slice(separatorIndex + 4);
    bodyBinary = bodyBinary.replace(/\r\n$/, "");

    const disposition = /name="([^"]+)"/i.exec(headerText);
    if (!disposition) continue;
    const fieldName = disposition[1];
    const fileNameMatch = /filename="([^"]*)"/i.exec(headerText);

    if (fileNameMatch && fileNameMatch[1]) {
      files[fieldName] = {
        filename: sanitizeFileName(path.basename(fileNameMatch[1])),
        content: Buffer.from(bodyBinary, "binary"),
        contentType: (/Content-Type:\s*([^\r\n]+)/i.exec(headerText) || [])[1] || "application/octet-stream"
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
  sessions.set(token, { id: user.id, username: user.username, role: user.role, createdAt: now() });
  return token;
}

function getSession(req) {
  const token = parseCookies(req).session_token;
  return token ? sessions.get(token) : null;
}

function logHistory(entityType, entityId, action, details, username) {
  db.prepare(
    `INSERT INTO history (entity_type, entity_id, action, details, username, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(entityType, entityId, action, JSON.stringify(details || {}), username || "sistema", now());
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'compras',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_name TEXT NOT NULL,
      description TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit TEXT NOT NULL,
      project_name TEXT NOT NULL,
      requester_name TEXT NOT NULL,
      request_date TEXT NOT NULL,
      needed_by_date TEXT NOT NULL,
      priority TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL,
      budget_attachment_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL UNIQUE,
      supplier TEXT NOT NULL,
      amount_paid REAL NOT NULL,
      purchase_date TEXT NOT NULL,
      delivery_deadline TEXT NOT NULL,
      invoice_number TEXT,
      payment_method TEXT,
      observations TEXT,
      invoice_file_path TEXT,
      approved_budget_file_path TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (request_id) REFERENCES requests(id)
    );

    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      username TEXT,
      created_at TEXT NOT NULL
    );
  `);

  const admin = db.prepare("SELECT id FROM users WHERE username = ?").get("admin");
  if (!admin) {
    db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)")
      .run("admin", hashPassword("admin123"), "administrador", now());
  }
}

function mapRequest(row) {
  return {
    ...row,
    quantity: Number(row.quantity),
    isOverdue: row.status !== "Entregue" && row.status !== "Cancelado" && new Date(row.needed_by_date) < new Date(),
    budgetAttachmentUrl: row.budget_attachment_path || null
  };
}

function listRequests(filters = {}) {
  const clauses = ["deleted_at IS NULL"];
  const params = [];

  if (filters.onlyOpen) clauses.push("id NOT IN (SELECT request_id FROM purchases)");
  if (filters.project) {
    clauses.push("project_name = ?");
    params.push(filters.project);
  }
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }
  if (filters.priority) {
    clauses.push("priority = ?");
    params.push(filters.priority);
  }
  if (filters.deadline === "overdue") {
    clauses.push("date(needed_by_date) < date('now')");
    clauses.push("status NOT IN ('Entregue','Cancelado')");
  }
  if (filters.deadline === "week") {
    clauses.push("date(needed_by_date) BETWEEN date('now') AND date('now', '+7 day')");
  }
  if (filters.search) {
    clauses.push("(item_name LIKE ? OR description LIKE ? OR project_name LIKE ?)");
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }

  return db.prepare(
    `SELECT * FROM requests WHERE ${clauses.join(" AND ")} ORDER BY
      CASE priority
        WHEN 'Urgente' THEN 1
        WHEN 'Alta' THEN 2
        WHEN 'Media' THEN 3
        ELSE 4
      END,
      needed_by_date ASC, id DESC`
  ).all(...params).map(mapRequest);
}

function listPurchases(filters = {}) {
  const clauses = ["r.deleted_at IS NULL"];
  const params = [];

  if (filters.project) {
    clauses.push("r.project_name = ?");
    params.push(filters.project);
  }
  if (filters.supplier) {
    clauses.push("p.supplier = ?");
    params.push(filters.supplier);
  }
  if (filters.search) {
    clauses.push("(r.item_name LIKE ? OR r.project_name LIKE ?)");
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.startDate) {
    clauses.push("date(p.purchase_date) >= date(?)");
    params.push(filters.startDate);
  }
  if (filters.endDate) {
    clauses.push("date(p.purchase_date) <= date(?)");
    params.push(filters.endDate);
  }

  return db.prepare(
    `SELECT
      p.*,
      r.item_name,
      r.project_name,
      r.priority,
      r.status
     FROM purchases p
     JOIN requests r ON r.id = p.request_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY p.purchase_date DESC, p.id DESC`
  ).all(...params).map((row) => ({
    ...row,
    amount_paid: Number(row.amount_paid)
  }));
}

function getDashboard() {
  const openDemandCount = db.prepare(
    `SELECT COUNT(*) AS total FROM requests
     WHERE deleted_at IS NULL
     AND id NOT IN (SELECT request_id FROM purchases)
     AND status NOT IN ('Entregue','Cancelado')`
  ).get().total;
  const completedCount = db.prepare("SELECT COUNT(*) AS total FROM purchases").get().total;
  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthlySpend = db.prepare(
    `SELECT COALESCE(SUM(amount_paid), 0) AS total
     FROM purchases
     WHERE substr(purchase_date, 1, 7) = ?`
  ).get(currentMonth).total;

  return {
    openDemandCount,
    completedCount,
    monthlySpend: Number(monthlySpend || 0),
    requestsByProject: db.prepare(
      `SELECT project_name AS name, COUNT(*) AS total
       FROM requests
       WHERE deleted_at IS NULL
       GROUP BY project_name
       ORDER BY total DESC`
    ).all(),
    expiringSoon: db.prepare(
      `SELECT id, item_name, project_name, needed_by_date, priority, status
       FROM requests
       WHERE deleted_at IS NULL
       AND date(needed_by_date) BETWEEN date('now') AND date('now', '+5 day')
       AND status NOT IN ('Entregue','Cancelado')
       ORDER BY needed_by_date ASC`
    ).all(),
    overdue: db.prepare(
      `SELECT id, item_name, project_name, needed_by_date, priority, status
       FROM requests
       WHERE deleted_at IS NULL
       AND date(needed_by_date) < date('now')
       AND status NOT IN ('Entregue','Cancelado')
       ORDER BY needed_by_date ASC`
    ).all(),
    statusChart: db.prepare(
      `SELECT status AS label, COUNT(*) AS total
       FROM requests
       WHERE deleted_at IS NULL
       GROUP BY status
       ORDER BY total DESC`
    ).all()
  };
}

function getReports(startDate, endDate) {
  const filters = [];
  const params = [];
  if (startDate) {
    filters.push("date(p.purchase_date) >= date(?)");
    params.push(startDate);
  }
  if (endDate) {
    filters.push("date(p.purchase_date) <= date(?)");
    params.push(endDate);
  }
  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  return {
    byProject: db.prepare(
      `SELECT r.project_name AS label, ROUND(SUM(p.amount_paid), 2) AS total
       FROM purchases p
       JOIN requests r ON r.id = p.request_id
       ${whereClause}
       GROUP BY r.project_name
       ORDER BY total DESC`
    ).all(...params),
    byMonth: db.prepare(
      `SELECT substr(p.purchase_date, 1, 7) AS label, ROUND(SUM(p.amount_paid), 2) AS total
       FROM purchases p
       ${whereClause}
       GROUP BY substr(p.purchase_date, 1, 7)
       ORDER BY label DESC`
    ).all(...params),
    bySupplier: db.prepare(
      `SELECT p.supplier AS label, ROUND(SUM(p.amount_paid), 2) AS total
       FROM purchases p
       ${whereClause}
       GROUP BY p.supplier
       ORDER BY total DESC`
    ).all(...params),
    topMaterials: db.prepare(
      `SELECT r.item_name AS label, COUNT(*) AS total
       FROM purchases p
       JOIN requests r ON r.id = p.request_id
       ${whereClause}
       GROUP BY r.item_name
       ORDER BY total DESC
       LIMIT 10`
    ).all(...params),
    delayedPurchases: db.prepare(
      `SELECT r.item_name, r.project_name, p.supplier, p.delivery_deadline, p.purchase_date
       FROM purchases p
       JOIN requests r ON r.id = p.request_id
       WHERE date(p.delivery_deadline) < date('now')
       ORDER BY p.delivery_deadline ASC`
    ).all(),
    totalsByProject: db.prepare(
      `SELECT r.project_name AS project, ROUND(SUM(p.amount_paid), 2) AS total
       FROM purchases p
       JOIN requests r ON r.id = p.request_id
       ${whereClause}
       GROUP BY r.project_name
       ORDER BY total DESC`
    ).all(...params)
  };
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return [headers.join(","), ...rows.map((row) => headers.map((key) => escape(row[key])).join(","))].join("\n");
}

function serveStatic(req, res, pathname) {
  const fullPath = path.join(ROOT, pathname);
  if (!fullPath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Acesso negado");
    return;
  }
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    return sendFile(res, fullPath);
  }
  res.writeHead(404);
  res.end("Nao encontrado");
}

async function handleApi(req, res, pathname, session) {
  const method = req.method || "GET";
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === "/api/login" && method === "POST") {
    const body = parseJsonBuffer(await readBody(req));
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get((body.username || "").trim());
    if (!user || user.password_hash !== hashPassword(body.password || "")) {
      return json(res, 401, { error: "Usuario ou senha invalidos" });
    }
    const token = createSession(user);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": `session_token=${token}; HttpOnly; Path=/; SameSite=Lax`
    });
    return res.end(JSON.stringify({ username: user.username, role: user.role }));
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

  if (pathname === "/api/session" && method === "GET") {
    return json(res, 200, { authenticated: Boolean(session), user: session || null });
  }

  if (!session) return json(res, 401, { error: "Nao autenticado" });

  if (pathname === "/api/meta" && method === "GET") {
    return json(res, 200, { statusOptions: STATUS_OPTIONS, priorityOptions: PRIORITY_OPTIONS });
  }

  if (pathname === "/api/dashboard" && method === "GET") return json(res, 200, getDashboard());

  if (pathname === "/api/requests" && method === "GET") {
    return json(res, 200, listRequests({
      onlyOpen: url.searchParams.get("onlyOpen") === "true",
      project: url.searchParams.get("project") || "",
      status: url.searchParams.get("status") || "",
      priority: url.searchParams.get("priority") || "",
      deadline: url.searchParams.get("deadline") || "",
      search: url.searchParams.get("search") || ""
    }));
  }

  if (pathname === "/api/requests" && method === "POST") {
    const body = parseJsonBuffer(await readBody(req));
    const required = ["item_name", "description", "quantity", "unit", "project_name", "requester_name", "request_date", "needed_by_date", "priority"];
    const missing = required.filter((field) => !String(body[field] || "").trim());
    if (missing.length) return json(res, 400, { error: `Campos obrigatorios: ${missing.join(", ")}` });

    const result = db.prepare(
      `INSERT INTO requests
      (item_name, description, quantity, unit, project_name, requester_name, request_date, needed_by_date, priority, notes, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      body.item_name.trim(),
      body.description.trim(),
      Number(body.quantity),
      body.unit.trim(),
      body.project_name.trim(),
      body.requester_name.trim(),
      body.request_date,
      body.needed_by_date,
      body.priority,
      (body.notes || "").trim(),
      body.status || "Solicitacao recebida",
      now(),
      now()
    );
    logHistory("request", result.lastInsertRowid, "created", body, session.username);
    return json(res, 201, { id: result.lastInsertRowid });
  }

  const requestIdMatch = /^\/api\/requests\/(\d+)$/.exec(pathname);
  if (requestIdMatch && method === "PUT") {
    const id = Number(requestIdMatch[1]);
    const body = parseJsonBuffer(await readBody(req));
    db.prepare(
      `UPDATE requests SET
        item_name = ?, description = ?, quantity = ?, unit = ?, project_name = ?, requester_name = ?,
        request_date = ?, needed_by_date = ?, priority = ?, notes = ?, status = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`
    ).run(
      body.item_name,
      body.description,
      Number(body.quantity),
      body.unit,
      body.project_name,
      body.requester_name,
      body.request_date,
      body.needed_by_date,
      body.priority,
      body.notes || "",
      body.status,
      now(),
      id
    );
    logHistory("request", id, "updated", body, session.username);
    return json(res, 200, { ok: true });
  }

  if (requestIdMatch && method === "DELETE") {
    const id = Number(requestIdMatch[1]);
    db.prepare("UPDATE requests SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
    logHistory("request", id, "deleted", {}, session.username);
    return json(res, 200, { ok: true });
  }

  const statusMatch = /^\/api\/requests\/(\d+)\/status$/.exec(pathname);
  if (statusMatch && method === "PATCH") {
    const id = Number(statusMatch[1]);
    const body = parseJsonBuffer(await readBody(req));
    db.prepare("UPDATE requests SET status = ?, updated_at = ? WHERE id = ?").run(body.status, now(), id);
    logHistory("request", id, "status_changed", { status: body.status }, session.username);
    return json(res, 200, { ok: true });
  }

  const budgetMatch = /^\/api\/requests\/(\d+)\/budget-attachment$/.exec(pathname);
  if (budgetMatch && method === "POST") {
    const id = Number(budgetMatch[1]);
    const multipart = parseMultipart(await readBody(req), req.headers["content-type"]);
    const budgetPath = saveUploadedFile(multipart.files.budget_file, `orcamento-${id}`);
    db.prepare("UPDATE requests SET budget_attachment_path = ?, updated_at = ? WHERE id = ?").run(budgetPath, now(), id);
    logHistory("request", id, "budget_attached", { budgetPath }, session.username);
    return json(res, 200, { ok: true, budgetPath });
  }

  const finalizeMatch = /^\/api\/requests\/(\d+)\/finalize$/.exec(pathname);
  if (finalizeMatch && method === "POST") {
    const id = Number(finalizeMatch[1]);
    const multipart = parseMultipart(await readBody(req), req.headers["content-type"]);
    const invoicePath = saveUploadedFile(multipart.files.invoice_file, `nota-${id}`);
    const approvedBudgetPath = saveUploadedFile(multipart.files.approved_budget_file, `orcamento-aprovado-${id}`);
    db.prepare(
      `INSERT INTO purchases
      (request_id, supplier, amount_paid, purchase_date, delivery_deadline, invoice_number, payment_method, observations, invoice_file_path, approved_budget_file_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      multipart.fields.supplier,
      Number(multipart.fields.amount_paid),
      multipart.fields.purchase_date,
      multipart.fields.delivery_deadline,
      multipart.fields.invoice_number || "",
      multipart.fields.payment_method || "",
      multipart.fields.observations || "",
      invoicePath,
      approvedBudgetPath,
      now()
    );
    db.prepare("UPDATE requests SET status = ?, updated_at = ? WHERE id = ?").run("Compra realizada", now(), id);
    logHistory("purchase", id, "finalized", multipart.fields, session.username);
    return json(res, 201, { ok: true });
  }

  if (pathname === "/api/purchases" && method === "GET") {
    return json(res, 200, listPurchases({
      project: url.searchParams.get("project") || "",
      supplier: url.searchParams.get("supplier") || "",
      search: url.searchParams.get("search") || "",
      startDate: url.searchParams.get("startDate") || "",
      endDate: url.searchParams.get("endDate") || ""
    }));
  }

  if (pathname === "/api/history" && method === "GET") {
    return json(res, 200, db.prepare(
      `SELECT * FROM history
       ORDER BY created_at DESC, id DESC
       LIMIT 200`
    ).all().map((row) => ({ ...row, details: row.details ? JSON.parse(row.details) : {} })));
  }

  if (pathname === "/api/reports" && method === "GET") {
    return json(res, 200, getReports(url.searchParams.get("startDate") || "", url.searchParams.get("endDate") || ""));
  }

  if (pathname === "/api/exports/purchases.csv" && method === "GET") {
    const csv = toCsv(listPurchases({
      project: url.searchParams.get("project") || "",
      supplier: url.searchParams.get("supplier") || "",
      search: url.searchParams.get("search") || "",
      startDate: url.searchParams.get("startDate") || "",
      endDate: url.searchParams.get("endDate") || ""
    }));
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=historico-compras.csv"
    });
    return res.end(csv);
  }

  if (pathname === "/api/exports/reports.csv" && method === "GET") {
    const report = getReports(url.searchParams.get("startDate") || "", url.searchParams.get("endDate") || "");
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=relatorio-gastos-por-obra.csv"
    });
    return res.end(toCsv(report.totalsByProject));
  }

  if (pathname === "/api/exports/reports-print" && method === "GET") {
    const report = getReports(url.searchParams.get("startDate") || "", url.searchParams.get("endDate") || "");
    const html = `
      <!doctype html>
      <html lang="pt-BR">
      <head>
        <meta charset="utf-8">
        <title>Relatorio de Compras</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 32px; color: #182534; }
          h1 { margin-bottom: 8px; }
          table { width: 100%; border-collapse: collapse; margin-top: 20px; }
          th, td { border: 1px solid #d4dce3; padding: 10px; text-align: left; }
          th { background: #eef3f8; }
        </style>
      </head>
      <body>
        <h1>Relatorio de Gastos por Obra</h1>
        <p>Gerado em ${new Date().toLocaleString("pt-BR")}</p>
        <table>
          <thead><tr><th>Obra</th><th>Total</th></tr></thead>
          <tbody>
            ${report.totalsByProject.map((row) => `<tr><td>${row.project}</td><td>R$ ${Number(row.total).toFixed(2)}</td></tr>`).join("")}
          </tbody>
        </table>
        <script>window.onload = () => window.print();</script>
      </body>
      </html>
    `;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  return json(res, 404, { error: "Rota nao encontrada" });
}

initDb();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    const session = getSession(req);

    if (pathname.startsWith("/api/")) {
      return await handleApi(req, res, pathname, session);
    }

    if (pathname === "/") {
      return serveStatic(req, res, "/public/index.html");
    }

    if (pathname.startsWith("/public/") || pathname.startsWith("/uploads/")) {
      return serveStatic(req, res, pathname);
    }

    return serveStatic(req, res, "/public/index.html");
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: "Erro interno do servidor" });
  }
});

server.listen(PORT, () => {
  console.log(`Sistema disponivel em http://localhost:${PORT}`);
  console.log("Usuario padrao: admin");
  console.log("Senha padrao: admin123");
});
