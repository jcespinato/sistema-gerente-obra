const state = {
  user: null,
  currentView: "dashboard",
  meta: { statusOptions: [], priorityOptions: [], unitOptions: [], purchaseStatusOptions: [], permissionsCatalog: [] },
  dashboard: null,
  requests: [],
  approvals: [],
  purchases: [],
  users: [],
  projects: [],
  projectSummary: null,
  history: [],
  reports: null,
  modal: null,
  editingRequest: null,
  editingUser: null,
  editingProject: null,
  newRequestStep: "edit",
  draftItems: [],
  selectedFinalizeIds: [],
  finalizeModalRequestIds: [],
  filters: {
    open: { search: "", project: "", status: "", priority: "", deadline: "", approvalState: "" },
    history: { search: "", project: "", supplier: "", status: "", startDate: "", endDate: "" },
    reports: { startDate: "", endDate: "" }
  }
};

const app = document.getElementById("app");
const WHATSAPP_NUMBER = "5528999644083";
const WHATSAPP_LINK = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent("Ola, gostaria de um orcamento.")}`;

function can(permission) {
  if (!state.user) return false;
  if (state.user.role === "ADM") return true;
  return Array.isArray(state.user.permissions) && state.user.permissions.includes(permission);
}

function currency(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("pt-BR").format(new Date(`${value}T00:00:00`));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function compactText(value, limit = 140) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function today() {
  const date = new Date();
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

let draftItemCounter = 0;

function createDraftItem(seed = {}) {
  draftItemCounter += 1;
  return {
    id: draftItemCounter,
    item_name: "",
    description: "",
    quantity: "",
    unit: state.meta.unitOptions?.[0] || "unidade",
    project_name: seed.project_name || state.projects?.[0]?.name || "",
    requester_name: seed.requester_name || state.user?.username || "",
    request_date: seed.request_date || today(),
    needed_by_date: today(),
    priority: state.meta.priorityOptions?.[1] || state.meta.priorityOptions?.[0] || "Media",
    status: "Solicitacao recebida",
    notes: ""
  };
}

function resetDraftItems() {
  state.draftItems = [createDraftItem()];
  state.newRequestStep = "edit";
}

function canFinalizeRequest(item) {
  if (!can("purchases.finalize")) return false;
  if (!item) return false;
  if ((item.approval_state || "Aprovado") === "Recusado") return false;
  if (["Recusado", "Cancelado", "Entregue"].includes(item.status)) return false;
  return true;
}

function pruneFinalizeSelection() {
  const available = new Set(state.requests.filter((item) => canFinalizeRequest(item)).map((item) => Number(item.id)));
  state.selectedFinalizeIds = (state.selectedFinalizeIds || []).filter((id) => available.has(Number(id)));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: options.body instanceof FormData ? {} : { "Content-Type": "application/json" },
    ...options
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Erro inesperado" }));
    throw new Error(data.error || "Erro na requisicao");
  }
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json") ? response.json() : response.text();
}

async function loadRequests() {
  return api(`/api/requests?${new URLSearchParams({ ...state.filters.open, onlyOpen: "true" }).toString()}`);
}

async function loadPurchases() {
  return api(`/api/purchases?${new URLSearchParams(state.filters.history).toString()}`);
}

async function loadReports() {
  return api(`/api/reports?${new URLSearchParams(state.filters.reports).toString()}`);
}

async function loadApprovals() {
  return api("/api/requests?pendingApproval=true&onlyOpen=true");
}

async function loadUsers() {
  return api("/api/users");
}

async function loadProjects() {
  return api("/api/projects");
}

async function loadProjectSummary(projectId) {
  return api(`/api/projects/${projectId}/summary`);
}

async function loadAllData() {
  const tasks = [];
  if (can("dashboard.view")) tasks.push(api("/api/dashboard").then((data) => { state.dashboard = data; }));
  if (can("requests.manage")) tasks.push(loadRequests().then((data) => { state.requests = data; }));
  if (can("requests.approve")) tasks.push(loadApprovals().then((data) => { state.approvals = data; }));
  if (can("reports.view") || can("purchases.finalize")) tasks.push(loadPurchases().then((data) => { state.purchases = data; }));
  if (can("history.view")) tasks.push(api("/api/history").then((data) => { state.history = data; }));
  if (can("reports.view")) tasks.push(loadReports().then((data) => { state.reports = data; }));
  if (can("users.manage")) tasks.push(loadUsers().then((data) => { state.users = data; }));
  if (can("projects.manage") || can("users.manage") || can("requests.create") || can("requests.manage")) {
    tasks.push(loadProjects().then(async (data) => {
      state.projects = data;
      if (data.length && (can("projects.manage") || can("users.manage") || can("reports.view") || can("requests.manage"))) {
        const currentId = state.projectSummary?.projectId || data[0].id;
        const selected = data.find((item) => item.id === currentId) || data[0];
        const summary = await loadProjectSummary(selected.id);
        state.projectSummary = { ...summary, projectId: selected.id };
      } else if (!data.length) {
        state.projectSummary = null;
      }
    }));
  }
  await Promise.all(tasks);
  pruneFinalizeSelection();

  if (!state.draftItems.length) {
    resetDraftItems();
  } else {
    const validProjects = new Set((state.projects || []).map((project) => project.name));
    state.draftItems = state.draftItems.map((item) => {
      const nextItem = { ...item };
      if (!nextItem.requester_name) nextItem.requester_name = state.user?.username || "";
      if (!validProjects.has(nextItem.project_name)) nextItem.project_name = state.projects?.[0]?.name || "";
      return nextItem;
    });
  }
}

function navButton(view, label) {
  return `<button class="${state.currentView === view ? "active" : ""}" data-view="${view}">${label}</button>`;
}

function renderDeveloperFooter() {
  return `
    <footer class="site-footer">
      Desenvolvido por <strong>Jo&atilde;o Espinato</strong> | Contato:
      <a href="${WHATSAPP_LINK}" target="_blank" rel="noopener">55 28 99964-4083 (WhatsApp)</a>
      | <a href="${WHATSAPP_LINK}" target="_blank" rel="noopener">Solicitar orcamento</a>
    </footer>
  `;
}

function defaultViewForUser() {
  if (can("dashboard.view")) return "dashboard";
  if (can("requests.approve")) return "approvals";
  if (can("requests.manage")) return "open-demands";
  if (can("requests.create")) return "new-request";
  if (can("users.manage")) return "users";
  return "dashboard";
}

function renderLogin() {
  return `
    <div class="login-screen">
      <div class="login-card">
        <h1>Compras Corporativas</h1>
        <p class="hint">Controle profissional de demandas, cotacoes, compras e historico por obra.</p>
        <form id="login-form" class="form-grid" style="margin-top:24px; grid-template-columns:1fr;">
          <div class="field">
            <label for="username">Usuario</label>
            <input id="username" name="username" required />
          </div>
          <div class="field">
            <label for="password">Senha</label>
            <input id="password" type="password" name="password" required />
          </div>
          <button class="primary-button" type="submit">Entrar no sistema</button>
        </form>
      </div>
      ${renderDeveloperFooter()}
    </div>
  `;
}

function renderShell() {
  const navItems = [];
  if (can("dashboard.view")) navItems.push(navButton("dashboard", "Dashboard"));
  if (can("requests.create")) navItems.push(navButton("new-request", "Nova Demanda"));
  if (can("requests.manage")) navItems.push(navButton("open-demands", "Demandas em Aberto"));
  if (can("requests.approve")) navItems.push(navButton("approvals", "Aprovacoes"));
  if (can("purchases.finalize") || can("reports.view")) navItems.push(navButton("history", "Compras Finalizadas"));
  if (can("reports.view")) navItems.push(navButton("reports", "Relatorios"));
  if (can("projects.manage") || can("users.manage")) navItems.push(navButton("projects", "Obras"));
  if (can("users.manage")) navItems.push(navButton("users", "Usuarios"));

  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <h1>Compras Corporativas</h1>
          <p>Operacao central do setor de compras, orcamentos e historico por obra.</p>
        </div>
        <nav class="nav">
          ${navItems.join("")}
        </nav>
        <div class="sidebar-footer">
          <div class="user-card">
            <strong>${escapeHtml(state.user.username)}</strong>
            <div class="hint">${escapeHtml(state.user.role)}</div>
          </div>
          <button class="ghost-button" data-action="logout">Sair</button>
        </div>
      </aside>
      <main class="content">${renderCurrentView()}${renderDeveloperFooter()}</main>
      ${state.modal ? renderModal() : ""}
    </div>
  `;
}

