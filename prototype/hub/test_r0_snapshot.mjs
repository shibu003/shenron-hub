// Canvas characterization harness — snapshots card markup + inspectors + buildFlow + undo round-trip for a
// flow covering every kind, to a golden JSON. Originally proved R0 (4-array→NODES[]) byte-identical.
// R1 (LLM-kind merge) changes kinds ON PURPOSE: prompt/languagemodel/structured/consensus load as model+mode
// via KIND_ALIAS — baseline regenerated for R1; the HOOK now ALSO asserts that promotion directly. Past R1 this
// is a regression guard for any UNINTENDED drift. (undo round-trip still proves canvasSnap preserves buildFlow.)
//   node test_r0_snapshot.mjs --write   # (re)generate r0_baseline.json
//   node test_r0_snapshot.mjs           # compare current output to baseline (exit 1 on drift)
// ponytail: stubs are the minimum render()/inspNode()/buildFlow() actually touch; grow only on a throw.
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(DIR, 'r0_baseline.json');
const html = fs.readFileSync(path.join(DIR, 'ui2.html'), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];   // first inline block = the canvas app (L260-1294)

// --- DOM element stub: records innerHTML, registers itself by id so the 2nd render() finds it ---
function el(reg, initialId) {
  let _id = initialId || '';
  const e = {
    dataset: {}, style: {}, className: '', _html: '', children: [], ondblclick: null,
    classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
      toggle(c,f){ const on = f===undefined ? !this._s.has(c) : !!f; on?this._s.add(c):this._s.delete(c); return on; },
      contains(c){return this._s.has(c);} },
    get id(){return _id;}, set id(v){ _id=v; if(reg) reg[v]=e; },
    get innerHTML(){return this._html;}, set innerHTML(v){this._html=String(v);},
    appendChild(c){ this.children.push(c); return c; },
    querySelector(){ return null; },
    querySelectorAll(sel){ return sel==='.node' ? this.children.slice() : []; },
    contains(){ return false; },            // activeElement is never inside → cards always rebuild (what we snapshot)
    remove(){ }, addEventListener(){}, removeEventListener(){}, setAttribute(){}, removeAttribute(){},
    getAttribute(){ return null; }, focus(){}, closest(){ return null; },
    getBoundingClientRect(){ return { width:1200, height:800, left:0, top:0, right:1200, bottom:800 }; },
    offsetLeft:0, offsetTop:0, offsetWidth:180, offsetHeight:60,
  };
  return e;
}
function docStub() {
  const reg = {};
  const get = (key) => reg[key] || (reg[key] = el(reg, key));
  return {
    _reg: reg,
    getElementById: (id) => get(id),
    querySelector: (sel) => get('sel:'+sel),
    querySelectorAll: () => [],
    createElement: () => el(reg),                // id assigned later (n.id=nid) → registers then
    createElementNS: () => el(reg),
    addEventListener(){}, removeEventListener(){},
    body: el(reg, 'body'), documentElement: el(reg, 'html'), activeElement: null,
  };
}
function memStore() {
  const m = {};
  return { getItem:(k)=> (k in m ? m[k] : null), setItem:(k,v)=>{ m[k]=String(v); },
    removeItem:(k)=>{ delete m[k]; }, clear:()=>{ for(const k in m) delete m[k]; } };
}

