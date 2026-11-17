/**
 * Catálogo de efeitos: shaders GLSL próprios (fragment shaders WebGL 1) e partículas.
 * Fonte única para o editor, a página de render, o MCP (`list_effects`) e os exportadores.
 * Sem DOM e sem Node.
 */
import type { EffectSpec, MediaParamValue } from '../types.js';
import {
  GLASS_FRAGMENT,
  GRAIN_FRAGMENT,
  HALFTONE_FRAGMENT,
  LIQUID_METAL_FRAGMENT,
  MESH_GRADIENT_FRAGMENT,
  WAVES_FRAGMENT,
} from './shaders.js';

export type EffectCategory = 'shader' | 'particles';
export type EffectParamType = 'number' | 'color' | 'boolean' | 'select';

export interface EffectParamDef {
  /** Nome do parâmetro (camelCase), ex.: `speed`, `color1`. No shader vira o uniform `u_<name>`. */
  name: string;
  label: string;
  type: EffectParamType;
  default: MediaParamValue;
  min?: number;
  max?: number;
  step?: number;
  /** Opções de `select`. */
  options?: string[];
  description: string;
}

export interface EffectPreset {
  /** Id do preset (kebab-case), ex.: `aurora`. */
  name: string;
  label: string;
  params: Record<string, MediaParamValue>;
}

export interface EffectDef {
  kind: string;
  label: string;
  category: EffectCategory;
  description: string;
  params: EffectParamDef[];
  presets: EffectPreset[];
  /** Fragment shader GLSL ES 1.0 (só `shader`). */
  fragment?: string;
}

// ---------- construtores de definições ----------

const num = (
  name: string,
  label: string,
  def: number,
  min: number,
  max: number,
  step: number,
  description: string,
): EffectParamDef => ({ name, label, type: 'number', default: def, min, max, step, description });

const color = (name: string, label: string, def: string, description: string): EffectParamDef => ({
  name,
  label,
  type: 'color',
  default: def,
  description,
});

const bool = (name: string, label: string, def: boolean, description: string): EffectParamDef => ({
  name,
  label,
  type: 'boolean',
  default: def,
  description,
});

const select = (
  name: string,
  label: string,
  def: string,
  options: string[],
  description: string,
): EffectParamDef => ({ name, label, type: 'select', default: def, options, description });

const speed = (def = 1): EffectParamDef =>
  num('speed', 'Velocidade', def, 0, 4, 0.05, 'Velocidade da animação (0 = estático).');

const preset = (
  name: string,
  label: string,
  params: Record<string, MediaParamValue>,
): EffectPreset => ({ name, label, params });

