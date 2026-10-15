import {act,cleanup,renderHook,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useCatalogInformation} from './useCatalogInformation';
import type {Place} from '../types';
const place:Place={id:'osm-node-1',name:'資料館',latitude:35,longitude:135,category:'博物館',description:'',access_point:'',themes:[]};
const record=(hours:string,revision='a'.repeat(64))=>({place_id:place.id,name:place.name,latitude:35,longitude:135,status:'updated',revision,field_checked_at:{opening_hours:'2026-10-15T01:00:00Z'},official:{opening_hours:hours}});
const response=(records:unknown[],status='ready')=>({ok:true,json:async()=>({status,records})});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();vi.restoreAllMocks();});
it('refreshes open card facts on focus without paid provider calls',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(response([record('9:00〜17:00')])).mockResolvedValue(response([record('10:00〜18:00','b'.repeat(64))]));vi.stubGlobal('fetch',fetcher);
  const view=renderHook(()=>useCatalogInformation(place));await waitFor(()=>expect(view.result.current?.revision).toBe('a'.repeat(64)));
  act(()=>window.dispatchEvent(new Event('focus')));await waitFor(()=>expect(view.result.current?.revision).toBe('b'.repeat(64)));
  expect(fetcher.mock.calls.every(([url])=>url==='/api/places/current-information')).toBe(true);
});
it('keeps accepted facts during an outage and ignores an unrelated facility',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(response([record('9:00〜17:00')])).mockResolvedValueOnce(response([],'unavailable')).mockResolvedValue(response([{...record('bad','b'.repeat(64)),name:'別の資料館'}]));vi.stubGlobal('fetch',fetcher);
  const view=renderHook(()=>useCatalogInformation(place));await waitFor(()=>expect(view.result.current?.revision).toBe('a'.repeat(64)));
  await act(async()=>window.dispatchEvent(new Event('focus')));expect(view.result.current?.revision).toBe('a'.repeat(64));
  await act(async()=>window.dispatchEvent(new Event('focus')));expect(view.result.current?.revision).toBe('a'.repeat(64));
});
it('polls once per minute and stops on unmount',async()=>{
  vi.useFakeTimers();const fetcher=vi.fn().mockResolvedValue(response([record('9:00〜17:00')]));vi.stubGlobal('fetch',fetcher);
  let view!:ReturnType<typeof renderHook>;await act(async()=>{view=renderHook(()=>useCatalogInformation(place));});
  expect(fetcher).toHaveBeenCalledTimes(1);await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});expect(fetcher).toHaveBeenCalledTimes(2);
  view.unmount();await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});expect(fetcher).toHaveBeenCalledTimes(2);
});
