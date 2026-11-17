# Assistente de IA

Um chat no editor conversa com o canvas usando as CLIs de agente já instaladas na máquina: **Claude Code** (`claude`) e **Codex** (`codex`). O daemon abre a CLI como subprocesso, registra o próprio MCP nela e a CLI edita o documento pelas mesmas ferramentas que qualquer agente externo usa ([MCP.md](MCP.md)). Não há chave de API própria: vale a conta que já está logada na CLI.

Cada pedido do usuário é um **turno**, e **cada turno é um único passo de desfazer** no editor.

## Visão geral

1. O usuário escreve o pedido no painel "Assistente" (com a seleção atual como contexto).
2. O daemon monta o contexto (documento, seleção, resumo da árvore, screenshot) e inicia a CLI.
3. A CLI conecta no MCP do daemon com um token de turno e edita o canvas. O editor vê as mudanças ao vivo, como em qualquer edição por MCP.
4. O texto do agente chega por streaming ao painel. No fim, a mensagem final traz o status, as ferramentas usadas e quantas ops foram aplicadas.

## Arquitetura

```
 editor (painel Assistente)
   │  WebSocket: assistant:send / cancel / history / clear / config
   │  ◄──────── assistant:event (turn-start, text, tool, tool-result, turn-end, cleared)
   ▼
 daemon (packages/server)
   AssistantService ── resolve backend ── AgentBackend.run(input, emit, signal)
        │                                      │
        │ token do turno (resolveTurn)         ▼
        │                              subprocesso da CLI (claude -p / codex exec)
        │                              cwd temporário; prompt por stdin;
        │                              config MCP e system prompt por arquivo temporário
        │                                      │  HTTP Streamable
        ▼                                      ▼
   DocumentStore.applyOps({ group })  ◄── MCP  /mcp?turn=<token>   (mesmo daemon, 127.0.0.1)
```

Peças:

- `packages/server/src/agent/assistant.ts`: `AssistantService` (turnos, contexto, histórico, configuração, mensagens WS).
- `packages/server/src/agent/cli.ts`: `ClaudeCliBackend`, `CodexCliBackend`, parsers do JSONL, `findExecutable`, `detectBackends`.
- `packages/server/src/agent/backend.ts`: contrato `AgentBackend`.
- `packages/server/src/mcp/session.ts` e `mcp/server.ts`: reconhecem o token `?turn=` e aplicam o grupo de undo do turno.
- `packages/server/test/fixtures/fake-agent-cli.mjs`: CLI falsa dos testes.

## Backends e detecção

O `AssistantService` conhece uma lista de backends (`claude`, depois `codex`). A configuração `backend: "auto"` usa o primeiro disponível; também dá para fixar um id.

Como a CLI é encontrada (`findExecutable`):

- Procura no `PATH`. No Windows respeita o `PATHEXT` e prefere `.exe` a `.cmd`/`.bat` (um `.exe` roda direto, sem shell).
- `.cmd`/`.bat` rodam por `shell: true` com um único comando já citado (argumentos com `"`, `%` ou quebra de linha são recusados; por isso nenhum argumento carrega JSON).
- Variáveis de ambiente de override:

| Variável            | Efeito                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `MOCKUP_CLAUDE_BIN` | Caminho do executável do Claude Code.                                                                                |
| `MOCKUP_CODEX_BIN`  | Caminho do executável do Codex.                                                                                      |
| `MOCKUP_AGENT_CLI`  | Caminho de um script `.mjs`/`.js`: o backend `claude` passa a rodar `node <script>` (usado nos e2e com a CLI falsa). |

`info()` de cada backend devolve `{ id, name, available, path?, detail? }` (`detail` = versão de `--version`, ou o motivo da indisponibilidade) e é cacheado por 30 s.

## Flags usadas

**Claude Code** (`claude`):

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages
  --tools ""                                  sem ferramentas embutidas (Bash, Read, Edit...)
  --strict-mcp-config --mcp-config <arq>      só o MCP do daemon (arquivo temporário)
  --allowedTools mcp__mockup-studio           libera todas as tools desse servidor
  --permission-mode dontAsk                   o que não está liberado é negado, sem prompt
  --setting-sources ""                        ignora settings/hooks do usuário
  --disable-slash-commands
  --append-system-prompt-file <arq>           prompt de sistema por arquivo (sem quoting)
  [--model <m>] [--resume <session_id>]
