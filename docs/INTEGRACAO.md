# Integração com agentes

Como registrar o servidor MCP do Mockup Studio no Claude Code, no Codex CLI e em outros clientes. Referência das ferramentas em [MCP.md](MCP.md).

## 1. Pré-requisitos e instalação do CLI

Todos os clientes usam o comando `mockup` (`mockup mcp` fala MCP por stdio). Duas formas de instalar.

**A partir do código** (Node 24, npm 11):

```bash
npm install
npm run build
npm link -w @mockup/cli
```

Isso cria `mockup`, `mockup.cmd` e `mockup.ps1` na pasta global do npm, que já está no PATH. Para desfazer: `npm unlink -g @mockup/cli`.

**Pelo instalador do app** (`npm run dist` gera `dist/MockupStudio-Setup-<versão>-x64.exe`):

- Instala por usuário e registra o CLI: `mockup.cmd` em `%LOCALAPPDATA%\MockupStudio\bin`, e essa pasta entra no PATH do usuário. Abra um terminal novo depois.
- O `mockup.cmd` roda o próprio executável do app como Node (`ELECTRON_RUN_AS_NODE=1`), então não precisa de Node instalado.
- A desinstalação remove o shim e a entrada do PATH.
- Comandos manuais: `mockup install-cli` e `mockup uninstall-cli` (ambos aceitam `--bin-dir <pasta>`), ou `"Mockup Studio.exe" --install-cli` / `--uninstall-cli` (reparo da instalação; o portátil recusa, porque roda de uma pasta temporária).

**Verificar:**

```bash
mockup --version
mockup doctor          # --json para saída legível por máquina
```

O `mockup doctor` confere:

- versão do CLI e do Node (>= 24, ou o Node embutido do Electron)
- pasta de dados
- daemon: rodando ou não, modo (desktop, headless, serve) e se há render/screenshot
- porta 4747: livre, em uso pelo Mockup Studio ou ocupada por outro programa
- Electron disponível e fontes do sistema
- `mockup`, `claude` e `codex` no PATH, e se `mockup-studio` já está registrado
- os comandos de registro já preenchidos com o caminho certo

## 2. Registro automático

```bash
mockup setup claude          # só Claude Code
mockup setup codex           # só Codex CLI
mockup setup all             # os dois
```

Flags:

- `--http`: registra o transporte HTTP (`http://127.0.0.1:4747/mcp`) em vez de stdio.
- `--skill`: copia `integrations/claude-code/SKILL.md` para `~/.claude/skills/mockup-studio/SKILL.md`.
- `--print`: só imprime as instruções, sem executar nada.
- `--force`: recria o registro do zero (`remove` + `add`), mesmo quando já está igual. Descarta campos extras (env, headers, aprovações).
- `--approve` (Codex): grava `default_tools_approval_mode = "approve"` na seção `[mcp_servers.mockup-studio]`. Idempotente.
- `--agents` (Codex): acrescenta o trecho de `integrations/codex/AGENTS.snippet.md` ao `~/.codex/AGENTS.md` (ou `$CODEX_HOME/AGENTS.md`), entre `<!-- mockup-studio:start -->` e `<!-- mockup-studio:end -->`. Roda de novo sem duplicar: atualiza o que está entre os marcadores e preserva o resto.
- `--command path|shim|absolute`: forma do comando registrado.
  - `path`: `mockup`, resolvido pelo PATH.
  - `shim`: caminho absoluto de `%LOCALAPPDATA%\MockupStudio\bin\mockup.cmd`.
  - `absolute`: caminho absoluto, sem depender do PATH. No app empacotado é o executável do app com `ELECTRON_RUN_AS_NODE=1`; a partir do repositório, o `node.exe` mais o script do CLI.

O setup lê o registro atual direto de `~/.claude.json` (ou `$CLAUDE_CONFIG_DIR/.claude.json`) e de `~/.codex/config.toml` (ou `$CODEX_HOME/config.toml`), sem rodar `mcp get` (que sobe o servidor e é lento). É idempotente e não destrói a sua config:

- Já registrado com o mesmo comando: não executa nada ("nada a fazer").
- Claude com comando diferente: avisa que o re-registro descarta campos extras e faz `remove -s user` + `add --scope user`. Se o servidor só existe no escopo local ou de projeto, informa e adiciona no escopo user.
- Codex com comando diferente: edita só as chaves de lançamento da seção no `config.toml` (`command`/`args`/`env`, ou `url` com `--http`). Chaves como `default_tools_approval_mode`, timeouts, comentários (inclusive no fim da linha) e as outras seções ficam como estão. Um `env = { ... }` em linha é atualizado em linha.
- Troca de transporte no Codex: ao ir para `--http`, remove `command`, `args`, `env`, `env_vars` e `cwd` (o Codex não aceita essas chaves em servidor HTTP e não sobe); ao voltar para stdio, remove `url`, `bearer_token_env_var`, `http_headers` e `env_http_headers`. O setup lista o que removeu.
- Antes de gravar, o setup confere o resultado com um parser TOML: se não ficar válido ou com o comando esperado, não grava nada e sugere editar à mão ou `--force`. Um `config.toml` já inválido é apontado (linha e coluna) pelo setup e pelo `mockup doctor`.
- Sem a seção no Codex: `codex mcp add`.
- Sem os executáveis no PATH, imprime as instruções.

`mockup doctor` mostra o escopo e o comando registrados e avisa (`!`) se o comando difere do atual. No Codex avisa também se falta `default_tools_approval_mode = "approve"` (`mockup setup codex --approve`) ou o trecho no `AGENTS.md` (`--agents`).

## 3. Claude Code

**stdio (recomendado).** O `mockup mcp` sobe o daemon sozinho e, com o app/Electron disponível, tem screenshot:

```bash
claude mcp add --scope user mockup-studio -- mockup mcp
```

**HTTP.** Exige um daemon rodando (app aberto, `mockup serve --render` ou `npm run dev`):

```bash
claude mcp add --scope user --transport http mockup-studio http://127.0.0.1:4747/mcp
```

Verificar e remover:

```bash
claude mcp list                          # mockup-studio: mockup mcp - ✔ Connected
claude mcp remove mockup-studio -s user
```

Dentro do Claude Code, `/mcp` mostra o estado do servidor e as ferramentas.

**Skill (opcional).** Ensina o fluxo de trabalho ao agente:

```bash
mockup setup claude --skill
```

Ou copie à mão [integrations/claude-code/SKILL.md](../integrations/claude-code/SKILL.md) para `~/.claude/skills/mockup-studio/SKILL.md`.

**Trecho para o `CLAUDE.md` global** (`~/.claude/CLAUDE.md`):

```markdown
## Mockup Studio

Para pedidos de mockup, tela, protótipo ou landing page, use o servidor MCP `mockup-studio`:

1. `get_guide('getting-started')`, depois `create_document` num caminho do projeto (`design/<nome>.mockup.json`).
2. `set_tokens` (cores, espaçamento, fonte) e `create_frame` (um frame por breakpoint: Desktop 1440x900, Tablet 768x1024, Mobile 390x844).
3. `write_html` uma seção por vez; `get_screenshot` depois de cada uma e corrija até ficar bom.
4. `export` (html, tailwind ou react) se pedirem código; `finish_working` ao terminar.
```

## 4. Codex CLI

**stdio:**

```bash
codex mcp add mockup-studio -- mockup mcp
```

Funciona no Windows (verificado com o Codex CLI 0.163.0 e o shim `mockup.cmd` do `npm link`). O equivalente em `~/.codex/config.toml`:

```toml
[mcp_servers.mockup-studio]
command = "mockup"
args = ["mcp"]
```

No Windows, caminhos em TOML usam `\\` ou aspas simples literais (`'C:\caminho\bin.js'`).

**Variáveis de ambiente.** O Codex não repassa todo o ambiente ao servidor MCP. Para `MOCKUP_PORT`, `MOCKUP_DATA_DIR` e similares, declare-as no config:

```toml
[mcp_servers.mockup-studio.env]
MOCKUP_PORT = "4747"
```

Ou use `--env K=V` no `codex mcp add`.

**Aprovação das ferramentas.** O Codex só deixa passar sem pergunta as ferramentas marcadas como somente leitura. As que gravam (`create_document`, `write_html`, `export`...) pedem aprovação, e no `codex exec` (política `never`) elas são **bloqueadas** (`MCP tool call requires approval, but approval policy is never`). Para liberar as do Mockup Studio, que só mexem em documentos de design e na pasta de exportação:

```toml
[mcp_servers.mockup-studio]
command = "mockup"
args = ["mcp"]
default_tools_approval_mode = "approve"
```

Ou só numa execução: `codex exec -c 'mcp_servers.mockup-studio.default_tools_approval_mode="approve"' "..."`. O `mockup setup codex` não liga isso por conta própria (é uma decisão de permissão do usuário): use `mockup setup codex --approve` para gravar a chave.