function renderCurrentView() {
  const hasPanelAccess = [
    "dashboard.view",
    "requests.create",
    "requests.manage",
    "requests.approve",
    "purchases.finalize",
    "reports.view",
    "history.view",
    "users.manage",
    "projects.manage"
  ].some((permission) => can(permission));
  if (!hasPanelAccess) {
    return `
      <section class="panel">
        <h2>Acesso restrito</h2>
        <p>Este perfil deve acessar o portal de funcionario no endereco principal.</p>
      </section>
    `;
  }

  switch (state.currentView) {
    case "dashboard":
      return renderDashboard();
    case "new-request":
      return renderRequestForm();
    case "open-demands":
      return renderOpenDemands();
    case "approvals":
      return renderApprovals();
    case "history":
      return renderHistory();
    case "reports":
      return renderReports();
    case "projects":
      return renderProjects();
    case "users":
      return renderUsers();
    default:
      return renderDashboard();
  }
}

function render() {
  app.innerHTML = state.user ? renderShell() : renderLogin();
  attachEvents();
}

function renderAlertItem(item, overdue = false) {
  return `
    <div class="alert-item ${overdue ? "overdue" : ""}">
      <div style="display:flex; justify-content:space-between; gap:12px; align-items:center;">
        <strong>${escapeHtml(item.item_name)}</strong>
        <span class="priority-pill" data-priority="${escapeHtml(item.priority)}">${escapeHtml(item.priority)}</span>
      </div>
      <div class="muted">${escapeHtml(item.project_name)} â€¢ ${formatDate(item.needed_by_date)}</div>
      <span class="status-pill">${escapeHtml(item.status)}</span>
    </div>
  `;
}

function renderDashboard() {
  const dashboard = state.dashboard || {
    openDemandCount: 0,
    completedCount: 0,
    monthlySpend: 0,
    requestsByProject: [],
    expiringSoon: [],
    overdue: [],
    statusChart: []
  };
  const maxStatus = Math.max(...dashboard.statusChart.map((item) => item.total), 1);
  return `
    <section class="page-header">
      <div>
        <h2>Dashboard Operacional</h2>
        <p>Visao consolidada das solicitacoes, compras concluidas, prazos e gastos do mes.</p>
      </div>
      <div class="top-actions">
        <button class="secondary-button" data-view="open-demands">Ver demandas abertas</button>
        <button class="primary-button" data-view="new-request">Registrar nova demanda</button>
      </div>
    </section>
    <section class="card-grid">
      <article class="card"><div class="metric-label">Demandas em aberto</div><div class="metric-value">${dashboard.openDemandCount}</div></article>
      <article class="card"><div class="metric-label">Compras finalizadas</div><div class="metric-value">${dashboard.completedCount}</div></article>
      <article class="card"><div class="metric-label">Valor gasto no mes</div><div class="metric-value">${currency(dashboard.monthlySpend)}</div></article>
      <article class="card"><div class="metric-label">Obras com solicitacoes</div><div class="metric-value">${dashboard.requestsByProject.length}</div></article>
    </section>
    <div class="split-layout">
      <section class="panel">
        <div class="topline"><h3>Solicitacoes por obra</h3><span class="muted">Organizacao por frente de trabalho</span></div>
        <div class="summary-list">
          ${dashboard.requestsByProject.length ? dashboard.requestsByProject.map((item) => `
            <div class="summary-item">
              <strong>${escapeHtml(item.name)}</strong>
              <span class="muted">${item.total} solicitacao(oes)</span>
            </div>
          `).join("") : `<div class="empty-state">Nenhuma demanda cadastrada ainda.</div>`}
        </div>
      </section>
      <section class="panel">
        <div class="topline"><h3>Grafico por status</h3><span class="muted">Distribuicao operacional</span></div>
        <div class="chart-list">
          ${dashboard.statusChart.length ? dashboard.statusChart.map((item) => `
            <div class="chart-row">
              <div style="display:flex; justify-content:space-between; gap:12px;"><strong>${escapeHtml(item.label)}</strong><span class="muted">${item.total}</span></div>
              <div class="chart-bar"><div class="chart-fill" style="width:${(item.total / maxStatus) * 100}%"></div></div>
            </div>
          `).join("") : `<div class="empty-state">Sem dados para exibir.</div>`}
        </div>
      </section>
    </div>
    <div class="two-panels">
      <section class="panel"><h3>Alertas de prazo proximo</h3><div class="alert-list">${dashboard.expiringSoon.length ? dashboard.expiringSoon.map(renderAlertItem).join("") : `<div class="empty-state">Nenhum item com vencimento proximo.</div>`}</div></section>
      <section class="panel"><h3>Itens em atraso</h3><div class="alert-list">${dashboard.overdue.length ? dashboard.overdue.map((item) => renderAlertItem(item, true)).join("") : `<div class="empty-state">Nao ha itens em atraso.</div>`}</div></section>
    </div>
  `;
}

