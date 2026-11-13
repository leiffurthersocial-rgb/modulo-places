// Material & Asset Lab entry (lab.html). Plain DOM, no framework.
import '../ui/styles.css';
import './lab.css';
import { LAB_MOODS } from './moods';
import {
  FETCH_COMMAND,
  type LabHdri,
  type LabManifest,
  type LabMaterial,
  loadManifest,
} from './manifest';
import {
  candidateKey,
  DEFAULT_TUNING,
  labUniforms,
  MaterialLibrary,
  type Tuning,
} from './materials';
import { exportPicks, loadPicks, type Picks, savePicks } from './picks';
import { type CameraPreset, type Layout, Viewport } from './viewport';
import { formatBytes, vramTable } from './vram';

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (typeof v === 'boolean') {
      if (v) el.setAttribute(k, '');
    } else if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of kids) if (c) el.append(c);
  return el;
}

const VERTICAL = /wall|plank|timber|roof|thatch|plaster|brick|cabin|door|house|log|bark|facade/i;

async function boot(root: HTMLElement): Promise<void> {
  let manifest: LabManifest;
  try {
    manifest = await loadManifest();
  } catch (e) {
    root.append(
      h(
        'div',
        { class: 'banner', style: 'position:fixed' },
        h(
          'div',
          {},
          h('h2', {}, 'Material & Asset Lab'),
          h(
            'p',
            {},
            'The lab manifest is not available yet. ',
            e instanceof Error ? e.message : '',
          ),
          h('p', {}, 'Generate it with:'),
          h('code', {}, FETCH_COMMAND),
          h('p', { class: 'note' }, 'Then reload this page.'),
        ),
      ),
    );
    return;
  }
  startLab(root, manifest);
}