export const EFFECTS: readonly EffectDef[] = [
  {
    kind: 'mesh-gradient',
    label: 'Degradê de malha',
    category: 'shader',
    description:
      'Degradê de quatro cores com manchas suaves que se deslocam, deformadas por ruído, com torção e grão opcionais.',
    params: [
      color('color1', 'Cor 1', '#0d1b4c', 'Primeira cor (canto superior esquerdo).'),
      color('color2', 'Cor 2', '#00c2a8', 'Segunda cor (canto superior direito).'),
      color('color3', 'Cor 3', '#7b2ff7', 'Terceira cor (canto inferior direito).'),
      color('color4', 'Cor 4', '#12d8fa', 'Quarta cor (canto inferior esquerdo).'),
      speed(1),
      num('distortion', 'Distorção', 0.5, 0, 1, 0.01, 'Intensidade da deformação por ruído.'),
      num('swirl', 'Torção', 0.3, 0, 1, 0.01, 'Quanto o centro gira sobre si mesmo.'),
      num('grain', 'Grão', 0.15, 0, 1, 0.01, 'Quantidade de grão sobre o degradê.'),
    ],
    presets: [
      preset('aurora', 'Aurora', {
        color1: '#0d1b4c',
        color2: '#00c2a8',
        color3: '#7b2ff7',
        color4: '#12d8fa',
      }),
      preset('sunset', 'Pôr do sol', {
        color1: '#ff5e62',
        color2: '#ff9966',
        color3: '#f9d423',
        color4: '#8e2de2',
        swirl: 0.45,
      }),
      preset('ocean', 'Oceano', {
        color1: '#03045e',
        color2: '#0077b6',
        color3: '#00b4d8',
        color4: '#90e0ef',
        distortion: 0.65,
        grain: 0.08,
      }),
      preset('candy', 'Algodão-doce', {
        color1: '#ff9ec7',
        color2: '#ffd6a5',
        color3: '#a0c4ff',
        color4: '#caffbf',
        distortion: 0.4,
        grain: 0.05,
      }),
    ],
    fragment: MESH_GRADIENT_FRAGMENT,
  },
  {
    kind: 'grain',
    label: 'Grão de filme',
    category: 'shader',
    description: 'Ruído de filme animado sobre um degradê de duas cores.',
    params: [
      color('color1', 'Cor 1', '#1b1b1f', 'Cor de base (topo do degradê).'),
      color('color2', 'Cor 2', '#4a4a55', 'Cor de base (fundo do degradê).'),
      num('intensity', 'Intensidade', 0.55, 0, 1, 0.01, 'Força do grão.'),
      num('size', 'Tamanho', 1.5, 0.5, 6, 0.1, 'Tamanho do grão (px a 720 de altura).'),
      speed(1),
    ],
    presets: [
      preset('film', 'Filme', {
        color1: '#1b1b1f',
        color2: '#4a4a55',
        intensity: 0.55,
        size: 1.5,
      }),
      preset('warm', 'Quente', {
        color1: '#ff7a59',
        color2: '#ffcf70',
        intensity: 0.45,
        size: 1.2,
      }),
      preset('cool', 'Frio', {
        color1: '#1d4ed8',
        color2: '#22d3ee',
        intensity: 0.5,
        size: 1.8,
      }),
      preset('paper', 'Papel', {
        color1: '#f5f5f4',
        color2: '#d6d3d1',
        intensity: 0.35,
        size: 1,
        speed: 0.4,
      }),
    ],
    fragment: GRAIN_FRAGMENT,
  },
  {
    kind: 'halftone',
    label: 'Meio-tom',
    category: 'shader',
    description:
      'Pontos, quadrados ou linhas de meio-tom que variam de tamanho sobre um gradiente em movimento.',
    params: [
      color('color', 'Cor', '#111111', 'Cor dos pontos.'),
      color('background', 'Fundo', '#f4efe6', 'Cor de fundo.'),
      num(
        'dotSize',
        'Tamanho da célula',
        22,
        6,
        60,
        1,
        'Lado da célula da grade (px a 720 de altura).',
      ),
      num('angle', 'Ângulo', 45, 0, 90, 1, 'Rotação da grade, em graus.'),
      speed(1),
      select(
        'shape',
        'Forma',
        'circle',
        ['circle', 'square', 'line'],
        'Forma do elemento: círculo, quadrado ou linha.',
      ),
    ],
    presets: [
      preset('ink', 'Tinta', { color: '#111111', background: '#f4efe6', dotSize: 22, angle: 45 }),
      preset('pop', 'Pop', { color: '#ff3d81', background: '#ffe14d', dotSize: 24, angle: 15 }),
      preset('blueprint', 'Planta', {
        color: '#9ad1ff',
        background: '#0a2540',
        dotSize: 18,
        angle: 0,
        shape: 'square',
      }),
      preset('scanlines', 'Linhas', {
        color: '#e5e5e5',
        background: '#0b0b0f',
        dotSize: 16,
        angle: 0,
        shape: 'line',
      }),
    ],
    fragment: HALFTONE_FRAGMENT,
  },
  {
    kind: 'waves',
    label: 'Ondas',
    category: 'shader',
    description: 'Linhas fluidas onduladas com degradê entre duas cores sobre um fundo sólido.',
    params: [
      color('color1', 'Cor 1', '#22d3ee', 'Cor das primeiras linhas.'),
      color('color2', 'Cor 2', '#e879f9', 'Cor das últimas linhas.'),
      color('background', 'Fundo', '#07070f', 'Cor de fundo.'),
      num('frequency', 'Frequência', 4, 0.5, 12, 0.1, 'Quantas ondulações cabem na largura.'),
      num('amplitude', 'Amplitude', 1, 0, 2, 0.05, 'Altura das ondas.'),
      num('lines', 'Linhas', 14, 1, 40, 1, 'Quantidade de linhas.'),
      speed(1),
    ],
    presets: [
      preset('neon', 'Neon', {
        color1: '#22d3ee',
        color2: '#e879f9',
        background: '#07070f',
      }),
      preset('silk', 'Seda', {
        color1: '#fda4af',
        color2: '#fcd34d',
        background: '#1c1917',
        frequency: 2.6,
        amplitude: 1.3,
        lines: 22,
        speed: 0.6,
      }),
      preset('deep', 'Profundo', {
        color1: '#38bdf8',
        color2: '#818cf8',
        background: '#0b132b',
        frequency: 5.5,
        lines: 9,
      }),
      preset('mint', 'Menta', {
        color1: '#34d399',
        color2: '#a7f3d0',
        background: '#052e2b',
        frequency: 3.2,
        amplitude: 0.8,
        lines: 30,
      }),
    ],
    fragment: WAVES_FRAGMENT,
  },
  {
    kind: 'liquid-metal',
    label: 'Metal líquido',
    category: 'shader',
    description: 'Superfície de metal líquido cromado com reflexos procedurais em movimento.',
    params: [
      color('tint', 'Tom do metal', '#c9ced8', 'Cor do metal nas áreas claras.'),
      color('highlight', 'Brilho', '#ffffff', 'Cor dos reflexos especulares.'),
      num('contrast', 'Contraste', 1.4, 0.5, 3, 0.05, 'Contraste entre faixas claras e escuras.'),
      speed(1),
      num('scale', 'Escala', 1, 0.3, 3, 0.05, 'Tamanho das ondulações (maior = mais detalhe).'),
    ],
    presets: [
      preset('chrome', 'Cromo', { tint: '#c9ced8', highlight: '#ffffff', contrast: 1.4 }),
      preset('gold', 'Ouro', { tint: '#e0b050', highlight: '#fff4cf', contrast: 1.6 }),
      preset('rose', 'Ouro rosé', { tint: '#e8a8b8', highlight: '#fff0f4', contrast: 1.3 }),
      preset('obsidian', 'Obsidiana', {
        tint: '#7a869e',
        highlight: '#bcd0ff',
        contrast: 2.2,
        scale: 1.3,
      }),
    ],
    fragment: LIQUID_METAL_FRAGMENT,
  },
  {
    kind: 'glass',
    label: 'Vidro canelado',
    category: 'shader',
    description: 'Vidro canelado refrativo sobre um degradê em movimento, com desfoque e reflexos.',
    params: [
      color('color1', 'Cor 1', '#6d5dfc', 'Primeira cor do fundo visto pelo vidro.'),
      color('color2', 'Cor 2', '#ff8ab3', 'Segunda cor do fundo visto pelo vidro.'),
      num('ribs', 'Caneluras', 24, 4, 80, 1, 'Quantidade de caneluras na largura.'),
      num('refraction', 'Refração', 1, 0, 2, 0.05, 'Quanto cada canelura desloca a imagem.'),
      num('blur', 'Desfoque', 0.25, 0, 1, 0.01, 'Desfoque do fundo atrás do vidro.'),
      speed(1),
    ],
    presets: [
      preset('prism', 'Prisma', { color1: '#6d5dfc', color2: '#ff8ab3' }),
      preset('dusk', 'Crepúsculo', {
        color1: '#1e1b4b',
        color2: '#f97316',
        ribs: 32,
        refraction: 1.2,
      }),
      preset('lime', 'Lima', {
        color1: '#0f766e',
        color2: '#bef264',
        ribs: 16,
        blur: 0.4,
      }),
      preset('frost', 'Geada', {
        color1: '#e0f2fe',
        color2: '#a5b4fc',
        ribs: 40,
        refraction: 0.7,
        blur: 0.15,
      }),
    ],
    fragment: GLASS_FRAGMENT,
  },
  {
    kind: 'particles',
    label: 'Partículas',
    category: 'particles',
    description:
      'Partículas em canvas 2D, determinísticas no tempo: a posição é função de (seed, índice, t), sem estado.',
    params: [
      num('count', 'Quantidade', 120, 10, 2000, 10, 'Número de partículas.'),
      color('color', 'Cor', '#ffffff', 'Cor das partículas.'),
      color(
        'background',
        'Fundo',
        '#0b1020',
        'Cor de fundo; `transparent` deixa o canvas transparente.',
      ),
      num('size', 'Tamanho', 2.5, 0.5, 12, 0.1, 'Raio médio das partículas, em px.'),
      speed(1),
      select(
        'direction',
        'Direção',
        'up',
        ['up', 'down', 'left', 'right', 'random'],
        'Direção do movimento.',
      ),
      num('twinkle', 'Cintilação', 0.5, 0, 1, 0.01, 'Quanto o brilho de cada partícula pisca.'),
      bool('links', 'Ligações', false, 'Desenha linhas entre partículas vizinhas.'),
      num(
        'seed',
        'Semente',
        1,
        0,
        9999,
        1,
        'Semente da distribuição (mesma semente, mesmo desenho).',
      ),
    ],
    presets: [
      preset('stars', 'Estrelas', {
        color: '#ffffff',
        background: '#05060f',
        count: 300,
        size: 1.6,
        speed: 0.3,
        direction: 'random',
        twinkle: 0.9,
      }),
      preset('snow', 'Neve', {
        color: '#ffffff',
        background: '#0f2a4a',
        count: 160,
        size: 3.5,
        speed: 0.8,
        direction: 'down',
        twinkle: 0.2,
      }),
      preset('embers', 'Brasas', {
        color: '#ffb347',
        background: '#1a0a05',
        count: 140,
        size: 3,
        speed: 1.2,
        direction: 'up',
        twinkle: 0.6,
      }),
      preset('network', 'Rede', {
        color: '#7dd3fc',
        background: '#0b1220',
        count: 90,
        size: 2,
        speed: 0.4,
        direction: 'random',
        twinkle: 0,
        links: true,
      }),
      preset('fireflies', 'Vaga-lumes', {
        color: '#fde68a',
        background: 'transparent',
        count: 50,
        size: 3,
        speed: 0.5,
        direction: 'random',
        twinkle: 1,
      }),
    ],
  },
];

