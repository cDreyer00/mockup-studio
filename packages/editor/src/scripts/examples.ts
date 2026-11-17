/** Exemplos prontos do painel de scripts. */
export interface ScriptExample {
  id: string;
  label: string;
  code: string;
}

export const SCRIPT_EXAMPLES: ScriptExample[] = [
  {
    id: 'rename-texts',
    label: 'Renomear textos em sequência',
    code: `// Renomeia todos os nós de texto como "Item 1", "Item 2"...
const textos = doc.select('text');
textos.forEach((n, i) => {
  n.name = 'Item ' + (i + 1);
});
return textos.length + ' nós renomeados';
`,
  },
  {
    id: 'button-color',
    label: 'Trocar a cor dos botões',
    code: `// Troca o fundo de todos os <button> (na seleção, se houver; senão no documento).
const raiz = doc.selection()[0];
const botoes = raiz ? raiz.select('button') : doc.select('button');
botoes.forEach((b) => b.setStyle({ 'background-color': '#2563eb', color: '#ffffff' }));
return botoes.length + ' botões atualizados';
`,
  },
  {
    id: 'list-frames',
    label: 'Listar frames e quantidade de nós',
    code: `// Resultado: nome de cada frame e quantos filhos diretos ele tem.
return doc.frames().map((f) => ({ frame: f.name, filhos: f.children.length }));
`,
  },
  {
    id: 'screenshot',
    label: 'Capturar a seleção',
    code: `// Gera uma imagem de cada nó selecionado (aparece na saída).
const sel = doc.selection();
for (const n of sel) await doc.screenshot(n);
return sel.length + ' captura(s)';
`,
  },
];
