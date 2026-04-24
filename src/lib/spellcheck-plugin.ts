/**
 * spellcheck-plugin.ts — Spell & grammar checking for JayNotes
 *
 * Strategy
 * ────────
 * • Uses nspell (Hunspell-compatible) with the standard en-US dictionary
 *   (dictionary-en files copied to /public/dict/) loaded via fetch().
 *   No custom dictionary, no server API, no proprietary service.
 * • The ProseMirror plugin walks text nodes on every (debounced) document
 *   change and builds two sets of inline Decoration objects:
 *     - .jn-spell-error   — red wavy underline   (misspelled words)
 *     - .jn-grammar-error — amber wavy underline  (lightweight grammar rules)
 * • Grammar rules are purely pattern-based (no large grammar corpus):
 *     - Doubled words  ("the the", "is is", …)
 *     - a/an mismatch  ("a apple", "an car", …)
 * • Ignored words are stored in localStorage so "ignore" survives reload.
 * • Personal dictionary additions are also persisted to localStorage.
 *
 * Public API (imported by MilkdownEditor.tsx)
 * ────────────────────────────────────────────
 *   spellcheckPlugin          Milkdown $prose plugin
 *   spellSuggest(word)        string[] — up to 8 suggestions (sync after init)
 *   spellAddWord(word)        add to personal dict + localStorage
 *   spellIgnoreOnce(word)     session-only ignore
 */

import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

// nspell is CJS; Vite's CJS interop handles it correctly when imported with ESM syntax.
import NSpell from 'nspell';

// ─── Singleton spell-checker (async init) ────────────────────────────────────

let _spell: any = null;
let _initPromise: Promise<void> | null = null;

// ─── Professional / modern vocabulary supplement ──────────────────────────────
// The Hunspell en-US dictionary predates many modern professional, tech, and
// business terms. These words are correctly spelled but flagged as errors.
// Adding them directly to the checker at init avoids false positives.
const SUPPLEMENT_WORDS = [
  // Business / strategy
  'aspirational','actionable','scalable','scalability','synergy','synergize',
  'ideate','ideation','learnings','deliverables','onboarding','offboarding',
  'reskilling','upskilling','upskill','roadmap','roadmaps','touchpoint',
  'touchpoints','swimlane','swimlanes','backlog','backlogs','sprint','sprints',
  'scrum','kanban','agile','standup','standups','retro','retrospective',
  'retrospectives','okr','okrs','kpi','kpis','sla','slas','roi','cta','ctas',
  'persona','personas','stakeholder','stakeholders','deliverable',
  'prioritization','prioritize','deprioritize','derisking','derisk',
  'greenfield','brownfield','lifecycle','lifecycles','playbook','playbooks',
  'runbook','runbooks','grooming','triaging','triage','triaged','kickoff',
  'kickoffs','signoff','signoffs','rollout','rollouts','operationalize',
  'operationalized','operationalizing','monetize','monetization','gamify',
  'gamification','incentivize','incentivization',
  // Tech / software
  'microservice','microservices','serverless','kubernetes','containerized',
  'containerize','devops','devsecops','gitops','ci','cd','cicd','webhook',
  'webhooks','api','apis','sdk','sdks','cli','gui','ui','ux','frontend',
  'backend','fullstack','codebase','refactor','refactored','refactoring',
  'repo','repos','repository','repositorie','linter','linting','linted',
  'prettier','typescript','javascript','javascript','jsx','tsx','css',
  'html','json','yaml','toml','markdown','regex','regexp','nullable',
  'nonnull','async','await','callback','callbacks','middleware','middlewares',
  'localhost','localhost','hotfix','hotfixes','bugfix','bugfixes','changelog',
  'changelogs','versioning','semver','monorepo','monorepos','polyrepo',
  'polyrepos','npm','pnpm','yarn','webpack','vite','esbuild','rollup',
  'dockerfile','containerization','vm','vms','serverless','multicloud',
  'multi-cloud','saas','paas','iaas','faas','baas','cms','crm','erp',
  'analytics','dataset','datasets','datastore','datastores','blockchain',
  'cryptocurrency','nft','nfts','decentralized','defi','metaverse',
  // Data / AI
  'dataset','datasets','dataframe','dataframes','preprocessing','preprocess',
  'preprocessed','tokenize','tokenized','tokenization','tokenizer',
  'tokenizers','embeddings','embedding','finetuning','finetune','finetuned',
  'pretrained','inference','inferencing','overfitting','underfitting',
  'hyperparameter','hyperparameters','backpropagation','feedforward',
  'autoencoder','autoencoders','transformer','transformers','llm','llms',
  'generative','multimodal','retrieval','rag','vectorstore','vectorstores',
  'workflow','workflows','pipeline','pipelines','datapoint','datapoints',
  // Common modern English
  'suboptimal','nonoptimal','workaround','workarounds','impactful',
  'bandwidth','mindset','mindsets','skillset','skillsets','toolset',
  'toolsets','ecosystem','ecosystems','proactive','proactively',
  'retroactive','retroactively','contextualize','contextualized','nuanced',
  'granular','granularity','holistic','holistically','iterative','iteratively',
  'overarching','hardcoded','hardcode','hardcoding','softcoded','softcode',
  'plugin','plugins','addon','addons','popup','popups','dropdown','dropdowns',
  'checkbox','checkboxes','tooltip','tooltips','modal','modals','sidebar',
  'sidebars','navbar','navbars','toolbar','toolbars','wireframe','wireframes',
  'mockup','mockups','prototype','prototypes','stylesheet','stylesheets',
  'favicon','favicon','screenshot','screenshots','screencast','screencasts',
  'workaround','workarounds','fallback','fallbacks','boilerplate','boilerplates',
  'unsubscribe','resubscribe','onsite','offsite','offload','offloaded',
  'onprem','on-prem','multi-tenant','multitenant','whitelabel','white-label',
  'crowdsource','crowdsourced','crowdsourcing','geolocation','geolocate',
  'autocomplete','autofill','autosave','autosaved',
];

