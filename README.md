# Sistema de Compras Corporativas

Sistema web para controle de compras e orcamentos de obras, agora com fluxo hibrido (ADM + portal de funcionario).

## Funcionalidades implementadas

- autenticacao com login e senha
- senha com hash seguro (`pbkdf2`) e compatibilidade com hash legado
- perfil `ADM` com gestao de usuarios
- cadastro, edicao e remocao de usuarios
- definicao de permissoes por usuario
- portal web para funcionario (`/`)
- envio de pedidos de materiais pelo funcionario
- aprovacao ou recusa dos pedidos no sistema principal
- sincronizacao de status entre portal e sistema principal
- dashboard, demandas, anexos, finalizacao de compra, historico e relatorios CSV/PDF
- persistencia local em banco de dados JSON (`data/database.json`)

## Como executar

1. Abra o terminal em `C:\sistema`
2. Execute:

```powershell
npm start
```

3. Acesse:

- Portal funcionario: [http://localhost:3000](http://localhost:3000)
- Painel ADM (somente via link manual): [http://localhost:3000/adm](http://localhost:3000/adm)

## Credenciais iniciais

- Usuario: `admin`
- Senha: `admin123`

## Gerar executavel (.exe)

Use o script abaixo para empacotar o sistema para Windows:

```powershell
npm run build:exe
```

Saida esperada:

- `dist/sistema-compras.exe`

Observacao: o empacotamento usa `pkg` via `npx` e baixa dependencias na primeira execucao.

## Arquivos principais

- `app-server.js`: servidor HTTP, API, autenticacao, permissoes, pedidos e uploads
- `public/index.html`: entrada do painel administrativo
- `public/app.js`: interface ADM (dashboard, aprovacoes, usuarios, relatorios)
- `public/employee.html`: entrada do portal do funcionario
- `public/employee-app.js`: interface do funcionario (pedido e acompanhamento)
- `public/styles.css`: estilos compartilhados

## Desenvolvedor

- Desenvolvido por **Joao Carlos Espinato**
- Contato / WhatsApp: [55 28 99964-4083](https://wa.me/5528999644083?text=Ola,%20gostaria%20de%20um%20orcamento.)
