const state = {
  user: null,
  currentView: "new-request",
  newRequestStep: "edit",
  draftItems: [],
  requests: [],
  filters: { search: "", status: "", approvalState: "" }
};

const app = document.getElementById("employee-app");
const WHATSAPP_NUMBER = "5528999644083";
const WHATSAPP_LINK = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent("Ola, gostaria de um orcamento.")}`;
const UNIT_OPTIONS = [
  { value: "unidade", label: "unidade" },
  { value: "metro", label: "metro" },
  { value: "metro2", label: "metro2" },
  { value: "peca", label: "peca" },
  { value: "kilo", label: "kilo" },
  { value: "grama", label: "grama" }
];

let draftItemCounter = 0;

function createDraftItem() {
  draftItemCounter += 1;
  return {
    id: draftItemCounter,
    item_name: "",
    quantity: "",
    unit: "unidade",
    needed_by_date: today(),
    priority: "media",
    description: "",
    notes: ""
  };
}

function resetDraftItems() {
  state.draftItems = [createDraftItem()];
  state.newRequestStep = "edit";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("pt-BR").format(new Date(`${value}T00:00:00`));
}

function unitLabel(value) {
  const normalized = String(value || "").toLowerCase();
  return UNIT_OPTIONS.find((option) => option.value === normalized)?.label || normalized;
}

function today() {
  const date = new Date();
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

async function loadMyRequests() {
  const query = new URLSearchParams(state.filters).toString();
  state.requests = await api(`/api/employee/requests?${query}`);
}

function renderLogin() {
  return `
    <div class="login-screen">
      <div class="login-card">
        <h1>Portal do Funcionario</h1>
        <p class="hint">Acesse com seu usuario para registrar pedidos de material.</p>
        <form id="employee-login-form" class="form-grid" style="margin-top:24px; grid-template-columns:1fr;">
          <div class="field">
            <label for="username">Usuario</label>
            <input id="username" name="username" required />
          </div>
          <div class="field">
            <label for="password">Senha</label>
            <input id="password" type="password" name="password" required />
          </div>
          <button class="primary-button" type="submit">Entrar</button>
        </form>
      </div>
      ${renderDeveloperFooter()}
    </div>
  `;
}

function renderDraftItem(item, index) {
  return `
    <article class="request-item-card">
      <div class="request-item-header">
        <strong>Item ${index + 1}</strong>
        ${state.draftItems.length > 1 ? `<button class="danger-button" type="button" data-action="remove-item" data-id="${item.id}">Remover</button>` : ""}
      </div>
      <div class="form-grid compact-form">
        <div class="field">
          <label>Material</label>
          <input data-item-id="${item.id}" data-item-field="item_name" value="${escapeHtml(item.item_name)}" required />
        </div>
        <div class="field">
          <label>Quantidade</label>
          <input data-item-id="${item.id}" data-item-field="quantity" type="number" min="0.01" step="0.01" value="${escapeHtml(item.quantity)}" required />
        </div>
        <div class="field">
          <label>Unidade de medida</label>
          <select data-item-id="${item.id}" data-item-field="unit">
            ${UNIT_OPTIONS.map((option) => `<option value="${option.value}" ${item.unit === option.value ? "selected" : ""}>${option.label}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>Entrega ate</label>
          <input data-item-id="${item.id}" data-item-field="needed_by_date" type="date" value="${escapeHtml(item.needed_by_date || today())}" />
        </div>
      </div>
      <details class="optional-box" style="margin-top:10px;">
        <summary>Prioridade e descricao (caso necessario)</summary>
        <div class="form-grid" style="margin-top:10px;">
          <div class="field">
            <label>Prioridade</label>
            <select data-item-id="${item.id}" data-item-field="priority">
              ${["baixa", "media", "alta", "urgente"].map((priority) => `<option value="${priority}" ${item.priority === priority ? "selected" : ""}>${priority}</option>`).join("")}
            </select>
          </div>
          <div class="field full">
            <label>Descricao</label>
            <textarea data-item-id="${item.id}" data-item-field="description" placeholder="Detalhes somente se necessario">${escapeHtml(item.description || "")}</textarea>
          </div>
          <div class="field full">
            <label>Observacoes</label>
            <textarea data-item-id="${item.id}" data-item-field="notes" placeholder="Informacoes adicionais">${escapeHtml(item.notes || "")}</textarea>
          </div>
        </div>
      </details>
    </article>
  `;
}

function renderReview() {
  return `
    <section class="panel">
      <h3>Conferencia final dos pedidos</h3>
      <p class="hint">Revise os itens abaixo antes de confirmar o envio.</p>
      <div class="review-list">
        ${state.draftItems.map((item, index) => `
          <div class="review-item">
            <strong>Item ${index + 1} - ${escapeHtml(item.item_name)}</strong>
            <div class="muted">Quantidade: ${escapeHtml(item.quantity)} | Unidade: ${escapeHtml(unitLabel(item.unit))}</div>
            <div class="muted">Solicitado em: ${formatDate(today())}</div>
            <div class="muted">Entrega ate: ${formatDate(item.needed_by_date)}</div>
            <div class="muted">Prioridade: ${escapeHtml(item.priority)}</div>
            <div class="muted">Descricao: ${escapeHtml(item.description || "-")}</div>
            <div class="muted">Observacoes: ${escapeHtml(item.notes || "-")}</div>
          </div>
        `).join("")}
      </div>
      <div class="top-actions" style="margin-top:12px;">
        <button class="secondary-button" type="button" data-action="back-to-edit">Voltar e editar</button>
        <button class="primary-button" type="button" data-action="confirm-submit">Confirmar envio</button>
      </div>
    </section>
  `;
}

function renderNewRequest() {
  return `
    <section class="page-header">
      <div>
        <h2>Novo Pedido</h2>
        <p>Preencha os itens e confirme antes do envio final.</p>
      </div>
    </section>
    <section class="panel">
      <div class="hint" style="margin-bottom:10px;">Obra vinculada: <strong>${escapeHtml(state.user.project_name || "Nao definida")}</strong></div>
      ${state.newRequestStep === "review" ? renderReview() : `
        <div class="request-item-list">
          ${state.draftItems.map(renderDraftItem).join("")}
        </div>
        <div class="top-actions" style="margin-top:12px;">
          <button class="secondary-button" type="button" data-action="add-item">Adicionar outro item</button>
          <button class="primary-button" type="button" data-action="review-items">Enviar pedido</button>
        </div>
      `}
    </section>
  `;
}

function renderRequestsList() {
  return `
    <section class="page-header">
      <div>
        <h2>Pedidos Feitos</h2>
        <p>Acompanhe aprovacao e andamento dos seus pedidos.</p>
      </div>
      <div class="top-actions">
        <button class="secondary-button" data-action="refresh">Atualizar</button>
      </div>
    </section>
    <section class="panel">
      <div class="toolbar" style="grid-template-columns: repeat(3, minmax(0, 1fr));">
        <div class="field"><label>Pesquisar</label><input data-filter="search" value="${escapeHtml(state.filters.search)}" placeholder="Material" /></div>
        <div class="field"><label>Status</label><select data-filter="status"><option value="">Todos</option>${["Pendente de aprovacao","Solicitacao recebida","Em cotacao","Aguardando aprovacao","Compra realizada","Entregue","Cancelado","Recusado"].map((status) => `<option value="${status}" ${state.filters.status === status ? "selected" : ""}>${status}</option>`).join("")}</select></div>
        <div class="field"><label>Aprovacao</label><select data-filter="approvalState"><option value="">Todas</option>${["Pendente","Aprovado","Recusado"].map((status) => `<option value="${status}" ${state.filters.approvalState === status ? "selected" : ""}>${status}</option>`).join("")}</select></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Material</th><th>Solicitado em</th><th>Qtd/Un</th><th>Prazo</th><th>Status</th><th>Aprovacao</th><th>Motivo</th></tr></thead>
          <tbody>
            ${state.requests.length ? state.requests.map((item) => `
              <tr>
                <td>#${item.id}</td>
                <td><strong>${escapeHtml(item.item_name)}</strong><div class="muted">${escapeHtml(item.description || "-")}</div></td>
                <td>${formatDate(item.request_date)}</td>
                <td>${item.quantity} ${escapeHtml(unitLabel(item.unit))}</td>
                <td>${formatDate(item.needed_by_date)}</td>
                <td>${escapeHtml(item.status)}</td>
                <td>${escapeHtml(item.approval_state || "Pendente")}</td>
                <td>${escapeHtml(item.approval_reason || "-")}</td>
              </tr>
            `).join("") : `<tr><td colspan="8"><div class="empty-state">Nenhum pedido encontrado.</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderPortal() {
  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <h1>Portal do Funcionario</h1>
          <p>Solicitacao de materiais para aprovacao.</p>
        </div>
        <nav class="nav">
          ${navButton("new-request", "Novo pedido")}
          ${navButton("my-requests", "Pedidos feitos")}
        </nav>
        <div class="sidebar-footer">
          <div class="user-card">
            <strong>${escapeHtml(state.user.username)}</strong>
            <div class="hint">${escapeHtml(state.user.role)}</div>
            <div class="hint">${escapeHtml(state.user.project_name || "Sem obra")}</div>
          </div>
          <button class="ghost-button" data-action="logout">Sair</button>
        </div>
      </aside>
      <main class="content">
        ${state.currentView === "new-request" ? renderNewRequest() : renderRequestsList()}
        ${renderDeveloperFooter()}
      </main>
    </div>
  `;
}

function render() {
  app.innerHTML = state.user ? renderPortal() : renderLogin();
  attachEvents();
}

function attachEvents() {
  document.querySelector("#employee-login-form")?.addEventListener("submit", onLoginSubmit);
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.currentView = button.dataset.view;
      render();
    });
  });
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", onAction));
  document.querySelectorAll("[data-filter]").forEach((input) => {
    input.addEventListener("change", onFilterChange);
    input.addEventListener("input", onFilterChange);
  });
  document.querySelectorAll("[data-item-field]").forEach((input) => {
    input.addEventListener("change", onDraftItemChange);
    input.addEventListener("input", onDraftItemChange);
  });
}

function onDraftItemChange(event) {
  const id = Number(event.currentTarget.dataset.itemId);
  const field = event.currentTarget.dataset.itemField;
  const item = state.draftItems.find((row) => row.id === id);
  if (!item) return;
  item[field] = event.currentTarget.value;
}

function validateDraftItems() {
  if (!state.draftItems.length) return "Adicione ao menos um item.";
  for (const [index, item] of state.draftItems.entries()) {
    if (!String(item.item_name || "").trim()) return `Informe o material do item ${index + 1}.`;
    if (!Number(item.quantity) || Number(item.quantity) <= 0) return `Quantidade invalida no item ${index + 1}.`;
    if (!String(item.unit || "").trim()) return `Informe a unidade do item ${index + 1}.`;
  }
  return "";
}

async function onLoginSubmit(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username: data.get("username"), password: data.get("password") })
    });
    const session = await api("/api/session");
    state.user = session.user;
    state.currentView = "new-request";
    resetDraftItems();
    await loadMyRequests();
    render();
  } catch (error) {
    alert(error.message);
  }
}

async function submitAllDraftItems() {
  const priorityMap = { baixa: "Baixa", media: "Media", alta: "Alta", urgente: "Urgente" };
  for (const item of state.draftItems) {
    const payload = {
      item_name: String(item.item_name || "").trim(),
      quantity: Number(item.quantity),
      unit: item.unit,
      needed_by_date: item.needed_by_date || today(),
      request_date: today(),
      priority: priorityMap[item.priority] || "Media",
      description: String(item.description || "").trim(),
      notes: String(item.notes || "").trim()
    };
    await api("/api/employee/requests", { method: "POST", body: JSON.stringify(payload) });
  }
}

async function onAction(event) {
  const action = event.currentTarget.dataset.action;

  if (action === "logout") {
    await api("/api/logout", { method: "POST" });
    state.user = null;
    state.requests = [];
    state.currentView = "new-request";
    resetDraftItems();
    render();
    return;
  }

  if (action === "refresh") {
    await loadMyRequests();
    render();
    return;
  }

  if (action === "add-item") {
    state.draftItems.push(createDraftItem());
    render();
    return;
  }

  if (action === "remove-item") {
    const id = Number(event.currentTarget.dataset.id);
    state.draftItems = state.draftItems.filter((item) => item.id !== id);
    if (!state.draftItems.length) state.draftItems = [createDraftItem()];
    render();
    return;
  }

  if (action === "review-items") {
    const validationError = validateDraftItems();
    if (validationError) {
      alert(validationError);
      return;
    }
    state.newRequestStep = "review";
    render();
    return;
  }

  if (action === "back-to-edit") {
    state.newRequestStep = "edit";
    render();
    return;
  }

  if (action === "confirm-submit") {
    try {
      await submitAllDraftItems();
      await loadMyRequests();
      const count = state.draftItems.length;
      resetDraftItems();
      state.currentView = "my-requests";
      alert(`${count} pedido(s) enviado(s) com sucesso.`);
      render();
    } catch (error) {
      alert(error.message);
    }
  }
}

async function onFilterChange(event) {
  state.filters[event.currentTarget.dataset.filter] = event.currentTarget.value;
  await loadMyRequests();
  render();
}

async function initialize() {
  const session = await api("/api/session");
  if (session.authenticated) {
    state.user = session.user;
    resetDraftItems();
    await loadMyRequests();
  } else {
    resetDraftItems();
  }
  render();
}

initialize().catch((error) => {
  console.error(error);
  app.innerHTML = `<div class="login-screen"><div class="login-card"><h1>Erro ao iniciar</h1><p>${escapeHtml(error.message)}</p></div></div>`;
});
