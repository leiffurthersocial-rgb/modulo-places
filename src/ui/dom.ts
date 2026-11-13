// Minimal DOM helpers (no framework).
export type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  attrs: Record<string, string> = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const c of children) if (c) n.append(c);
  return n;
}

export function clear(n: Node): void {
  while (n.firstChild) n.removeChild(n.firstChild);
}

export function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', `mp-btn ${cls}`.trim(), { type: 'button' }, [label]);
  b.addEventListener('click', onClick);
  return b;
}
