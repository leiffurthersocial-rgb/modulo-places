// Minimal, mostly diegetic HUD + menus (plain DOM). The sim's numbers stay hidden except in the
// debug view; relationships are shown as a notebook page with sticky notes.
import { CAST, CHALLENGES, LESSONS, NOTES, PLAYABLE_LESSON_TYPES, TEACHERS } from '../sim/data';
import { gradeAverage, letter, type StudentRecord } from '../sim/record';
import type { CaughtCard } from '../sim/world';
import { PRESET_ORDER, type PresetId, type Settings } from '../quality';

const CSS = `
.ui{position:fixed;inset:0;pointer-events:none;z-index:20;font:14px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;color:#f4f2ec}
.ui *{box-sizing:border-box}
.hud-tl{position:absolute;left:calc(env(safe-area-inset-left,0px) + 14px);top:calc(env(safe-area-inset-top,0px) + 12px);background:rgba(16,18,22,.55);padding:8px 12px;border-radius:10px;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.hud-clock{font:700 22px/1 ui-monospace,Menlo,monospace;letter-spacing:.5px}
.hud-phase{opacity:.85;font-size:12px;margin-top:3px}
.cross{position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:rgba(255,255,255,.75);box-shadow:0 0 2px #000}
.prompt{position:absolute;left:50%;top:calc(50% + 26px);transform:translateX(-50%);text-align:center;text-shadow:0 1px 3px #000;font-weight:600}
.prompt small{display:block;font-weight:400;opacity:.8}
.prompt .risk{color:#ffb86b}
.subs{position:absolute;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 90px);transform:translateX(-50%);width:min(760px,92vw);display:flex;flex-direction:column;align-items:center;gap:4px}
.sub{background:rgba(10,12,15,.7);padding:4px 10px;border-radius:6px;transition:opacity .4s}
.sub b{color:#ffd88a}.sub.cue{font-style:italic;color:#bfe3ff}
.toasts{position:absolute;left:50%;top:calc(env(safe-area-inset-top,0px) + 14px);transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;align-items:center}
.toast{background:rgba(20,24,30,.82);padding:6px 12px;border-radius:8px;transition:opacity .5s}
.chips{position:absolute;left:calc(env(safe-area-inset-left,0px) + 14px);bottom:calc(env(safe-area-inset-bottom,0px) + 14px);display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.chip{background:rgba(16,18,22,.6);padding:4px 10px;border-radius:14px;font-size:12px}
.bar{width:160px;height:6px;background:rgba(255,255,255,.2);border-radius:3px;overflow:hidden;margin-top:3px}.bar>i{display:block;height:100%;background:#7ad7a1}
.card{position:absolute;right:calc(env(safe-area-inset-right,0px) + 14px);top:calc(env(safe-area-inset-top,0px) + 70px);width:min(340px,86vw);background:#fbf7ea;color:#2a2620;border-radius:6px;padding:12px 14px;box-shadow:0 8px 30px rgba(0,0,0,.45);transform:rotate(-1.2deg);pointer-events:auto}
.card h3{margin:0 0 6px;font-size:15px;color:#a3261a}.card li{margin:2px 0}.card ul{padding-left:18px;margin:0}
.card .x{float:right;cursor:pointer;opacity:.6}
.banner{position:absolute;left:50%;top:22%;transform:translateX(-50%);font:700 26px system-ui;text-shadow:0 2px 8px #000;transition:opacity .6s;text-align:center}
.charge{position:absolute;left:50%;top:calc(50% + 60px);transform:translateX(-50%);width:120px;height:6px;background:rgba(255,255,255,.25);border-radius:3px}.charge>i{display:block;height:100%;background:#ffd23f;border-radius:3px}
.menu{font:14px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;color:#f4f2ec;position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(10,11,14,.72);pointer-events:auto;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);z-index:30;padding:16px}
.panel{background:#1d2026;border:1px solid #333a44;border-radius:14px;padding:20px 22px;width:min(640px,100%);max-height:92vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.panel h1{margin:0 0 4px;font-size:28px}.panel h2{margin:16px 0 8px;font-size:17px}.panel p{margin:6px 0;opacity:.9}
.panel .sub2{opacity:.7;font-size:13px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:8px 0}
.row label{min-width:120px;opacity:.85}
.btn{pointer-events:auto;background:#e9c46a;color:#1d1a12;border:0;border-radius:10px;padding:10px 16px;font:600 15px system-ui;cursor:pointer;min-height:44px}
.btn.alt{background:#2c323b;color:#eee;border:1px solid #444c57}
.btn.small{padding:6px 10px;min-height:34px;font-size:13px}
select,input[type=text],input[type=number]{background:#111419;color:#eee;border:1px solid #3a414c;border-radius:8px;padding:8px;min-height:38px;font:14px system-ui}
.grid2{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.pick{background:#262b33;border:1px solid #3a414c;border-radius:10px;padding:8px;cursor:pointer;text-align:left;color:#eee;font:13px system-ui}
.pick.on{border-color:#e9c46a;background:#3a3423}
.nb{background:#f6f1e1;color:#2b2720;border-radius:6px;padding:18px;background-image:repeating-linear-gradient(#f6f1e1 0 27px,#cfdbe8 27px 28px)}
.sticky{display:inline-block;width:150px;min-height:110px;margin:8px;padding:8px;vertical-align:top;box-shadow:0 3px 8px rgba(0,0,0,.25);font:14px "Comic Sans MS","Marker Felt",cursive;transform:rotate(var(--r))}
.sticky b{display:block;font-size:16px}.face{width:34px;height:34px;border-radius:50%;border:2px solid #2b2720;float:right;margin-left:4px}
.kv{display:grid;grid-template-columns:1fr auto;gap:2px 16px}
table.rep{width:100%;border-collapse:collapse;font-size:13px}table.rep td{padding:3px 4px;border-bottom:1px solid #333a44}
.mem{font-size:12px;opacity:.85}
@media (max-width:700px){.panel{padding:14px}.hud-clock{font-size:18px}}
`;