async function initSpell(): Promise<void> {
  if (_spell) return;
  try {
    const [affText, dicText] = await Promise.all([
      fetch('/dict/en.aff').then(r => {
        if (!r.ok) throw new Error(`Failed to load /dict/en.aff: ${r.status}`);
        return r.text();
      }),
      fetch('/dict/en.dic').then(r => {
        if (!r.ok) throw new Error(`Failed to load /dict/en.dic: ${r.status}`);
        return r.text();
      }),
    ]);
    _spell = NSpell(affText, dicText);
    // Add professional/modern vocabulary supplement
    for (const w of SUPPLEMENT_WORDS) _spell.add(w);
    // Restore personal dictionary from localStorage
    for (const w of getPersonalWords()) {
      _spell.add(w);
    }
  } catch (err) {
    console.error('[spellcheck] dictionary load failed:', err);
    _spell = null; // fail open — no underlines rather than crashing
  }
}

function ensureInit(): Promise<void> {
  if (!_initPromise) _initPromise = initSpell();
  return _initPromise;
}

// ─── Personal dictionary (localStorage) ──────────────────────────────────────

const LS_PERSONAL = 'jn-personal-dict';

function getPersonalWords(): string[] {
  try {
    const raw = localStorage.getItem(LS_PERSONAL);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch { return []; }
}
function savePersonalWords(words: string[]) {
  try { localStorage.setItem(LS_PERSONAL, JSON.stringify(words)); } catch { /* quota */ }
}

/** Add a word to the permanent personal dictionary (persisted to localStorage). */
export function spellAddWord(word: string) {
  const clean = word.trim();
  if (!clean) return;
  if (_spell) _spell.add(clean);
  const current = getPersonalWords();
  if (!current.includes(clean)) savePersonalWords([...current, clean]);
  _ignoredOnce.add(clean.toLowerCase());
  invalidateDecorations();
}

// ─── Session-only ignore ──────────────────────────────────────────────────────

const _ignoredOnce = new Set<string>();

/** Ignore a word for this editing session only (not persisted). */
export function spellIgnoreOnce(word: string) {
  _ignoredOnce.add(word.toLowerCase());
  invalidateDecorations();
}

// ─── Force decoration rebuild after ignore / add-to-dict ─────────────────────

let _lastView: any = null;

function invalidateDecorations() {
  if (_lastView) {
    try {
      _lastView.dispatch(
        _lastView.state.tr.setMeta('jn-spell-invalidate', true)
      );
    } catch { /* view may have unmounted */ }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Up to 8 spelling suggestions.  Returns [] if the checker isn't ready yet. */
export function spellSuggest(word: string): string[] {
  if (!_spell) return [];
  try { return (_spell.suggest(word) as string[]).slice(0, 8); } catch { return []; }
}

/** True if correctly spelled (or checker not yet ready — fail open). */
export function spellCheck(word: string): boolean {
  if (!_spell) return true;
  try { return _spell.correct(word) as boolean; } catch { return true; }
}

// ─── Word tokeniser ───────────────────────────────────────────────────────────

const WORD_RE = /[a-zA-Z'\u2019]+/g;

interface WordToken { word: string; offset: number }

function tokeniseWords(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  let m: RegExpExecArray | null;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(text)) !== null) {
    const raw = m[0];
    // Strip leading apostrophes — track how many were stripped so offset is correct
    let leadStrip = 0;
    let w = raw;
    while (w.length > 0 && (w[0] === "'" || w[0] === '\u2019')) { w = w.slice(1); leadStrip++; }
    // Strip trailing apostrophes
    while (w.length > 0 && (w[w.length - 1] === "'" || w[w.length - 1] === '\u2019')) w = w.slice(0, -1);
    if (!w || w.length < 2) continue;
    // Skip pure uppercase acronyms (>=3 chars all caps, e.g. URL, API, NATO)
    if (w.length >= 3 && w === w.toUpperCase()) continue;
    // Skip camelCase / mixed-internal-caps words (brands like SharePoint, iPhone,
    // compound proper nouns). A capital letter after position 0 signals this.
    if (/[A-Z]/.test(w.slice(1))) continue;
    tokens.push({ word: w, offset: m.index + leadStrip });
  }
  return tokens;
}

// ─── Grammar rules ────────────────────────────────────────────────────────────

interface GrammarError { from: number; to: number; message: string }

const VOWEL_SOUND_RE = /^[aeiouAEIOU]/;

// Words beginning with a vowel letter but sounding like a consonant
const VOWEL_EXCEPTIONS = new Set([
  'uniform', 'union', 'unique', 'unit', 'universal', 'university',
  'use', 'user', 'usual', 'utility', 'european', 'eu', 'useful',
  'once', 'one', 'ufo',
]);
// Words beginning with a consonant letter but sounding like a vowel
const CONSONANT_EXCEPTIONS = new Set([
  'hour', 'honest', 'honour', 'honor', 'heir', 'herb',
]);

function grammarCheck(text: string): GrammarError[] {
  const errors: GrammarError[] = [];

  // Rule 1: doubled words ("the the", "is is", ...)
  {
    const DOUBLE_RE = /\b([a-zA-Z]{2,})\s+\1\b/gi;
    let m: RegExpExecArray | null;
    DOUBLE_RE.lastIndex = 0;
    while ((m = DOUBLE_RE.exec(text)) !== null) {
      errors.push({
        from: m.index,
        to: m.index + m[0].length,
        message: `Doubled word: "${m[1]}"`,
      });
    }
  }

  // Rule 2: a/an mismatch
  {
    const AN_RE = /\b(a|an)\s+([a-zA-Z]+)/gi;
    let m: RegExpExecArray | null;
    AN_RE.lastIndex = 0;
    while ((m = AN_RE.exec(text)) !== null) {
      const article   = m[1].toLowerCase();
      const next      = m[2];
      const nextLower = next.toLowerCase();
      const vowelStart = VOWEL_SOUND_RE.test(next);

      if (article === 'a' && vowelStart && !VOWEL_EXCEPTIONS.has(nextLower)) {
        errors.push({
          from: m.index,
          to: m.index + m[0].length,
          message: `Use "an" before words starting with a vowel sound`,
        });
      } else if (article === 'an' && !vowelStart && !CONSONANT_EXCEPTIONS.has(nextLower)) {
        errors.push({
          from: m.index,
          to: m.index + m[0].length,
          message: `Use "a" before words starting with a consonant sound`,
        });
      }
    }
  }

  return errors;
}

// ─── Node types to skip (code, inline code, HTML) ────────────────────────────

const SKIP_TYPES = new Set([
  'code_block', 'fence', 'code', 'inline_code', 'code_inline',
  'html_block', 'html_inline',
]);

// ─── Decoration builder ───────────────────────────────────────────────────────

function buildDecorations(doc: any): DecorationSet {
  const decos: Decoration[] = [];

  doc.descendants((node: any, pos: number, parent: any) => {
    if (!node.isText) {
      // Prune entire subtree for skip-type block nodes
      return !SKIP_TYPES.has(node.type?.name ?? '');
    }
    // Skip if inside a code/html parent
    if (parent && SKIP_TYPES.has(parent.type?.name ?? '')) return false;

    const text = node.text ?? '';
    if (!text.trim()) return false;

    // ── Spelling ─────────────────────────────────────────────────────────────
    if (_spell) {
      for (const { word, offset } of tokeniseWords(text)) {
        const lc = word.toLowerCase();
        if (_ignoredOnce.has(lc)) continue;
        // Try original capitalisation first, then lowercase (handles proper nouns)
        if (_spell.correct(word)) continue;
        if (word !== lc && _spell.correct(lc)) continue;
        const from = pos + offset;
        const to   = from + word.length;
        decos.push(Decoration.inline(from, to, {
          class: 'jn-spell-error',
          nodeName: 'span',
          'data-jn-word': word,
          'data-jn-type': 'spell',
        }));
      }
    }

    // ── Grammar ──────────────────────────────────────────────────────────────
    for (const err of grammarCheck(text)) {
      const phrase = text.slice(err.from, err.to);
      if (_ignoredOnce.has(phrase.toLowerCase())) continue;
      decos.push(Decoration.inline(pos + err.from, pos + err.to, {
        class: 'jn-grammar-error',
        nodeName: 'span',
        'data-jn-word': phrase,
        'data-jn-type': 'grammar',
        'data-jn-msg': err.message,
      }));
    }

    return false; // text nodes have no children
  });

  return DecorationSet.create(doc, decos);
}

// ─── Debounce ─────────────────────────────────────────────────────────────────

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...args: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  }) as T;
}

