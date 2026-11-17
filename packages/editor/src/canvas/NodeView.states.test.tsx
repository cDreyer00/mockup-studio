// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { breakpointsOf, createNodeFromTag } from '@mockup/core';
import type { Node, PreviewState } from '@mockup/core';
import { BASE_STATE_CTX, StateCtxContext, quantizeWidth, toCoreContext } from './stateContext';
import type { StateCtx } from './stateContext';
import { NodeView, buildNodeStyle } from './NodeView';

afterEach(cleanup);

function button(): Node {
  const n = createNodeFromTag('button', {
    name: 'Botão',
    styles: { background: 'blue', padding: '8px' },
  });
  n.states = {
    hover: { background: 'red' },
    md: { padding: '32px' },
    dark: { color: 'white' },
  };
  return n;
}

function frameWith(width: string, child: Node, attrs: Record<string, string> = {}): Node {
  return createNodeFromTag('div', {
    isRoot: true,
    name: 'Frame',
    styles: { width, height: '200px' },
    attrs,
    children: [child],
  });
}

const el = (node: Node): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`)!;

function renderTree(
  frame: Node,
  preview: PreviewState | null = null,
  extra: Partial<StateCtx> = {},
) {
  return render(
    <StateCtxContext.Provider value={{ ...BASE_STATE_CTX, preview, ...extra }}>
      <NodeView node={frame} root />
    </StateCtxContext.Provider>,
  );
}

describe('buildNodeStyle com estados', () => {
  it('sem contexto usa só node.style', () => {
    const style = buildNodeStyle(button(), undefined, false);
    expect(style).toMatchObject({ background: 'blue', padding: '8px' });
  });

  it('aplica os estados ativos do contexto', () => {
    const n = button();
    const hover = buildNodeStyle(
      n,
      undefined,
      false,
      toCoreContext({ ...BASE_STATE_CTX, preview: 'hover' }),
    );
    expect(hover).toMatchObject({ background: 'red', padding: '8px' });
    const md = buildNodeStyle(n, undefined, false, { frameWidth: 768 });
    expect(md).toMatchObject({ padding: '32px' });
    expect(buildNodeStyle(n, undefined, false, { frameWidth: 767 })).toMatchObject({
      padding: '8px',
    });
  });

  it('left/top do filho absoluto vêm do estilo resolvido', () => {
    const n = createNodeFromTag('div', {
      styles: { position: 'static' },
      position: { x: 5, y: 6 },
    });
    n.states = { hover: { position: 'absolute' } };
    expect(buildNodeStyle(n, undefined, false, { pseudo: 'hover' })).toMatchObject({
      left: '5px',
      top: '6px',
    });
  });

  it('quantiza a largura pelos breakpoints do Tailwind', () => {
    expect(quantizeWidth(undefined)).toBe(0);
    expect(quantizeWidth(639)).toBe(0);
    expect(quantizeWidth(768)).toBe(768);
    expect(quantizeWidth(1100)).toBe(1024);
    const custom = breakpointsOf({ tokens: { '--breakpoint-md': '900px' } });
    expect(quantizeWidth(800, custom)).toBe(640);
    expect(quantizeWidth(900, custom)).toBe(900);
  });
});

describe('NodeView com estados', () => {
  it('prévia hover aplica o estado em todos os nós', () => {
    const b = button();
    const { rerender } = renderTree(frameWith('400px', b));
    expect(el(b).style.background).toBe('blue');
    rerender(
      <StateCtxContext.Provider value={{ ...BASE_STATE_CTX, preview: 'hover' }}>
        <NodeView node={frameWith('400px', b)} root />
      </StateCtxContext.Provider>,
    );
    expect(el(b).style.background).toBe('red');
  });

  it('breakpoint vale pela largura do frame raiz', () => {
    const b = button();
    renderTree(frameWith('800px', b));
    expect(el(b).style.padding).toBe('32px');
    cleanup();
    const c = button();
    renderTree(frameWith('375px', c));
    expect(el(c).style.padding).toBe('8px');
  });

  it('dark vale dentro de data-theme="dark" e na prévia dark', () => {
    const b = button();
    renderTree(frameWith('400px', b, { 'data-theme': 'dark' }));
    expect(el(b).style.color).toBe('white');
    cleanup();
    const c = button();
    renderTree(frameWith('400px', c));
    expect(el(c).style.color).toBe('');
    cleanup();
    const d = button();
    renderTree(frameWith('400px', d), 'dark');
    expect(el(d).style.color).toBe('white');
  });

  it('data-theme num ancestral intermediário vale só para a subárvore', () => {
    const inner = button();
    const wrapper = createNodeFromTag('div', {
      attrs: { 'data-theme': 'dark' },
      children: [inner],
    });
    const outside = button();
    renderTree(
      createNodeFromTag('div', {
        isRoot: true,
        styles: { width: '300px' },
        children: [wrapper, outside],
      }),
    );
    expect(el(inner).style.color).toBe('white');
    expect(el(outside).style.color).toBe('');
  });

  it('breakpoint customizado do documento vale no lugar do padrão', () => {
    const breakpoints = breakpointsOf({ tokens: { '--breakpoint-md': '900px' } });
    const b = button();
    renderTree(frameWith('800px', b), null, { breakpoints });
    expect(el(b).style.padding).toBe('8px');
    cleanup();
    const c = button();
    renderTree(frameWith('900px', c), null, { breakpoints });
    expect(el(c).style.padding).toBe('32px');
  });

  it('prévia dark põe data-theme="dark" no frame raiz só se o tema existe', () => {
    const b = button();
    const frame = frameWith('400px', b);
    renderTree(frame, 'dark', { darkTheme: true });
    expect(el(frame).getAttribute('data-theme')).toBe('dark');
    expect(el(b).getAttribute('data-theme')).toBeNull();
    cleanup();
    const f2 = frameWith('400px', button());
    renderTree(f2, 'dark');
    expect(el(f2).getAttribute('data-theme')).toBeNull();
    cleanup();
    const f3 = frameWith('400px', button());
    renderTree(f3, 'hover', { darkTheme: true });
    expect(el(f3).getAttribute('data-theme')).toBeNull();
  });

  it('dark continua ligado num tema claro aninhado, como no CSS exportado', () => {
    const inner = button();
    const light = createNodeFromTag('div', { attrs: { 'data-theme': 'light' }, children: [inner] });
    renderTree(
      createNodeFromTag('div', {
        isRoot: true,
        styles: { width: '300px' },
        attrs: { 'data-theme': 'dark' },
        children: [light],
      }),
    );
    expect(el(inner).style.color).toBe('white');
  });
});
