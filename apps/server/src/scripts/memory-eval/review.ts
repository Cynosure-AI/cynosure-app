import * as lancedb from '@lancedb/lancedb'
import { join } from 'node:path'
import { getAppDataDir } from '../../core/data-dir.js'
import { getActivePermanentMemoryTableName } from '../../core/memory/memory-index-manifest.js'
import { chunkMatchesGold } from './score.js'
import type { EvalCase, EvalDataset } from './types.js'

interface ReviewExportItem {
  id: string
  v?: 'ok' | 'fix' | 'bad'
  note?: string
}

/** Local, self-contained review page. It embeds personal memory text, so it is never published. */
export async function renderReviewPage(cases: EvalCase[]): Promise<string> {
  const db = await lancedb.connect(join(getAppDataDir(), 'lancedb'))
  const table = await db.openTable(getActivePermanentMemoryTableName())
  const rows = (await table.query().where("representationType = 'raw'").select(['text', 'sourceFile', 'chunkIndex']).toArray())
    .map((row) => ({ file: String(row.sourceFile), chunkIndex: Number(row.chunkIndex), text: String(row.text) }))
  const items = cases.map((item) => ({
    id: item.id,
    type: item.type,
    query: item.query,
    answer: item.answer || '',
    quotes: item.gold.map((gold) => gold.quote || ''),
    sources: item.gold.map((gold) => {
      const match = rows.find((row) => chunkMatchesGold(row, gold)) || rows.find((row) => row.file === gold.file)
      return { file: gold.file, chunk: match?.chunkIndex ?? null, text: match?.text.slice(0, 2_000) || '(source chunk not found in current index)' }
    }),
  }))
  return REVIEW_HTML.replace('__DATA__', JSON.stringify(items).replace(/</g, '\\u003c'))
}

export function applyReview(dataset: EvalDataset, exported: ReviewExportItem[]): { applied: number; bad: number } {
  const byId = new Map(dataset.cases.map((item) => [item.id, item]))
  let applied = 0
  let bad = 0
  for (const entry of exported) {
    const item = byId.get(entry.id)
    if (!item || !entry.v) continue
    item.review = { verdict: entry.v, note: entry.note?.trim() || undefined, at: Date.now() }
    applied++
    if (entry.v === 'bad') bad++
  }
  return { applied, bad }
}