// ─── ProseMirror plugin ───────────────────────────────────────────────────────

const spellKey = new PluginKey('jn-spellcheck');
interface SpellState { decorations: DecorationSet }

export const spellcheckPlugin = $prose(() => {
  // Begin dictionary fetch immediately (background, non-blocking)
  ensureInit();

  // The view reference captured when the plugin mounts.
  // Stored in a box so the debouncer closure always gets the live view.
  const viewBox = { current: null as any };

  const scheduleRebuild = debounce(() => {
    const v = viewBox.current;
    if (!v) return;
    ensureInit().then(() => {
      const v2 = viewBox.current;
      if (!v2) return;
      const decorations = buildDecorations(v2.state.doc);
      try {
        v2.dispatch(v2.state.tr.setMeta(spellKey, { decorations }));
      } catch { /* view changed between scheduling and firing */ }
    });
  }, 700);

  return new Plugin<SpellState>({
    key: spellKey,

    state: {
      init() {
        return { decorations: DecorationSet.empty };
      },
      apply(tr, prev, _old, newState) {
        // Forced rebuild (from ignore / add-to-dict)
        if (tr.getMeta('jn-spell-invalidate')) {
          return { decorations: buildDecorations(newState.doc) };
        }
        // Accept fresh decorations from the debouncer
        const incoming = tr.getMeta(spellKey) as { decorations: DecorationSet } | undefined;
        if (incoming) return { decorations: incoming.decorations };
        // Map existing decorations through any position changes
        if (!tr.docChanged) return prev;
        return { decorations: prev.decorations.map(tr.mapping, tr.doc) };
      },
    },

    props: {
      decorations(state) {
        return spellKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },

    view(view) {
      _lastView = view;
      viewBox.current = view;
      scheduleRebuild(); // first pass

      return {
        update(v) {
          _lastView = v;
          // Only schedule when the document actually changed
          if (v.state.doc !== viewBox.current?.state.doc) {
            viewBox.current = v;
            scheduleRebuild();
          } else {
            viewBox.current = v;
          }
        },
        destroy() {
          if (_lastView === view) _lastView = null;
          viewBox.current = null;
        },
      };
    },
  });
});