export function getEffect(kind: string): EffectDef | undefined {
  return EFFECTS.find((e) => e.kind === kind);
}

export function effectKinds(): string[] {
  return EFFECTS.map((e) => e.kind);
}

// ---------- validação ----------

const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUM = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)%?';
const FUNC_RE = new RegExp(
  `^rgba?\\(\\s*${NUM}\\s*[,\\s]\\s*${NUM}\\s*[,\\s]\\s*${NUM}\\s*(?:[,/]\\s*${NUM}\\s*)?\\)$`,
  'i',
);

/** Cor CSS aceita pelos efeitos: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` ou `transparent`. */
function isCssColor(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return s.toLowerCase() === 'transparent' || HEX_RE.test(s) || FUNC_RE.test(s);
}

function isValid(def: EffectParamDef, v: unknown): boolean {
  switch (def.type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'color':
      return isCssColor(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'select':
      return typeof v === 'string' && (def.options ?? []).includes(v);
  }
}

function clampNumber(def: EffectParamDef, v: number): number {
  let n = v;
  if (def.min !== undefined) n = Math.max(def.min, n);
  if (def.max !== undefined) n = Math.min(def.max, n);
  return n;
}

/** Parâmetros completos: padrões do catálogo + valores válidos de `params` (números limitados a min/max). */
export function resolveEffectParams(
  kind: string,
  params: Record<string, MediaParamValue> = {},
): Record<string, MediaParamValue> {
  const def = getEffect(kind);
  if (!def) return { ...params };
  const out: Record<string, MediaParamValue> = {};
  for (const p of def.params) {
    const v = Object.prototype.hasOwnProperty.call(params, p.name) ? params[p.name] : undefined;
    if (v === undefined || !isValid(p, v)) out[p.name] = p.default;
    else out[p.name] = p.type === 'number' ? clampNumber(p, v as number) : (v as MediaParamValue);
  }
  return out;
}

const TYPE_NAMES: Record<EffectParamType, string> = {
  number: 'número',
  color: 'cor CSS (#rgb, #rrggbb, #rrggbbaa, rgb() ou rgba())',
  boolean: 'booleano',
  select: 'texto (uma das opções)',
};

/** Problemas de `params` para `kind` (efeito inexistente, parâmetro desconhecido, tipo, faixa). Vazio = ok. */
export function effectParamsProblems(
  kind: string,
  params: Record<string, MediaParamValue> = {},
): string[] {
  const def = getEffect(kind);
  if (!def) return [`efeito inexistente: "${kind}" (efeitos válidos: ${effectKinds().join(', ')})`];
  const problems: string[] = [];
  const names = def.params.map((p) => p.name);
  for (const [name, v] of Object.entries(params)) {
    const p = def.params.find((x) => x.name === name);
    if (!p) {
      problems.push(
        `parâmetro desconhecido em "${kind}": "${name}" (parâmetros válidos: ${names.join(', ')})`,
      );
      continue;
    }
    if (p.type === 'select') {
      if (typeof v !== 'string') {
        problems.push(
          `parâmetro "${name}" de "${kind}" deve ser ${TYPE_NAMES.select}, recebeu ${typeof v}`,
        );
      } else if (!(p.options ?? []).includes(v)) {
        problems.push(
          `opção inválida em "${name}" de "${kind}": "${v}" (opções: ${(p.options ?? []).join(', ')})`,
        );
      }
    } else if (!isValid(p, v)) {
      problems.push(
        `parâmetro "${name}" de "${kind}" deve ser ${TYPE_NAMES[p.type]}, recebeu ${
          typeof v === 'string' ? `"${v}"` : String(v)
        }`,
      );
    } else if (p.type === 'number') {
      const n = v as number;
      if ((p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max)) {
        problems.push(
          `parâmetro "${name}" de "${kind}" fora da faixa: ${n} (permitido: ${p.min} a ${p.max})`,
        );
      }
    }
  }
  return problems;
}

/** Parâmetros de um preset (já resolvidos com os padrões) ou undefined. */
export function presetParams(
  kind: string,
  preset: string,
): Record<string, MediaParamValue> | undefined {
  const p = getEffect(kind)?.presets.find((x) => x.name === preset);
  return p ? resolveEffectParams(kind, p.params) : undefined;
}

// ---------- fallback CSS ----------

/** CSS estático que aproxima o efeito (fundo de fallback para export sem JS, SVG e poster). */
export function effectFallbackCss(spec: EffectSpec): Record<string, string> {
  const def = getEffect(spec.kind);
  if (!def) return { background: '#1e1b4b' };
  // Cores já validadas por resolveEffectParams: só contêm caracteres de cor CSS.
  const p = resolveEffectParams(spec.kind, spec.params);
  const s = (name: string): string => String(p[name]).trim();
  const n = (name: string): number => Number(p[name]);

  switch (spec.kind) {
    case 'mesh-gradient':
      return {
        background: [
          `radial-gradient(circle at 15% 20%, ${s('color1')}, transparent 60%)`,
          `radial-gradient(circle at 85% 15%, ${s('color2')}, transparent 60%)`,
          `radial-gradient(circle at 80% 85%, ${s('color3')}, transparent 60%)`,
          s('color4'),
        ].join(', '),
      };
    case 'grain':
      return { background: `linear-gradient(160deg, ${s('color1')}, ${s('color2')})` };
    case 'halftone': {
      const cell = Math.round(n('dotSize'));
      const dot =
        p.shape === 'line'
          ? `repeating-linear-gradient(0deg, ${s('color')} 0 ${Math.max(1, Math.round(cell / 4))}px, transparent ${Math.max(1, Math.round(cell / 4))}px ${cell}px)`
          : `radial-gradient(circle at center, ${s('color')} 0 ${p.shape === 'square' ? 38 : 30}%, transparent ${p.shape === 'square' ? 40 : 32}%) 0 0 / ${cell}px ${cell}px`;
      return { background: `${dot}, ${s('background')}` };
    }
    case 'waves': {
      const step = Math.max(6, Math.round(240 / Math.max(1, n('lines'))));
      return {
        background: [
          `repeating-linear-gradient(172deg, transparent 0 ${step}px, ${s('color1')} ${step}px ${step + 2}px)`,
          `linear-gradient(160deg, ${s('color1')}, transparent 45%)`,
          `linear-gradient(20deg, ${s('color2')}, transparent 50%)`,
          s('background'),
        ].join(', '),
      };
    }
    case 'liquid-metal':
      return {
        background: `linear-gradient(115deg, #0b0b10 0%, ${s('tint')} 25%, ${s('highlight')} 40%, #15151c 55%, ${s('tint')} 75%, ${s('highlight')} 90%)`,
      };
    case 'glass':
      return {
        background: `repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.18) 0, rgba(255, 255, 255, 0) 14px, rgba(0, 0, 0, 0.1) 18px), linear-gradient(135deg, ${s('color1')}, ${s('color2')})`,
      };
    case 'particles': {
      const c = s('color');
      const dots = [
        `radial-gradient(circle at 20% 30%, ${c} 0 1.5px, transparent 2.5px)`,
        `radial-gradient(circle at 70% 20%, ${c} 0 2px, transparent 3px)`,
        `radial-gradient(circle at 45% 70%, ${c} 0 1.5px, transparent 2.5px)`,
        `radial-gradient(circle at 85% 80%, ${c} 0 2px, transparent 3px)`,
      ];
      const bg = s('background');
      return {
        background: [...dots, bg.toLowerCase() === 'transparent' ? 'transparent' : bg].join(', '),
      };
    }
    default:
      return { background: '#1e1b4b' };
  }
}