const REVIEW_HTML = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Memory Eval Review</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--mut:#78716c;--card:#fff;--bd:#e7e5e4;--ok:#15803d;--bad:#b91c1c;--fix:#b45309;--acc:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--mut:#a8a29e;--card:#292524;--bd:#44403c;--ok:#4ade80;--bad:#f87171;--fix:#fbbf24;--acc:#93c5fd}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;padding:16px;max-width:900px}
h1{font-size:20px;margin:0 0 4px}.mut{color:var(--mut);font-size:13px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px 16px;margin:12px 0}
.card.ok{border-left:5px solid var(--ok)}.card.bad{border-left:5px solid var(--bad)}.card.fix{border-left:5px solid var(--fix)}
.q{font-size:16px;font-weight:600;margin:6px 0}.tag{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--acc);font-weight:700}
.src{font-size:12px;white-space:pre-wrap;background:var(--bg);border:1px solid var(--bd);border-radius:6px;padding:8px;max-height:220px;overflow:auto;margin-top:6px}
details summary{cursor:pointer;color:var(--mut);font-size:13px}
.btns{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}button{border:1px solid var(--bd);background:var(--card);color:var(--fg);border-radius:6px;padding:5px 12px;cursor:pointer;font:inherit;font-size:13px}
button.sel-ok{background:var(--ok);color:#fff}button.sel-bad{background:var(--bad);color:#fff}button.sel-fix{background:var(--fix);color:#fff}
textarea{width:100%;box-sizing:border-box;margin-top:6px;background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:6px;font:inherit;font-size:13px;min-height:34px}
.bar{position:sticky;top:0;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--bd);display:flex;gap:12px;align-items:center;flex-wrap:wrap;z-index:2}
mark{background:#fde68a;color:#1c1917}
</style></head><body>
<div class="bar"><div><h1>Memory Eval – Fälle prüfen</h1><div class="mut" id="prog"></div></div><button id="exp">Export JSON</button></div>
<p class="mut"><b>OK</b> = realistische Frage, erwartete Antwort stimmt mit der Quelle. <b>Fix</b> = brauchbar, aber korrekturbedürftig (Notiz). <b>Bad</b> = verwerfen (unrealistisch, mehrdeutig, falsche Antwort, oder „keine Antwort“-Frage ist doch beantwortbar). Tastatur: j/k weiter/zurück, 1/2/3 = OK/Fix/Bad. Danach <i>Export JSON</i> und <code>pnpm --filter cynosure-server memory:eval apply-review &lt;datei&gt;</code>.</p>
<div id="list"></div>
<script>
const DATA=__DATA__;
const KEY='memeval-review-'+DATA.map(c=>c.id).join('').length;let st={};try{st=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){}
const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(st))}catch(e){}prog()};
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const label={single:'Direkt',paraphrase:'Paraphrase',crosslang:'Andere Sprache',multi:'Zwei Chunks',noanswer:'Keine Antwort erwartet',real:'Echter Turn','real-noanswer':'Echter Turn ohne Memory-Bedarf'};
function hl(text,quote){let h=esc(text);const q=esc((quote||'').trim());if(q.length>3)h=h.split(q).join('<mark>'+q+'</mark>');return h}
function render(){document.getElementById('list').innerHTML=DATA.map((c,i)=>{const s=st[c.id]||{};const neg=c.type.includes('noanswer');return '<div class="card '+(s.v||'')+'" id="c'+i+'" data-i="'+i+'">'+
'<div class="tag">'+(i+1)+'/'+DATA.length+' · '+(label[c.type]||c.type)+' · '+esc(c.id)+'</div><div class="q">'+esc(c.query)+'</div>'+
(neg?'<div class="mut">Erwartet: <b>nicht in Memory</b></div>':'<div>Erwartete Antwort: <b>'+esc(c.answer)+'</b></div>')+
(c.sources.length?'<details '+(neg?'':'open')+'><summary>Quelle(n): '+c.sources.map(x=>esc(x.file)+(x.chunk!==null?' #'+x.chunk:'')).join(', ')+'</summary>'+c.sources.map((x,j)=>'<div class="src">'+hl(x.text,c.quotes[j])+'</div>').join('')+'</details>':'')+
'<div class="btns"><button data-v="ok" class="'+(s.v==='ok'?'sel-ok':'')+'">✓ OK</button><button data-v="fix" class="'+(s.v==='fix'?'sel-fix':'')+'">✎ Fix</button><button data-v="bad" class="'+(s.v==='bad'?'sel-bad':'')+'">✗ Bad</button></div>'+
'<textarea placeholder="Notiz (optional)">'+esc(s.note||'')+'</textarea></div>'}).join('');
document.querySelectorAll('.card').forEach(card=>{const id=DATA[card.dataset.i].id;card.querySelectorAll('button').forEach(b=>b.onclick=()=>{st[id]={...(st[id]||{}),v:b.dataset.v};save();render()});card.querySelector('textarea').onchange=e=>{st[id]={...(st[id]||{}),note:e.target.value};save()}});prog()}
function prog(){const v=Object.values(st);const c=k=>v.filter(x=>x.v===k).length;document.getElementById('prog').textContent=v.filter(x=>x.v).length+'/'+DATA.length+' geprüft · OK '+c('ok')+' · Fix '+c('fix')+' · Bad '+c('bad')}
let cur=0;document.addEventListener('keydown',e=>{if(e.target.tagName==='TEXTAREA')return;const go=i=>{cur=Math.max(0,Math.min(DATA.length-1,i));document.getElementById('c'+cur).scrollIntoView({behavior:'smooth',block:'center'})};
if(e.key==='j')go(cur+1);if(e.key==='k')go(cur-1);const m={'1':'ok','2':'fix','3':'bad'}[e.key];if(m){st[DATA[cur].id]={...(st[DATA[cur].id]||{}),v:m};save();render();go(cur+1)}});
document.getElementById('exp').onclick=()=>{const blob=new Blob([JSON.stringify(DATA.map(c=>({id:c.id,...(st[c.id]||{})})),null,1)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='memory-eval-review.json';a.click()};
render();
</script></body></html>`
