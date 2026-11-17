/** Popup: escolhe destino e porta, mostra se o app está no ar e inicia o seletor na aba ativa. */
const DEFAULT_PORT = 4747;

const startBtn = document.getElementById('start') as HTMLButtonElement;
const portInput = document.getElementById('port') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLElement;
const modeInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="mode"]'));

function currentMode(): 'send' | 'copy' {
  return modeInputs.find((i) => i.checked)?.value === 'copy' ? 'copy' : 'send';
}

function currentPort(): number {
  const n = Number(portInput.value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

portInput.value = localStorage.getItem('port') ?? String(DEFAULT_PORT);
const savedMode = localStorage.getItem('mode');
for (const i of modeInputs) i.checked = i.value === (savedMode === 'copy' ? 'copy' : 'send');

let pingSeq = 0;
async function ping(): Promise<void> {
  const seq = ++pingSeq;
  const port = currentPort();
  statusEl.dataset.state = 'checking';
  statusEl.textContent = 'Verificando o app…';
  let up = false;
  try {
    // Resposta opaca (no-cors) já indica que há algo ouvindo na porta.
    await fetch(`http://127.0.0.1:${port}/api/health`, {
      mode: 'no-cors',
      signal: AbortSignal.timeout(1500),
    });
    up = true;
  } catch {
    up = false;
  }
  if (seq !== pingSeq) return;
  statusEl.dataset.state = up ? 'up' : 'down';
  statusEl.textContent = up
    ? 'Mockup Studio no ar'
    : 'Mockup Studio não encontrado (a captura será copiada)';
}

portInput.addEventListener('change', () => {
  localStorage.setItem('port', String(currentPort()));
  void ping();
});
for (const i of modeInputs) {
  i.addEventListener('change', () => localStorage.setItem('mode', currentMode()));
}

startBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  localStorage.setItem('port', String(currentPort()));
  localStorage.setItem('mode', currentMode());
  const res = await chrome.runtime.sendMessage({
    type: 'popup-start',
    tabId: tab.id,
    mode: currentMode(),
    port: currentPort(),
  });
  if (res?.ok === false) {
    statusEl.dataset.state = 'down';
    statusEl.textContent = 'Não foi possível iniciar nesta página.';
    return;
  }
  window.close();
});

void ping();