**AGENTS.md.** Sem o trecho de [integrations/codex/AGENTS.snippet.md](../integrations/codex/AGENTS.snippet.md), um pedido como "crie um mockup de tela de login" faz o Codex escrever um HTML à mão em vez de usar o MCP. `mockup setup codex --agents` instala o trecho no `~/.codex/AGENTS.md`, entre marcadores e sem duplicar.

**HTTP** (daemon rodando):

```bash
codex mcp add mockup-studio --url http://127.0.0.1:4747/mcp
```

```toml
[mcp_servers.mockup-studio]
url = "http://127.0.0.1:4747/mcp"
```

Verificar:

```bash
codex mcp list
codex mcp get mockup-studio
```

**Windows:** se algum ambiente não achar `mockup`, registre o comando absoluto: `mockup setup codex --command absolute`.

**AGENTS.md (à mão).** Em vez do `--agents`, cole o conteúdo de [integrations/codex/AGENTS.snippet.md](../integrations/codex/AGENTS.snippet.md) no `~/.codex/AGENTS.md` (global) ou no `AGENTS.md` do projeto.

## 5. Outros clientes

Clientes com JSON `mcpServers`:

- Cursor: `~/.cursor/mcp.json` (global) ou `.cursor/mcp.json` (projeto).
- Claude Desktop: `%APPDATA%\Claude\claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "mockup-studio": {
      "command": "mockup",
      "args": ["mcp"]
    }
  }
}
```

VS Code, em `.vscode/mcp.json`:

```json
{
  "servers": {
    "mockup-studio": {
      "type": "stdio",
      "command": "mockup",
      "args": ["mcp"]
    }
  }
}
```

Variante HTTP (daemon rodando):

```json
{
  "servers": {
    "mockup-studio": {
      "type": "http",
      "url": "http://127.0.0.1:4747/mcp"
    }
  }
}
```

Se o cliente não resolver `mockup.cmd` sem shell, veja a próxima seção.

## 6. Windows

- Com `npm link`, `claude mcp add --scope user mockup-studio -- mockup mcp` funciona: o Claude Code resolve o shim `mockup.cmd`. O Codex também (verificado).
- O Claude Code não precisa de `cmd /c mockup mcp`.
- Clientes que não resolvem `.cmd` sem shell: use `cmd /c mockup mcp` ou o caminho absoluto impresso pelo `mockup doctor`, por exemplo `"C:\Program Files\nodejs\node.exe" "C:\...\packages\cli\dist\bin.js" mcp`.
- No Git Bash, `/c` é convertido em `C:/`. Escreva `cmd //c` ou use o PowerShell.
- Com o instalador, o `mockup.cmd` fica em `%LOCALAPPDATA%\MockupStudio\bin`. Abra um terminal novo depois de instalar para o PATH valer.

## 7. Como funciona

- `mockup mcp` fala MCP por stdio com o cliente e funciona como proxy para um único daemon em `127.0.0.1:4747`.
- O daemon é compartilhado com o editor: o que o agente faz aparece no canvas em tempo real, e a seleção do editor chega ao agente.
- Se não houver daemon, o CLI sobe o Electron headless (com motor de render, necessário para screenshot). Sem Electron, cai para um daemon Node, sem screenshot. `MOCKUP_NO_ELECTRON=1` força o daemon Node.
- `mockup stop` encerra o daemon (o app com janela recusa: feche-o pela janela).
- Variáveis: `MOCKUP_PORT` (padrão 4747), `MOCKUP_DATA_DIR`, `MOCKUP_DESKTOP_EXE`, `MOCKUP_NO_ELECTRON=1`.

## 8. Solução de problemas

- Comece por `mockup doctor`.
- **Ferramentas não aparecem:** `claude mcp list` / `codex mcp list`; registre de novo com `mockup setup all`.
- **Screenshot indisponível:** o daemon está em modo Node, sem render. Abra o app, ou `mockup stop` e deixe o `mockup mcp` subir o Electron headless. Confira se o Electron foi encontrado (`MOCKUP_DESKTOP_EXE`).
- **Porta ocupada:** outro programa usa a 4747. Use `MOCKUP_PORT` (o mesmo valor no cliente e no daemon) ou libere a porta.
- **Logs:** `daemon.log` na pasta de dados. Padrão no Windows: `%LOCALAPPDATA%\MockupStudio`; nos outros sistemas, `~/.mockup-studio`; `MOCKUP_DATA_DIR` troca a pasta.
- No MCP: `get_guide('troubleshooting')` e `get_guide('setup')`.
