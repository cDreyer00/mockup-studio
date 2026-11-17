/**
 * Registro de prontidão das animações: cada componente de mídia registra uma pendência quando
 * começa a carregar ou quando o tempo manual muda, e a libera depois de desenhar aquele tempo.
 * A página de render espera `fxSettled()` antes de medir/capturar.
 */

const pending = new Set<Promise<void>>();

/** Informações do render atual (preenchidas pela página de render antes de montar o frame). */
export const fxRenderInfo = {
  /** O chamador informou `time` explicitamente (vídeo com poster só usa o poster se NÃO informou). */
  explicitTime: false,
};

/**
 * Registra uma pendência e devolve a função que a libera. Libera sozinha após `maxMs` para que
 * um componente que falhou em avisar nunca trave a página.
 */
export function fxBegin(maxMs = 15000): () => void {
  let release!: () => void;
  const p = new Promise<void>((r) => {
    release = r;
  });
  pending.add(p);
  const timer = setTimeout(release, maxMs);
  void p.then(() => {
    clearTimeout(timer);
    pending.delete(p);
  });
  return release;
}

/** Número de pendências (testes e diagnóstico). */
export function fxPendingCount(): number {
  return pending.size;
}

/** Espera todas as pendências (inclusive as registradas enquanto espera), com limite. */
export async function fxSettled(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let quietTicks = 0;
  for (;;) {
    if (pending.size === 0) {
      // Um turno extra: efeitos recém-montados podem registrar pendências logo em seguida.
      if (quietTicks++ >= 1) return true;
      await new Promise((r) => setTimeout(r, 0));
      continue;
    }
    quietTicks = 0;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...pending]),
      new Promise((r) => {
        timer = setTimeout(r, left);
      }),
    ]);
    clearTimeout(timer);
  }
}

/** Espera um dos eventos (ou o limite de tempo) num elemento. */
export function fxOnce(
  el: EventTarget,
  events: string[],
  ms: number,
): Promise<'event' | 'timeout'> {
  return new Promise((resolve) => {
    const off = (): void => {
      clearTimeout(timer);
      for (const e of events) el.removeEventListener(e, onEvent);
    };
    const onEvent = (): void => {
      off();
      resolve('event');
    };
    const timer = setTimeout(() => {
      off();
      resolve('timeout');
    }, ms);
    for (const e of events) el.addEventListener(e, onEvent, { once: true });
  });
}