const ctx = {
  console, JSON, Math, Date, Object, Array, String, Number, Boolean, Set, Map, WeakMap,
  Promise, RegExp, Error, parseInt, parseFloat, isNaN, isFinite,
  encodeURIComponent, decodeURIComponent, structuredClone,
  setInterval:()=>0, clearInterval:()=>{}, setTimeout:()=>0, clearTimeout:()=>{}, requestAnimationFrame:()=>0,
  localStorage: memStore(), sessionStorage: memStore(),
  fetch: () => new Promise(()=>{}),                          // never resolves — refresh()/api() can't fire
  WebSocket: function(){ return { send(){}, close(){}, addEventListener(){} }; },
  EventSource: function(){ return { close(){}, addEventListener(){} }; },
  FileReader: function(){ return { readAsText(){}, addEventListener(){} }; },
  navigator: { language:'ja' }, location: { href:'http://localhost/', search:'', pathname:'/' },
  matchMedia: () => ({ matches:false, addEventListener(){}, removeEventListener(){} }),
  addEventListener(){}, removeEventListener(){},
  document: docStub(),
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;

// Representative flow: every kind loadFlow() understands + branch/share edges so buildFlow() exercises them.
ctx.__FLOW__ = {
  nodes: [
    { id:'agent-1', kind:'agent', agent:'agent-1', skill:'task', x:40, y:40 },
    { id:'trigger-1', kind:'trigger', trigger:{ type:'build_state', match:{ event:'review_completed', status:'green' } }, x:40, y:120 },
    { id:'mcp-1', kind:'mcp', server:'srv-a', tool:'do_thing', config:{ k:'v' }, auto:true, x:40, y:200 },
    { id:'note-1', kind:'note', text:'# note\n**bold**', color:'blue', x:40, y:280 },
    { id:'input-1', kind:'input', config:{ text:'hi' }, x:200, y:40 },
    { id:'prompt-1', kind:'prompt', config:{ template:'{input}' }, x:280, y:40 },
    { id:'consensus-1', kind:'consensus', config:{ vendors:'claude,codex', prompt:'go' }, x:360, y:40 },
    { id:'output-1', kind:'output', config:{}, x:440, y:40 },
    { id:'languagemodel-1', kind:'languagemodel', config:{ model:'claude', system:'sys' }, x:520, y:40 },
    { id:'structured-1', kind:'structured', config:{ schema:'a,b', instructions:'ins' }, x:600, y:40 },
    { id:'parser-1', kind:'parser', config:{ pattern:'{input}' }, x:680, y:40 },
    { id:'router-1', kind:'router', config:{ predicate:'redacted', value:'' }, x:760, y:40 },
    { id:'workflow-1', kind:'workflow', ref:'wf-xyz', config:{ ref:'wf-xyz', name:'Sub' }, x:840, y:40 },
    { id:'langflow-1', kind:'langflow', config:{ _lfType:'Custom' }, x:920, y:40 },
  ],
  edges: [
    { id:'e1', source:'input-1', target:'prompt-1' },
    { id:'e2', source:'prompt-1', target:'consensus-1' },
    { id:'e3', source:'consensus-1', target:'output-1', share:{ never:['secret'], classes:['pii'] } },
    { id:'e4', source:'router-1', target:'parser-1', branch:'then' },
    { id:'e5', source:'router-1', target:'structured-1', branch:'else' },
    { id:'e6', source:'trigger-1', target:'agent-1' },
    { id:'e7', source:'agent-1', target:'mcp-1' },
    { id:'e8', source:'mcp-1', target:'languagemodel-1' },
    { id:'e9', source:'languagemodel-1', target:'workflow-1' },
    { id:'e10', source:'workflow-1', target:'langflow-1' },
  ],
};

const HOOK = `
;(function(){
  state.agents = [{ id:'agent-1', company:'Acme', skill:'task', online:true, local:false, accepts:['*'], emits:['text'] }];
  INTEGRATIONS = [{ id:'srv-a', label:'Server A', enabled:true, tools:1 }];
  INTEG_FULL['srv-a'] = { id:'srv-a', tools:[{ name:'do_thing', accepts:['*'], emits:['*'] }] };
  loadFlow(__FLOW__);
  // R1 alias check (independent of the golden compare): old LLM kinds must promote to model+mode.
  const __EXP = { 'prompt-1':'plain', 'languagemodel-1':'system', 'structured-1':'structured', 'consensus-1':'consensus' };
  for(const __id in __EXP){ const __n = NODES.find(x=>x.id===__id);
    if(!__n || __n.kind!=='model' || (__n.config&&__n.config.mode)!==__EXP[__id]) throw new Error('R1 alias FAIL: '+__id+' → '+(__n?__n.kind+'/'+(__n.config&&__n.config.mode):'missing')+' expected model/'+__EXP[__id]); }
  render();
  const out = {};
  for(const n of __FLOW__.nodes){
    const node = document.getElementById('n_'+cssid(n.id));
    out['card:'+n.id] = node ? node.innerHTML : null;
    out['insp:'+n.id] = inspNode(n.id);
  }
  for(const e of EDGES) out['inspEdge:'+e.id] = inspEdge(e);
  out['buildFlow'] = buildFlow();
  const _snap = canvasSnap(); undoApply(_snap);              // round-trip: snapshot the state then restore it (a no-op)
  out['buildFlow_afterUndo'] = buildFlow();                  // undo must preserve the public serialization byte-for-byte
  globalThis.__RESULT__ = JSON.stringify(out, null, 2);
})();
`;

vm.createContext(ctx);
try {
  vm.runInContext(code + HOOK, ctx, { filename: 'ui2-inline.js' });
} catch (e) {
  console.error('✗ harness threw while running ui2 inline script:\n', e.stack || e);
  process.exit(2);
}
const result = ctx.__RESULT__;
if (!result) { console.error('✗ harness produced no result'); process.exit(2); }

const write = process.argv.includes('--write');
if (write) {
  fs.writeFileSync(BASELINE, result + '\n');
  const keys = Object.keys(JSON.parse(result)).length;
  console.log(`✓ baseline written: ${path.basename(BASELINE)} (${keys} snapshot keys, ${result.length} bytes)`);
  process.exit(0);
}
if (!fs.existsSync(BASELINE)) { console.error('✗ no baseline — run with --write first'); process.exit(2); }
const baseline = fs.readFileSync(BASELINE, 'utf8').trimEnd();
if (result.trimEnd() === baseline) {
  console.log('✓ R0 snapshot matches baseline — behavior preserved (card markup + inspectors + buildFlow + undo round-trip byte-identical)');
  process.exit(0);
}
// Drift: report which snapshot keys differ.
const a = JSON.parse(baseline), b = JSON.parse(result);
const diffs = [];
for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
  if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(k);
}
console.error(`✗ R0 snapshot DRIFT — ${diffs.length} key(s) changed:`);
for (const k of diffs.slice(0, 12)) {
  console.error(`\n  [${k}]\n    baseline: ${JSON.stringify(a[k])?.slice(0,200)}\n    current : ${JSON.stringify(b[k])?.slice(0,200)}`);
}
if (diffs.length > 12) console.error(`  …and ${diffs.length - 12} more`);
process.exit(1);