export interface HudState {
  clock: string;
  phase: string;
  lesson: string;
  teacher: string;
  prompt: { label: string; risk?: string; more: number; key: string } | null;
  chips: string[];
  test: number | null;
  charge: number | null;
  showCross: boolean;
}

type Btn = [label: string, fn: () => void, alt?: boolean];

export class UI {
  readonly root: HTMLDivElement;
  private tl: HTMLDivElement;
  private prompt: HTMLDivElement;
  private subs: HTMLDivElement;
  private toasts: HTMLDivElement;
  private chips: HTMLDivElement;
  private cross: HTMLDivElement;
  private banner: HTMLDivElement;
  private chargeEl: HTMLDivElement;
  private card: HTMLDivElement | null = null;
  private menuEl: HTMLDivElement | null = null;
  subtitlesOn = true;

  constructor() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.className = 'ui';
    const mk = (cls: string) => {
      const d = document.createElement('div');
      d.className = cls;
      this.root.appendChild(d);
      return d;
    };
    this.tl = mk('hud-tl');
    this.cross = mk('cross');
    this.prompt = mk('prompt');
    this.subs = mk('subs');
    this.toasts = mk('toasts');
    this.chips = mk('chips');
    this.banner = mk('banner');
    this.chargeEl = mk('charge');
    this.chargeEl.innerHTML = '<i></i>';
    document.body.appendChild(this.root);
  }

  setScale(s: number): void {
    this.root.style.fontSize = `${14 * s}px`;
  }

  setHudVisible(v: boolean): void {
    for (const el of [this.tl, this.prompt, this.chips, this.cross, this.chargeEl])
      el.style.display = v ? '' : 'none';
  }

  update(h: HudState): void {
    this.tl.innerHTML = `<div class="hud-clock">${h.clock}</div><div class="hud-phase">${esc(h.lesson)} · ${esc(h.phase)}<br>${esc(h.teacher)}</div>`;
    this.cross.style.display = h.showCross ? '' : 'none';
    this.prompt.innerHTML = h.prompt
      ? `<span class="${h.prompt.risk ? 'risk' : ''}">[${h.prompt.key}] ${esc(h.prompt.label)}${h.prompt.risk === 'loud' ? ' 🔊' : h.prompt.risk ? ' ⚠' : ''}</span>${h.prompt.more > 1 ? `<small>[X / wheel] ${h.prompt.more - 1} more</small>` : ''}`
      : '';
    let chips = h.chips.map((c) => `<div class="chip">${c}</div>`).join('');
    if (h.test !== null)
      chips += `<div class="chip">Test answered<div class="bar"><i style="width:${Math.round(h.test * 100)}%"></i></div></div>`;
    this.chips.innerHTML = chips;
    this.chargeEl.style.display = h.charge !== null ? '' : 'none';
    if (h.charge !== null)
      (this.chargeEl.firstChild as HTMLElement).style.width = `${Math.round(h.charge * 100)}%`;
  }

  subtitle(speaker: string, text: string, cue = false): void {
    if (cue && !this.subtitlesOn) return;
    const d = document.createElement('div');
    d.className = `sub${cue ? ' cue' : ''}`;
    d.innerHTML = cue ? esc(text) : `<b>${esc(speaker)}:</b> ${esc(text)}`;
    this.subs.appendChild(d);
    while (this.subs.children.length > 4) this.subs.firstChild?.remove();
    setTimeout(() => (d.style.opacity = '0'), 3600);
    setTimeout(() => d.remove(), 4100);
  }

  toast(text: string, ms = 2600): void {
    const d = document.createElement('div');
    d.className = 'toast';
    d.textContent = text;
    this.toasts.appendChild(d);
    while (this.toasts.children.length > 3) this.toasts.firstChild?.remove();
    setTimeout(() => (d.style.opacity = '0'), ms);
    setTimeout(() => d.remove(), ms + 600);
  }

  showBanner(text: string): void {
    this.banner.textContent = text;
    this.banner.style.opacity = '1';
    setTimeout(() => (this.banner.style.opacity = '0'), 2200);
  }

  caught(card: CaughtCard): void {
    this.card?.remove();
    const d = document.createElement('div');
    d.className = 'card';
    d.innerHTML = `<span class="x">✕</span><h3>${esc(card.title)}</h3><ul>${card.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
    d.querySelector('.x')!.addEventListener('click', () => d.remove());
    this.root.appendChild(d);
    this.card = d;
    setTimeout(() => d.remove(), 9000);
  }

  // ------------------------------------------------------------------------------------------
  // Menus

  get menuOpen(): boolean {
    return this.menuEl !== null;
  }

  closeMenu(): void {
    this.menuEl?.remove();
    this.menuEl = null;
  }

  private open(html: string, buttons: Btn[] = []): HTMLDivElement {
    this.closeMenu();
    const m = document.createElement('div');
    m.className = 'menu';
    const p = document.createElement('div');
    p.className = 'panel';
    p.innerHTML = html;
    if (buttons.length) {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.marginTop = '16px';
      for (const [label, fn, alt] of buttons) {
        const b = document.createElement('button');
        b.className = `btn${alt ? ' alt' : ''}`;
        b.textContent = label;
        b.addEventListener('click', fn);
        row.appendChild(b);
      }
      p.appendChild(row);
    }
    m.appendChild(p);
    document.body.appendChild(m);
    this.menuEl = m;
    return p;
  }

  title(opts: {
    record: StudentRecord;
    hasSave: boolean;
    detention: boolean;
    seed: string;
    onStart: (cfg: {
      lesson: string;
      teacher: string;
      seed: string;
      cheatSheet: boolean;
      wishlist: string[];
    }) => void;
    onReset: () => void;
    onSettings: () => void;
    onCredits: () => void;
  }): void {
    const r = opts.record;
    const lessonOpts = ['random', ...PLAYABLE_LESSON_TYPES]
      .map(
        (t) =>
          `<option value="${t}">${t === 'random' ? 'Seeded random' : LESSONS.types[t]!.label}</option>`,
      )
      .join('');
    const teacherOpts = ['random', ...TEACHERS.map((t) => t.id)]
      .map(
        (t) =>
          `<option value="${t}">${t === 'random' ? 'Seeded random' : `${TEACHERS.find((x) => x.id === t)!.label} — ${TEACHERS.find((x) => x.id === t)!.name}`}</option>`,
      )
      .join('');
    const avg = gradeAverage(r);
    const active = new Set(r.wishlist.active);
    const wl = CHALLENGES.map(
      (c) =>
        `<button class="pick${active.has(c.id) ? ' on' : ''}" data-wl="${c.id}">${esc(c.text)}${r.wishlist.done.includes(c.id) ? ' ✓' : ''}</button>`,
    ).join('');
    const p = this.open(
      `
      <h1>Modulo: Classroom</h1>
      <p class="sub2">A sandbox about one classroom. Sneak a game, pass notes, pull harmless pranks, make friends. Nobody wins. You can always keep going.</p>
      <h2>Day ${r.day} · lesson ${r.lessonInDay + 1} of ${r.lessonsPerDay}</h2>
      <p class="sub2">Strikes: ${r.strikes} · Warnings: ${r.warnings} · Detentions: ${r.detentions} · Calls home: ${r.callsHome}${avg !== null ? ` · Grade avg ${avg.toFixed(0)}% (${letter(avg)})` : ''}</p>
      ${
        opts.detention
          ? '<p><b>⚠ Detention is pending: this lesson is detention.</b></p>'
          : `
      <div class="row"><label>Lesson</label><select id="t-lesson">${lessonOpts}</select></div>
      <div class="row"><label>Teacher</label><select id="t-teacher">${teacherOpts}</select></div>`
      }
      <div class="row"><label>Seed</label><input id="t-seed" type="text" value="${esc(opts.seed)}" size="12"></div>
      <div class="row"><label>Prep</label><label style="min-width:0"><input id="t-cheat" type="checkbox"> Hide a cheat sheet (only matters in tests)</label></div>
      <h2>Wishlist (optional, pick up to 3)</h2><div class="grid2">${wl}</div>
    `,
      [
        [
          'Enter class',
          () => {
            const q = (id: string) =>
              (p.querySelector(id) as HTMLInputElement | HTMLSelectElement | null)?.value ??
              'random';
            const picked = [...p.querySelectorAll('.pick.on')].map(
              (b) => (b as HTMLElement).dataset.wl!,
            );
            opts.onStart({
              lesson: q('#t-lesson'),
              teacher: q('#t-teacher'),
              seed: q('#t-seed'),
              cheatSheet: (p.querySelector('#t-cheat') as HTMLInputElement).checked,
              wishlist: picked,
            });
          },
        ],
        ['Settings', opts.onSettings, true],
        ['Credits', opts.onCredits, true],
        ...(opts.hasSave ? ([['Reset record', opts.onReset, true]] as Btn[]) : []),
      ],
    );
    for (const b of p.querySelectorAll('.pick')) {
      b.addEventListener('click', () => {
        const on = p.querySelectorAll('.pick.on').length;
        if (!b.classList.contains('on') && on >= 3) return;
        b.classList.toggle('on');
      });
    }
  }

  pause(h: {
    seedLink: string;
    onResume: () => void;
    onNotebook: () => void;
    onSettings: () => void;
    onControls: () => void;
    onCredits: () => void;
    onEnd: () => void;
    wishlist: string;
  }): void {
    const p = this.open(
      `<h1>Paused</h1>
      <p class="sub2">Share this lesson (same seed, same events):</p>
      <div class="row"><input type="text" readonly value="${esc(h.seedLink)}" style="flex:1;min-width:0" id="seedlink"><button class="btn small alt" id="copy">Copy</button></div>
      <h2>Wishlist</h2>${h.wishlist}`,
      [
        ['Resume', h.onResume],
        ['Notebook', h.onNotebook, true],
        ['Settings', h.onSettings, true],
        ['Controls', h.onControls, true],
        ['Credits', h.onCredits, true],
        ['Leave lesson', h.onEnd, true],
      ],
    );
    p.querySelector('#copy')?.addEventListener('click', () => {
      void navigator.clipboard?.writeText(h.seedLink).catch(() => undefined);
      (p.querySelector('#seedlink') as HTMLInputElement).select();
    });
  }

  notebook(r: StudentRecord, debug: boolean, onClose: () => void): void {
    const mood = (a: number) =>
      a >= 50
        ? 'friend ♥'
        : a >= 20
          ? 'likes you'
          : a >= -10
            ? 'neutral'
            : a >= -40
              ? 'annoyed'
              : 'can’t stand you';
    const colors = ['#fff59d', '#ffcc80', '#b2ebf2', '#c5e1a5', '#f8bbd0'];
    const notes = CAST.students
      .map((s, i) => {
        const a = r.affinity[s.id] ?? s.affinity;
        const mem = r.memories
          .filter((m) => m.who === s.id)
          .slice(-2)
          .map((m) => `<div class="mem">${m.delta > 0 ? '+' : '–'} ${esc(m.text)}</div>`)
          .join('');
        const friends = CAST.students
          .filter((o) => o.id !== s.id && (r.npcAffinity[`${s.id}>${o.id}`] ?? 0) > 25)
          .map((o) => o.name);
        return `<div class="sticky" style="background:${colors[i % colors.length]};--r:${((i * 37) % 7) - 3}deg"><span class="face" style="background:${s.color}"></span><b>${esc(s.name)}</b>${mood(a)}${debug ? ` <small>(${a.toFixed(0)})</small>` : ''}${friends.length ? `<div class="mem">→ ${friends.join(', ')}</div>` : ''}${mem}</div>`;
      })
      .join('');
    this.open(
      `<h1>Notebook</h1><div class="nb">${notes}</div><p class="sub2">Arrows: who they hang out with. Recent memories at the bottom of each note.</p>`,
      [['Close', onClose]],
    );
  }

  noteComposer(
    students: { id: string; name: string }[],
    onSend: (tpl: string, to: string) => void,
    onClose: () => void,
  ): void {
    const tpl = NOTES.map(
      (n, i) =>
        `<button class="pick${i === 0 ? ' on' : ''}" data-t="${n.id}">${esc(n.text)}</button>`,
    ).join('');
    const to = students
      .map(
        (s, i) =>
          `<button class="pick${i === 0 ? ' on' : ''}" data-s="${s.id}">${esc(s.name)}</button>`,
      )
      .join('');
    const p = this.open(
      `<h1>Pass a note</h1><p class="sub2">It travels hand to hand. Every link can pass it on, read it, refuse it… or hand it to the teacher.</p><h2>Write</h2><div class="grid2">${tpl}</div><h2>To</h2><div class="grid2">${to}</div>`,
      [
        [
          'Send',
          () => {
            const t = (p.querySelector('[data-t].on') as HTMLElement)?.dataset.t;
            const s = (p.querySelector('[data-s].on') as HTMLElement)?.dataset.s;
            if (t && s) onSend(t, s);
          },
        ],
        ['Cancel', onClose, true],
      ],
    );
    for (const attr of ['t', 's'])
      for (const b of p.querySelectorAll(`[data-${attr}]`))
        b.addEventListener('click', () => {
          p.querySelectorAll(`[data-${attr}]`).forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
        });
  }

  settings(s: Settings, onChange: (s: Settings) => void, onClose: () => void): void {
    const presets = [...PRESET_ORDER, 'custom']
      .map(
        (p) =>
          `<option value="${p}"${p === s.preset ? ' selected' : ''}>${p === 'battery' ? 'Battery Saver' : p[0]!.toUpperCase() + p.slice(1)}</option>`,
      )
      .join('');
    const p = this.open(
      `<h1>Settings</h1>
      <div class="row"><label>Quality</label><select id="s-preset">${presets}</select></div>
      <div class="row"><label>Field of view</label><input id="s-fov" type="range" min="55" max="100" value="${s.fov}"><span>${s.fov}°</span></div>
      <div class="row"><label>Look sensitivity</label><input id="s-sens" type="range" min="0.3" max="2.5" step="0.1" value="${s.sensitivity}"></div>
      <div class="row"><label>Volume</label><input id="s-vol" type="range" min="0" max="1" step="0.05" value="${s.volume}"></div>
      <div class="row"><label>UI scale</label><input id="s-ui" type="range" min="0.8" max="1.5" step="0.05" value="${s.uiScale}"></div>
      <div class="row"><label>Name</label><input id="s-name" type="text" value="${esc(s.playerName)}" maxlength="16"></div>
      <div class="row"><label>Touch controls</label><select id="s-touch">${['auto', 'on', 'off'].map((x) => `<option${x === s.touchControls ? ' selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="row"><label><input id="s-inv" type="checkbox"${s.invertY ? ' checked' : ''}> Invert look Y</label></div>
      <div class="row"><label><input id="s-subs" type="checkbox"${s.subtitles ? ' checked' : ''}> Subtitles for sound cues ("footsteps approaching")</label></div>
      <div class="row"><label><input id="s-rm" type="checkbox"${s.reducedMotion ? ' checked' : ''}> Reduced motion (no head bob/lean roll)</label></div>
      <div class="row"><label><input id="s-wd" type="checkbox"${s.watchdog ? ' checked' : ''}> Auto-lower quality if frames are slow</label></div>
      <h2>Keys</h2><p class="sub2">Click a key, then press the new key.</p><div class="grid2" id="s-keys">${Object.entries(
        s.bindings,
      )
        .map(
          ([a, c]) =>
            `<button class="pick" data-a="${a}">${a}: <b>${c.replace(/^Key|^Digit/, '')}</b></button>`,
        )
        .join('')}</div>`,
      [['Done', onClose]],
    );
    const get = <T extends HTMLElement>(id: string) => p.querySelector(id) as T;
    const apply = () => {
      const n: Settings = {
        ...s,
        preset: get<HTMLSelectElement>('#s-preset').value as PresetId,
        fov: Number(get<HTMLInputElement>('#s-fov').value),
        sensitivity: Number(get<HTMLInputElement>('#s-sens').value),
        volume: Number(get<HTMLInputElement>('#s-vol').value),
        uiScale: Number(get<HTMLInputElement>('#s-ui').value),
        playerName: get<HTMLInputElement>('#s-name').value.trim() || 'Alex',
        touchControls: get<HTMLSelectElement>('#s-touch').value as Settings['touchControls'],
        invertY: get<HTMLInputElement>('#s-inv').checked,
        subtitles: get<HTMLInputElement>('#s-subs').checked,
        reducedMotion: get<HTMLInputElement>('#s-rm').checked,
        watchdog: get<HTMLInputElement>('#s-wd').checked,
      };
      Object.assign(s, n);
      onChange(s);
    };
    p.querySelectorAll('input,select').forEach((el) => el.addEventListener('change', apply));
    for (const b of p.querySelectorAll<HTMLElement>('[data-a]')) {
      b.addEventListener('click', () => {
        b.innerHTML = `${b.dataset.a}: <b>…</b>`;
        const h = (e: KeyboardEvent) => {
          e.preventDefault();
          if (e.code !== 'Escape') s.bindings[b.dataset.a!] = e.code;
          b.innerHTML = `${b.dataset.a}: <b>${s.bindings[b.dataset.a!]!.replace(/^Key|^Digit/, '')}</b>`;
          window.removeEventListener('keydown', h, true);
          onChange(s);
        };
        window.addEventListener('keydown', h, true);
      });
    }
  }

  controls(onClose: () => void): void {
    this.open(
      `<h1>Controls</h1><table class="rep">
      ${[
        ['WASD / stick', 'Walk (Shift sprint = loud, C crouch = quiet)'],
        ['Mouse / drag / right side', 'Look (click to lock the mouse on desktop)'],
        ['Space', 'Sit down / stand up'],
        ['E · X / wheel', 'Use highlighted thing · next option'],
        ['Hold left mouse / H', 'Do real work (lowers suspicion, earns grades)'],
        ['1 / 2', 'Phone (held low in your lap) / laptop (on the table)'],
        ['Q', 'Quick-switch to the decoy notes (fumbling while watched is worse!)'],
        ['V · B · , .', 'Game ↔ video · earbud · screen brightness'],
        ['A / D (while gaming)', 'Move the Block Drop paddle'],
        ['G / Shift+G · hold T', 'Make a paper ball / plane · throw (hold to charge)'],
        ['N · R · M', 'Pass a note · raise hand · notebook'],
        ['Hold right mouse / Y', 'Peek at a neighbour’s test · hold K: cheat sheet'],
        ['Z / F', 'Lean left / right'],
        ['Esc · F3 · F4', 'Pause · debug view · free camera (debug)'],
      ]
        .map(([k, v]) => `<tr><td><b>${k}</b></td><td>${v}</td></tr>`)
        .join('')}</table>
      <p class="sub2">Being out of your seat during a lesson is suspicious unless you have a reason (sharpener, bin, handing in papers, picking up something you dropped).</p>`,
      [['Back', onClose]],
    );
  }

  credits(onClose: () => void): void {
    this.open(
      `<h1>Credits</h1>
      <p>Modulo: Classroom · greybox build. Design, code and placeholder content are original to this project.</p>
      <p class="sub2">No third-party art, audio or video is used yet: everything is generated (flat colours, synthesized sounds, procedural "videos"). Real assets arrive with Phase 4 and will be listed here with their licences.</p>
      <p class="sub2">Built with three.js (MIT). Research credits: see docs/classroom/RESEARCH.md.</p>
      <p class="sub2">All characters are fictional.</p>`,
      [['Back', onClose]],
    );
  }

  summary(html: string, buttons: Btn[]): void {
    this.open(html, buttons);
  }

  splash(text: string, sub: string, onGo: () => void): void {
    this.open(`<h1>${esc(text)}</h1><p class="sub2">${esc(sub)}</p>`, [
      ['Tap / click to enter class', onGo],
    ]);
  }
}

export function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