```

O prompt vai por stdin como uma mensagem `stream-json`:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "text", "text": "..." },
      { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } }
    ]
  }
}
```

**Codex** (`codex`):

```
codex exec [-i <imagem.png>] --json --skip-git-repo-check --ephemeral -s read-only -C <pasta>
  [-m <modelo>]
  -c mcp_servers.mockup_studio.url=<url do MCP com ?turn=>
  -c mcp_servers.mockup_studio.default_tools_approval_mode=approve
```

O prompt (system prompt + contexto + pedido) vai por stdin. `approve` evita o bloqueio das tools que gravam em `codex exec`. Os valores dos `-c` seguem sem aspas: se não forem TOML válido o Codex usa a string crua, e assim nada precisa de aspas em `.cmd`. O Codex não tem como desligar o shell embutido; ele roda em `-s read-only` e o system prompt manda usar só o MCP. A conversa não é retomada por `resume` (turnos `--ephemeral`): o histórico recente vai resumido no prompt.

Em ambos: `windowsHide: true`, pasta de trabalho própria (fora do projeto do usuário), arquivos temporários apagados no fim do turno.

## Contexto enviado

**System prompt**: papel (assistente de design dentro do Mockup Studio), usar só as ferramentas MCP do `mockup-studio`, `docId` explícito, trabalhar sobre a seleção, conferir com `get_screenshot`, não chamar `undo`, chamar `finish_working` e responder curto em português. O texto extra de `RunTurnOptions.instructions` é acrescentado.

**Prompt do usuário**:

- documento: nome e `docId`;
- seleção: ids e `getTreeSummary(nó, 3)` de cada nó (limitado a ~6000 caracteres); sem seleção, o resumo dos frames;
- se há motor de render, um screenshot do primeiro nó selecionado (ou do primeiro frame), escala 1 e `maxWidth` 1024. Falha no screenshot não impede o turno;
- sem sessão para continuar, um resumo curto das últimas mensagens da conversa;
- o pedido do usuário.

## Streaming

O Claude emite `stream_event` com `text_delta` (com `--include-partial-messages`): viram eventos `text` na hora, sem repetir o texto quando a mensagem `assistant` completa chega. Mensagens separadas por ferramentas são unidas com uma linha em branco. O Codex entrega cada `agent_message` completo. `tool_use`/`tool_result` (Claude) e `mcp_tool_call` (Codex) viram `tool` e `tool-result` (nome sem o prefixo `mcp__mockup-studio__`, resumo = primeira linha do resultado, até 200 caracteres). Linhas não-JSON da CLI são ignoradas e registradas no log.

## Grupo de undo

- Cada turno tem um grupo `assistant:<turnId>` (ou o `group` passado em `RunTurnOptions`, quando outro serviço aninha um turno).
- O token do turno (`crypto.randomBytes(16)`) vai na URL do MCP. O MCP passa o grupo a `store.applyOps(..., { group })`, e `History` funde as aplicações seguidas do mesmo grupo numa entrada: **um Ctrl+Z desfaz o turno inteiro**.
- `undo`/`redo` pelo MCP são recusados dentro de um turno. O agente corrige com as ferramentas de edição.
- Ao fim do turno (sucesso, erro ou cancelamento) o grupo é fechado, o token vira inválido (sessões antigas recusam escritas; novas sessões levam 403) e o daemon chama `finishWorking` para apagar o selo "agente trabalhando".
- `opsCount` da mensagem final é o nº de ops da entrada de undo do grupo.

Limite: a fusão só vale para aplicações **consecutivas**. Se o usuário editar o documento (ou desfazer) no meio do turno, a próxima op do agente abre uma entrada nova: o turno passa a ter mais de um passo de undo, e `opsCount` conta só a entrada mais recente. Evite editar o documento enquanto o agente trabalha.

## Cancelamento e timeout

- `assistant:cancel` aborta o turno: a árvore de processos da CLI é encerrada (Windows: `taskkill /pid <pid> /T /F`; outros: grupo de processos). O turno termina com `status: "cancelled"`; o que o agente já tinha feito continua no documento e é desfeito por um único undo.
- Cada turno tem um timeout (padrão 10 minutos) que também mata a árvore e termina com `status: "error"`.
- Só há um turno por documento por vez: um segundo `send` com turno rodando é recusado.
- `close()` do serviço (encerramento do daemon) cancela tudo e aguarda.

## Histórico

