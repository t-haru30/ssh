const $=id=>document.getElementById(id);
const labels={updated:'確認・保存済み',conflict:'差分・休業告知を要確認',needs_review:'根拠不足・要確認',failed:'取得失敗・再試行待ち'};
const el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
const date=seconds=>new Date(seconds*1000).toLocaleString('ja-JP');
let latest=-1,loading=false;
function source(url){const a=el('a','出典を開く');try{const u=new URL(url);if(['http:','https:'].includes(u.protocol)){a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';}}catch{}return a;}
async function refresh(){
  if(loading)return;loading=true;
  try{
    const response=await fetch('/api/catalog-agent',{cache:'no-store'});if(!response.ok)throw Error();const data=await response.json();
    const mode=data.scheduled?`Cloud Schedulerから実行（日上限${data.daily_limit}件・稼働状態はCloud Runで確認）`:`自動更新：${data.enabled?'有効':'停止'} / ${data.running?'確認中':'待機中'}`;
    if(data.scheduled){const description=document.querySelector('#agent > p:nth-of-type(2)');description.textContent=description.textContent.replace('サーバー稼働中、5分ごとに最大3施設。','クラウドではSchedulerの設定間隔で最大3施設を確認します。');}
    $('agent-run').hidden=!!data.scheduled;
    $('agent-state').textContent=`${data.engine}（${data.model}） / ${mode} / 確認対象 ${data.due}件 / 保存済み ${data.counts.updated||0}件（直近50件の履歴）`;
    const opened=new Set([...$('agent-events').querySelectorAll('details[open]')].map(n=>n.dataset.seq));
    const nodes=data.events.map(e=>{
      const box=el('details','');box.dataset.seq=String(e.seq);box.open=opened.has(String(e.seq));box.append(el('summary',`${e.name}：${labels[e.status]||e.status} — ${date(e.at)}`));
      box.append(el('p',e.note),el('p',`試行日時：${date(e.at)} / 次回確認：${date(e.next_check)}`));
      if(e.evidence.note)box.append(el('p',e.evidence.note));
      for(const step of e.evidence.agent_trace||[]){
        box.append(el('p',step.error?`判断処理のエラー：${step.error}`:`Gemini ${step.step}回目（${step.model}）：${{accept:'保存を提案',review:'要確認',recheck:'追加取得'}[step.action]} — ${step.reason}`));
        if(step.fields?.length)box.append(el('p',`採用候補の項目：${step.fields.join(' / ')}（サーバーの保存条件も適用）`));
      }
      if(e.evidence.url)box.append(source(e.evidence.url));
      const names={opening_hours:'営業時間',closed_days:'休業日',admission:'料金'};
      for(const [key,name]of Object.entries(names)){
        if(e.evidence[key]){const p=el('p',`${name}：${e.evidence[key]} `);if(e.evidence.field_sources?.[key])p.append(source(e.evidence.field_sources[key]));box.append(p);}
        const change=e.changes[key];if(change?.before)box.append(el('p',`前回値：${change.before}`));
      }
      for(const notice of e.evidence.notices||[]){const p=el('p',`休業告知：${notice.text}（${notice.starts_on}〜${notice.ends_on}） `);p.append(source(notice.url));box.append(p);}
      if(e.status==='updated')box.append(el('p',`公式情報確認日時：${e.evidence.checked_at}`));
      else box.append(el('p','今回の試行では確認済み日時・保存値を更新していません。'));
      return box;
    });
    $('agent-events').replaceChildren(...(nodes.length?nodes:[el('p','まだ確認履歴はありません。')]));
    const seq=data.events[0]?.seq||0;if(latest!==seq){latest=seq;document.dispatchEvent(new Event('catalog-updated'));}
  }catch{$('agent-state').textContent='更新状況を取得できません。実験版サーバーの稼働を確認してください。';}
  finally{loading=false;}
}
$('agent-refresh').onclick=refresh;
$('agent-run').onclick=async()=>{const b=$('agent-run');b.disabled=true;$('agent-state').textContent='公式ページを確認しています…';try{const r=await fetch('/api/catalog-agent/run',{method:'POST'});if(!r.ok)throw Error();await refresh();}catch{$('agent-state').textContent='確認を開始できませんでした。サーバーと接続を確認してください。';}finally{b.disabled=false;}};
setInterval(()=>{if(!document.hidden)refresh();},15000);
refresh();
