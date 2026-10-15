import test from 'node:test';
import assert from 'node:assert/strict';
import {auditCatalog,ageStatus,duplicateGroups} from '../public/catalog-audit.mjs';
const place=(id,name='施設',latitude=35,tags={})=>({id,name,region:'東京都',latitude,longitude:139,category:'博物館',tags:{catalog_kind:'facility',recommendation_status:'eligible',recommendation_tier:'regional',...tags}});
test('dates keep source and official verification separate, including missing and invalid dates',()=>{
  assert.equal(ageStatus('2026-07-17','2026-10-15',90).state,'stale');
  for(const d of [undefined,'bad','2026-02-31','2027-01-01'])assert.equal(ageStatus(d,'2026-10-15').state,'unknown');
  const r=auditCatalog([place('a','施設',35,{source_checked_at:'2026-10-14T20:21:31Z',catalog_reviewed_at:'2026-10-15'})],{today:'2026-10-15'}).rows[0];
  assert.equal(r.source.state,'recent');assert.equal(r.official.state,'unknown');
  assert.equal(r.source.date,'2026-10-15');assert.equal(r.source.days,0);
});
test('coverage includes empty prefectures and excludes parts or excluded facilities',()=>{
  const a=auditCatalog([place('a'),place('b','入口',35,{catalog_kind:'entrance'}),place('c','閉業',35,{recommendation_status:'excluded'})],{today:'2026-10-15',targets:{sights:2,dining:1,classics:1}});
  assert.equal(a.regions.length,47);assert.equal(a.regions.find(r=>r.region==='東京都').sights,1);
  assert.equal(a.regions.find(r=>r.region==='北海道').gaps[0].missing,2);
});
test('duplicates distinguish nearby equal names, distant branches, invalid coordinates and different nearby facilities',()=>{
  const p=[place('a','テスト・施設'),place('b','テスト施設',35.001),place('c','テスト施設',36),place('d','別の施設'),place('e','テスト施設',null)];
  assert.deepEqual(duplicateGroups(p).map(g=>g.indices),[[0,1]]);
  assert.deepEqual(duplicateGroups([place('same','A'),place('same','B',36)])[0].indices,[0,1]);
});
test('aliases link duplicates without merging source records or inflating coverage',()=>{
  const p=[place('a','英語名',35,{'name:ja':'日本語名'}),place('b','日本語名',35.001)];const before=JSON.stringify(p);
  assert.equal(duplicateGroups(p).length,1);assert.equal(JSON.stringify(p),before);
  const a=auditCatalog([p[0],p[0]],{today:'2026-10-15'});assert.equal(a.regions.find(r=>r.region==='東京都').sights,1);
});