Decisão: **arquivo lateral por documento**, ao lado do `.mockup.json`: `<pasta>/<base>.assistant.json`. Não entra no documento (o arquivo do projeto não suja nem cresce com conversa) e acompanha a pasta do projeto. Documento sem caminho (ainda não salvo): histórico só em memória; ao salvar, passa a ser gravado.

```json
{
  "version": 1,
  "messages": [
    {
      "id": "msg_...",
      "role": "user",
      "text": "...",
      "turnId": "turn_...",
      "at": "ISO",
      "selection": ["..."]
    },
    {
      "id": "msg_...",
      "role": "assistant",
      "text": "...",
      "status": "done",
      "tools": [],
      "opsCount": 3,
      "backend": "claude"
    }
  ],
  "sessions": { "claude": "<session_id do Claude Code>" }
}
```

- Até 200 mensagens (as mais antigas saem). Gravado (atomicamente) no fim de cada turno e no `clear`; carregado sob demanda em `history(docId)`.
- `sessions` guarda o `session_id` por backend: o turno seguinte usa `--resume` (a pasta de trabalho é estável por documento, porque a CLI guarda a sessão por pasta). Se o resume falhar antes de qualquer ferramenta, o turno é refeito sem ele.
- Turnos `ephemeral` (`RunTurnOptions.ephemeral`) não entram no histórico.

## Configuração

`assistant:config` lê ou grava `{ backend: "auto" | "claude" | "codex" | ..., model?: string }`, persistida em `<dataDir>/assistant.json` (sem pasta de dados, só em memória). O `model` vai para `--model` (Claude) ou `-m` (Codex) e só vale quando o turno não pede um backend específico. `backend` desconhecido ou `model` inválido são recusados.

## Protocolo WebSocket

Cliente para servidor (todas com `reqId`; o ack traz o resultado):

| Mensagem            | Campos                                      | Resultado                                                 |
| ------------------- | ------------------------------------------- | --------------------------------------------------------- |
| `assistant:send`    | `docId`, `prompt`, `selection?`, `backend?` | `{ turnId }` (o resto chega por eventos)                  |
| `assistant:cancel`  | `docId`                                     | `{ cancelled }`                                           |
| `assistant:history` | `docId`                                     | `{ messages, running: turnId \| null, backends, config }` |
| `assistant:clear`   | `docId`                                     | `{}` (recusado com turno em andamento)                    |
| `assistant:config`  | `config?: { backend?, model? }`             | `{ config, backends }`                                    |

Servidor para cliente: `{ type: "assistant:event", docId, event }`, com `event.kind`:

- `turn-start` `{ turnId, user, backend }`
- `text` `{ turnId, text }` (delta)
- `tool` `{ turnId, tool: { id, name, input } }`
- `tool-result` `{ turnId, toolId, ok, summary? }`
- `turn-end` `{ turnId, message }` (`message`: `status` `done | cancelled | error`, `text`, `error?`, `tools`, `opsCount`, `backend`)
- `cleared`

Durante um turno, `assistant:history` devolve também o pedido e uma mensagem do assistente com `status: "running"` (texto e ferramentas até então), para o editor se reconectar no meio do turno.

## Plugar outro backend (`AgentBackend`)

Um backend implementa (em `agent/backend.ts`):

```ts
interface AgentBackend {
  readonly id: string;
  readonly name: string;
  info(): Promise<AssistantBackendInfo>;
  run(
    input: AgentRunInput,
    emit: (ev: AgentRunEvent) => void,
    signal: AbortSignal,
  ): Promise<AgentRunResult>;
}
```

`AgentRunInput` traz `prompt`, `system`, `images`, `mcp` (`{ name, url }` com o token do turno), `resumeSession`, `model` e `cwd`. O backend emite `text`, `tool`, `tool-result` e `session`, devolve `{ text, sessionId? }`, rejeita com erro legível em falha e com `AbortError` quando o `signal` abortar. Uma API direta (sem CLI) precisa apenas conectar-se ao MCP em `input.mcp.url` (cliente MCP HTTP) e repassar as ferramentas ao modelo. Registre passando `agentBackends` a `startDaemon` (ou à opção `backends` do `AssistantService`).

## Segurança