function startLab(root: HTMLElement, manifest: LabManifest): void {
  const sceneIds = Object.keys(manifest.scenes).filter((id) => id in LAB_MOODS);
  if (sceneIds.length === 0) {
    root.textContent = 'Manifest has no known scenes.';
    return;
  }
  const picks: Picks = loadPicks();
  const tuning: Tuning = { ...DEFAULT_TUNING };
  const st = {
    scene: sceneIds[0]!,
    tab: 'materials' as 'materials' | 'hdris',
    key: '',
    hdriMood: '',
    moodIdx: 0,
    a: null as LabMaterial | null,
    b: null as LabMaterial | null,
    focus: null as LabMaterial | null,
    compare: false,
    camera: 'orbit' as CameraPreset,
  };

  // ---- DOM skeleton ----
  const side = h('aside', { class: 'side' });
  const stage = h('main', { class: 'stage' });
  const panel = h('aside', { class: 'panel' });
  const footer = h(
    'footer',
    {},
    h(
      'span',
      {},
      'Textures: ',
      h('a', { href: 'https://polyhaven.com', target: '_blank', rel: 'noopener' }, 'Poly Haven'),
      ' (CC0) and ',
      h('a', { href: 'https://ambientcg.com', target: '_blank', rel: 'noopener' }, 'ambientCG'),
      ' (CC0)',
    ),
    h('span', {}, `Manifest: ${manifest.generatedAt || 'unknown date'}`),
  );
  root.append(side, stage, panel, footer);
  const vpEl = h('div', { class: 'viewport' });
  const toolbar = h('div', { class: 'toolbar' });
  const tagA = h('div', { class: 'tag', style: 'left:10px' });
  const tagB = h('div', { class: 'tag', style: 'right:10px' });
  const divider = h('div', { class: 'divider' });
  const status = h('div', { class: 'status' });
  const debug = h('div', { class: 'debug' });
  stage.append(vpEl, toolbar, tagA, tagB, divider, status, debug);

  const moodsOf = () => LAB_MOODS[st.scene] ?? [];
  // Open on midday where available: clear light makes textures easiest to judge.
  const defaultMoodIdx = () =>
    Math.max(
      0,
      moodsOf().findIndex((m) => m.id === 'midday'),
    );
  st.moodIdx = defaultMoodIdx();
  const sceneData = () => manifest.scenes[st.scene]!;
  const vp = new Viewport(vpEl, moodsOf()[st.moodIdx]!);
  const lib = new MaterialLibrary(vp.renderer);
  lib.onChange = () => {
    updateStatus();
    renderPanel();
  };

  // ---- material selection ----
  function candidates(): LabMaterial[] {
    return sceneData().materials[st.key]?.candidates ?? [];
  }
  function applyMaterials(): void {
    const keep = new Set<string>();
    if (st.a) keep.add(candidateKey(st.a));
    if (st.compare && st.b) keep.add(candidateKey(st.b));
    lib.prune(keep);
    vp.matA = st.a ? lib.get(st.a).material : null;
    vp.matB = st.compare && st.b ? lib.get(st.b).material : null;
    vp.compare = st.compare && !!st.b && !!st.a;
    const use = sceneData().materials[st.key]?.use ?? st.key;
    const layout: Layout = VERTICAL.test(`${use} ${st.key}`) ? 'vertical' : 'ground';
    vp.setLayout(layout);
    updateOverlay();
    updateStatus();
  }
  function selectKey(key: string): void {
    st.key = key;
    const list = candidates();
    const pick = picks.materials[`${st.scene}/${key}`];
    st.a =
      list.find((c) => pick && c.source === pick.source && c.id === pick.id) ?? list[0] ?? null;
    st.b = list.find((c) => c !== st.a) ?? null;
    st.focus = st.a;
    st.tab = 'materials';
    applyMaterials();
    renderSide();
    renderPanel();
  }
  function selectScene(id: string): void {
    st.scene = id;
    st.moodIdx = defaultMoodIdx();
    vp.setMood(moodsOf()[st.moodIdx]!, 0);
    const keys = Object.keys(sceneData().materials);
    st.hdriMood = Object.keys(sceneData().hdris)[0] ?? '';
    selectKey(keys[0] ?? '');
    renderToolbar();
  }

  // ---- toolbar ----
  const narrow = window.matchMedia('(max-width: 1250px)');
  function setSide(open: boolean): void {
    document.body.classList.toggle('side-open', narrow.matches && open);
    document.body.classList.toggle('side-closed', !narrow.matches && !open);
  }
  let sideOpen = !narrow.matches;
  narrow.addEventListener('change', () => {
    sideOpen = !narrow.matches;
    setSide(sideOpen);
  });
  setSide(sideOpen);

  function renderToolbar(): void {
    toolbar.replaceChildren(
      h(
        'button',
        {
          'aria-label': 'Toggle sidebar',
          onclick: () => {
            sideOpen = !sideOpen;
            setSide(sideOpen);
          },
        },
        '☰',
      ),
      h(
        'div',
        { class: 'group', role: 'group', 'aria-label': 'Lighting mood' },
        ...moodsOf().map((m, i) =>
          h(
            'button',
            {
              class: i === st.moodIdx ? 'on' : '',
              onclick: () => {
                st.moodIdx = i;
                vp.setMood(m, 3);
                renderToolbar();
              },
            },
            m.name,
          ),
        ),
      ),
      h(
        'div',
        { class: 'group', role: 'group', 'aria-label': 'Camera' },
        ...(['orbit', 'walk', 'close'] as CameraPreset[]).map((p) =>
          h(
            'button',
            {
              class: p === st.camera ? 'on' : '',
              onclick: () => {
                st.camera = p;
                vp.setCameraPreset(p);
                renderToolbar();
              },
            },
            p === 'walk' ? 'Walk height' : p === 'close' ? 'Close-up' : 'Orbit',
          ),
        ),
      ),
      h('div', { class: 'spacer' }),
      h(
        'div',
        { class: 'group' },
        h(
          'button',
          {
            class: st.compare ? 'on' : '',
            onclick: () => {
              st.compare = !st.compare;
              applyMaterials();
              renderToolbar();
              renderPanel();
            },
          },
          st.compare ? 'Compare A | B' : 'Single',
        ),
      ),
    );
  }

  function updateOverlay(): void {
    const on = vp.compare;
    divider.style.display = on ? '' : 'none';
    tagB.style.display = on ? '' : 'none';
    divider.style.left = `${vp.split * 100}%`;
    tagA.textContent = st.a ? `${on ? 'A: ' : ''}${st.a.name}` : '';
    tagB.textContent = st.b ? `B: ${st.b.name}` : '';
  }
  divider.addEventListener('pointerdown', (e) => {
    divider.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = stage.getBoundingClientRect();
      vp.split = Math.min(0.97, Math.max(0.03, (ev.clientX - r.left) / r.width));
      divider.style.left = `${vp.split * 100}%`;
    };
    const up = () => {
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
  });

  function updateStatus(): void {
    const parts: string[] = [];
    let err = false;
    for (const c of [st.a, vp.compare ? st.b : null]) {
      if (!c) continue;
      const cm = lib.get(c);
      if (cm.state === 'loading') parts.push(`loading ${c.name}...`);
      if (cm.state === 'error') {
        err = true;
        parts.push(`${c.name}: ${cm.error}`);
      }
    }
    status.textContent = parts.join(' | ');
    status.style.display = parts.length ? '' : 'none';
    status.className = err ? 'status err' : 'status';
  }

  vp.onFrame = (mem, fps) => {
    const s = lib.stats;
    debug.textContent = `GPU geometries ${mem.geometries} | textures ${mem.textures} | lab materials ${s.materials} | lab textures ${s.textures} | ${fps.toFixed(0)} fps`;
  };

  // ---- sidebar ----
  function renderSide(): void {
    const sel = h(
      'select',
      {
        'aria-label': 'Scene',
        onchange: (e) => selectScene((e.target as HTMLSelectElement).value),
      },
      ...sceneIds.map((id) => {
        const o = h('option', { value: id }, id);
        if (id === st.scene) o.selected = true;
        return o;
      }),
    );
    const mats = sceneData().materials;
    const hd = sceneData().hdris;
    side.replaceChildren(
      h('div', { class: 'title' }, 'Material & Asset Lab'),
      h('h2', {}, 'Scene'),
      sel,
      h(
        'div',
        { class: 'tabs' },
        h(
          'button',
          {
            class: st.tab === 'materials' ? 'on' : '',
            onclick: () => {
              st.tab = 'materials';
              renderSide();
              renderPanel();
            },
          },
          'Materials',
        ),
        h(
          'button',
          {
            class: st.tab === 'hdris' ? 'on' : '',
            onclick: () => {
              st.tab = 'hdris';
              if (!st.hdriMood) st.hdriMood = Object.keys(hd)[0] ?? '';
              renderSide();
              renderPanel();
            },
          },
          'HDRIs',
        ),
      ),
      st.tab === 'materials'
        ? h(
            'div',
            { class: 'list' },
            ...Object.entries(mats).map(([key, g]) => {
              const picked = picks.materials[`${st.scene}/${key}`];
              return h(
                'button',
                { class: key === st.key ? 'on' : '', onclick: () => selectKey(key) },
                h('span', {}, g.label),
                h('span', { class: 'meta' }, `${picked ? '★ ' : ''}${g.candidates.length}`),
              );
            }),
          )
        : h(
            'div',
            { class: 'list' },
            ...Object.entries(hd).map(([mood, g]) => {
              const picked = picks.hdris[`${st.scene}/${mood}`];
              return h(
                'button',
                {
                  class: mood === st.hdriMood ? 'on' : '',
                  onclick: () => {
                    st.hdriMood = mood;
                    renderSide();
                    renderPanel();
                  },
                },
                h('span', {}, g.label),
                h('span', { class: 'meta' }, `${picked ? '★ ' : ''}${g.candidates.length}`),
              );
            }),
          ),
      h(
        'p',
        { class: 'note' },
        'HDRIs are preview thumbnails only; the lab does not load them as environment maps.',
      ),
    );
  }

  // ---- right panel ----
  const candBox = h('div');
  const ctlBox = h('div');
  const infoBox = h('div');
  const exportBox = h('div');
  panel.append(candBox, ctlBox, infoBox, exportBox);

  function togglePick(c: LabMaterial): void {
    const k = `${st.scene}/${st.key}`;
    const cur = picks.materials[k];
    if (cur && cur.source === c.source && cur.id === c.id) delete picks.materials[k];
    else picks.materials[k] = { source: c.source, id: c.id };
    savePicks(picks);
    renderSide();
    renderPanel();
  }
  function toggleHdriPick(c: LabHdri): void {
    const k = `${st.scene}/${st.hdriMood}`;
    if (picks.hdris[k]?.id === c.id) delete picks.hdris[k];
    else picks.hdris[k] = { source: 'polyhaven', id: c.id };
    savePicks(picks);
    renderSide();
    renderPanel();
  }

  function renderPanel(): void {
    if (st.tab === 'hdris') {
      const g = sceneData().hdris[st.hdriMood];
      candBox.replaceChildren(
        h('h2', {}, `HDRI candidates: ${g?.label ?? ''}`),
        h(
          'div',
          { class: 'hdri' },
          ...(g?.candidates ?? []).map((c) => {
            const picked = picks.hdris[`${st.scene}/${st.hdriMood}`]?.id === c.id;
            const img = h('img', {
              src: c.preview,
              alt: c.name,
              loading: 'lazy',
              crossorigin: 'anonymous',
            });
            return h(
              'div',
              { class: `cand${picked ? ' a' : ''}` },
              img,
              h(
                'div',
                {},
                h('div', { class: 'name' }, c.name),
                h('div', { class: 'src' }, 'Poly Haven, CC0'),
                h(
                  'div',
                  { class: 'btns' },
                  h('a', { href: c.url, target: '_blank', rel: 'noopener' }, 'Page'),
                  h(
                    'button',
                    {
                      class: `star${picked ? ' on' : ''}`,
                      'aria-pressed': String(picked),
                      onclick: () => toggleHdriPick(c),
                    },
                    picked ? '★ Picked' : '☆ Pick',
                  ),
                ),
              ),
            );
          }),
        ),
        h(
          'p',
          { class: 'note', style: g?.candidates.length ? 'display:none' : '' },
          'No HDRI candidates for this mood.',
        ),
      );
      ctlBox.style.display = 'none';
      infoBox.replaceChildren();
    } else {
      ctlBox.style.display = '';
      const pk = picks.materials[`${st.scene}/${st.key}`];
      candBox.replaceChildren(
        h('h2', {}, `Candidates: ${sceneData().materials[st.key]?.label ?? ''}`),
        ...candidates().map((c) => {
          const picked = !!pk && pk.source === c.source && pk.id === c.id;
          const cls = c === st.a ? ' a' : st.compare && c === st.b ? ' b' : '';
          return h(
            'div',
            { class: `cand${cls}` },
            h('img', { src: c.maps.color, alt: '', loading: 'lazy', crossorigin: 'anonymous' }),
            h(
              'div',
              {},
              h('div', { class: 'name' }, c.name),
              h('div', { class: 'src' }, `${c.source} ${c.id}`),
              h(
                'div',
                { class: 'btns' },
                h(
                  'button',
                  {
                    class: c === st.a ? 'on' : '',
                    onclick: () => {
                      st.a = c;
                      st.focus = c;
                      applyMaterials();
                      renderPanel();
                    },
                  },
                  'A',
                ),
                h(
                  'button',
                  {
                    class: c === st.b && st.compare ? 'on' : '',
                    onclick: () => {
                      st.b = c;
                      st.focus = c;
                      st.compare = true;
                      applyMaterials();
                      renderToolbar();
                      renderPanel();
                    },
                  },
                  'B',
                ),
                h(
                  'button',
                  {
                    onclick: () => {
                      st.focus = c;
                      renderPanel();
                    },
                  },
                  'Info',
                ),
                h(
                  'button',
                  {
                    class: `star${picked ? ' on' : ''}`,
                    'aria-pressed': String(picked),
                    'aria-label': 'Pick candidate',
                    onclick: () => togglePick(c),
                  },
                  picked ? '★' : '☆',
                ),
              ),
            ),
          );
        }),
        h(
          'p',
          { class: 'note', style: candidates().length ? 'display:none' : '' },
          'No candidates in the manifest for this material.',
        ),
      );
      renderInfo();
    }
  }

  function renderInfo(): void {
    const c = st.focus;
    if (!c) {
      infoBox.replaceChildren();
      return;
    }
    const cdn = c.maps.color.startsWith('http');
    infoBox.replaceChildren(
      h('h2', {}, 'Info'),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'name' }, c.name),
        h(
          'dl',
          {},
          h('dt', {}, 'Source'),
          h('dd', {}, `${c.source} (${c.id})`),
          h('dt', {}, 'Authors'),
          h('dd', {}, c.authors.join(', ') || 'unknown'),
          h('dt', {}, 'License'),
          h(
            'dd',
            {},
            'CC0 ',
            h('a', { href: c.url, target: '_blank', rel: 'noopener' }, 'source page'),
          ),
          h('dt', {}, 'Preview'),
          h('dd', {}, cdn ? 'CDN' : formatBytes(c.previewBytes)),
          c.why ? h('dt', {}, 'Why') : null,
          c.why ? h('dd', {}, c.why) : null,
        ),
        h(
          'div',
          { class: 'note', style: 'margin-top:8px' },
          `Estimated GPU memory, KTX2 (ASTC/ETC2 8 bpp, mips), ${c.maps.arm ? 3 : 2} maps:`,
        ),
        h(
          'table',
          {},
          h(
            'thead',
            {},
            h('tr', {}, h('th', {}, 'Tier'), h('th', {}, 'Per map'), h('th', {}, 'Total')),
          ),
          h(
            'tbody',
            {},
            ...vramTable(true, c.maps.arm ? 3 : 2).map((r) =>
              h(
                'tr',
                {},
                h('td', {}, r.size >= 1024 ? `${r.size / 1024}k` : String(r.size)),
                h('td', {}, formatBytes(r.perMap)),
                h('td', {}, formatBytes(r.total)),
              ),
            ),
          ),
        ),
      ),
    );
  }

  // ---- controls (built once so sliders keep focus) ----
  function slider(
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    onInput: (v: number) => void,
    fmt: (v: number) => string = (v) => v.toFixed(2),
  ): HTMLElement {
    const out = h('output', {}, fmt(value));
    const input = h('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
    });
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = fmt(v);
      onInput(v);
    });
    return h('label', { class: 'ctl' }, h('span', {}, label), out, input);
  }
  const pushTuning = () => lib.setTuning(tuning);
  const controls = h(
    'div',
    {},
    h('h2', {}, 'Material'),
    slider('Tiling (repeats / m)', 0.25, 8, 0.05, tuning.tiling, (v) => {
      tuning.tiling = v;
      pushTuning();
    }),
    slider('Normal strength', 0, 3, 0.05, tuning.normalStrength, (v) => {
      tuning.normalStrength = v;
      pushTuning();
    }),
    slider('Roughness multiplier', 0.2, 2, 0.05, tuning.roughnessMul, (v) => {
      tuning.roughnessMul = v;
      pushTuning();
    }),
    h('h2', {}, 'Weather'),
    slider('Wetness', 0, 1, 0.01, 0, (v) => {
      labUniforms.uLabWet.value = v;
    }),
    slider('Frost', 0, 1, 0.01, 0, (v) => {
      labUniforms.uLabFrost.value = v;
    }),
    slider('Moss', 0, 1, 0.01, 0, (v) => {
      labUniforms.uLabMoss.value = v;
    }),
  );
  ctlBox.append(controls);

  // ---- export ----
  const ta = h('textarea', { readonly: true, 'aria-label': 'Exported picks JSON' });
  const exportOut = h(
    'div',
    { style: 'display:none' },
    ta,
    h(
      'div',
      { class: 'row', style: 'margin-top:6px' },
      h(
        'button',
        {
          onclick: () => {
            ta.select();
            navigator.clipboard?.writeText(ta.value).catch(() => undefined);
          },
        },
        'Copy',
      ),
      h(
        'button',
        {
          onclick: () => {
            const url = URL.createObjectURL(new Blob([ta.value], { type: 'application/json' }));
            const a = h('a', { href: url, download: 'lab-picks.json' });
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          },
        },
        'Download',
      ),
    ),
  );
  exportBox.append(
    h('h2', {}, 'Picks'),
    h(
      'button',
      {
        onclick: () => {
          ta.value = exportPicks(picks);
          exportOut.style.display = '';
          ta.select();
          navigator.clipboard?.writeText(ta.value).catch(() => undefined);
        },
      },
      'Export picks',
    ),
    exportOut,
  );

  // ---- go ----
  st.hdriMood = Object.keys(sceneData().hdris)[0] ?? '';
  renderToolbar();
  renderSide();
  selectKey(Object.keys(sceneData().materials)[0] ?? '');
}

const rootEl = document.getElementById('lab');
if (rootEl) void boot(rootEl);