function renderRequestForm() {
  const editing = state.editingRequest;
  const projectOptions = (state.projects || []).map((project) => `<option value="${escapeHtml(project.name)}" ${editing?.project_name === project.name ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  if (editing) {
    return `
      <section class="page-header">
        <div>
          <h2>Editar Demanda</h2>
          <p>Ajuste os dados da solicitacao existente.</p>
        </div>
      </section>
      <section class="panel">
        <form id="request-form" class="form-grid">
          <div class="field"><label>Nome do item/material</label><input name="item_name" required value="${escapeHtml(editing.item_name || "")}" /></div>
          <div class="field"><label>Obra solicitante</label><select name="project_name" required>${projectOptions}</select></div>
          <div class="field full"><label>Descricao detalhada da demanda</label><textarea name="description" required>${escapeHtml(editing.description || "")}</textarea></div>
          <div class="field"><label>Quantidade</label><input name="quantity" type="number" min="0.01" step="0.01" required value="${escapeHtml(editing.quantity || "")}" /></div>
          <div class="field"><label>Unidade</label><select name="unit" required>${state.meta.unitOptions.map((option) => `<option value="${option}" ${editing.unit === option ? "selected" : ""}>${option}</option>`).join("")}</select></div>
          <div class="field"><label>Responsavel pela solicitacao</label><input name="requester_name" required value="${escapeHtml(editing.requester_name || "")}" /></div>
          <div class="field"><label>Data da solicitacao</label><input name="request_date" type="date" required value="${escapeHtml(editing.request_date || today())}" /></div>
          <div class="field"><label>Prazo necessario para entrega</label><input name="needed_by_date" type="date" required value="${escapeHtml(editing.needed_by_date || today())}" /></div>
          <div class="field"><label>Prioridade</label><select name="priority" required>${state.meta.priorityOptions.map((option) => `<option ${editing.priority === option ? "selected" : ""}>${option}</option>`).join("")}</select></div>
          <div class="field"><label>Status</label><select name="status" required>${state.meta.statusOptions.map((option) => `<option ${editing.status === option ? "selected" : ""}>${option}</option>`).join("")}</select></div>
          <div class="field full"><label>Observacoes adicionais</label><textarea name="notes">${escapeHtml(editing.notes || "")}</textarea></div>
          <div class="field full" style="display:flex; gap:12px; flex-wrap:wrap;">
            <button class="primary-button" type="submit">Salvar alteracoes</button>
            <button class="secondary-button" type="button" data-action="cancel-edit">Cancelar edicao</button>
          </div>
        </form>
      </section>
    `;
  }

  return `
    <section class="page-header">
      <div>
        <h2>Cadastro de Nova Demanda</h2>
        <p>Adicione um ou mais itens, revise o resumo e confirme o envio.</p>
      </div>
    </section>
    <section class="panel">
      ${state.newRequestStep === "review" ? renderRequestReview() : renderDraftRequestEditor()}
    </section>
  `;
}

function renderDraftRequestItem(item, index) {
  return `
    <article class="request-item-card">
      <div class="request-item-header">
        <strong>Item ${index + 1}</strong>
        ${state.draftItems.length > 1 ? `<button class="danger-button" type="button" data-action="remove-request-item" data-id="${item.id}">Remover</button>` : ""}
      </div>
      <div class="form-grid compact-form">
        <div class="field"><label>Material</label><input data-item-id="${item.id}" data-item-field="item_name" value="${escapeHtml(item.item_name)}" required /></div>
        <div class="field"><label>Obra</label><select data-item-id="${item.id}" data-item-field="project_name">${state.projects.map((project) => `<option value="${escapeHtml(project.name)}" ${item.project_name === project.name ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}</select></div>
        <div class="field"><label>Quantidade</label><input data-item-id="${item.id}" data-item-field="quantity" type="number" min="0.01" step="0.01" value="${escapeHtml(item.quantity)}" required /></div>
        <div class="field"><label>Unidade</label><select data-item-id="${item.id}" data-item-field="unit">${state.meta.unitOptions.map((option) => `<option value="${option}" ${item.unit === option ? "selected" : ""}>${option}</option>`).join("")}</select></div>
        <div class="field"><label>Solicitante</label><input data-item-id="${item.id}" data-item-field="requester_name" value="${escapeHtml(item.requester_name)}" required /></div>
        <div class="field"><label>Data da solicitacao</label><input data-item-id="${item.id}" data-item-field="request_date" type="date" value="${escapeHtml(item.request_date || today())}" required /></div>
        <div class="field"><label>Entrega ate</label><input data-item-id="${item.id}" data-item-field="needed_by_date" type="date" value="${escapeHtml(item.needed_by_date || today())}" required /></div>
        <div class="field"><label>Prioridade</label><select data-item-id="${item.id}" data-item-field="priority">${state.meta.priorityOptions.map((priority) => `<option value="${priority}" ${item.priority === priority ? "selected" : ""}>${priority}</option>`).join("")}</select></div>
      </div>
      <details class="optional-box" style="margin-top:10px;">
        <summary>Status, descricao e observacoes</summary>
        <div class="form-grid" style="margin-top:10px;">
          <div class="field"><label>Status</label><select data-item-id="${item.id}" data-item-field="status">${state.meta.statusOptions.map((status) => `<option value="${status}" ${item.status === status ? "selected" : ""}>${status}</option>`).join("")}</select></div>
          <div class="field full"><label>Descricao</label><textarea data-item-id="${item.id}" data-item-field="description">${escapeHtml(item.description)}</textarea></div>
          <div class="field full"><label>Observacoes</label><textarea data-item-id="${item.id}" data-item-field="notes">${escapeHtml(item.notes)}</textarea></div>
        </div>
      </details>
    </article>
  `;
}

function renderDraftRequestEditor() {
  if (!state.projects.length) return `<div class="empty-state">Cadastre ao menos uma obra antes de abrir novas demandas.</div>`;
  return `
    <div class="request-item-list">
      ${state.draftItems.map(renderDraftRequestItem).join("")}
    </div>
    <div class="top-actions" style="margin-top:12px;">
      <button class="secondary-button" type="button" data-action="add-request-item">Adicionar outro item</button>
      <button class="primary-button" type="button" data-action="review-request-items">Salvar demanda</button>
    </div>
  `;
}

function renderRequestReview() {
  return `
    <section class="panel" style="padding:0; box-shadow:none; border:0; background:transparent; margin:0;">
      <h3>Resumo antes de confirmar</h3>
      <p class="hint">Confira os itens abaixo para confirmar o envio.</p>
      <div class="review-list">
        ${state.draftItems.map((item, index) => `
          <div class="review-item">
            <strong>Item ${index + 1} - ${escapeHtml(item.item_name)}</strong>
            <div class="muted">Obra: ${escapeHtml(item.project_name)}</div>
            <div class="muted">Solicitante: ${escapeHtml(item.requester_name)} | Data: ${formatDate(item.request_date)}</div>
            <div class="muted">Qtd/Un: ${escapeHtml(item.quantity)} ${escapeHtml(item.unit)} | Entrega: ${formatDate(item.needed_by_date)}</div>
            <div class="muted">Prioridade: ${escapeHtml(item.priority)} | Status inicial: ${escapeHtml(item.status)}</div>
            <div class="muted">Descricao: ${escapeHtml(item.description || "-")}</div>
            <div class="muted">Observacoes: ${escapeHtml(item.notes || "-")}</div>
          </div>
        `).join("")}
      </div>
      <div class="top-actions" style="margin-top:12px;">
        <button class="secondary-button" type="button" data-action="back-request-edit">Voltar e editar</button>
        <button class="primary-button" type="button" data-action="confirm-request-submit">Confirmar envio</button>
      </div>
    </section>
  `;
}

function validateDraftItems() {
  if (!state.draftItems.length) return "Adicione ao menos um item.";
  for (const [index, item] of state.draftItems.entries()) {
    if (!String(item.item_name || "").trim()) return `Informe o material do item ${index + 1}.`;
    if (!String(item.project_name || "").trim()) return `Selecione a obra do item ${index + 1}.`;
    if (!String(item.requester_name || "").trim()) return `Informe o solicitante do item ${index + 1}.`;
    if (!Number(item.quantity) || Number(item.quantity) <= 0) return `Quantidade invalida no item ${index + 1}.`;
    if (!String(item.request_date || "").trim()) return `Informe a data de solicitacao do item ${index + 1}.`;
    if (!String(item.needed_by_date || "").trim()) return `Informe a data de entrega do item ${index + 1}.`;
  }
  return "";
}

async function submitAllDraftItems() {
  for (const item of state.draftItems) {
    await api("/api/requests", {
      method: "POST",
      body: JSON.stringify({
        item_name: String(item.item_name || "").trim(),
        description: String(item.description || "").trim(),
        quantity: Number(item.quantity),
        unit: item.unit,
        project_name: item.project_name,
        requester_name: String(item.requester_name || "").trim(),
        request_date: item.request_date || today(),
        needed_by_date: item.needed_by_date || today(),
        priority: item.priority,
        status: item.status,
        notes: String(item.notes || "").trim()
      })
    });
  }
}

function renderOpenDemands() {
  const projects = [...new Set(state.requests.map((item) => item.project_name))].sort();
  const filters = state.filters.open;
  const showSelection = can("purchases.finalize");
  const selectedSet = new Set((state.selectedFinalizeIds || []).map((id) => Number(id)));
  const selectedCount = selectedSet.size;
  const totalColumns = showSelection ? 12 : 11;
  return `
    <section class="page-header">
      <div>
        <h2>Demandas em Aberto</h2>
        <p>Acompanhe pendencias por obra, prioridade, prazo e status com acoes rapidas.</p>
      </div>
      <div class="top-actions">
        <button class="secondary-button" data-action="refresh-open">Atualizar</button>
        ${showSelection ? `<button class="secondary-button" data-action="finalize-selected">Finalizar selecionados (${selectedCount})</button>` : ""}
        <button class="primary-button" data-action="open-new-request">Nova demanda</button>
      </div>
    </section>
    <section class="panel">
      <div class="toolbar">
        <div class="field"><label>Pesquisar</label><input data-filter-group="open" data-filter="search" value="${escapeHtml(filters.search)}" placeholder="Item, descricao ou obra" /></div>
        <div class="field"><label>Obra</label><select data-filter-group="open" data-filter="project"><option value="">Todas</option>${projects.map((project) => `<option ${filters.project === project ? "selected" : ""}>${escapeHtml(project)}</option>`).join("")}</select></div>
        <div class="field"><label>Status</label><select data-filter-group="open" data-filter="status"><option value="">Todos</option>${state.meta.statusOptions.map((option) => `<option ${filters.status === option ? "selected" : ""}>${option}</option>`).join("")}</select></div>
        <div class="field"><label>Aprovacao</label><select data-filter-group="open" data-filter="approvalState"><option value="">Todas</option><option value="Pendente" ${filters.approvalState === "Pendente" ? "selected" : ""}>Pendente</option><option value="Aprovado" ${filters.approvalState === "Aprovado" ? "selected" : ""}>Aprovado</option><option value="Recusado" ${filters.approvalState === "Recusado" ? "selected" : ""}>Recusado</option></select></div>
        <div class="field"><label>Prioridade</label><select data-filter-group="open" data-filter="priority"><option value="">Todas</option>${state.meta.priorityOptions.map((option) => `<option ${filters.priority === option ? "selected" : ""}>${option}</option>`).join("")}</select></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              ${showSelection ? "<th>Sel.</th>" : ""}
              <th>ID</th><th>Item</th><th>Obra</th><th>Solicitante</th><th>Solicitado em</th><th>Quantidade</th><th>Prazo</th><th>Status</th><th>Aprovacao</th><th>Prioridade</th><th>Acoes</th>
            </tr>
          </thead>
          <tbody>
            ${state.requests.length ? state.requests.map((item) => `
              <tr>
                ${showSelection ? `<td>
                  ${canFinalizeRequest(item)
                    ? `<input type="checkbox" data-action="toggle-finalize-selection" data-id="${item.id}" ${selectedSet.has(Number(item.id)) ? "checked" : ""} />`
                    : "-"}
                </td>` : ""}
                <td>#${item.id}</td>
                <td><strong>${escapeHtml(item.item_name)}</strong><div class="muted">${escapeHtml(item.description)}</div></td>
                <td>${escapeHtml(item.project_name)}</td>
                <td>${escapeHtml(item.requester_name || "-")}</td>
                <td>${formatDate(item.request_date)}</td>
                <td>${item.quantity} ${escapeHtml(item.unit)}</td>
                <td>${formatDate(item.needed_by_date)} ${item.isOverdue ? `<div class="muted" style="color:var(--danger)">Atrasado</div>` : ""}</td>
                <td><select data-action="change-status" data-id="${item.id}">${state.meta.statusOptions.map((status) => `<option ${status === item.status ? "selected" : ""}>${status}</option>`).join("")}</select></td>
                <td>${escapeHtml(item.approval_state || "Aprovado")}</td>
                <td><span class="priority-pill" data-priority="${escapeHtml(item.priority)}">${escapeHtml(item.priority)}</span></td>
                <td>
                  <div class="table-actions">
                    <button data-action="edit-request" data-id="${item.id}">Editar</button>
                    <button data-action="attach-budget" data-id="${item.id}">Registrar orcamento</button>
                    ${canFinalizeRequest(item) ? `<button data-action="finalize-request" data-id="${item.id}">Finalizar</button>` : ""}
                    <button data-action="delete-request" data-id="${item.id}">Excluir</button>
                  </div>
                  <div class="muted" style="margin-top:8px;">${escapeHtml(compactText(item.budget_notes || "" ) || "Orcamento ainda nao informado.")}</div>
                  ${item.budgetAttachmentUrl ? `<div style="margin-top:6px;"><a class="link-button" href="${item.budgetAttachmentUrl}" target="_blank">Anexo legado</a></div>` : ""}
                </td>
              </tr>
            `).join("") : `<tr><td colspan="${totalColumns}"><div class="empty-state">Nenhuma demanda encontrada com os filtros atuais.</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderApprovals() {
  return `
    <section class="page-header">
      <div>
        <h2>Aprovacao de Pedidos Web</h2>
        <p>Pedidos enviados pelos funcionarios aguardando decisao do setor responsavel.</p>
      </div>
      <div class="top-actions">
        <button class="secondary-button" data-action="refresh-approvals">Atualizar</button>
      </div>
    </section>
    <section class="panel">
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>ID</th><th>Item</th><th>Obra</th><th>Solicitante</th><th>Status</th><th>Aprovacao</th><th>Acoes</th></tr>
          </thead>
          <tbody>
            ${state.approvals.length ? state.approvals.map((item) => `
              <tr>
                <td>#${item.id}</td>
                <td><strong>${escapeHtml(item.item_name)}</strong><div class="muted">${escapeHtml(item.description)}</div></td>
                <td>${escapeHtml(item.project_name)}</td>
                <td>${escapeHtml(item.requester_name)}</td>
                <td>${escapeHtml(item.status)}</td>
                <td>${escapeHtml(item.approval_state || "Pendente")}</td>
                <td>
                  <div class="table-actions">
                    <button data-action="approve-request" data-id="${item.id}">Aprovar</button>
                    <button data-action="reject-request" data-id="${item.id}">Recusar</button>
                  </div>
                </td>
              </tr>
            `).join("") : `<tr><td colspan="7"><div class="empty-state">Nenhum pedido aguardando aprovacao.</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderUsers() {
  const editing = state.editingUser;
  const permissions = state.meta.permissionsCatalog || [];
  const projects = state.projects || [];
  const selectedProjectId = editing?.project_id ? String(editing.project_id) : "";
  return `
    <section class="page-header">
      <div>
        <h2>Usuarios e Permissoes</h2>
        <p>Crie contas, atualize perfil de acesso e remova usuarios quando necessario.</p>
      </div>
      <div class="top-actions">
        <button class="secondary-button" data-action="refresh-users">Atualizar</button>
      </div>
    </section>
    <section class="panel">
      <form id="user-form" class="form-grid">
        <div class="field">
          <label>Usuario</label>
          <input name="username" required value="${escapeHtml(editing?.username || "")}" />
        </div>
        <div class="field">
          <label>Senha ${editing ? "(deixe vazio para manter)" : ""}</label>
          <input name="password" type="password" ${editing ? "" : "required"} />
        </div>
        <div class="field">
          <label>Perfil</label>
          <select name="role">
            <option value="ADM" ${editing?.role === "ADM" ? "selected" : ""}>ADM</option>
            <option value="FUNCIONARIO" ${editing?.role === "FUNCIONARIO" ? "selected" : ""}>FUNCIONARIO</option>
          </select>
        </div>
        <div class="field">
          <label>Obra do funcionario</label>
          <select name="project_id">
            <option value="">Sem obra</option>
            ${projects.map((project) => `<option value="${project.id}" ${selectedProjectId === String(project.id) ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}
          </select>
        </div>
        <div class="field full">
          <label>Permissoes</label>
          <div class="table-actions">
            ${permissions.map((permission) => `
              <label style="display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); border-radius:10px; padding:6px 10px;">
                <input type="checkbox" name="permissions" value="${permission.key}" ${editing?.permissions?.includes(permission.key) ? "checked" : ""} />
                <span>${escapeHtml(permission.label)}</span>
              </label>
            `).join("")}
          </div>
        </div>
        <div class="field full" style="display:flex; gap:12px; flex-wrap:wrap;">
          <button class="primary-button" type="submit">${editing ? "Salvar usuario" : "Criar usuario"}</button>
          ${editing ? `<button class="secondary-button" type="button" data-action="cancel-user-edit">Cancelar</button>` : ""}
        </div>
      </form>
    </section>
    <section class="panel">
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Usuario</th><th>Perfil</th><th>Obra</th><th>Permissoes</th><th>Acoes</th></tr></thead>
          <tbody>
            ${state.users.length ? state.users.map((user) => `
              <tr>
                <td>#${user.id}</td>
                <td>${escapeHtml(user.username)}</td>
                <td>${escapeHtml(user.role)}</td>
                <td>${escapeHtml(user.project || "-")}</td>
                <td>${escapeHtml((user.permissions || []).join(", "))}</td>
                <td>
                  <div class="table-actions">
                    <button data-action="edit-user" data-id="${user.id}">Editar</button>
                    <button data-action="delete-user" data-id="${user.id}">Remover</button>
                  </div>
                </td>
              </tr>
            `).join("") : `<tr><td colspan="6"><div class="empty-state">Nenhum usuario cadastrado.</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderProjects() {
  const summary = state.projectSummary;
  return `
    <section class="page-header">
      <div>
        <h2>Cadastro de Obras</h2>
        <p>Registre obras e acompanhe os indicadores de cada uma.</p>
      </div>
      <div class="top-actions">
        <button class="secondary-button" data-action="refresh-projects">Atualizar</button>
      </div>
    </section>
    <section class="panel">
      <form id="project-form" class="form-grid">
        <div class="field"><label>Nome da obra</label><input name="name" required /></div>
        <div class="field"><label>Endereco</label><input name="address" required placeholder="Rua, numero, bairro, cidade" /></div>
        <div class="field full"><button class="primary-button" type="submit">Cadastrar obra</button></div>
      </form>
    </section>
    <section class="panel">
      <div class="toolbar" style="grid-template-columns: 1fr auto;">
        <div class="field">
          <label>Selecionar obra para resumo</label>
          <select data-action="select-project-summary">
            ${state.projects.map((project) => `<option value="${project.id}" ${summary?.projectId === project.id ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}
          </select>
        </div>
      </div>
      ${summary ? `
        <div class="top-actions" style="margin-top:10px;">
          <button class="secondary-button" data-action="view-project-requests" data-id="${summary.projectId}">Ver pedidos desta obra</button>
        </div>
        <div class="card-grid" style="grid-template-columns: repeat(5, minmax(0, 1fr)); margin-top:16px;">
          <article class="card"><div class="metric-label">Pedidos totais</div><div class="metric-value">${summary.totalRequests}</div></article>
          <article class="card"><div class="metric-label">Pedidos abertos</div><div class="metric-value">${summary.openRequests}</div></article>
          <article class="card"><div class="metric-label">Aguardando aprovacao</div><div class="metric-value">${summary.pendingApproval}</div></article>
          <article class="card"><div class="metric-label">Compras finalizadas</div><div class="metric-value">${summary.completedPurchases}</div></article>
          <article class="card"><div class="metric-label">Total gasto</div><div class="metric-value">${currency(summary.totalSpent)}</div></article>
        </div>
      ` : `<div class="empty-state">Nenhuma obra cadastrada ainda.</div>`}
      <div class="table-wrap" style="margin-top:16px;">
        <table>
          <thead><tr><th>ID</th><th>Obra</th><th>Endereco</th><th>Acoes</th></tr></thead>
          <tbody>
            ${state.projects.length ? state.projects.map((project) => `
              <tr>
                <td>#${project.id}</td>
                <td>${escapeHtml(project.name)}</td>
                <td>${escapeHtml(project.address || "-")}</td>
                <td>
                  <div class="table-actions">
                    <button data-action="view-project-summary" data-id="${project.id}">Ver dados</button>
                    <button data-action="delete-project" data-id="${project.id}">Excluir</button>
                  </div>
                </td>
              </tr>
            `).join("") : `<tr><td colspan="4"><div class="empty-state">Nenhuma obra cadastrada.</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderHistory() {
  const projects = [...new Set(state.purchases.map((item) => item.project_name))].sort();
  const suppliers = [...new Set(state.purchases.map((item) => item.supplier))].sort();
  const finalizedPurchases = state.purchases.filter((purchase) => purchase.purchase_status !== "Cancelada");
  const totals = Object.values(finalizedPurchases.reduce((acc, purchase) => {
    if (!acc[purchase.project_name]) acc[purchase.project_name] = { project: purchase.project_name, total: 0 };
    acc[purchase.project_name].total += Number(purchase.amount_paid);
    return acc;
  }, {})).sort((a, b) => b.total - a.total);
  const filters = state.filters.history;
  const purchaseStatusOptions = state.meta.purchaseStatusOptions || ["Finalizada", "Cancelada"];
  return `
    <section class="page-header">
      <div>
        <h2>Compras Finalizadas e Historico</h2>
        <p>Consulta dos blocos de compra finalizados por fornecedor/nota fiscal e rastreabilidade das alteracoes.</p>
      </div>
      <div class="top-actions">
        <a class="secondary-button" href="/api/exports/purchases.csv?${new URLSearchParams(filters).toString()}">Exportar Excel</a>
      </div>
    </section>
    <section class="panel">
      <div class="toolbar" style="grid-template-columns: repeat(6, minmax(0, 1fr));">
        <div class="field"><label>Pesquisar</label><input data-filter-group="history" data-filter="search" value="${escapeHtml(filters.search)}" placeholder="Item ou obra" /></div>
        <div class="field"><label>Obra</label><select data-filter-group="history" data-filter="project"><option value="">Todas</option>${projects.map((project) => `<option ${filters.project === project ? "selected" : ""}>${escapeHtml(project)}</option>`).join("")}</select></div>
        <div class="field"><label>Fornecedor</label><select data-filter-group="history" data-filter="supplier"><option value="">Todos</option>${suppliers.map((supplier) => `<option ${filters.supplier === supplier ? "selected" : ""}>${escapeHtml(supplier)}</option>`).join("")}</select></div>
        <div class="field"><label>Status da compra</label><select data-filter-group="history" data-filter="status"><option value="">Todos</option>${purchaseStatusOptions.map((status) => `<option value="${status}" ${filters.status === status ? "selected" : ""}>${status}</option>`).join("")}</select></div>
        <div class="field"><label>Periodo inicial</label><input type="date" data-filter-group="history" data-filter="startDate" value="${escapeHtml(filters.startDate)}" /></div>
        <div class="field"><label>Periodo final</label><input type="date" data-filter-group="history" data-filter="endDate" value="${escapeHtml(filters.endDate)}" /></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Bloco</th><th>Itens</th><th>Obra</th><th>Status</th><th>Valor pago</th><th>Fornecedor</th><th>Data</th><th>Nota fiscal</th><th>Orcamento</th><th>Acoes</th></tr></thead>
          <tbody>
            ${state.purchases.length ? state.purchases.map((item) => `
              <tr>
                <td><strong>${escapeHtml(item.block_name || `Compra #${item.id}`)}</strong><div class="muted">#${item.id}</div></td>
                <td>
                  <div><strong>${item.item_count || 1} item(ns)</strong></div>
                  <div class="muted">${escapeHtml(compactText(item.item_name || "-"))}</div>
                </td>
                <td>${escapeHtml(item.project_name)}</td>
                <td>
                  <span class="status-pill">${escapeHtml(item.purchase_status || "Finalizada")}</span>
                  ${(item.purchase_status === "Cancelada" && item.canceled_reason) ? `<div class="muted">${escapeHtml(item.canceled_reason)}</div>` : ""}
                </td>
                <td>${currency(item.amount_paid)}</td>
                <td>${escapeHtml(item.supplier)}</td>
                <td>${formatDate(item.purchase_date)}</td>
                <td>${escapeHtml(item.invoice_number || "-")}</td>
                <td>${escapeHtml(compactText(item.budget_reference || "-"))}</td>
                <td>
                  ${can("purchases.finalize")
                    ? (item.purchase_status === "Cancelada"
                      ? `<button class="secondary-button" data-action="restore-purchase" data-id="${item.id}">Reativar</button>`
                      : `<button class="secondary-button" data-action="cancel-purchase" data-id="${item.id}">Cancelar compra</button>`)
                    : "-"}
                </td>
              </tr>
            `).join("") : `<tr><td colspan="10"><div class="empty-state">Nenhuma compra finalizada encontrada.</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
    <section class="panel">
      <h3>Valor total por obra (compras ativas)</h3>
      <div class="summary-list">
        ${totals.length ? totals.map((item) => `<div class="summary-item"><strong>${escapeHtml(item.project)}</strong><span>${currency(item.total)}</span></div>`).join("") : `<div class="empty-state">Sem compras finalizadas ativas.</div>`}
      </div>
      <details class="optional-box" style="margin-top:18px;">
        <summary>Mostrar historico de alteracoes</summary>
        <div class="history-list" style="margin-top:12px;">
          ${state.history.length ? state.history.slice(0, 20).map((item) => `
            <div class="history-item">
              <strong>${escapeHtml(item.action)}</strong>
              <div class="muted">${escapeHtml(item.username || "sistema")} - ${new Date(item.created_at).toLocaleString("pt-BR")}</div>
              <div class="muted">${escapeHtml(item.entity_type)} #${item.entity_id}</div>
            </div>
          `).join("") : `<div class="empty-state">Nenhum historico registrado.</div>`}
        </div>
      </details>
    </section>
  `;
}

function renderReportPanel(title, rows, currencyMode) {
  return `
    <section class="panel">
      <h3>${title}</h3>
      <div class="summary-list">
        ${rows.length ? rows.map((row) => `
          <div class="summary-item">
            <strong>${escapeHtml(row.label)}</strong>
            <span>${currencyMode ? currency(row.total) : `${row.total} registro(s)`}</span>
          </div>
        `).join("") : `<div class="empty-state">Sem dados para o periodo selecionado.</div>`}
      </div>
    </section>
  `;
}

function renderReports() {
  const reports = state.reports || { byProject: [], byMonth: [], bySupplier: [], topMaterials: [], delayedPurchases: [] };
  const filters = state.filters.reports;
  return `
    <section class="page-header">
      <div>
        <h2>Relatorios</h2>
        <p>Analise gastos por obra, mes, fornecedor, materiais recorrentes e compras com atraso.</p>
      </div>
      <div class="top-actions">
        <a class="secondary-button" href="/api/exports/reports.csv?${new URLSearchParams(filters).toString()}">Exportar Excel</a>
        <a class="primary-button" href="/api/exports/reports-print?${new URLSearchParams(filters).toString()}" target="_blank">Exportar PDF</a>
      </div>
    </section>
    <section class="panel">
      <div class="toolbar" style="grid-template-columns: repeat(2, minmax(0, 1fr));">
        <div class="field"><label>Periodo inicial</label><input type="date" data-filter-group="reports" data-filter="startDate" value="${escapeHtml(filters.startDate)}" /></div>
        <div class="field"><label>Periodo final</label><input type="date" data-filter-group="reports" data-filter="endDate" value="${escapeHtml(filters.endDate)}" /></div>
      </div>
    </section>
    <div class="two-panels">
      ${renderReportPanel("Gastos por obra", reports.byProject, true)}
      ${renderReportPanel("Gastos por mes", reports.byMonth, true)}
      ${renderReportPanel("Gastos por fornecedor", reports.bySupplier, true)}
      ${renderReportPanel("Materiais mais comprados", reports.topMaterials, false)}
    </div>
    <section class="panel">
      <h3>Compras em atraso</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Item</th><th>Obra</th><th>Fornecedor</th><th>Data da compra</th><th>Prazo de entrega</th></tr></thead>
          <tbody>
            ${reports.delayedPurchases.length ? reports.delayedPurchases.map((item) => `
              <tr>
                <td>${escapeHtml(item.item_name)}</td>
                <td>${escapeHtml(item.project_name)}</td>
                <td>${escapeHtml(item.supplier)}</td>
                <td>${formatDate(item.purchase_date)}</td>
                <td>${formatDate(item.delivery_deadline)}</td>
              </tr>
            `).join("") : `<tr><td colspan="5"><div class="empty-state">Nenhuma compra em atraso no momento.</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderModal() {
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" onclick="event.stopPropagation()">${state.modal}</div>
    </div>
  `;
}

function openBudgetModal(id) {
  const request = state.requests.find((item) => Number(item.id) === Number(id));
  if (!request) {
    alert("Demanda nao encontrada para registrar orcamento.");
    return;
  }
  state.modal = `
    <div class="modal-header">
      <div><h3 class="section-title">Registrar Orcamento</h3><div class="muted">Informe lojas pesquisadas, valores e observacoes desta demanda.</div></div>
      <button class="secondary-button" data-action="close-modal">Fechar</button>
    </div>
    <form id="budget-form" class="form-grid">
      <div class="field full"><label>Dados do orcamento</label><textarea name="budget_notes" rows="8" placeholder="Ex: Loja A - R$ 1.200, Loja B - R$ 1.350, observacoes..." required>${escapeHtml(request.budget_notes || "")}</textarea></div>
      <div class="field full"><button class="primary-button" type="button" data-action="submit-budget" data-id="${id}">Salvar orcamento</button></div>
    </form>
  `;
  render();
}

function openFinalizeGroupModal(requestIds) {
  const selectedIds = [...new Set((requestIds || []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
  const items = state.requests.filter((request) => selectedIds.includes(Number(request.id)));
  const validItems = items.filter((item) => canFinalizeRequest(item));
  if (!validItems.length) {
    alert("Selecione ao menos uma demanda valida para finalizar.");
    return;
  }

  const projectNames = [...new Set(validItems.map((item) => item.project_name))];
  if (projectNames.length > 1) {
    alert("Selecione demandas da mesma obra para finalizar em bloco.");
    return;
  }

  state.finalizeModalRequestIds = validItems.map((item) => Number(item.id));
  const defaultBlockName = `Compra ${projectNames[0]} - ${today()}`;
  const budgetReference = validItems
    .map((item) => `#${item.id} ${item.item_name}: ${item.budget_notes || "Sem orcamento digitado"}`)
    .join("\n");

  state.modal = `
    <div class="modal-header">
      <div><h3 class="section-title">Finalizar Compra em Bloco</h3><div class="muted">Todos os itens abaixo serao concluídos juntos (mesma loja/nota fiscal).</div></div>
      <button class="secondary-button" data-action="close-modal">Fechar</button>
    </div>
    <section class="panel" style="margin-bottom:14px;">
      <h4 style="margin:0 0 8px;">Itens do bloco (${validItems.length})</h4>
      <div class="summary-list">
        ${validItems.map((item) => `
          <div class="summary-item">
            <strong>#${item.id} - ${escapeHtml(item.item_name)}</strong>
            <span>${escapeHtml(item.project_name)}</span>
            <div class="muted">${escapeHtml(compactText(item.budget_notes || "Sem orcamento digitado"))}</div>
          </div>
        `).join("")}
      </div>
    </section>
    <form id="finalize-group-form" class="form-grid">
      <div class="field"><label>Nome do bloco</label><input name="block_name" value="${escapeHtml(defaultBlockName)}" required /></div>
      <div class="field"><label>Loja / Fornecedor</label><input name="supplier" required /></div>
      <div class="field"><label>Data da compra</label><input name="purchase_date" type="date" value="${today()}" required /></div>
      <div class="field"><label>Prazo de entrega</label><input name="delivery_deadline" type="date" value="${today()}" required /></div>
      <div class="field"><label>Numero da nota fiscal</label><input name="invoice_number" /></div>
      <div class="field"><label>Valor total da compra</label><input name="amount_paid" type="number" step="0.01" min="0" required /></div>
      <div class="field full"><label>Resumo de orcamento/cotacao</label><textarea name="budget_reference" rows="6" placeholder="Referencias utilizadas para esta compra">${escapeHtml(budgetReference)}</textarea></div>
      <div class="field"><label>Forma de pagamento</label><input name="payment_method" placeholder="Pix, boleto, transferencia..." /></div>
      <div class="field full"><label>Observacoes</label><textarea name="observations"></textarea></div>
      <div class="field full"><button class="primary-button" type="button" data-action="submit-finalize-group">Concluir compra em bloco</button></div>
    </form>
  `;
  render();
}

function openFinalizeModal(id) {
  openFinalizeGroupModal([id]);
}

function attachEvents() {
  document.querySelector("#login-form")?.addEventListener("submit", onLoginSubmit);
  document.querySelector("#request-form")?.addEventListener("submit", onRequestSubmit);
  document.querySelector("#user-form")?.addEventListener("submit", onUserSubmit);
  document.querySelector("#project-form")?.addEventListener("submit", onProjectSubmit);

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.currentView = button.dataset.view;
      if (button.dataset.view !== "new-request") state.editingRequest = null;
      if (button.dataset.view === "new-request" && !state.editingRequest && !state.draftItems.length) resetDraftItems();
      render();
    });
  });

  document.querySelectorAll("[data-filter-group]").forEach((input) => {
    input.addEventListener("change", onFilterChange);
    input.addEventListener("input", onFilterChange);
  });

  document.querySelectorAll("[data-item-field]").forEach((input) => {
    input.addEventListener("change", onDraftItemChange);
    input.addEventListener("input", onDraftItemChange);
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", handleAction);
  });

  document.querySelector('[data-action="select-project-summary"]')?.addEventListener("change", onProjectSummaryChange);
}

async function onLoginSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: formData.get("username"),
        password: formData.get("password")
      })
    });
    state.user = (await api("/api/session")).user;
    state.meta = await api("/api/meta");
    state.currentView = defaultViewForUser();
    state.selectedFinalizeIds = [];
    state.finalizeModalRequestIds = [];
    await loadAllData();
    resetDraftItems();
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function onRequestSubmit(event) {
  event.preventDefault();
  if (!state.editingRequest) return;
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    await api(`/api/requests/${state.editingRequest.id}`, { method: "PUT", body: JSON.stringify(payload) });
    state.editingRequest = null;
    resetDraftItems();
    await refreshAll();
    state.currentView = "open-demands";
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function onUserSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const permissions = data.getAll("permissions");
  const payload = {
    username: data.get("username"),
    password: data.get("password"),
    role: data.get("role"),
    project_id: data.get("project_id") || null,
    permissions
  };

  try {
    if (state.editingUser) {
      if (!payload.password) delete payload.password;
      await api(`/api/users/${state.editingUser.id}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api("/api/users", { method: "POST", body: JSON.stringify(payload) });
    }
    state.editingUser = null;
    state.users = await loadUsers();
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function onProjectSubmit(event) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    await api("/api/projects", { method: "POST", body: JSON.stringify(payload) });
    await refreshAll();
    if (!state.editingRequest) resetDraftItems();
    state.currentView = "projects";
    event.currentTarget.reset();
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function onProjectSummaryChange(event) {
  const projectId = Number(event.currentTarget.value);
  if (!projectId) return;
  const summary = await loadProjectSummary(projectId);
  state.projectSummary = { ...summary, projectId };
  render();
}

function onDraftItemChange(event) {
  const id = Number(event.currentTarget.dataset.itemId);
  const field = event.currentTarget.dataset.itemField;
  const item = state.draftItems.find((row) => row.id === id);
  if (!item) return;
  item[field] = event.currentTarget.value;
}

async function onFilterChange(event) {
  const group = event.currentTarget.dataset.filterGroup;
  const key = event.currentTarget.dataset.filter;
  state.filters[group][key] = event.currentTarget.value;

  if (group === "open") {
    state.requests = await loadRequests();
    pruneFinalizeSelection();
  }
  if (group === "history") {
    state.purchases = await loadPurchases();
    state.history = can("history.view") ? await api("/api/history") : [];
  }
  if (group === "reports") state.reports = await loadReports();
  render();
}

async function submitBudgetAttachment(id) {
  try {
    const formData = new FormData(document.getElementById("budget-form"));
    await api(`/api/requests/${id}/budget-attachment`, {
      method: "POST",
      body: JSON.stringify({ budget_notes: String(formData.get("budget_notes") || "").trim() })
    });
    state.modal = null;
    await refreshAll();
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function submitFinalizeGroup() {
  try {
    const formData = new FormData(document.getElementById("finalize-group-form"));
    const payload = {
      block_name: String(formData.get("block_name") || "").trim(),
      supplier: String(formData.get("supplier") || "").trim(),
      amount_paid: Number(formData.get("amount_paid")),
      purchase_date: formData.get("purchase_date"),
      delivery_deadline: formData.get("delivery_deadline"),
      invoice_number: String(formData.get("invoice_number") || "").trim(),
      budget_reference: String(formData.get("budget_reference") || "").trim(),
      payment_method: String(formData.get("payment_method") || "").trim(),
      observations: String(formData.get("observations") || "").trim(),
      request_ids: [...(state.finalizeModalRequestIds || [])]
    };
    await api("/api/purchases/finalize-group", { method: "POST", body: JSON.stringify(payload) });
    state.selectedFinalizeIds = (state.selectedFinalizeIds || [])
      .filter((id) => !payload.request_ids.includes(Number(id)));
    state.finalizeModalRequestIds = [];
    state.modal = null;
    await refreshAll();
    state.currentView = "history";
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function refreshAll() {
  await loadAllData();
}

async function handleAction(event) {
  const action = event.currentTarget.dataset.action;
  const id = Number(event.currentTarget.dataset.id);

  if (action === "logout") {
    await api("/api/logout", { method: "POST" });
    state.user = null;
    state.dashboard = null;
    state.requests = [];
    state.approvals = [];
    state.purchases = [];
    state.users = [];
    state.projects = [];
    state.projectSummary = null;
    state.history = [];
    state.reports = null;
    state.editingRequest = null;
    state.editingUser = null;
    state.draftItems = [];
    state.selectedFinalizeIds = [];
    state.finalizeModalRequestIds = [];
    state.newRequestStep = "edit";
    render();
    return;
  }
  if (action === "refresh-open") {
    state.requests = await loadRequests();
    pruneFinalizeSelection();
    if (can("dashboard.view")) state.dashboard = await api("/api/dashboard");
    render();
    return;
  }
  if (action === "open-new-request") {
    state.editingRequest = null;
    resetDraftItems();
    state.currentView = "new-request";
    render();
    return;
  }
  if (action === "refresh-approvals") {
    state.approvals = await loadApprovals();
    render();
    return;
  }
  if (action === "refresh-users") {
    state.users = await loadUsers();
    render();
    return;
  }
  if (action === "refresh-projects") {
    state.projects = await loadProjects();
    if (state.projects.length) {
      const selected = state.projects.find((item) => item.id === state.projectSummary?.projectId) || state.projects[0];
      const summary = await loadProjectSummary(selected.id);
      state.projectSummary = { ...summary, projectId: selected.id };
    } else {
      state.projectSummary = null;
    }
    render();
    return;
  }
  if (action === "cancel-edit") {
    state.editingRequest = null;
    resetDraftItems();
    render();
    return;
  }
  if (action === "cancel-user-edit") {
    state.editingUser = null;
    render();
    return;
  }
  if (action === "edit-request") {
    state.editingRequest = state.requests.find((item) => item.id === id);
    state.newRequestStep = "edit";
    state.currentView = "new-request";
    render();
    return;
  }
  if (action === "add-request-item") {
    const baseItem = state.draftItems[state.draftItems.length - 1] || {};
    state.draftItems.push(createDraftItem({
      project_name: baseItem.project_name,
      requester_name: baseItem.requester_name,
      request_date: baseItem.request_date
    }));
    render();
    return;
  }
  if (action === "remove-request-item") {
    state.draftItems = state.draftItems.filter((item) => item.id !== id);
    if (!state.draftItems.length) state.draftItems = [createDraftItem()];
    render();
    return;
  }
  if (action === "review-request-items") {
    const validationError = validateDraftItems();
    if (validationError) {
      alert(validationError);
      return;
    }
    state.newRequestStep = "review";
    render();
    return;
  }
  if (action === "back-request-edit") {
    state.newRequestStep = "edit";
    render();
    return;
  }
  if (action === "confirm-request-submit") {
    try {
      await submitAllDraftItems();
      const count = state.draftItems.length;
      resetDraftItems();
      await refreshAll();
      state.currentView = "open-demands";
      alert(`${count} demanda(s) enviada(s) com sucesso.`);
      render();
    } catch (error) {
      alert(error.message);
    }
    return;
  }
  if (action === "approve-request") {
    const reason = prompt("Motivo/observacao da aprovacao (opcional):") || "";
    await api(`/api/requests/${id}/approval`, { method: "PATCH", body: JSON.stringify({ decision: "approve", reason }) });
    await refreshAll();
    state.currentView = "approvals";
    render();
    return;
  }
  if (action === "reject-request") {
    const reason = prompt("Informe o motivo da recusa:") || "";
    await api(`/api/requests/${id}/approval`, { method: "PATCH", body: JSON.stringify({ decision: "reject", reason }) });
    await refreshAll();
    state.currentView = "approvals";
    render();
    return;
  }
  if (action === "edit-user") {
    state.editingUser = state.users.find((item) => item.id === id) || null;
    state.currentView = "users";
    render();
    return;
  }
  if (action === "delete-user") {
    if (!confirm("Deseja remover este usuario?")) return;
    await api(`/api/users/${id}`, { method: "DELETE" });
    state.users = await loadUsers();
    if (state.editingUser?.id === id) state.editingUser = null;
    render();
    return;
  }
  if (action === "view-project-summary") {
    const summary = await loadProjectSummary(id);
    state.projectSummary = { ...summary, projectId: id };
    state.currentView = "projects";
    render();
    return;
  }
  if (action === "view-project-requests") {
    const project = state.projects.find((item) => item.id === id);
    state.filters.open.project = project?.name || "";
    state.currentView = "open-demands";
    state.requests = await loadRequests();
    render();
    return;
  }
  if (action === "delete-project") {
    if (!confirm("Deseja remover esta obra?")) return;
    await api(`/api/projects/${id}`, { method: "DELETE" });
    await refreshAll();
    state.currentView = "projects";
    render();
    return;
  }
  if (action === "delete-request") {
    if (!confirm("Deseja realmente excluir esta demanda?")) return;
    await api(`/api/requests/${id}`, { method: "DELETE" });
    await refreshAll();
    render();
    return;
  }
  if (action === "toggle-finalize-selection") {
    if (!can("purchases.finalize")) return;
    const idValue = Number(id);
    if (!Number.isInteger(idValue) || idValue <= 0) return;
    if ((state.selectedFinalizeIds || []).includes(idValue)) {
      state.selectedFinalizeIds = state.selectedFinalizeIds.filter((value) => Number(value) !== idValue);
    } else {
      const request = state.requests.find((item) => Number(item.id) === idValue);
      if (!canFinalizeRequest(request)) {
        alert("Esta demanda nao pode ser finalizada.");
        return;
      }
      state.selectedFinalizeIds = [...(state.selectedFinalizeIds || []), idValue];
    }
    render();
    return;
  }
  if (action === "finalize-selected") {
    if (!state.selectedFinalizeIds.length) {
      alert("Selecione ao menos uma demanda para finalizar em bloco.");
      return;
    }
    return openFinalizeGroupModal(state.selectedFinalizeIds);
  }
  if (action === "cancel-purchase") {
    const reason = prompt("Motivo do cancelamento da compra (opcional):");
    if (reason === null) return;
    await api(`/api/purchases/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "Cancelada", reason })
    });
    await refreshAll();
    state.currentView = "history";
    render();
    return;
  }
  if (action === "restore-purchase") {
    await api(`/api/purchases/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "Finalizada" })
    });
    await refreshAll();
    state.currentView = "history";
    render();
    return;
  }
  if (action === "attach-budget") return openBudgetModal(id);
  if (action === "finalize-request") return openFinalizeModal(id);
  if (action === "close-modal") {
    state.modal = null;
    state.finalizeModalRequestIds = [];
    render();
    return;
  }
  if (action === "submit-budget") return submitBudgetAttachment(id);
  if (action === "submit-finalize-group") return submitFinalizeGroup();
}

document.addEventListener("change", async (event) => {
  const select = event.target;
  if (select.matches('[data-action="change-status"]')) {
    await api(`/api/requests/${select.dataset.id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: select.value })
    });
    await refreshAll();
    render();
  }
});

async function initialize() {
  const session = await api("/api/session");
  if (session.authenticated) {
    state.user = session.user;
    state.meta = await api("/api/meta");
    state.currentView = defaultViewForUser();
    state.selectedFinalizeIds = [];
    state.finalizeModalRequestIds = [];
    await loadAllData();
    resetDraftItems();
  }
  render();
}

initialize().catch((error) => {
  console.error(error);
  app.innerHTML = `<div class="login-screen"><div class="login-card"><h1>Erro ao iniciar</h1><p>${escapeHtml(error.message)}</p></div></div>`;
});