- O MCP só escuta em `127.0.0.1` (ou o host do daemon) e o `/mcp` valida o `Host`.
- O token de turno é aleatório (128 bits), vale só enquanto o turno roda e só amarra a sessão a um documento e a um grupo de undo; depois dele, escritas são recusadas.
- O Claude roda sem ferramentas embutidas (`--tools ""`), com `dontAsk`: só as tools do MCP do `mockup-studio` estão liberadas. O Codex não permite desligar o shell: roda em sandbox `read-only`.
- Nenhuma chave é lida ou guardada pelo Mockup Studio: a autenticação é da própria CLI. O prompt e o screenshot vão para o provedor da CLI escolhida.
- O subprocesso roda numa pasta temporária, nunca na pasta do projeto; argumentos não carregam conteúdo do usuário.

## Solução de problemas

| Sintoma                                   | O que fazer                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| "Nenhum agente de IA disponível"          | Instale o Claude Code ou o Codex e abra a CLI uma vez no terminal para fazer login. Confira com `mockup doctor`. |
| CLI instalada mas não encontrada          | Defina `MOCKUP_CLAUDE_BIN` / `MOCKUP_CODEX_BIN` com o caminho do executável e reinicie o daemon.                 |
| Erro de login/autenticação no turno       | A mensagem inclui o fim do stderr da CLI. Rode `claude` (ou `codex login`) no terminal e entre de novo.          |
| "Já existe um turno em andamento"         | Cancele o turno atual ou espere o fim.                                                                           |
| Turno demora e termina com "tempo limite" | O limite é de 10 minutos por turno; divida o pedido.                                                             |
| O agente diz que o turno terminou         | O usuário cancelou ou o tempo acabou; as alterações já feitas continuam e um Ctrl+Z as desfaz.                   |
| Sem screenshot no contexto                | O daemon está sem motor de render (daemon Node puro); abra o app desktop. O turno funciona sem a imagem.         |
| Conversa "esqueceu" o contexto            | O `--resume` falhou e o turno recomeçou sem ele (resumo curto no prompt); limpe a conversa se preferir.          |

## Remix

Gera variações de um nó **lado a lado**: clona o frame raiz que contém o nó (com todos os descendentes) e aplica uma transformação ao nó equivalente em cada clone. Os clones ficam numa linha à direita, começando depois do frame mais à direita da página que se sobrepõe verticalmente ao de origem, com 80 px entre eles, e se chamam `<frame> — <variação>`. Todas as ops de um remix entram numa única entrada de undo (um Ctrl+Z desfaz tudo) e os frames criados ficam selecionados.

Tipos locais (determinísticos, sem IA; planejador puro `planRemix` em `packages/core/src/remix/`):

| `kind`        | Padrão / máx. | O que faz                                                                                                                                                                                                                    |
| ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `color-scale` | 10 / 10       | Escala de 10 tons (stops 50–900, OKLCH) a partir da primeira cor sólida do nó entre `background-color`, `background`, `color`, `border-color` e `fill` (`var()` resolvido); a base cai no stop de luminosidade mais próxima. |
| `font-pairs`  | 4 / 10        | Pares curados (Editorial, Neutro, Display, Técnico, Humanista, Clássico) filtrados pelas fontes locais (instaladas ou do documento); títulos (h1–h6, ≥ 24 px ou peso ≥ 600) recebem a de título, o resto a de corpo.         |
| `spacing`     | 4 / 5         | Escala 4/8 sobre `padding`, `margin` e `gap` em px: compacto, grade 4, grade 8, confortável, espaçoso.                                                                                                                       |
| `layout`      | 3 / 3         | Rearranjos do contêiner flex mais próximo: direção invertida, ordem invertida e centralizado com quebra.                                                                                                                     |

O tipo `ai` (exige `prompt`, padrão 3 variações) roda um turno do assistente com instruções para duplicar o frame, posicionar as cópias, renomeá-las e conferir com `get_screenshot`; devolve os frames raiz que surgiram na página. As ops do agente ficam no grupo de undo do turno (ou no grupo de quem chamou: um `remix` com `ai` feito de dentro de outro turno entra no mesmo undo).

Disponível no menu de contexto do editor (mensagem WS `remix`) e na ferramenta MCP `remix({ nodeId, kind, count?, prompt?, docId? })`.

## Interface no editor

O painel lateral "Assistente" (feito à parte, em `packages/editor`) mostra a conversa do documento ativo: pedido do usuário, texto do agente em streaming, as ferramentas chamadas (com ok/erro) e o resultado de cada turno, com botões para cancelar o turno em andamento e limpar a conversa, e a escolha do backend/modelo. Ele só fala o protocolo WebSocket acima.
