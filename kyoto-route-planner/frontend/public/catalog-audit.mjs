export const PREFECTURES = '北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県'.split(' ');
export const isDining = p => ['restaurant','cafe','fast_food','food_court','bar','pub'].includes(p.tags?.amenity) || /飲食|カフェ|レストラン|食堂|喫茶|料理/.test(p.category || '');
export const normalizedName = name => String(name || '').normalize('NFKC').toLowerCase().replace(/[\s・･\-‐－()（）]/g,'');
export function ageStatus(value, today, threshold = 90) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return {state:'unknown', label:'確認日なし'};
  let date = value.slice(0,10);
  if(value.includes('T')) {
    const timestamp=Date.parse(value);
    if(!Number.isFinite(timestamp))return {state:'unknown',label:'日付を要確認'};
    date=new Date(timestamp+9*3600000).toISOString().slice(0,10);
  }
  const time = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== date) return {state:'unknown', label:'日付を要確認'};
  const days = Math.floor((Date.parse(today+'T00:00:00Z')-time)/86400000);
  if (days < 0) return {state:'unknown',label:'未来の日付・要確認',date};
  return {state:days >= threshold ? 'stale':'recent',label:`${days}日前`,date,days};
}
export function distanceMeters(a,b) {
  if (![a.latitude,a.longitude,b.latitude,b.longitude].every(v=>typeof v==='number' && Number.isFinite(v)) || [a.latitude,b.latitude].some(v=>Math.abs(v)>90) || [a.longitude,b.longitude].some(v=>Math.abs(v)>180)) return Infinity;
  const rad=Math.PI/180, dlat=(b.latitude-a.latitude)*rad, dlon=(b.longitude-a.longitude)*rad;
  return 6371000*2*Math.asin(Math.min(1,Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(dlon/2)**2)));
}
export function duplicateGroups(places) {
  const parent=places.map((_,i)=>i), buckets=new Map(), reasons=[];
  const root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  const join=(a,b,reason)=>{parent[root(a)]=root(b);reasons.push({a,b,reason});};
  places.forEach((p,i)=>{
    const keys=[...(p.id?[`id:${p.id}`]:[]),...new Set([p.name,p.tags?.['name:ja'],p.tags?.official_name].map(normalizedName).filter(Boolean).map(n=>'name:'+n))];
    for(const key of keys){const previous=buckets.get(key)||[];for(const j of previous){if(key.startsWith('id:'))join(i,j,'同じ施設ID');else if(distanceMeters(p,places[j])<=300)join(i,j,'同名・別名が一致し300m以内');}previous.push(i);buckets.set(key,previous);}
  });
  const groups=new Map();places.forEach((_,i)=>{const k=root(i);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(i);});
  return [...groups.values()].filter(g=>g.length>1).map((indices,i)=>({id:i+1,indices,reasons:[...new Set(reasons.filter(r=>root(r.a)===root(indices[0])).map(r=>r.reason))]}));
}
export function auditCatalog(places,{today,staleDays=90,targets={sights:50,dining:30,classics:3}}) {
  const duplicates=duplicateGroups(places), membership=new Map();
  for(const g of duplicates)for(const i of g.indices)membership.set(i,g.id);
  const rows=places.map((place,index)=>({place,index,duplicate:membership.get(index),
    source:ageStatus(place.tags?.source_checked_at,today,staleDays),
    official:ageStatus(place.tags?.official_checked_at,today,staleDays)}));
  const regions=PREFECTURES.map(region=>{
    const all=rows.filter(r=>r.place.region===region), seen=new Set();
    const candidates=all.filter(({place:p})=>{if(seen.has(p.id))return false;seen.add(p.id);return p.tags?.recommendation_status==='eligible' && p.tags?.catalog_kind==='facility';});
    const dining=candidates.filter(r=>isDining(r.place)).length, sights=candidates.length-dining;
    const classics=candidates.filter(r=>!isDining(r.place)&&r.place.tags?.recommendation_tier==='classic').length;
    const gaps=Object.entries({sights,dining,classics}).map(([key,count])=>({key,count,target:targets[key],missing:Math.max(0,targets[key]-count)}));
    return {region,total:all.length,sights,dining,classics,gaps,short:gaps.some(g=>g.missing>0),sourceUnknown:all.filter(r=>r.source.state==='unknown').length,sourceStale:all.filter(r=>r.source.state==='stale').length,officialUnknown:all.filter(r=>r.official.state==='unknown').length};
  });
  return {rows,regions,duplicates};
}
